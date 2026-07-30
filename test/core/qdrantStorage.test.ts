import { describe, expect, it } from 'vitest';
import { VectorStore } from '@atlas/core';

/**
 * Where Qdrant keeps each copy of a vector, and what it does with them at
 * search time.
 *
 * Both properties pinned here have already failed once in production, and both
 * failed *silently* — nothing errored, nothing was logged, and the dashboard
 * looked fine. That is what makes them worth a test rather than a comment:
 *
 *  1. `always_ram` on the quantization config was read as "originals go to
 *     disk". It never meant that. The originals stayed in RAM alongside the
 *     int8 copy, and the collection carried both for two weeks.
 *  2. Qdrant's default for `rescore` flips to OFF once the originals are on
 *     disk, handing back recall to save a disk read. Nothing announces it;
 *     measured recall@10 against an exact scan fell 0.992 → 0.956.
 *
 * A search that returns slightly worse results is invisible without ground
 * truth, so these assertions are on the *request*, which is checkable here.
 */

type Call = { collection: string; args: Record<string, unknown> };

function fakeClient() {
  const calls: Record<string, Call[]> = {
    createCollection: [],
    updateCollection: [],
    query: [],
  };
  const record =
    (name: string, result: unknown = { points: [] }) =>
    async (collection: string, args: Record<string, unknown>) => {
      calls[name]!.push({ collection, args });
      return result;
    };
  return {
    calls,
    client: {
      getCollections: async () => ({ collections: [] as { name: string }[] }),
      createCollection: record('createCollection', true),
      updateCollection: record('updateCollection', true),
      createPayloadIndex: async () => ({}),
      query: record('query', { points: [] }),
    },
  };
}

function storeWith(client: unknown) {
  const store = new VectorStore('http://qdrant:6333', 'c');
  (store as unknown as { client: unknown }).client = client;
  return store;
}

describe('VectorStore storage layout', () => {
  it('creates collections with the fp32 originals on disk', async () => {
    const fake = fakeClient();
    await storeWith(fake.client).ensure(768);

    const args = fake.calls.createCollection[0]!.args as {
      vectors: { dense: { size: number; distance: string; on_disk: boolean } };
    };
    expect(args.vectors.dense.on_disk).toBe(true);
    // The dimension and metric must survive being spread alongside on_disk.
    expect(args.vectors.dense.size).toBe(768);
    expect(args.vectors.dense.distance).toBe('Cosine');
  });

  it('creates collections with the sparse index on disk, keeping IDF', async () => {
    const fake = fakeClient();
    await storeWith(fake.client).ensure(768);

    const args = fake.calls.createCollection[0]!.args as {
      sparse_vectors: { sparse: { modifier: string; index: { on_disk: boolean } } };
    };
    expect(args.sparse_vectors.sparse.index.on_disk).toBe(true);
    // Dropping the modifier would turn off server-side IDF and silently
    // re-rank every keyword result.
    expect(args.sparse_vectors.sparse.modifier).toBe('idf');
  });

  it('keeps the quantized copy in RAM — that is what pays for the disk move', async () => {
    const fake = fakeClient();
    await storeWith(fake.client).ensure(768);

    const args = fake.calls.createCollection[0]!.args as {
      quantization_config: { scalar: { type: string; always_ram: boolean } };
    };
    expect(args.quantization_config.scalar.type).toBe('int8');
    expect(args.quantization_config.scalar.always_ram).toBe(true);
  });

  it('retrofits on_disk onto an existing collection, not just quantization', async () => {
    const fake = fakeClient();
    await storeWith(fake.client).ensureStorageLayout();

    const args = fake.calls.updateCollection[0]!.args as {
      vectors: { dense: { on_disk: boolean } };
      sparse_vectors: { sparse: { modifier: string; index: { on_disk: boolean } } };
      quantization_config: unknown;
      optimizers_config: { max_optimization_threads: number };
    };
    // The whole point of the v2 marker: a collection already carrying
    // quantization still needs these two.
    expect(args.vectors.dense.on_disk).toBe(true);
    expect(args.sparse_vectors.sparse.index.on_disk).toBe(true);
    expect(args.sparse_vectors.sparse.modifier).toBe('idf');
    expect(args.quantization_config).toBeDefined();
    expect(args.optimizers_config.max_optimization_threads).toBe(2);
  });
});

describe('VectorStore search params', () => {
  const sparse = { indices: [1, 2], values: [0.5, 0.5] };

  it('asks for rescoring on the dense branch of a hybrid query', async () => {
    const fake = fakeClient();
    await storeWith(fake.client).query({ dense: [0.1, 0.2], sparse, filters: {}, limit: 10 });

    const args = fake.calls.query[0]!.args as {
      prefetch: { using: string; params?: { quantization?: { rescore?: boolean } } }[];
    };
    const denseBranch = args.prefetch.find((p) => p.using === 'dense');
    expect(denseBranch?.params?.quantization?.rescore).toBe(true);
  });

  it('does not put quantization params on the sparse branch', async () => {
    const fake = fakeClient();
    await storeWith(fake.client).query({ dense: [0.1, 0.2], sparse, filters: {}, limit: 10 });

    const args = fake.calls.query[0]!.args as {
      prefetch: { using: string; params?: unknown }[];
    };
    // Sparse vectors are not quantized; the knob is meaningless there and
    // asking for it would be a lie about what the branch does.
    expect(args.prefetch.find((p) => p.using === 'sparse')?.params).toBeUndefined();
  });

  it('asks for rescoring on the raw-cosine path', async () => {
    const fake = fakeClient();
    await storeWith(fake.client).queryDense({ dense: [0.1, 0.2], filters: {}, limit: 10 });

    const args = fake.calls.query[0]!.args as {
      params?: { quantization?: { rescore?: boolean } };
    };
    // Without this the returned score is the distance to the int8
    // approximation, which is not the calibrated signal this path promises.
    expect(args.params?.quantization?.rescore).toBe(true);
  });

  it('leaves the sparse-only path alone when there is no dense vector', async () => {
    const fake = fakeClient();
    await storeWith(fake.client).query({ sparse, filters: {}, limit: 10 });

    const args = fake.calls.query[0]!.args as { using?: string; params?: unknown };
    expect(args.using).toBe('sparse');
    expect(args.params).toBeUndefined();
  });
});
