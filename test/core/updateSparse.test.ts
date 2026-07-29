import { describe, expect, it } from 'vitest';
import { VectorStore } from '@atlas/core';

/**
 * `updateSparse` rewrites the sparse half of existing points in place — the
 * mechanism behind the re-tokenisation pass (`SPARSE_VERSION`).
 *
 * Its failure mode is specific and easy to get wrong: Qdrant rejects the
 * **entire batch** when any point id is unknown. So one stale id can cost 64
 * good writes, and a naive implementation that lets the rejection propagate
 * loses every remaining slice of a multi-hour pass as well. Both halves of the
 * contract are pinned here — keep going, and *report* what was lost.
 */

/** Minimal stand-in for the Qdrant client; `reject` fails those call indices. */
function fakeClient(reject: Set<number> = new Set()) {
  const calls: { id: string }[][] = [];
  return {
    calls,
    client: {
      updateVectors: async (_c: string, args: { points: { id: string }[] }) => {
        const n = calls.length;
        calls.push(args.points);
        if (reject.has(n)) throw new Error('Unprocessable Entity');
        return { status: 'acknowledged' };
      },
    },
  };
}

function storeWith(client: unknown) {
  const store = new VectorStore('http://qdrant:6333', 'c');
  (store as unknown as { client: unknown }).client = client;
  return store;
}

const points = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, sparse: { indices: [i], values: [1] } }));

describe('VectorStore.updateSparse', () => {
  it('writes only the sparse vector, leaving dense and payload alone', async () => {
    const fake = fakeClient();
    await storeWith(fake.client).updateSparse([
      { id: 'a', sparse: { indices: [7], values: [2] } },
    ]);

    expect(fake.calls[0]).toEqual([{ id: 'a', vector: { sparse: { indices: [7], values: [2] } } }]);
  });

  it('reports nothing to do for an empty input', async () => {
    const fake = fakeClient();
    expect(await storeWith(fake.client).updateSparse([])).toEqual({ updated: 0, failed: 0 });
    expect(fake.calls).toHaveLength(0);
  });

  it('keeps going past a rejected slice and counts what it lost', async () => {
    // 1536 points = three slices of SPARSE_UPDATE_BATCH; the middle is rejected.
    // withRetry gives a non-retryable error one attempt, so calls are 0,1,2.
    const fake = fakeClient(new Set([1]));

    const r = await storeWith(fake.client).updateSparse(points(1536));

    // The third slice must still have been attempted — that is the whole point.
    expect(fake.calls).toHaveLength(3);
    expect(r).toEqual({ updated: 1024, failed: 512 });
  });

  it('never silently under-reports: updated + failed covers every point', async () => {
    const fake = fakeClient(new Set([0, 2]));
    const r = await storeWith(fake.client).updateSparse(points(1536));
    expect(r.updated + r.failed).toBe(1536);
  });
});
