import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '@kdbscope/core';
import { backfillVectors, needsBackfill } from '../../packages/indexer/src/pipeline.js';

/**
 * Regression: the trigger originally required an *empty* collection, so a
 * backfill that died partway (leaving 1,886 of 70,135 vectors) was never
 * retried — the collection stayed permanently under-populated.
 */
describe('needsBackfill', () => {
  it('fires when the collection has fewer vectors than the catalog has entries', () => {
    expect(needsBackfill(0, 70135)).toBe(true);
    expect(needsBackfill(1886, 70135)).toBe(true); // resumed after a crash
  });

  it('does not fire for a fresh install or a fully populated collection', () => {
    expect(needsBackfill(0, 0)).toBe(false);
    expect(needsBackfill(94744, 70135)).toBe(false); // chunks >= entries
    expect(needsBackfill(70135, 70135)).toBe(false);
  });
});

/**
 * Backfill exists because switching the embedding model creates a new,
 * empty Qdrant collection while the catalog still holds every entry. Dedup
 * keys stop a normal scan from re-emitting them, so vectors must be rebuilt
 * from Postgres rather than by re-parsing the sources.
 */
function makeDeps(totalEntries: number) {
  const rows = Array.from({ length: totalEntries }, (_, i) => ({
    id: i + 1,
    projectSlug: 'deepcast',
    sourceType: 'kdb_changelog' as const,
    title: `entry ${i + 1}`,
    body: 'short body',
    sourcePath: '/x.log',
  }));
  const upserted: any[] = [];
  const errors: any[] = [];
  return {
    rows,
    upserted,
    errors,
    deps: {
      catalog: {
        countEntries: async () => totalEntries,
        entriesAfter: async (cursor: number, limit: number) =>
          rows.filter((r) => r.id > cursor).slice(0, limit),
        logError: vi.fn(async (...a: any[]) => void errors.push(a)),
      } as any,
      vectors: { upsert: vi.fn(async (p: any[]) => void upserted.push(...p)) } as any,
      embedder: {
        name: 'ollama',
        model: 'nomic',
        dim: 3,
        embed: vi.fn(async (t: string[]) => t.map(() => [1, 2, 3])),
      },
    },
  };
}

describe('backfillVectors', () => {
  it('pages through every entry and upserts each one exactly once', async () => {
    const { deps, upserted } = makeDeps(75);
    const n = await backfillVectors(deps, { pageSize: 20 });

    expect(n).toBe(75);
    expect(upserted).toHaveLength(75);
    const ids = upserted.map((p) => p.payload.entry_id);
    expect(new Set(ids).size).toBe(75);
  });

  it('reports progress against the total', async () => {
    const { deps } = makeDeps(50);
    const seen: [number, number][] = [];
    await backfillVectors(deps, { pageSize: 20, onPage: (d, t) => void seen.push([d, t]) });

    expect(seen.map(([d]) => d)).toEqual([20, 40, 50]);
    expect(seen.every(([, t]) => t === 50)).toBe(true);
  });

  it('advances the keyset cursor so it terminates', async () => {
    const { deps } = makeDeps(5);
    await expect(backfillVectors(deps, { pageSize: 2 })).resolves.toBe(5);
  });

  it('does nothing when the catalog is empty', async () => {
    const { deps, upserted } = makeDeps(0);
    expect(await backfillVectors(deps)).toBe(0);
    expect(upserted).toHaveLength(0);
  });

  /**
   * A single bad page must not abandon a multi-hour re-embed; it is logged
   * and the run continues from the next cursor.
   */
  it('logs and skips a page that fails, then keeps going', async () => {
    const { deps, errors, upserted } = makeDeps(30);
    let call = 0;
    (deps.embedder.embed as any) = vi.fn(async (t: string[]) => {
      // Permanent error: exhausts no retries, so the page fails immediately.
      if (++call === 1) throw new HttpError('invalid vector dimension', 400);
      return t.map(() => [1, 2, 3]);
    });

    const n = await backfillVectors(deps, { pageSize: 10 });

    expect(n).toBe(30); // all pages visited
    expect(errors).toHaveLength(1);
    expect(errors[0][2]).toBe('backfill');
    // The two healthy pages still landed.
    expect(upserted).toHaveLength(20);
  });
});
