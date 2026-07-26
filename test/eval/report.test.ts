import { describe, expect, it } from 'vitest';
import type { SearchHit } from '@atlas/core';
import {
  MIN_N_FOR_CLAIM,
  compare,
  decisionHolds,
  formatSummary,
  scoreQuery,
  summarise,
  type Judgements,
  type QueryScore,
} from '@atlas/eval/report.js';
import type { Measured } from '@atlas/eval/retrieve.js';
import type { EvalQuery, PoolId, QueryClass } from '@atlas/eval/types.js';

const hit = (entryId: number): SearchHit => ({
  entryId,
  score: 1,
  projectSlug: 'p',
  sourceType: 'doc',
  title: `t${entryId}`,
  snippet: '',
  sourcePath: `/x${entryId}`,
});

const measured = (context: number[], pool: number[] = context): Measured => ({
  context: context.map(hit),
  pool: pool.map(hit),
  mode: 'hybrid',
  degraded: false,
  tookMs: 1,
  scopeWidened: false,
});

const query = (pool: PoolId, over: Partial<EvalQuery> = {}): EvalQuery => ({
  id: 'q1',
  pool,
  text: 'q',
  class: 'intent',
  filters: {},
  provenance: { source: 'usage_log' },
  ...over,
});

const judgements = (
  grades: Record<number, number> = {},
  unjudged: number[] = [],
): Judgements => ({
  grades: new Map([['q1', new Map(Object.entries(grades).map(([k, v]) => [Number(k), v]))]]),
  relevant: new Map([
    ['q1', new Set(Object.entries(grades).filter(([, v]) => v >= 2).map(([k]) => Number(k)))],
  ]),
  unjudged: new Map([['q1', new Set(unjudged)]]),
});

describe('scoreQuery', () => {
  /**
   * Never judged is not the same as judged and found irrelevant. Reporting 0.000
   * for an unjudged query reads as "retrieval surfaced nothing relevant" when the
   * truth is "nobody has said" — the same conflation of absent evidence with
   * negative evidence that the trust contract exists to stop.
   */
  it('scores every metric null when the query carries no judgements at all', () => {
    const s = scoreQuery(query('A'), measured([1, 2]), judgements(), 12, 30, 0);
    expect(s).toMatchObject({ ndcg: null, precision: null, recall: null, unjudged: 0 });
  });

  it('scores a judged query at both stages', () => {
    const j = judgements({ 1: 3, 2: 0, 9: 2 });
    const s = scoreQuery(query('A'), measured([1, 2], [1, 2, 9]), j, 12, 30, 0);
    expect(s.ndcg).toBeGreaterThan(0);
    expect(s.precision).toBeCloseTo(0.5, 10); // 1 of 2 context blocks relevant
    expect(s.recall).toBeCloseTo(1, 10); // both relevant entries are in the pool
  });

  it('separates the two stages — the pool can hold what the context dropped', () => {
    const j = judgements({ 7: 3 });
    // The relevant entry was retrieved but reranking did not select it.
    const s = scoreQuery(query('A'), measured([1, 2], [1, 2, 7]), j, 12, 30, 0);
    expect(s.recall).toBeCloseTo(1, 10);
    expect(s.precision).toBe(0);
  });

  it('scores pool B against its gold set, including duplicate siblings', () => {
    const s = scoreQuery(
      query('B', { gold: [77, 88] }),
      measured([88], [5, 88]),
      judgements(),
      12,
      30,
      0,
    );
    expect(s.mrr).toBeCloseTo(0.5, 10); // gold at rank 2 of the pool
    expect(s.hit).toBe(1); // and it reached the context window
  });

  it('leaves pool N unscored — a negative has no ranking to be right about', () => {
    const s = scoreQuery(query('N'), measured([1, 2]), judgements(), 12, 30, 0);
    expect(s).toMatchObject({ ndcg: null, recall: null, mrr: null, hit: null });
  });

  /**
   * The optimistic/pessimistic pair is what replaces an invented "more than N%
   * unjudged is invalid" threshold with a bound derived from the data.
   */
  it('treats unjudged candidates differently under each bound', () => {
    const j = judgements({ 1: 0 }, [2]);
    const pessimistic = scoreQuery(query('A'), measured([1, 2]), j, 12, 30, 0);
    const optimistic = scoreQuery(query('A'), measured([1, 2]), j, 12, 30, 3);
    expect(pessimistic.precision).toBe(0);
    expect(optimistic.precision).toBeCloseTo(0.5, 10);
    expect(pessimistic.unjudged).toBeGreaterThan(0);
  });
});

const score = (over: Partial<QueryScore> & { queryId: string; class: QueryClass }): QueryScore => ({
  pool: 'A',
  ndcg: null,
  precision: null,
  recall: null,
  mrr: null,
  hit: null,
  degraded: false,
  tookMs: 1,
  unjudged: 0,
  ...over,
});

describe('summarise', () => {
  it('marks a class the harness cannot speak for', () => {
    const scores = [
      score({ queryId: 'a', class: 'temporal', ndcg: 0.5 }),
      score({ queryId: 'b', class: 'temporal', ndcg: 0.7 }),
    ];
    const rows = summarise(scores, 'A');
    const temporal = rows.find((r) => r.class === 'temporal')!;
    expect(temporal.n).toBe(2);
    expect(temporal.indicative).toBe(true);
    expect(temporal.values.ndcg).toBeCloseTo(0.6, 10);
    // Pool A really does have 3 temporal and 2 procedural queries, so this is not
    // a hypothetical guard.
    expect(MIN_N_FOR_CLAIM).toBeGreaterThan(2);
  });

  it('never marks the all-classes row indicative on class size alone', () => {
    const rows = summarise([score({ queryId: 'a', class: 'temporal', ndcg: 1 })], 'A');
    expect(rows.find((r) => r.class === 'all')!.indicative).toBe(false);
  });

  it('renders a dash rather than a zero for an unavailable metric', () => {
    const text = formatSummary('t', summarise([score({ queryId: 'a', class: 'intent' })], 'A'), 'A');
    expect(text).toContain('—');
    expect(text).not.toContain('0.000');
  });
});

describe('compare and decisionHolds', () => {
  const pair = (id: string, cls: QueryClass, ndcg: number) =>
    score({ queryId: id, class: cls, ndcg });

  it('produces a paired comparison per pool, class and metric', () => {
    const base = [pair('a', 'intent', 0.5), pair('b', 'intent', 0.5)];
    const cand = [pair('a', 'intent', 0.7), pair('b', 'intent', 0.6)];
    const comps = compare(base, cand, 1);
    const ndcg = comps.find((c) => c.class === 'all' && c.metric === 'ndcg')!;
    expect(ndcg.result.wins).toBe(2);
    expect(ndcg.result.mean).toBeCloseTo(0.15, 10);
  });

  /**
   * If the verdict depends on how unlabelled candidates are treated, the run has
   * not settled anything — and must not be read as a pass.
   */
  it('detects a verdict that flips sign between the bounds', () => {
    const base = [pair('a', 'intent', 0.5)];
    const optimistic = compare(base, [pair('a', 'intent', 0.7)], 1);
    const pessimistic = compare(base, [pair('a', 'intent', 0.3)], 1);
    const { holds, flipped } = decisionHolds(optimistic, pessimistic);
    expect(holds).toBe(false);
    expect(flipped.length).toBeGreaterThan(0);
  });

  it('holds when both bounds agree on the direction', () => {
    const base = [pair('a', 'intent', 0.5), pair('b', 'intent', 0.4)];
    const optimistic = compare(base, [pair('a', 'intent', 0.7), pair('b', 'intent', 0.6)], 1);
    const pessimistic = compare(base, [pair('a', 'intent', 0.6), pair('b', 'intent', 0.5)], 1);
    expect(decisionHolds(optimistic, pessimistic).holds).toBe(true);
  });

  it('ignores a query neither bound could score', () => {
    const comps = compare(
      [score({ queryId: 'a', class: 'intent' })],
      [score({ queryId: 'a', class: 'intent' })],
      1,
    );
    expect(comps).toEqual([]);
  });
});
