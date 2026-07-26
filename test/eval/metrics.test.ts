import { describe, expect, it } from 'vitest';
import {
  bootstrapCI,
  dcg,
  hitAt,
  mean,
  ndcgAt,
  paired,
  precisionAt,
  quadraticWeightedKappa,
  recallAt,
  reciprocalRank,
  shuffle,
} from '@atlas/eval/metrics.js';
import type { Grade } from '@atlas/eval/metrics.js';

/**
 * These numbers decide whether a ranking change ships, so they are checked
 * against arithmetic worked out by hand rather than against whatever the
 * implementation happened to return first.
 */

describe('dcg', () => {
  it('leaves rank 1 undiscounted and halves nothing else by accident', () => {
    // log2(2)=1, log2(3)≈1.585, log2(4)=2
    expect(dcg([3])).toBeCloseTo(3, 10);
    expect(dcg([3, 3])).toBeCloseTo(3 + 3 / Math.log2(3), 10);
    expect(dcg([0, 0, 2])).toBeCloseTo(2 / 2, 10);
  });

  it('is zero for an all-irrelevant list', () => {
    expect(dcg([0, 0, 0])).toBe(0);
  });
});

describe('ndcgAt', () => {
  it('is 1.0 when the ranking is already ideal', () => {
    expect(ndcgAt([3, 2, 1], [3, 2, 1], 10)).toBeCloseTo(1, 10);
  });

  it('penalises burying the best hit', () => {
    // Same gains, worse order: 1/1 + 3/1.585 = 2.893 over ideal 3 + 1/1.585.
    const ideal = 3 + 1 / Math.log2(3);
    expect(ndcgAt([1, 3], [3, 1], 10)).toBeCloseTo((1 + 3 / Math.log2(3)) / ideal, 10);
  });

  it('measures against the best achievable order, not the list handed in', () => {
    // Two relevant entries exist but only one was retrieved: nDCG must fall short
    // of 1.0 even though the retrieved item is at rank 1.
    expect(ndcgAt([3], [3, 3], 10)!).toBeLessThan(1);
  });

  it('truncates the ideal to k, so a short window is not punished twice', () => {
    // At k=1 the ideal is a single grade-3 hit; retrieving it scores a clean 1.0.
    expect(ndcgAt([3, 0, 0], [3, 3, 3], 1)).toBeCloseTo(1, 10);
  });

  it('handles a list shorter than k', () => {
    expect(ndcgAt([3], [3], 10)).toBeCloseTo(1, 10);
  });

  /**
   * A query with nothing relevant returns null rather than 0. Averaging a
   * fabricated zero would drag every variant down identically while hiding how
   * many queries the harness cannot actually speak to.
   */
  it('returns null when nothing relevant was judged', () => {
    expect(ndcgAt([0, 0], [0, 0, 0], 10)).toBeNull();
    expect(ndcgAt([], [], 10)).toBeNull();
  });
});

describe('recallAt / precisionAt', () => {
  const relevant = new Set([10, 20, 30]);

  it('counts relevant entries found within the window', () => {
    expect(recallAt([10, 99, 20], relevant, 30)).toBeCloseTo(2 / 3, 10);
    expect(recallAt([99, 98], relevant, 30)).toBe(0);
  });

  it('respects the cutoff', () => {
    expect(recallAt([99, 98, 97, 10], relevant, 3)).toBe(0);
    expect(recallAt([99, 98, 97, 10], relevant, 4)).toBeCloseTo(1 / 3, 10);
  });

  it('returns null when there is nothing to recall', () => {
    expect(recallAt([1, 2], new Set(), 10)).toBeNull();
  });

  it('measures precision over the window actually returned', () => {
    expect(precisionAt([10, 99], relevant, 12)).toBeCloseTo(0.5, 10);
    // An empty window is 0 precision, not a division by zero.
    expect(precisionAt([], relevant, 12)).toBe(0);
  });
});

describe('reciprocalRank / hitAt', () => {
  it('scores the first gold hit and ignores later ones', () => {
    expect(reciprocalRank([5, 7, 9], new Set([7, 9]), 30)).toBeCloseTo(0.5, 10);
    expect(reciprocalRank([7], new Set([7]), 30)).toBe(1);
  });

  it('is 0 when no gold entry is inside the cutoff', () => {
    expect(reciprocalRank([1, 2, 3, 7], new Set([7]), 3)).toBe(0);
    expect(hitAt([1, 2, 3, 7], new Set([7]), 3)).toBe(0);
    expect(hitAt([1, 2, 3, 7], new Set([7]), 4)).toBe(1);
  });

  /**
   * Pool B's gold set holds the source entry *and* its near-duplicate siblings,
   * because reranking keeps the best-scoring member of a duplicate group. Any of
   * them counts as finding the answer.
   */
  it('accepts a near-duplicate sibling as the answer', () => {
    expect(reciprocalRank([888], new Set([777, 888]), 30)).toBe(1);
  });
});

describe('bootstrapCI', () => {
  it('brackets a clearly positive effect without touching zero', () => {
    const ci = bootstrapCI(Array.from({ length: 40 }, () => 0.2), 42)!;
    expect(ci.mean).toBeCloseTo(0.2, 10);
    // Zero variance: every resample has the same mean.
    expect(ci.lo).toBeCloseTo(0.2, 10);
    expect(ci.straddlesZero).toBe(false);
  });

  it('reports straddling zero when the deltas are noise', () => {
    const noisy = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.3 : -0.3));
    expect(bootstrapCI(noisy, 42)!.straddlesZero).toBe(true);
  });

  it('is reproducible for a given seed and differs across seeds', () => {
    // Distinct deltas, so a resample mean is effectively continuous. With only a
    // few repeated values the 2.5th percentile is a coarse discrete step that two
    // seeds can legitimately share, which would make the second assertion flaky
    // without saying anything about the seeding.
    const d = Array.from({ length: 30 }, (_, i) => i / 100 - 0.15);
    expect(bootstrapCI(d, 7)).toEqual(bootstrapCI(d, 7));
    const a = bootstrapCI(d, 7)!;
    const b = bootstrapCI(d, 8)!;
    expect([a.lo, a.hi]).not.toEqual([b.lo, b.hi]);
  });

  it('declines to invent an interval from a single observation', () => {
    expect(bootstrapCI([0.5], 1)).toBeNull();
  });
});

describe('paired', () => {
  it('counts wins, losses and ties from per-query deltas', () => {
    const r = paired([0.5, 0.5, 0.5], [0.7, 0.3, 0.5], 1);
    expect(r).toMatchObject({ wins: 1, losses: 1, ties: 1, n: 3 });
  });

  /**
   * A query that only one variant could score is dropped from the comparison
   * entirely. Otherwise a variant could improve its average by making hard
   * queries unscoreable, which is the opposite of an improvement.
   */
  it('drops a query either side could not score', () => {
    const r = paired([0.5, null, 0.2], [0.6, 0.9, null], 1);
    expect(r.n).toBe(1);
    expect(r.wins).toBe(1);
  });

  it('reports n=0 rather than throwing when nothing is comparable', () => {
    expect(paired([null], [null], 1)).toMatchObject({ n: 0, wins: 0 });
  });
});

describe('quadraticWeightedKappa', () => {
  it('is 1.0 for identical labels with spread', () => {
    const a: Grade[] = [0, 1, 2, 3, 0, 3];
    expect(quadraticWeightedKappa(a, a).kappa).toBeCloseTo(1, 10);
  });

  /**
   * The reason for weighting: two judges who both found a hit useful but split
   * 2-vs-3 must score far higher than judges who split 0-vs-3. Plain Cohen's κ
   * treats those identically, which would understate agreement and so overstate
   * how small a difference this harness can resolve.
   */
  it('treats a near-miss far more kindly than an opposite call', () => {
    const near = quadraticWeightedKappa([2, 3, 2, 3, 0, 0], [3, 2, 3, 2, 0, 0]).kappa;
    const opposite = quadraticWeightedKappa([3, 0, 3, 0, 3, 0], [0, 3, 0, 3, 0, 3]).kappa;
    expect(near).toBeGreaterThan(opposite);
    expect(opposite).toBeLessThan(0);
  });

  it('returns the raw matrix and exact-agreement rate alongside', () => {
    const r = quadraticWeightedKappa([0, 0, 3], [0, 3, 3]);
    expect(r.n).toBe(3);
    expect(r.exact).toBeCloseTo(2 / 3, 10);
    expect(r.matrix[0]![0]).toBe(1);
    expect(r.matrix[0]![3]).toBe(1);
    expect(r.matrix[3]![3]).toBe(1);
  });

  it('calls unanimous single-grade labelling perfect agreement, not a divide by zero', () => {
    // Both judges said 0 for everything: expected disagreement is 0, and the
    // honest reading is total agreement rather than NaN.
    expect(quadraticWeightedKappa([0, 0, 0], [0, 0, 0]).kappa).toBe(1);
  });

  it('handles an empty sample', () => {
    expect(quadraticWeightedKappa([], []).n).toBe(0);
  });
});

describe('shuffle', () => {
  it('is a permutation, seeded and reproducible', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = shuffle(items, 99);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
    expect(a).toEqual(shuffle(items, 99));
    expect(a).not.toEqual(shuffle(items, 100));
    // The input is not mutated — callers reuse the candidate list per judge.
    expect(items[0]).toBe(1);
  });
});

describe('mean', () => {
  it('returns null for an empty sample rather than NaN', () => {
    expect(mean([])).toBeNull();
    expect(mean([1, 2])).toBe(1.5);
  });
});
