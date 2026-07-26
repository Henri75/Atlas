import type { Catalog } from './catalog.js';
import { DEFAULT_AGING_MONTHS, DEFAULT_ARCHIVED_PENALTY, deriveDocAge } from './docStatus.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import type { VectorStore } from './qdrant.js';
import { sparseVector } from './sparse.js';
import { selectedProjects, type SearchFilters, type SearchHit, type SearchResult } from './types.js';

/**
 * Search orchestration with the graceful-degradation chain:
 *   hybrid (dense+sparse RRF) → sparse-only → Postgres FTS.
 */
/** How long the API trusts its cached view of the indexer's active collection. */
const COLLECTION_TTL_MS = 15_000;

export interface DocRankingOpts {
  /** Multiplier applied to the fused score of archived doc hits. */
  archivedPenalty?: number;
  /** Age (months) past which an unarchived doc gets the aging label. */
  agingMonths?: number;
}

export class SearchService {
  private collectionCheckedAt = 0;

  constructor(
    private catalog: Catalog,
    private vectors: VectorStore,
    /** Resolved lazily and may be null when the provider is unreachable. */
    private embedder: EmbeddingProvider | null,
    private ranking: DocRankingOpts = {},
  ) {}

  setEmbedder(e: EmbeddingProvider | null) {
    this.embedder = e;
  }

  /**
   * Follow the collection the indexer is currently writing.
   *
   * Changing the embedding model changes the vector dimension, and therefore
   * the collection. Without this, the API keeps querying the collection it saw
   * at boot: every dense query then fails on a dimension mismatch and search
   * silently degrades to the Postgres fallback.
   */
  private async syncCollection(now: number): Promise<void> {
    if (now - this.collectionCheckedAt < COLLECTION_TTL_MS) return;
    this.collectionCheckedAt = now;
    try {
      const active = await this.catalog.getSetting('active_collection');
      if (active && active !== this.vectors.collection) this.vectors.useCollection(active);
    } catch {
      // Keep serving with the current collection if the catalog is unreachable.
    }
  }

  async search(q: string, filters: SearchFilters = {}, limit = 20): Promise<SearchResult> {
    const t0 = Date.now();
    await this.syncCollection(t0);
    // Widen the scope to the project's older locations before anything filters
    // on it. Both the vector path and the FTS fallback flow through here, so
    // they cannot disagree about what "scoped to deepcast" means.
    filters = await this.expandScope(filters);
    const sparse = sparseVector(q);

    let dense: number[] | undefined;
    let mode = 'sparse-only';
    if (this.embedder) {
      try {
        dense = (await this.embedder.embed([q]))[0];
        mode = 'hybrid';
      } catch {
        dense = undefined; // provider down → sparse still works
      }
    }

    // Over-fetch so downranked archived docs can fall out of the window
    // instead of pushing better hits out of it.
    const fetchLimit = Math.min(limit * 2, 100);
    try {
      const raw = await this.vectors.query({ dense, sparse, filters, limit: fetchLimit });
      const hydrated = await this.hydrate(raw);
      return {
        hits: this.finalize(hydrated, limit),
        mode,
        degraded: mode !== 'hybrid',
        tookMs: Date.now() - t0,
      };
    } catch {
      // Qdrant unavailable → keyword fallback straight from Postgres.
      const hits = await this.catalog.ftsSearch(q, filters, fetchLimit);
      return { hits: this.finalize(hits, limit), mode: 'fts', degraded: true, tookMs: Date.now() - t0 };
    }
  }

  /**
   * Include a project's aliases — the slugs its history was filed under before
   * the checkout moved. Best-effort: a catalog hiccup must narrow the search,
   * never fail it.
   */
  private async expandScope(filters: SearchFilters): Promise<SearchFilters> {
    const selected = selectedProjects(filters);
    if (!selected.length) return filters;
    try {
      const expanded = await this.catalog.expandProjectScope(selected);
      if (expanded.length === selected.length) return filters;
      return { ...filters, project: undefined, projects: expanded };
    } catch {
      return filters;
    }
  }

  /**
   * Shared staleness pass — BOTH the vector path and the FTS fallback flow
   * through here, so degraded mode ranks by the same rules.
   *
   * archived → score penalty + label; aging → label only (an old runbook that
   * simply never needed edits must not be buried); everything re-sorted.
   */
  private finalize(hits: SearchHit[], limit: number): SearchHit[] {
    const penalty = this.ranking.archivedPenalty ?? DEFAULT_ARCHIVED_PENALTY;
    const agingMonths = this.ranking.agingMonths ?? DEFAULT_AGING_MONTHS;
    const nowMs = Date.now();
    return hits
      .map((h): SearchHit => {
        const { status, ageMonths } = deriveDocAge(h.occurredAt, agingMonths, nowMs);

        // Archiving and the aging *label* are doc conventions: `archived` comes
        // from a doc's path, and calling a two-year-old commit "aging" would be
        // noise — commits are historical by nature, not stale.
        if (h.sourceType === 'doc') {
          if (h.docStatus === 'archived') {
            return { ...h, score: h.score * penalty, ...(ageMonths != null ? { ageMonths } : {}) };
          }
          if (status === 'aging') return { ...h, docStatus: 'aging', ageMonths };
          return ageMonths != null ? { ...h, ageMonths } : h;
        }

        // Every other source type still gets its age *measured* and carried, so
        // callers can reason about it. Previously only docs did, which is why
        // Ask received session and kdb blocks with no indication of how old they
        // were and treated a 2025 transcript exactly like last week's.
        return ageMonths != null ? { ...h, ageMonths } : h;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Map Qdrant matches back to full entries; drops stale ids gracefully. */
  private async hydrate(raw: { entryId: number; score: number }[]): Promise<SearchHit[]> {
    const rows = await this.catalog.getEntries(raw.map((r) => r.entryId).filter(Boolean));
    const hits: SearchHit[] = [];
    for (const r of raw) {
      const row = rows.get(r.entryId);
      if (!row) continue;
      hits.push({
        entryId: r.entryId,
        score: r.score,
        projectSlug: row.slug,
        sourceType: row.source_type,
        component: row.component ?? undefined,
        sessionId: row.session_id ?? undefined,
        title: row.title,
        snippet: String(row.body).slice(0, 280),
        occurredAt: row.occurred_at?.toISOString?.() ?? undefined,
        sourcePath: row.source_path,
        sourceRef: row.source_ref ?? undefined,
        ...(row.meta?.docStatus === 'archived' ? { docStatus: 'archived' as const } : {}),
      });
    }
    return hits;
  }
}
