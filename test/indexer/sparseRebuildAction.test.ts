import { describe, expect, it } from 'vitest';
import { sparseRebuildAction } from '../../packages/indexer/src/pipeline.js';

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
