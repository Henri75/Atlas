import { mean, ndcgAt, paired, precisionAt, recallAt, reciprocalRank, hitAt, RELEVANT_AT } from './metrics.js';
import type { PairedResult } from './metrics.js';
import type { EvalQuery, PoolId, QueryClass } from './types.js';
import type { Measured, SignalRow } from './retrieve.js';

/**
 * Turning measurements into a report somebody can act on.
 *
 * Two rules shape everything here. Pools are never averaged together, because
 * each has a different bias and mixing them hides a change that helps one and
 * hurts another. And a number computed over too few queries is labelled as such
 * rather than presented alongside a well-supported one as though they were peers.
 */

/**
 * Below this, a per-class figure is reported but marked indicative.
 *
 * Pool A has 3 temporal and 2 procedural queries — a single query swings such a
 * class by a third. Suppressing the number entirely would hide real information;
 * printing it unqualified would invite a decision it cannot support.
 */
export const MIN_N_FOR_CLAIM = 8;

export interface QueryScore {
  queryId: string;
  pool: PoolId;
  class: QueryClass;
  /** Context stage (k blocks Ask would see). Null when unscoreable. */
  ndcg: number | null;
  precision: number | null;
  /** Retrieval stage (the pool). */
  recall: number | null;
  /** Pool B known-item. */
  mrr: number | null;
  hit: number | null;
  degraded: boolean;
  tookMs: number;
  /** Candidates in this query's windows that carry no judgement. */
  unjudged: number;
}

export interface Judgements {
  /** entryId -> grade, per query. */
  grades: Map<string, Map<number, number>>;
  relevant: Map<string, Set<number>>;
  unjudged: Map<string, Set<number>>;
}

/**
 * Score one query under one variant.
 *
 * `unjudgedAs` is how an unlabelled candidate is treated: the caller computes
 * every metric twice, once optimistically and once pessimistically, and a
 * decision only stands if it holds under both. That replaces the tempting
 * alternative — an invented "more than N% unjudged is invalid" threshold — with a
 * bound derived from the data.
 */
export function scoreQuery(
  query: EvalQuery,
  m: Measured,
  j: Judgements,
  k: number,
  poolCutoff: number,
  unjudgedAs: 0 | 3,
): QueryScore {
  const contextIds = m.context.map((h) => h.entryId);
  const poolIds = m.pool.map((h) => h.entryId);
  const base: Omit<QueryScore, 'ndcg' | 'precision' | 'recall' | 'mrr' | 'hit' | 'unjudged'> = {
    queryId: query.id,
    pool: query.pool,
    class: query.class,
    degraded: m.degraded,
    tookMs: m.tookMs,
  };

  if (query.pool === 'B') {
    const gold = new Set(query.gold ?? []);
    return {
      ...base,
      ndcg: null,
      precision: null,
      recall: null,
      mrr: reciprocalRank(poolIds, gold, poolCutoff),
      hit: hitAt(contextIds, gold, k),
      unjudged: 0,
    };
  }

  if (query.pool === 'N') {
    // A negative has no relevant entry by construction, so ranking metrics are
    // undefined for it. Its value is in the signal panel, not here.
    return { ...base, ndcg: null, precision: null, recall: null, mrr: null, hit: null, unjudged: 0 };
  }

  const grades = j.grades.get(query.id) ?? new Map<number, number>();
  const unjudgedIds = j.unjudged.get(query.id) ?? new Set<number>();

  // Never judged at all is not the same as judged and found irrelevant.
  // Precision would otherwise report a confident 0.000 for an unjudged query,
  // which reads as "retrieval surfaced nothing relevant" when the truth is "no
  // one has said". That conflation of absent evidence with negative evidence is
  // the exact failure this harness was built to stop reproducing.
  if (!grades.size && !unjudgedIds.size) {
    return { ...base, ndcg: null, precision: null, recall: null, mrr: null, hit: null, unjudged: 0 };
  }

  const gradeOf = (id: number) => grades.get(id) ?? (unjudgedIds.has(id) ? unjudgedAs : 0);

  const relevant = new Set(j.relevant.get(query.id) ?? []);
  if (unjudgedAs >= RELEVANT_AT) for (const id of unjudgedIds) relevant.add(id);

  const allGrades = [
    ...[...grades.values()],
    ...[...unjudgedIds].filter((id) => !grades.has(id)).map(() => unjudgedAs),
  ];

  return {
    ...base,
    ndcg: ndcgAt(contextIds.map(gradeOf), allGrades, 10),
    precision: precisionAt(contextIds, relevant, k),
    recall: recallAt(poolIds, relevant, poolCutoff),
    mrr: null,
    hit: null,
    unjudged: [...contextIds, ...poolIds].filter((id) => unjudgedIds.has(id) && !grades.has(id))
      .length,
  };
}

export type MetricName = 'ndcg' | 'precision' | 'recall' | 'mrr' | 'hit';

export interface ClassSummary {
  class: QueryClass | 'all';
  n: number;
  values: Partial<Record<MetricName, number | null>>;
  indicative: boolean;
}

const METRICS_BY_POOL: Record<PoolId, MetricName[]> = {
  A: ['ndcg', 'precision', 'recall'],
  B: ['mrr', 'hit'],
  N: [],
};

/** Per-class means for one pool under one variant. */
export function summarise(scores: QueryScore[], pool: PoolId): ClassSummary[] {
  const inPool = scores.filter((s) => s.pool === pool);
  const metrics = METRICS_BY_POOL[pool];
  const classes = [...new Set(inPool.map((s) => s.class))].sort();
  const rows: ClassSummary[] = [];
  for (const cls of [...classes, 'all' as const]) {
    const subset = cls === 'all' ? inPool : inPool.filter((s) => s.class === cls);
    if (!subset.length) continue;
    const values: ClassSummary['values'] = {};
    for (const metric of metrics) {
      values[metric] = mean(subset.map((s) => s[metric]).filter((v): v is number => v != null));
    }
    rows.push({
      class: cls,
      n: subset.length,
      values,
      indicative: cls !== 'all' && subset.length < MIN_N_FOR_CLAIM,
    });
  }
  return rows;
}

export interface Comparison {
  pool: PoolId;
  class: QueryClass | 'all';
  metric: MetricName;
  result: PairedResult;
  indicative: boolean;
}

/**
 * Paired comparison of a candidate against the baseline, per pool and class.
 *
 * Paired because both variants ran over the same queries: the per-query
 * difference cancels how intrinsically hard each question is, which is most of
 * the variance at n=21. Two aggregate means would need far more queries to see
 * the same effect.
 */
export function compare(
  base: QueryScore[],
  candidate: QueryScore[],
  seed: number,
): Comparison[] {
  const byId = new Map(candidate.map((s) => [s.queryId, s]));
  const out: Comparison[] = [];
  for (const pool of ['A', 'B'] as PoolId[]) {
    const inPool = base.filter((s) => s.pool === pool);
    if (!inPool.length) continue;
    const classes = [...new Set(inPool.map((s) => s.class))].sort();
    for (const cls of [...classes, 'all' as const]) {
      const subset = cls === 'all' ? inPool : inPool.filter((s) => s.class === cls);
      for (const metric of METRICS_BY_POOL[pool]) {
        const result = paired(
          subset.map((s) => s[metric]),
          subset.map((s) => byId.get(s.queryId)?.[metric] ?? null),
          seed,
        );
        if (!result.n) continue;
        out.push({
          pool,
          class: cls,
          metric,
          result,
          indicative: cls !== 'all' && subset.length < MIN_N_FOR_CLAIM,
        });
      }
    }
  }
  return out;
}

const f3 = (v: number | null | undefined) => (v == null ? '   —  ' : v.toFixed(3).padStart(6));

export function formatSummary(title: string, rows: ClassSummary[], pool: PoolId): string {
  if (!rows.length) return '';
  const metrics = METRICS_BY_POOL[pool];
  const head = ['class'.padEnd(14), 'n'.padStart(3), ...metrics.map((m) => m.padStart(6))].join('  ');
  const body = rows.map((r) => {
    const cells = metrics.map((m) => f3(r.values[m]));
    return [
      `${r.class}${r.indicative ? ' *' : ''}`.padEnd(14),
      String(r.n).padStart(3),
      ...cells,
    ].join('  ');
  });
  const note = rows.some((r) => r.indicative)
    ? `\n  * n < ${MIN_N_FOR_CLAIM}: indicative only, cannot carry a decision`
    : '';
  return `\n${title}\n  ${head}\n${body.map((b) => `  ${b}`).join('\n')}${note}\n`;
}

export function formatComparison(name: string, comps: Comparison[]): string {
  if (!comps.length) return `\nno comparable queries for ${name}\n`;
  const lines = comps.map((c) => {
    const r = c.result;
    const ci =
      r.lo == null
        ? '           '
        : `[${r.lo >= 0 ? '+' : ''}${r.lo.toFixed(3)}, ${r.hi! >= 0 ? '+' : ''}${r.hi!.toFixed(3)}]`;
    const verdict = r.straddlesZero === false ? '' : r.lo == null ? '' : '  (CI includes 0)';
    const delta = r.mean == null ? '  —' : `${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(3)}`;
    return (
      `  ${`${c.pool}/${c.class}${c.indicative ? ' *' : ''}`.padEnd(20)} ` +
      `${c.metric.padEnd(9)} ${delta.padStart(7)} ${ci}  ` +
      `${r.wins}W/${r.losses}L/${r.ties}T${verdict}`
    );
  });
  return `\n${name} vs baseline (paired, 95% bootstrap CI)\n${lines.join('\n')}\n`;
}

/**
 * The signal panel, as a distribution per pool.
 *
 * Pool N is the load-bearing row. A signal that does not separate it from Pools A
 * and B cannot support a "found nothing relevant" state, whatever its absolute
 * values look like — and demonstrating that about the fused RRF score is as
 * useful a result as finding a signal that works.
 */
export function formatSignals(rows: SignalRow[]): string {
  const pools: PoolId[] = ['A', 'B', 'N'];
  const metrics: { key: keyof SignalRow; label: string }[] = [
    { key: 'rrf1', label: 'rrf@1' },
    { key: 'rrfGap', label: 'rrf gap' },
    { key: 'cosine1', label: 'cos@1' },
    { key: 'cosine5', label: 'cos@5' },
    { key: 'lexicalOverlap', label: 'lex ovl' },
  ];
  const pct = (xs: number[], p: number) =>
    xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : null;

  let out = '\nrelevance signals by pool (no bands, no thresholds — calibration data only)\n';
  out += `  ${'pool'.padEnd(6)}${'n'.padStart(4)}  ${metrics.map((m) => `${m.label} p50   p95`.padEnd(20)).join('')}\n`;
  for (const pool of pools) {
    const inPool = rows.filter((r) => r.pool === pool);
    if (!inPool.length) continue;
    const cells = metrics.map((m) => {
      const xs = inPool.map((r) => r[m.key]).filter((v): v is number => typeof v === 'number');
      const p50 = pct(xs, 0.5);
      const p95 = pct(xs, 0.95);
      return `${f3(p50)} ${f3(p95)}      `.padEnd(20);
    });
    out += `  ${pool.padEnd(6)}${String(inPool.length).padStart(4)}  ${cells.join('')}\n`;
  }
  const separates = (key: keyof SignalRow) => {
    const val = (pool: PoolId) =>
      pct(
        rows.filter((r) => r.pool === pool).map((r) => r[key]).filter((v): v is number => typeof v === 'number'),
        0.5,
      );
    const answerable = val('A');
    const negative = val('N');
    if (answerable == null || negative == null) return null;
    return answerable - negative;
  };
  out += '\n  median gap, answerable (A) minus unanswerable (N) — larger is a more usable signal:\n';
  for (const m of metrics) {
    const gap = separates(m.key);
    out += `    ${m.label.padEnd(10)} ${gap == null ? '—' : (gap >= 0 ? '+' : '') + gap.toFixed(3)}\n`;
  }
  return out;
}

/**
 * Whether a decision survives the optimistic/pessimistic bounds.
 *
 * If treating every unlabelled candidate as perfect and treating it as
 * irrelevant lead to different answers, the run cannot settle the question and
 * says so — instead of picking whichever bound reads better.
 */
export function decisionHolds(
  optimistic: Comparison[],
  pessimistic: Comparison[],
): { holds: boolean; flipped: string[] } {
  const key = (c: Comparison) => `${c.pool}/${c.class}/${c.metric}`;
  const byKey = new Map(pessimistic.map((c) => [key(c), c]));
  const flipped: string[] = [];
  for (const o of optimistic) {
    const p = byKey.get(key(o));
    if (!p || o.result.mean == null || p.result.mean == null) continue;
    // A flip is a sign change in the mean delta, or a claim that only one bound
    // supports (one CI excludes zero while the other does not).
    const signFlip = Math.sign(o.result.mean) !== Math.sign(p.result.mean);
    const claimFlip = o.result.straddlesZero !== p.result.straddlesZero;
    if (signFlip || claimFlip) flipped.push(key(o));
  }
  return { holds: flipped.length === 0, flipped };
}
