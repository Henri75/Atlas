import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '@atlas/core';
import { backfillVectors, needsBackfill } from '../../packages/indexer/src/pipeline.js';

/**
 * Regression: this used to compare Qdrant points to catalog entries — different
 * units — so it could never fire. On 2026-07-25 the collection held 361,941
 * points for 323,176 entries while 39 entries, including two whole documents,
 * had no vectors at all and were silently unsearchable.
 */
describe('needsBackfill', () => {
  it('fires whenever any entry is not searchable in the active collection', () => {
    expect(needsBackfill(1)).toBe(true);
    expect(needsBackfill(39)).toBe(true); // the 2026-07-25 incident
    expect(needsBackfill(70135)).toBe(true); // fresh collection after a model switch
  });

  it('does not fire when coverage is complete', () => {
    expect(needsBackfill(0)).toBe(false);
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
  const settings = new Map<string, string>();
  /** entry id -> collection it is embedded in. */
  const covered = new Map<number, string>();
  return {
    rows,
    upserted,
    errors,
    settings,
    covered,
    deps: {
      catalog: {
        countUncovered: async (c: string) =>
          rows.filter((r) => covered.get(r.id) !== c).length,
        uncoveredEntriesAfter: async (c: string, cursor: number, limit: number) =>
          rows.filter((r) => covered.get(r.id) !== c && r.id > cursor).slice(0, limit),
        // indexEntries marks coverage as each entry's final chunk lands.
        markVectorized: vi.fn(async (ids: number[], c: string) => {
          for (const id of ids) covered.set(id, c);
        }),
        logError: vi.fn(async (...a: any[]) => void errors.push(a)),
        getSetting: async (k: string) => settings.get(k) ?? null,
        setSetting: async (k: string, v: string) => void settings.set(k, v),
      } as any,
      vectors: {
        collection: 'kdbscope_ollama_nomic_768',
        upsert: vi.fn(async (p: any[]) => void upserted.push(...p)),
      } as any,
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
  it('pages through every uncovered entry and upserts each one exactly once', async () => {
    const { deps, upserted } = makeDeps(75);
    const n = await backfillVectors(deps, { pageSize: 20 });

    expect(n).toBe(75);
    expect(upserted).toHaveLength(75);
    const ids = upserted.map((p) => p.payload.entry_id);
    expect(new Set(ids).size).toBe(75);
  });

  it('reports progress against the uncovered total', async () => {
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

  it('is a no-op once every entry is covered', async () => {
    const { deps, upserted } = makeDeps(30);
    await backfillVectors(deps, { pageSize: 10 });
    upserted.length = 0;

    // Second run: coverage is complete, so nothing is re-embedded.
    expect(await backfillVectors(deps, { pageSize: 10 })).toBe(0);
    expect(upserted).toHaveLength(0);
  });

  /**
   * Resumption comes from `vectorized_in`, not a stored cursor: an interrupted
   * run simply re-selects whatever is still uncovered. Previously a persisted
   * `backfill_cursor` could disagree with the actual state of the collection.
   */
  it('resumes by re-selecting uncovered entries, not from a stored cursor', async () => {
    const { deps, upserted, covered } = makeDeps(30);
    for (let id = 1; id <= 20; id++) covered.set(id, 'kdbscope_ollama_nomic_768');

    const embedded = await backfillVectors(deps, { pageSize: 10 });

    expect(embedded).toBe(10); // only 21..30
    expect(upserted.map((p) => p.payload.entry_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => 21 + i),
    );
  });

  it('consults no stored cursor setting at all', async () => {
    const { deps, settings } = makeDeps(30);
    settings.set('backfill_cursor:kdbscope_ollama_nomic_768', '20');

    // The stale setting must not shorten the run, and none is written back.
    expect(await backfillVectors(deps, { pageSize: 10 })).toBe(30);
    expect([...settings.keys()]).toEqual(['backfill_cursor:kdbscope_ollama_nomic_768']);
  });

  /**
   * The regression test for the design flaw caught in self-review: a
   * `vectorized_at` timestamp would report these rows as covered against a
   * brand-new empty collection, so the rebuild after a model switch would
   * silently never run.
   */
  it('treats entries embedded in another collection as uncovered', async () => {
    const { deps, upserted, covered } = makeDeps(30);
    for (let id = 1; id <= 30; id++) covered.set(id, 'kdbscope_some_other_model_1024');

    expect(await backfillVectors(deps, { pageSize: 10 })).toBe(30);
    expect(upserted).toHaveLength(30);
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

  /**
   * The periodic reconciler shares the embedder with live scanning, and a local
   * Ollama serves one request at a time (~1.9s each, measured). An uncapped run
   * after a model switch would occupy it for hours, so routine reconciliation is
   * bounded and large rebuilds stay the boot path's job.
   */
  it('stops at maxEntries and leaves the rest for the next run', async () => {
    const { deps, upserted, covered } = makeDeps(100);

    const n = await backfillVectors(deps, { pageSize: 10, maxEntries: 25 });

    expect(n).toBe(25);
    expect(upserted).toHaveLength(25);
    // The remainder is untouched and still selectable next time.
    expect(await deps.catalog.countUncovered('kdbscope_ollama_nomic_768')).toBe(75);
    expect(covered.size).toBe(25);
  });

  it('does not overshoot maxEntries when it is not a multiple of the page size', async () => {
    const { deps, upserted } = makeDeps(100);
    const n = await backfillVectors(deps, { pageSize: 30, maxEntries: 25 });
    expect(n).toBe(25);
    expect(upserted).toHaveLength(25);
  });

  it('treats maxEntries larger than the backlog as no cap', async () => {
    const { deps } = makeDeps(20);
    expect(await backfillVectors(deps, { pageSize: 10, maxEntries: 500 })).toBe(20);
  });

  it('leaves a failed page uncovered so the next run retries it', async () => {
    const { deps, covered } = makeDeps(30);
    let call = 0;
    (deps.embedder.embed as any) = vi.fn(async (t: string[]) => {
      if (++call === 1) throw new HttpError('invalid vector dimension', 400);
      return t.map(() => [1, 2, 3]);
    });

    await backfillVectors(deps, { pageSize: 10 });

    // Entries 1..10 failed and must still be pending, unlike the old cursor
    // behaviour which skipped past them until a full rebuild.
    for (let id = 1; id <= 10; id++) expect(covered.has(id)).toBe(false);
    expect(await deps.catalog.countUncovered('kdbscope_ollama_nomic_768')).toBe(10);
  });
});
