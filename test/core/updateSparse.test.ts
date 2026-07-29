import { describe, expect, it } from 'vitest';
import { VectorStore } from '@atlas/core';

/**
 * `updateSparse` rewrites the sparse half of existing points in place — the
 * mechanism behind the re-tokenisation pass (`SPARSE_VERSION`).
 *
 * Its failure mode is specific and easy to get wrong: Qdrant rejects the
 * **entire batch** when any point id is unknown, and says nothing about which
 * id was at fault. Three properties are pinned here — keep going past a
 * rejection, bisect it down to the actual bad ids, and *report* them by name.
 */

/** Stand-in that fails a call by its index. Used only where ids are irrelevant. */
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
    expect(await storeWith(fake.client).updateSparse([])).toEqual({
      updated: 0,
      failed: 0,
      failedIds: [],
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('keeps going past a rejected slice', async () => {
    // 1536 points spans three slices of SPARSE_UPDATE_BATCH; one bad id sits in
    // the middle one. The slices after it must still be written — losing hours
    // of a pass to one stale point is the failure this guards.
    const fake = rejectingClient(new Set(['p700']));

    const r = await storeWith(fake.client).updateSparse(points(1536));

    expect(r.updated).toBe(1535);
    expect(r.failedIds).toEqual(['p700']);
    // p1200 lives in the third slice, after the rejection.
    expect(fake.calls.flat().some((p) => p.id === 'p1200')).toBe(true);
  });

  it('never silently under-reports: updated + failed covers every point', async () => {
    const fake = rejectingClient(new Set(['p0', 'p1000']));
    const r = await storeWith(fake.client).updateSparse(points(1536));
    expect(r.updated + r.failed).toBe(1536);
  });
});

/**
 * Qdrant rejects an update batch outright when it contains an id it does not
 * hold — it does not skip the offender. So one stale id used to cost every good
 * point beside it. Measured 2026-07-29: entry 7707 was missing one of its five
 * chunk points, and that single point failed a 250-point batch on every repair
 * pass, twice, before a per-entry run isolated it by hand.
 *
 * Bisecting does that automatically: halve the rejected slice until the bad ids
 * are alone, write everything else, and name them.
 */
function rejectingClient(bad: Set<string>) {
  const calls: { id: string }[][] = [];
  return {
    calls,
    client: {
      updateVectors: async (_c: string, args: { points: { id: string }[] }) => {
        calls.push(args.points);
        if (args.points.some((p) => bad.has(p.id))) throw new Error('Unprocessable Entity');
        return { status: 'acknowledged' };
      },
    },
  };
}

describe('VectorStore.updateSparse bisection', () => {
  it('salvages every good point in a rejected slice and names the bad one', async () => {
    const fake = rejectingClient(new Set(['p5']));

    const r = await storeWith(fake.client).updateSparse(points(8));

    expect(r.updated).toBe(7);
    expect(r.failed).toBe(1);
    expect(r.failedIds).toEqual(['p5']);
  });

  it('isolates several bad ids in one slice', async () => {
    const fake = rejectingClient(new Set(['p1', 'p6']));

    const r = await storeWith(fake.client).updateSparse(points(8));

    expect(r.updated).toBe(6);
    expect([...r.failedIds].sort()).toEqual(['p1', 'p6']);
  });

  it('gives up on a single point rather than recursing forever', async () => {
    const fake = rejectingClient(new Set(['p0']));

    const r = await storeWith(fake.client).updateSparse(points(1));

    expect(r).toEqual({ updated: 0, failed: 1, failedIds: ['p0'] });
  });

  it('does not bisect when the whole slice succeeds', async () => {
    const fake = rejectingClient(new Set());

    const r = await storeWith(fake.client).updateSparse(points(8));

    // One call, not a bisection tree: the happy path must stay one round trip.
    expect(fake.calls).toHaveLength(1);
    expect(r).toEqual({ updated: 8, failed: 0, failedIds: [] });
  });
});
