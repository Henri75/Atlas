import { QdrantClient } from '@qdrant/js-client-rest';
import type { SearchFilters } from './types.js';
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
    occurred_at?: string;
  };
}

export function collectionNameFor(provider: string, model: string, dim: number): string {
  const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `kdbscope_${safe(provider)}_${safe(model)}_${dim}`;
}

/**
 * Translate search filters into a Qdrant payload filter. An over-broad filter
 * silently returns the wrong rows and an over-narrow one silently returns
 * none, so this is worth testing on its own.
 */
export function buildQdrantFilter(filters: SearchFilters): { must: object[] } | undefined {
  const must: object[] = [];
  if (filters.project) must.push({ key: 'project', match: { value: filters.project } });
  if (filters.sourceType) must.push({ key: 'source_type', match: { value: filters.sourceType } });
  if (filters.component) must.push({ key: 'component', match: { value: filters.component } });
  if (filters.kind) must.push({ key: 'kind', match: { value: filters.kind } });
  if (filters.since || filters.until) {
    must.push({
      key: 'occurred_at',
      range: {
        ...(filters.since ? { gte: filters.since } : {}),
        ...(filters.until ? { lte: filters.until } : {}),
      },
    });
  }
  return must.length ? { must } : undefined;
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
    if (existing.collections.some((c) => c.name === this.collection)) return;
    await this.client.createCollection(this.collection, {
      vectors: { dense: { size: denseDim, distance: 'Cosine' } },
      sparse_vectors: { sparse: { modifier: 'idf' } },
    });
    for (const field of ['project', 'source_type', 'component', 'session_id', 'kind'] as const) {
      await this.client.createPayloadIndex(this.collection, {
        field_name: field,
        field_schema: 'keyword',
        wait: true,
      });
    }
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

    const res = opts.dense
      ? await this.client.query(this.collection, {
          prefetch: [
            { query: opts.dense, using: 'dense', limit: perBranch, filter },
            { query: sparseQuery, using: 'sparse', limit: perBranch, filter },
          ],
          query: { fusion: 'rrf' },
          limit: opts.limit,
          with_payload: true,
        })
      : await this.client.query(this.collection, {
          query: sparseQuery,
          using: 'sparse',
          limit: opts.limit,
          filter,
          with_payload: true,
        });

    return res.points.map((p) => ({
      entryId: Number((p.payload as any)?.entry_id),
      score: p.score ?? 0,
    }));
  }
}
