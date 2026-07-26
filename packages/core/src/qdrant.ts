import { QdrantClient } from '@qdrant/js-client-rest';
import { selectedProjects, type SearchFilters } from './types.js';
import type { SparseVector } from './sparse.js';
import { withRetry } from './retry.js';

/** Points per HTTP call. Keeps each request well inside Qdrant's 5s timeout. */
const UPSERT_BATCH = 64;

/**
 * Qdrant wrapper: one collection per embedding config, named vectors
 * 'dense' + 'sparse'. Sparse uses the server-side IDF modifier so clients
 * only ship term frequencies. Hybrid queries fuse both branches with RRF.
 */

export interface VectorPoint {
  id: string;
  dense?: number[];
  sparse: SparseVector;
  payload: {
    entry_id: number;
    project: string;
    source_type: string;
    component?: string;
    session_id?: string;
    /** Message classification (insight, summary, action…) for session entries. */
    kind?: string;
    /** 'archived' for docs under archive-style paths; absent means active. */
    doc_status?: string;
    occurred_at?: string;
  };
}

/**
 * The product is Atlas; the `kdbscope_` prefix is the former name and is FROZEN
 * PERMANENTLY. It is the storage key the live collection is stored under: every
 * one of the ~324k dense vectors lives in `kdbscope_<provider>_<model>_<dim>`.
 * Renaming the prefix to `atlas_` points the indexer at a collection that does
 * not exist — it creates an empty one and search returns nothing until a full
 * re-embed of every entry (hours). This is an internal namespace users never
 * see; do NOT attempt the rename unless a full re-embed is already happening
 * for another reason. The matching id namespace is frozen for the same reason
 * (see ids.ts). Cosmetic gain, hours of rebuild. Leave it.
 *
 * `COLLECTION_PREFIX` is the guard the orphan-reclaim path uses: we only ever
 * drop collections we ourselves created, never anything else in Qdrant.
 */
export const COLLECTION_PREFIX = 'kdbscope_';

export function collectionNameFor(provider: string, model: string, dim: number): string {
  const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `${COLLECTION_PREFIX}${safe(provider)}_${safe(model)}_${dim}`;
}

/**
 * Scalar int8 quantization: keeps a 1-byte-per-dimension approximation of each
 * dense vector in RAM (≈4× smaller than the fp32 original) and rescores the
 * top candidates against the full-precision vectors on disk. Recall loss for
 * Cosine is well under a percent, while the resident set of the 768-dim
 * collection drops from ~1GB of raw vectors to ~250MB. `quantile: 0.99` clips
 * outlier dimensions so the int8 range is not wasted on a few extreme values.
 */
const QUANTIZATION = {
  scalar: { type: 'int8' as const, quantile: 0.99, always_ram: true },
};

/**
 * Optimizer bounds chosen to cap the boot-time RAM spike. On start Qdrant
 * re-optimizes segments, pulling vectors into RAM to (re)build HNSW; a single
 * giant segment makes that spike the size of the whole collection. Capping the
 * segment size bounds how much is resident at once, trading a slightly larger
 * graph for a much lower peak — which is what a memory-constrained host feels.
 */
const OPTIMIZERS = {
  // ~64k vectors per segment: several smaller segments instead of one huge one.
  max_segment_size: 64_000,
};

/**
 * Translate search filters into a Qdrant payload filter. An over-broad filter
 * silently returns the wrong rows and an over-narrow one silently returns
 * none, so this is worth testing on its own.
 */
export function buildQdrantFilter(
  filters: SearchFilters,
): { must: object[]; must_not?: object[] } | undefined {
  const must: object[] = [];
  const mustNot: object[] = [];
  // Projects and source types take the same shape: one value is an equality
  // match, several are an OR (`any`), none means no constraint at all.
  const projects = selectedProjects(filters);
  if (projects.length === 1) must.push({ key: 'project', match: { value: projects[0] } });
  else if (projects.length > 1) must.push({ key: 'project', match: { any: projects } });
  // A subset (sourceTypes) wins over the single sourceType; the singular stays
  // for back-compat. Qdrant's `any` is the multi-value OR match.
  const types = filters.sourceTypes?.length
    ? filters.sourceTypes
    : filters.sourceType
      ? [filters.sourceType]
      : [];
  if (types.length === 1) must.push({ key: 'source_type', match: { value: types[0] } });
  else if (types.length > 1) must.push({ key: 'source_type', match: { any: types } });
  if (filters.component) must.push({ key: 'component', match: { value: filters.component } });
  if (filters.kind) must.push({ key: 'kind', match: { value: filters.kind } });
  // 'active' is expressed as NOT archived: most points carry no doc_status at
  // all, and a positive match would silently exclude every one of them.
  if (filters.docStatus === 'archived') {
    must.push({ key: 'doc_status', match: { value: 'archived' } });
  } else if (filters.docStatus === 'active') {
    mustNot.push({ key: 'doc_status', match: { value: 'archived' } });
  }
  if (filters.since || filters.until) {
    must.push({
      key: 'occurred_at',
      range: {
        ...(filters.since ? { gte: filters.since } : {}),
        ...(filters.until ? { lte: filters.until } : {}),
      },
    });
  }
  if (!must.length && !mustNot.length) return undefined;
  return { must, ...(mustNot.length ? { must_not: mustNot } : {}) };
}

export class VectorStore {
  private client: QdrantClient;
  /** Mutable: the indexer can switch collections when the embedder changes. */
  collection: string;

  constructor(url: string, collection: string) {
    // Client-side ceiling above Qdrant's own 5s REST timeout, so a slow-but-
    // progressing request is ended by the server, not silently by us.
    this.client = new QdrantClient({ url, timeout: 60_000 });
    this.collection = collection;
  }

  /** Point this store at a different collection (e.g. after a model switch). */
  useCollection(name: string): void {
    this.collection = name;
  }

  async healthy(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  async ensure(denseDim: number): Promise<void> {
    const existing = await this.client.getCollections();
    if (!existing.collections.some((c) => c.name === this.collection)) {
      await this.client.createCollection(this.collection, {
        vectors: { dense: { size: denseDim, distance: 'Cosine' } },
        sparse_vectors: { sparse: { modifier: 'idf' } },
        // int8-quantize the dense vectors from the start; ~4× less RAM with
        // negligible recall loss (see QUANTIZATION). Only the dense branch is
        // quantized — sparse vectors are already tiny.
        quantization_config: QUANTIZATION,
        optimizers_config: OPTIMIZERS,
      });
    }
    // Runs on existing collections too: payload fields added after a
    // collection was created (doc_status, entry_id) still need their index.
    // Re-creating an existing index is a cheap no-op for Qdrant.
    const fields: [string, 'keyword' | 'integer' | 'datetime'][] = [
      ['project', 'keyword'],
      ['source_type', 'keyword'],
      ['component', 'keyword'],
      ['session_id', 'keyword'],
      ['kind', 'keyword'],
      ['doc_status', 'keyword'],
      // Integer index so setDocStatus can address points by entry id.
      ['entry_id', 'integer'],
      // Range filtering on occurred_at works without this — Qdrant falls back to
      // a full scan — but at a measured 3.11s vs 0.087s (36x) it was far too slow
      // to expose date scoping as a normal filter. Every point already carries
      // the RFC-3339 value; only the index was missing.
      ['occurred_at', 'datetime'],
    ];
    for (const [field, schema] of fields) {
      await this.client
        .createPayloadIndex(this.collection, {
          field_name: field,
          field_schema: schema,
          wait: true,
        })
        .catch(() => {}); // already indexed
    }
  }

  /**
   * Retrofit int8 quantization onto the active collection in place — no
   * re-embed. Qdrant re-optimizes segments from the fp32 vectors already on
   * disk; search keeps serving throughout (the operation blocks server-side
   * until current optimizations finish, but the collection stays queryable).
   * Idempotent: re-applying an identical quantization config is a no-op, so a
   * caller can guard it with a one-shot marker and never worry about reruns.
   */
  async ensureQuantized(): Promise<void> {
    await this.client.updateCollection(this.collection, {
      quantization_config: QUANTIZATION,
      optimizers_config: OPTIMIZERS,
    });
  }

  /** Every collection name Qdrant currently holds. */
  async listCollections(): Promise<string[]> {
    const r = await this.client.getCollections();
    return r.collections.map((c) => c.name);
  }

  /**
   * Delete collections we created that are neither the active one nor the
   * currently-selected embedder's collection — the dead weight a past model
   * switch leaves behind (see the dashboard's "orphaned vectors" callout).
   *
   * Guard rails, because this deletes data: only names carrying our own
   * COLLECTION_PREFIX are ever touched, and both `keep` names are always
   * spared. Everything dropped is rebuildable from Postgres, so the worst case
   * is a re-embed, never lost source data. Returns the names actually dropped.
   */
  async reclaimOrphans(keep: string[]): Promise<string[]> {
    const spare = new Set(keep.filter(Boolean));
    const dropped: string[] = [];
    for (const name of await this.listCollections()) {
      if (!name.startsWith(COLLECTION_PREFIX)) continue; // never ours → never touch
      if (spare.has(name)) continue;
      try {
        await this.client.deleteCollection(name);
        dropped.push(name);
      } catch {
        // A collection that vanished under us is already reclaimed.
      }
    }
    return dropped;
  }

  /**
   * Bulk upsert. `wait: false` on purpose: waiting forces a synchronous flush
   * per batch, which under ingest load exceeds Qdrant's REST
   * client_request_timeout (5s) and surfaces as `fetch failed`. The write is
   * still durable (accepted into the WAL); it just isn't searchable the same
   * millisecond, which no caller requires. Retried because point ids are
   * deterministic, so a replayed batch is a no-op.
   */
  /** Drop the collection if it exists. Vectors are always rebuildable. */
  async drop(): Promise<void> {
    try {
      await this.client.deleteCollection(this.collection);
    } catch {
      // Nothing to drop.
    }
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    if (!points.length) return;
    for (let i = 0; i < points.length; i += UPSERT_BATCH) {
      const slice = points.slice(i, i + UPSERT_BATCH);
      await withRetry(() =>
        this.client.upsert(this.collection, {
          wait: false,
          points: slice.map((p) => ({
            id: p.id,
            vector: {
              ...(p.dense ? { dense: p.dense } : {}),
              sparse: { indices: p.sparse.indices, values: p.sparse.values },
            },
            payload: p.payload,
          })),
        }),
      );
    }
  }

  /**
   * Flip doc_status on every chunk of the given entries, in place — no
   * re-embedding. Used when a file's archive classification changes (or the
   * parser version bumps) but its content did not.
   */
  async setDocStatus(entryIds: number[], status: 'archived' | null): Promise<void> {
    for (let i = 0; i < entryIds.length; i += 500) {
      const filter = { must: [{ key: 'entry_id', match: { any: entryIds.slice(i, i + 500) } }] };
      await withRetry(() =>
        status
          ? this.client.setPayload(this.collection, {
              payload: { doc_status: status },
              filter,
              wait: false,
            })
          : this.client.deletePayload(this.collection, { keys: ['doc_status'], filter, wait: false }),
      );
    }
  }

  /**
   * Points vs vectors: each point carries two named vectors (dense + sparse),
   * so `indexed_vectors_count` runs at roughly twice the point count. Both are
   * shown, because one of them is always the number someone expected.
   */
  async info(): Promise<{ points: number; vectors: number; segments: number } | null> {
    try {
      const r = await this.client.getCollection(this.collection);
      return {
        points: r.points_count ?? 0,
        vectors: r.indexed_vectors_count ?? 0,
        segments: r.segments_count ?? 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Every distinct `entry_id` that currently has at least one point.
   *
   * The ground truth for the coverage audit: the catalog column records what we
   * *believe* we embedded, and this is what the collection actually holds. Only
   * the id payload is fetched, so the scroll stays cheap (measured ~5-10s for
   * ~362k points); the ids are held in a Set, a few MB at this scale.
   */
  async allEntryIds(): Promise<Set<number>> {
    const seen = new Set<number>();
    let offset: unknown;
    for (;;) {
      const res = await this.client.scroll(this.collection, {
        limit: 16_000,
        with_payload: ['entry_id'],
        with_vector: false,
        ...(offset ? { offset: offset as never } : {}),
      });
      for (const p of res.points) {
        const id = (p.payload as { entry_id?: number } | null)?.entry_id;
        if (typeof id === 'number') seen.add(id);
      }
      if (!res.next_page_offset) break;
      offset = res.next_page_offset;
    }
    return seen;
  }

  async count(): Promise<number> {
    try {
      const r = await this.client.count(this.collection, { exact: false });
      return r.count;
    } catch {
      return 0;
    }
  }

  private buildFilter(filters: SearchFilters) {
    return buildQdrantFilter(filters);
  }

  /**
   * Hybrid (dense+sparse, RRF) when a dense query vector is supplied;
   * sparse-only nearest otherwise.
   */
  async query(opts: {
    dense?: number[];
    sparse: SparseVector;
    filters: SearchFilters;
    limit: number;
  }): Promise<{ entryId: number; score: number }[]> {
    const filter = this.buildFilter(opts.filters);
    const sparseQuery = { indices: opts.sparse.indices, values: opts.sparse.values };
    const perBranch = Math.max(opts.limit * 3, 30);

    // Only `entry_id` is read below — every hit is then rehydrated from
    // Postgres (SearchService.hydrate). Fetching the whole payload (project,
    // source_type, component, session_id, occurred_at…) shipped bytes the
    // caller throws away; scope it to the one field we use.
    const withPayload = ['entry_id'];
    const res = opts.dense
      ? await this.client.query(this.collection, {
          prefetch: [
            { query: opts.dense, using: 'dense', limit: perBranch, filter },
            { query: sparseQuery, using: 'sparse', limit: perBranch, filter },
          ],
          query: { fusion: 'rrf' },
          limit: opts.limit,
          with_payload: withPayload,
        })
      : await this.client.query(this.collection, {
          query: sparseQuery,
          using: 'sparse',
          limit: opts.limit,
          filter,
          with_payload: withPayload,
        });

    return res.points.map((p) => ({
      entryId: Number((p.payload as any)?.entry_id),
      score: p.score ?? 0,
    }));
  }

  /**
   * Dense branch alone, returning raw cosine similarity.
   *
   * Not a search path — nothing in the product calls this. It exists because the
   * fused `query()` above returns RRF scores, which are rank-based: `Σ 1/(k+rank)`
   * yields the same 0.75 for the top hit of a perfect match and the top hit of a
   * query with nothing relevant in the index. So no threshold on a fused score can
   * ever express "found nothing *relevant*", and there is no way to derive one
   * from the fused response either, because Qdrant reports no per-branch score.
   *
   * Cosine is comparable across queries, which is what a calibrated relevance
   * signal needs. This returns it so the evaluation harness can measure whether
   * it actually separates answerable questions from unanswerable ones, before any
   * product surface commits to a number.
   */
  async queryDense(opts: {
    dense: number[];
    filters: SearchFilters;
    limit: number;
  }): Promise<{ entryId: number; score: number }[]> {
    const res = await this.client.query(this.collection, {
      query: opts.dense,
      using: 'dense',
      limit: opts.limit,
      filter: this.buildFilter(opts.filters),
      with_payload: ['entry_id'],
    });
    return res.points.map((p) => ({
      entryId: Number((p.payload as any)?.entry_id),
      score: p.score ?? 0,
    }));
  }
}
