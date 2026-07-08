import type { Catalog } from './catalog.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import type { VectorStore } from './qdrant.js';
import { sparseVector } from './sparse.js';
import type { SearchFilters, SearchHit, SearchResult } from './types.js';

/**
 * Search orchestration with the graceful-degradation chain:
 *   hybrid (dense+sparse RRF) → sparse-only → Postgres FTS.
 */
export class SearchService {
  constructor(
    private catalog: Catalog,
    private vectors: VectorStore,
    /** Resolved lazily and may be null when the provider is unreachable. */
    private embedder: EmbeddingProvider | null,
  ) {}

  setEmbedder(e: EmbeddingProvider | null) {
    this.embedder = e;
  }

  async search(q: string, filters: SearchFilters = {}, limit = 20): Promise<SearchResult> {
    const t0 = Date.now();
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

    try {
      const raw = await this.vectors.query({ dense, sparse, filters, limit });
      const hydrated = await this.hydrate(raw);
      return {
        hits: hydrated,
        mode,
        degraded: mode !== 'hybrid',
        tookMs: Date.now() - t0,
      };
    } catch {
      // Qdrant unavailable → keyword fallback straight from Postgres.
      const hits = await this.catalog.ftsSearch(q, filters, limit);
      return { hits, mode: 'fts', degraded: true, tookMs: Date.now() - t0 };
    }
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
      });
    }
    return hits;
  }
}
