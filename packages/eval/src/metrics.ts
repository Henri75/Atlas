/**
 * Retrieval quality metrics.
 *
 * Every function here is pure and deterministic — no clock, no network, no
 * randomness that is not seeded. That is deliberate: these numbers decide
 * whether a ranking change ships, so they have to be reproducible from the
 * committed fixtures alone.
 */

/** Relevance grade from the judge. 2 and 3 count as relevant; 0 and 1 do not. */
export type Grade = 0 | 1 | 2 | 3;

/**
 * Grade at which a hit counts as answering the question.
 *
 * 1 means "marginal" — a block that mentions the subject without informing the
 * answer. Counting those as relevant would make almost everything relevant on a
 * corpus that talks about itself constantly, and would flatter every variant
 * equally, which is worse than useless for a comparison.
 */
export const RELEVANT_AT: Grade = 2;

/** Discounted cumulative gain. Rank 1 is undiscounted (log2(2) = 1). */
export function dcg(gains: number[]): number {
  return gains.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
}

/**
 * nDCG@k over a ranked list, normalised by the best ordering achievable from
 * the judged set for this query.
 *
 * Returns null when nothing relevant was judged for the query: 0/0 is not 0, and
 * averaging a fabricated zero over such queries would drag every variant's score
 * down by the same amount while hiding how many queries the harness cannot speak
 * to. Those queries are counted separately instead.
 */
export function ndcgAt(rankedGains: number[], allGrades: number[], k: number): number | null {
  const ideal = [...allGrades].sort((a, b) => b - a).slice(0, k);
  const idealDcg = dcg(ideal);
  if (idealDcg === 0) return null;
  return dcg(rankedGains.slice(0, k)) / idealDcg;
}

/** Fraction of all judged-relevant entries that appear in the top k. */
export function recallAt(ranked: number[], relevant: Set<number>, k: number): number | null {
  if (relevant.size === 0) return null;
  const found = ranked.slice(0, k).filter((id) => relevant.has(id)).length;
  return found / relevant.size;
}

/** Fraction of the top k that is relevant. Defined even with no relevant set. */
export function precisionAt(ranked: number[], relevant: Set<number>, k: number): number {
  const window = ranked.slice(0, k);
  if (!window.length) return 0;
  return window.filter((id) => relevant.has(id)).length / window.length;
}

/**
 * Reciprocal rank of the first gold entry, 0 if none appears within k.
 *
 * `gold` is a set rather than a single id because Pool B's known item may have
 * near-duplicate siblings, and `rerankForContext` keeps the best-scoring member
 * of a duplicate group — which need not be the entry the question was written
 * from. Scoring only the exact entry would mark a successful retrieval as a miss
 * and punish the near-duplicate collapse for working.
 */
export function reciprocalRank(ranked: number[], gold: Set<number>, k: number): number {
  const at = ranked.slice(0, k).findIndex((id) => gold.has(id));
  return at === -1 ? 0 : 1 / (at + 1);
}

/** 1 if any gold entry is in the top k. */
export function hitAt(ranked: number[], gold: Set<number>, k: number): 0 | 1 {
  return ranked.slice(0, k).some((id) => gold.has(id)) ? 1 : 0;
}

export function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Deterministic PRNG (mulberry32).
 *
 * `Math.random()` would make a bootstrap interval unreproducible, so a run could
 * never be re-derived from its committed inputs — and an interval nobody can
 * reproduce is an assertion, not a measurement.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates against a seeded PRNG. Used to shuffle judge candidates. */
export function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  const rand = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface Interval {
  mean: number;
  lo: number;
  hi: number;
  /** True when the interval contains zero, i.e. the run cannot call a winner. */
  straddlesZero: boolean;
}

/**
 * Percentile bootstrap over paired per-query deltas.
 *
 * Paired, because a tuning comparison runs both variants over the *same*
 * queries: the per-query difference cancels out how intrinsically hard each
 * question is, which is most of the variance at n=21. Comparing two aggregate
 * means instead would need far more queries to see the same effect.
 *
 * A CI containing zero means the harness cannot distinguish the variants on this
 * query set. That is a finding to report, not a number to round in the preferred
 * direction.
 */
export function bootstrapCI(deltas: number[], seed: number, resamples = 10_000): Interval | null {
  if (deltas.length < 2) return null;
  const rand = rng(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < deltas.length; i++) sum += deltas[Math.floor(rand() * deltas.length)]!;
    means.push(sum / deltas.length);
  }
  means.sort((a, b) => a - b);
  const at = (p: number) => means[Math.min(means.length - 1, Math.floor(p * means.length))]!;
  const lo = at(0.025);
  const hi = at(0.975);
  return { mean: mean(deltas)!, lo, hi, straddlesZero: lo <= 0 && hi >= 0 };
}

export interface PairedResult extends Partial<Interval> {
  wins: number;
  losses: number;
  ties: number;
  n: number;
}

/** Win/loss/tie counts plus the bootstrap interval, from paired measurements. */
export function paired(
  base: (number | null)[],
  candidate: (number | null)[],
  seed: number,
): PairedResult {
  const deltas: number[] = [];
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (let i = 0; i < base.length; i++) {
    const b = base[i];
    const c = candidate[i];
    // A query only contributes if BOTH variants produced a number for it.
    // Otherwise a variant could look better by making queries unscoreable.
    if (b == null || c == null) continue;
    const d = c - b;
    deltas.push(d);
    if (d > 1e-9) wins++;
    else if (d < -1e-9) losses++;
    else ties++;
  }
  // The mean delta is defined for a single pair; only the interval needs two.
  // Folding both into the CI meant a one-query comparison reported no mean at
  // all, and `decisionHolds` skipped it — returning "the verdict holds" when the
  // truth was "there was nothing to check". Absence of a check must never read as
  // a passed check.
  const ci = bootstrapCI(deltas, seed);
  const avg = mean(deltas);
  return {
    wins,
    losses,
    ties,
    n: deltas.length,
    ...(avg != null ? { mean: avg } : {}),
    ...(ci ?? {}),
  };
}

export interface AgreementReport {
  kappa: number;
  /** matrix[a][b] = times judge 1 said a and judge 2 said b. */
  matrix: number[][];
  n: number;
  /** Fraction of labels both judges scored identically. */
  exact: number;
}

/**
 * Quadratic-weighted Cohen's κ over ordinal grades.
 *
 * Weighted, not plain: the grades are an ordered scale, and plain κ treats a
 * 2-vs-3 disagreement — two judges who both found the hit useful — exactly as
 * severely as 0-vs-3, which would understate agreement and therefore overstate
 * how small a metric difference this harness can resolve.
 *
 * The raw matrix is returned alongside, because a single agreement number is
 * precisely the kind of summary this project does not take on trust.
 */
export function quadraticWeightedKappa(a: Grade[], b: Grade[], categories = 4): AgreementReport {
  const n = Math.min(a.length, b.length);
  const matrix = Array.from({ length: categories }, () => new Array<number>(categories).fill(0));
  const rowSum = new Array<number>(categories).fill(0);
  const colSum = new Array<number>(categories).fill(0);
  let exact = 0;
  for (let i = 0; i < n; i++) {
    matrix[a[i]!]![b[i]!]! += 1;
    rowSum[a[i]!]! += 1;
    colSum[b[i]!]! += 1;
    if (a[i] === b[i]) exact++;
  }
  if (n === 0) return { kappa: 0, matrix, n: 0, exact: 0 };

  const denom = (categories - 1) ** 2;
  let observed = 0;
  let expected = 0;
  for (let i = 0; i < categories; i++) {
    for (let j = 0; j < categories; j++) {
      const w = (i - j) ** 2 / denom;
      observed += w * (matrix[i]![j]! / n);
      expected += w * ((rowSum[i]! / n) * (colSum[j]! / n));
    }
  }
  // Perfect agreement with zero expected disagreement is κ = 1, not a division
  // by zero: it happens whenever both judges used a single grade throughout.
  const kappa = expected === 0 ? (observed === 0 ? 1 : 0) : 1 - observed / expected;
  return { kappa, matrix, n, exact: exact / n };
}
