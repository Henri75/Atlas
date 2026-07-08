import { QdrantClient } from '@qdrant/js-client-rest';
import type { SearchFilters } from './types.js';
import type { SparseVector } from './sparse.js';

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
    occurred_at?: string;
  };
}

export function collectionNameFor(provider: string, model: string, dim: number): string {
  const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `kdbscope_${safe(provider)}_${safe(model)}_${dim}`;
}

export class VectorStore {
  private client: QdrantClient;

  constructor(
    url: string,
    readonly collection: string,
  ) {
    this.client = new QdrantClient({ url });
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
    for (const field of ['project', 'source_type', 'component', 'session_id'] as const) {
      await this.client.createPayloadIndex(this.collection, {
        field_name: field,
        field_schema: 'keyword',
        wait: true,
      });
    }
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    if (!points.length) return;
    await this.client.upsert(this.collection, {
      wait: true,
      points: points.map((p) => ({
        id: p.id,
        vector: {
          ...(p.dense ? { dense: p.dense } : {}),
          sparse: { indices: p.sparse.indices, values: p.sparse.values },
        },
        payload: p.payload,
      })),
    });
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
    const must: object[] = [];
    if (filters.project) must.push({ key: 'project', match: { value: filters.project } });
    if (filters.sourceType) must.push({ key: 'source_type', match: { value: filters.sourceType } });
    if (filters.component) must.push({ key: 'component', match: { value: filters.component } });
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
