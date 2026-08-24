import { readFileSync } from 'node:fs';
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

/**
 * @param livePayloadSchema what `getCollection` reports the collection already
 *   indexes. `undefined` means "the call fails", which is a real case the
 *   reaper has to survive — not the same thing as an empty schema.
 */
function fakeClient(livePayloadSchema?: Record<string, unknown>) {
  const calls: Record<string, Call[]> = {
    createCollection: [],
    updateCollection: [],
    createPayloadIndex: [],
    deletePayloadIndex: [],
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
      getCollection: async () => {
        if (livePayloadSchema === undefined) throw new Error('unreachable');
        return { payload_schema: livePayloadSchema };
      },
      createCollection: record('createCollection', true),
      updateCollection: record('updateCollection', true),
      createPayloadIndex: record('createPayloadIndex', {}),
      // The real client takes (collection, fieldName, opts) — a positional
      // third arg, not the (collection, args) shape everything else uses.
      deletePayloadIndex: async (collection: string, field: string, opts?: unknown) => {
        calls.deletePayloadIndex!.push({ collection, args: { field, opts } });
        return {};
      },
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
  /**
   * `max_segment_size` is in KILOBYTES against a 256-dim reference vector —
   * "1Kb = 1 vector of size 256" — so the vector count it buys is
   * `max_segment_size / (dim / 256)`, which is dimension-dependent.
   *
   * It read 64_000 with the comment "~64k vectors per segment" until
   * 2026-08-14. At 768 dimensions that bought ~21.3k, a third of the intent,
   * and the collection ran at 23 segments instead of ~8. That is expensive in
   * a way segment count usually is not: each indexed field's null-index
   * allocates two FIXED 1 MiB `flags_a.dat` mmaps per segment regardless of how
   * few points it holds, so 8 fields x 23 segments = 385.9 MB of padding —
   * measured 64% of the whole 600.2 MB payload index on the live store.
   *
   * Asserted as the DERIVATION rather than the literal, so it fails if the
   * embedding dimension moves and the constant is carried over unchanged.
   */
  it('sizes segments in KB-of-256-dim-vectors, not in vectors', async () => {
    const INTENDED_VECTORS_PER_SEGMENT = 64_000;
    const dim = 768;
    const fake = fakeClient();
    await storeWith(fake.client).ensure(dim);

    const args = fake.calls.createCollection[0]!.args as {
      optimizers_config: { max_segment_size: number };
    };
    expect(args.optimizers_config.max_segment_size).toBe(
      INTENDED_VECTORS_PER_SEGMENT * (dim / 256),
    );
  });
  /**
   * An index is only worth its cost if something filters on it.
   *
   * `session_id` was indexed from the day the collection was created and never
   * appeared in a single filter — the only mention of it in the repo was the
   * line that created it. Measured 2026-08-14 on the live store: 79.7 MB, being
   * 31.5 MB of real index plus 48.2 MB of fixed null-index padding (two 1 MiB
   * flags_a.dat mmaps per segment), i.e. 13% of a 600.2 MB payload index spent
   * answering a question nothing asks.
   *
   * Asserted as a BINDING against the filter builder in the same module, not as
   * a hand-copied list: adding an index nothing queries has to fail here rather
   * than quietly cost RAM. Only one direction — filtering without an index is a
   * legitimate choice, Qdrant just full-scans.
   */
  it('indexes only fields the filter builder can actually query', async () => {
    const src = readFileSync(
      new URL('../../packages/core/src/qdrant.ts', import.meta.url),
      'utf8',
    );
    const filtered = new Set([...src.matchAll(/key:\s*'([\w.]+)'/g)].map((m) => m[1]!));
    expect(filtered.size).toBeGreaterThan(0); // the regex, not the schema, if this trips

    const fake = fakeClient({});
    await storeWith(fake.client).ensure(768);
    const indexed = fake.calls.createPayloadIndex.map(
      (c) => (c.args as { field_name: string }).field_name,
    );
    expect(indexed.length).toBeGreaterThan(0);

    const unused = indexed.filter((f) => !filtered.has(f));
    expect(unused).toEqual([]);
    // The specific regression: it must not come back.
    expect(indexed).not.toContain('session_id');

    // 'machine' is the opposite shape from session_id: filtered but
    // DELIBERATELY not indexed. It is two-valued today (self vs one remote)
    // and low-selectivity — exactly the per-segment null-index padding cost
    // the 2026-08-14 payload-index work (max_segment_size KB-vs-vectors, see
    // OPTIMIZERS above) paid down. `indexed ⊆ filtered` still holds; this is
    // the other direction, which the guard test never enforces.
    expect(filtered.has('machine')).toBe(true);
    expect(indexed).not.toContain('machine');
  });

  it('reaps a live index that is no longer wanted, and keeps the ones that are', async () => {
    const fake = fakeClient({
      project: { data_type: 'keyword' },
      entry_id: { data_type: 'integer' },
      session_id: { data_type: 'keyword' }, // dropped from PAYLOAD_INDEXES
    });
    const dropped = await storeWith(fake.client).dropUnusedPayloadIndexes();

    expect(dropped).toEqual(['session_id']);
    expect(fake.calls.deletePayloadIndex.map((c) => (c.args as { field: string }).field)).toEqual([
      'session_id',
    ]);
  });

  it('reaps nothing when the schema cannot be read', async () => {
    // `undefined` makes getCollection throw. A failed read and a collection
    // with no indexes must NOT be treated alike — deleting on a misread is the
    // one outcome worth engineering against.
    const fake = fakeClient(undefined);
    expect(await storeWith(fake.client).dropUnusedPayloadIndexes()).toEqual([]);
    expect(fake.calls.deletePayloadIndex).toEqual([]);
  });

  it('reaps nothing when the collection reports no indexes at all', async () => {
    const fake = fakeClient({});
    expect(await storeWith(fake.client).dropUnusedPayloadIndexes()).toEqual([]);
    expect(fake.calls.deletePayloadIndex).toEqual([]);
  });

  it('retrofit runs the reaper, so a stale index cannot outlive the marker bump', async () => {
    const fake = fakeClient({ project: { data_type: 'keyword' }, session_id: { data_type: 'keyword' } });
    await storeWith(fake.client).ensureStorageLayout();
    expect(fake.calls.deletePayloadIndex.map((c) => (c.args as { field: string }).field)).toEqual([
      'session_id',
    ]);
  });
});
