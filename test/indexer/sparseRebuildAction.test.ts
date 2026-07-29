import { describe, expect, it } from 'vitest';
import {
  INDEXING_SUSPENDED,
  restoreIndexingThreshold,
  sparseRebuildAction,
} from '../../packages/indexer/src/pipeline.js';

/**
 * The decision that governs whether stored sparse vectors get re-tokenised.
 *
 * Worth pinning because every wrong answer here is invisible. Stamping the
 * version without rewriting leaves query tokens and document tokens disagreeing:
 * keyword search does not error, it just quietly stops matching, and the stamp
 * guarantees nothing will ever run the pass again to fix it.
 *
 * That is not hypothetical — it is what the first version of this branch did on
 * the 2026-07-29 boot, treating a 111-entry repair as proof that all 326,606
 * entries had been rewritten.
 */
const base = {
  storedVersion: 1,
  currentVersion: 2,
  uncovered: 0,
  totalEntries: 326_606,
  backfilled: false,
  enabled: true,
};

describe('sparseRebuildAction', () => {
  it('does nothing when the collection is already at the current version', () => {
    expect(sparseRebuildAction({ ...base, storedVersion: 2 })).toBe('none');
  });

  it('rebuilds when the version moved and no backfill ran', () => {
    expect(sparseRebuildAction(base)).toBe('rebuild');
  });

  /** The regression. A partial repair is not a rewrite of the collection. */
  it('rebuilds after a partial backfill, however large the version gap', () => {
    expect(sparseRebuildAction({ ...base, backfilled: true, uncovered: 111 })).toBe('rebuild');
  });

  it('only stamps when the backfill covered every entry', () => {
    // A model switch: the collection name encodes the dimension, so every row's
    // vectorized_in goes stale at once and the backfill genuinely rewrites all.
    expect(
      sparseRebuildAction({ ...base, backfilled: true, uncovered: 326_606 }),
    ).toBe('stamp');
  });

  it('does not stamp an empty catalog, where "all covered" is vacuous', () => {
    expect(
      sparseRebuildAction({ ...base, backfilled: true, uncovered: 0, totalEntries: 0 }),
    ).toBe('rebuild');
  });

  it('reports the operator kill switch rather than silently doing nothing', () => {
    expect(sparseRebuildAction({ ...base, enabled: false })).toBe('skipped');
  });

  it('lets a completed version win over the kill switch', () => {
    // Nothing to do is nothing to do; this must not read as "skipped" and warn
    // on every boot forever.
    expect(sparseRebuildAction({ ...base, storedVersion: 2, enabled: false })).toBe('none');
  });
});

/**
 * HNSW building is suspended for the duration of a re-tokenise pass, because
 * writing to every segment otherwise makes Qdrant re-optimise each one and — on
 * the 2026-07-29 run — held segment locks until the update queue stopped
 * draining, stranding 4,070 operations in the WAL.
 *
 * The restore has to survive a kill, not just an exception: `finally` never runs
 * for SIGKILL, and a collection left unindexed serves every dense query by exact
 * scan, correctly and silently, forever.
 */
describe('restoreIndexingThreshold', () => {
  function deps(suspended: string | null, collection = 'c1') {
    const settings = new Map<string, string>();
    if (suspended !== null) settings.set(INDEXING_SUSPENDED, suspended);
    const calls: (number | null)[] = [];
    return {
      calls,
      settings,
      deps: {
        catalog: {
          getSetting: async (k: string) => settings.get(k) ?? null,
          setSetting: async (k: string, v: string) => void settings.set(k, v),
        },
        vectors: {
          collection,
          setIndexingThreshold: async (t: number | null) => void calls.push(t),
        },
      } as never,
    };
  }

  it('restores and clears the marker after an interrupted rebuild', async () => {
    const d = deps('c1');
    expect(await restoreIndexingThreshold(d.deps)).toBe(true);
    expect(d.calls).toEqual([null]);
    expect(d.settings.get(INDEXING_SUSPENDED)).toBe('');
  });

  it('does nothing when no rebuild was interrupted', async () => {
    const d = deps(null);
    expect(await restoreIndexingThreshold(d.deps)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  it('ignores a marker left by a different collection', async () => {
    // A model switch moved us to a new collection; the old one's suspension is
    // not ours to undo, and undoing it here would touch a collection we are not
    // serving from.
    const d = deps('c-old', 'c1');
    expect(await restoreIndexingThreshold(d.deps)).toBe(false);
    expect(d.calls).toEqual([]);
  });
});
