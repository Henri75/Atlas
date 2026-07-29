import { describe, expect, it } from 'vitest';
import { rerankForContext } from '@atlas/core';
import type { SearchHit } from '@atlas/core';
import {
  LEAKAGE_THRESHOLD,
  dedupeKeyOf,
  expandGold,
  gradesByQuery,
  hashJudgements,
  leakage,
  mergeQueries,
  queryId,
  relevantByQuery,
  validateQueries,
} from '@atlas/eval/pools.js';
import type { EvalQuery, JudgementFile, QueryFile } from '@atlas/eval/types.js';

/** The id is derived from text+filters unless a test is deliberately corrupting it. */
const q = (over: Partial<EvalQuery> = {}): EvalQuery => {
  const text = over.text ?? 'why was nvidia removed from the backfill chain?';
  const filters = over.filters ?? {};
  return {
    pool: 'A',
    class: 'intent',
    provenance: { source: 'usage_log' },
    ...over,
    text,
    filters,
    id: over.id ?? queryId(text, filters),
  };
};

describe('queryId', () => {
  it('ignores case and whitespace noise', () => {
    expect(queryId('  Why  was X removed? ')).toBe(queryId('why was x removed?'));
  });

  /**
   * Filters are part of a query's identity. The same words scoped to `deepcast`
   * and scoped to nothing are two different retrieval problems over two different
   * candidate universes, so sharing an id would apply one's judgements to the
   * other's results.
   */
  it('separates the same words under different filters', () => {
    expect(queryId('worker pool resize')).not.toBe(
      queryId('worker pool resize', { project: 'deepcast' }),
    );
  });

  it('is insensitive to filter key order and array order', () => {
    expect(queryId('x', { project: 'a', kind: 'summary' } as never)).toBe(
      queryId('x', { kind: 'summary', project: 'a' } as never),
    );
    expect(queryId('x', { projects: ['b', 'a'] })).toBe(queryId('x', { projects: ['a', 'b'] }));
  });

  it('treats an empty filter list as no filter at all', () => {
    expect(queryId('x', { projects: [] })).toBe(queryId('x'));
  });
});

describe('mergeQueries', () => {
  /**
   * Mining re-runs as traffic accumulates. Hand-assigned classes and every
   * judgement keyed by query id must survive that, or each pass would silently
   * reset the labelling work.
   */
  it('adds new queries and never overwrites an existing one', () => {
    const existing = [q({ text: 'a', class: 'incident' })];
    const incoming = [q({ text: 'a', class: 'definitional' }), q({ text: 'b' })];
    const r = mergeQueries(existing, incoming);
    expect(r.added).toBe(1);
    expect(r.queries).toHaveLength(2);
    expect(r.queries.find((x) => x.text === 'a')!.class).toBe('incident');
  });
});

describe('leakage', () => {
  it('is high when the question echoes the entry it came from', () => {
    const entry =
      'analyzer-worker: videoinsight_low queue had no consumer after the supervisorctl restart';
    expect(leakage('videoinsight_low queue had no consumer supervisorctl', entry)).toBeGreaterThan(
      LEAKAGE_THRESHOLD,
    );
  });

  it('is low for a paraphrase that shares no rare terms', () => {
    const entry =
      'analyzer-worker: videoinsight_low queue had no consumer after the supervisorctl restart';
    expect(leakage('which background jobs stopped being picked up?', entry)).toBeLessThan(
      LEAKAGE_THRESHOLD,
    );
  });

  it('ignores stopwords, which the sparse branch also ignores', () => {
    // Every content word overlaps; only articles and prepositions differ.
    expect(leakage('the resize of the pool', 'resize pool')).toBe(1);
  });

  it('is 0 for a question with no content terms', () => {
    expect(leakage('and the of', 'anything')).toBe(0);
  });
});

describe('expandGold', () => {
  const hit = (id: number, title: string, at: string): SearchHit & { entryId: number } => ({
    entryId: id,
    score: 0,
    projectSlug: 'p',
    sourceType: 'claude_session',
    title,
    snippet: '',
    occurredAt: at,
    sourcePath: `/x${id}`,
  });

  it('includes every entry that is the same content recorded twice', () => {
    const target = hit(1, 'Summary: root cause', '2025-11-25T10:55:42.276Z');
    const pool = [target, hit(2, 'Summary: root cause', '2025-11-25T10:55:42.276Z'), hit(3, 'other', '2026-01-01T00:00:00.000Z')];
    expect(expandGold(target, pool)).toEqual([1, 2]);
  });

  it('does not merge same-titled entries from different times', () => {
    const target = hit(1, 'Prompt: continue', '2026-07-01T10:00:00.000Z');
    const pool = [target, hit(2, 'Prompt: continue', '2026-07-20T10:00:00.000Z')];
    expect(expandGold(target, pool)).toEqual([1]);
  });

  /**
   * The eval's dedupe key is a copy of the reranker's private one, so this
   * asserts the two agree by *behaviour*: the sibling the reranker keeps must be
   * inside the gold set the eval computed. If core's key ever changes, Pool B
   * would otherwise start scoring successful retrievals as misses.
   */
  it('agrees with the reranker about which entries collapse together', () => {
    const a = { ...hit(1, 'Summary: root cause', '2025-11-25T10:55:42.276Z'), score: 0.7 };
    const b = { ...hit(2, 'Summary: root cause', '2025-11-25T10:55:42.276Z'), score: 0.9 };
    const gold = expandGold(a, [a, b]);
    const survivors = rerankForContext([a, b], 5, { nowMs: Date.parse('2026-07-26T00:00:00Z') });
    expect(survivors).toHaveLength(1);
    expect(gold).toContain(survivors[0]!.entryId);
    // And it is b that survived — the better-scoring member, not the target.
    expect(survivors[0]!.entryId).toBe(2);
  });

  it('builds the same key core would for an undated entry', () => {
    expect(dedupeKeyOf({ projectSlug: 'p', sourceType: 'doc', title: 't' })).toBe('p|doc|t|');
  });
});

describe('judgement helpers', () => {
  const j = (labels: JudgementFile['labels']): JudgementFile => ({
    version: 1,
    generatedAt: '2026-07-26T00:00:00.000Z',
    primaryJudge: 'cline-pass/kimi-k3',
    shuffleSeed: 1,
    labels,
    unjudged: [],
  });

  it('collects relevant entries at the configured grade cutoff', () => {
    const f = j([
      { queryId: 'q1', entryId: 1, grade: 3, why: '', judge: 'm' },
      { queryId: 'q1', entryId: 2, grade: 2, why: '', judge: 'm' },
      { queryId: 'q1', entryId: 3, grade: 1, why: '', judge: 'm' },
    ]);
    expect([...relevantByQuery(f, 2).get('q1')!].sort()).toEqual([1, 2]);
    expect([...relevantByQuery(f, 3).get('q1')!].sort()).toEqual([1]);
  });

  it('lets a human arbitration override a model label', () => {
    const f = j([
      { queryId: 'q1', entryId: 1, grade: 0, why: 'model', judge: 'cline-pass/kimi-k3' },
      { queryId: 'q1', entryId: 1, grade: 3, why: 'human', judge: 'human' },
    ]);
    expect(gradesByQuery(f).get('q1')!.get(1)).toBe(3);
    // ...regardless of which order they appear in.
    expect(gradesByQuery(j([...f.labels].reverse())).get('q1')!.get(1)).toBe(3);
  });

  /**
   * Precedence must be explicit, not positional. Labels are written sorted by
   * judge name, and `cline-pass/glm-5.2` sorts BEFORE `cline-pass/kimi-k3`, so a
   * first-one-wins rule would promote the agreement-subsample judge to
   * authoritative for every double-labelled pair — quietly replacing the primary
   * judge's grades with the second opinion's across a quarter of the fixture.
   */
  it('prefers the primary judge over the second, whatever the file order', () => {
    const labels: JudgementFile['labels'] = [
      { queryId: 'q1', entryId: 1, grade: 1, why: 'second', judge: 'cline-pass/glm-5.2' },
      { queryId: 'q1', entryId: 1, grade: 3, why: 'primary', judge: 'cline-pass/kimi-k3' },
    ];
    expect(gradesByQuery(j(labels)).get('q1')!.get(1)).toBe(3);
    expect(gradesByQuery(j([...labels].reverse())).get('q1')!.get(1)).toBe(3);
  });

  it('still ranks a human above the primary judge', () => {
    const labels: JudgementFile['labels'] = [
      { queryId: 'q1', entryId: 1, grade: 3, why: 'primary', judge: 'cline-pass/kimi-k3' },
      { queryId: 'q1', entryId: 1, grade: 0, why: 'human says no', judge: 'human' },
      { queryId: 'q1', entryId: 1, grade: 2, why: 'second', judge: 'cline-pass/glm-5.2' },
    ];
    expect(gradesByQuery(j(labels)).get('q1')!.get(1)).toBe(0);
  });

  /**
   * The hash pins a baseline to the labels it was computed under. Relabelling
   * must invalidate it, or a recorded number would silently start meaning
   * something else.
   */
  it('changes when a grade changes and not when order does', () => {
    const a = j([
      { queryId: 'q1', entryId: 1, grade: 3, why: 'x', judge: 'm' },
      { queryId: 'q1', entryId: 2, grade: 0, why: 'y', judge: 'm' },
    ]);
    const reordered = j([...a.labels].reverse());
    expect(hashJudgements(reordered)).toBe(hashJudgements(a));
    const changed = j([{ ...a.labels[0]!, grade: 0 }, a.labels[1]!]);
    expect(hashJudgements(changed)).not.toBe(hashJudgements(a));
  });
});

describe('validateQueries', () => {
  const file = (queries: EvalQuery[]): QueryFile => ({
    version: 1,
    generatedAt: '2026-07-26T00:00:00.000Z',
    queries,
  });

  it('accepts a well-formed fixture', () => {
    expect(() => validateQueries(file([q(), q({ text: 'other', pool: 'A' })]))).not.toThrow();
  });

  /**
   * A tampered or hand-edited id would break the link between a query and its
   * judgements while every count still looked right — the most dangerous failure
   * shape available to this harness, since the report would still read like a
   * full evaluation.
   */
  it('rejects an id that does not match its text and filters', () => {
    expect(() => validateQueries(file([{ ...q(), id: 'deadbeef' }]))).toThrow(/expected/);
  });

  it('rejects a pool B query with no gold set', () => {
    expect(() => validateQueries(file([q({ pool: 'B', text: 'gen' })]))).toThrow(/no gold/);
  });

  it('rejects a pool N query that has gold entries', () => {
    expect(() => validateQueries(file([q({ pool: 'N', text: 'neg', gold: [5] })]))).toThrow(
      /not a negative/,
    );
  });

  it('rejects an unknown fixture version rather than guessing', () => {
    expect(() => validateQueries({ ...file([]), version: 2 as never })).toThrow(/version/);
  });
});

/**
 * Pool L quotes one literal from its source entry on purpose — that verbatim
 * token is the whole point of the pool. Measured against the ordinary rule it
 * would look like leakage, so the literal (and the sub-tokens it produces) is
 * exempted; everything else is still held to the same standard.
 */
describe('leakage with an exemption', () => {
  it('ignores the exempted literal when scoring overlap', () => {
    const entry = 'the tags_with_counts column reached 6.8MB and was slow';
    const question = 'why was the 6.8MB column slow';

    const plain = leakage(question, entry);
    const exempt = leakage(question, entry, ['6.8MB']);

    expect(exempt).toBeLessThan(plain);
  });

  it('still counts every other shared word', () => {
    // Only the literal is forgiven. A question that otherwise echoes its entry
    // must still be rejected, or the pool becomes a keyword-matching exercise.
    const entry = 'the tags_with_counts column reached 6.8MB and was slow';
    const question = 'tags_with_counts column reached 6.8MB slow';

    expect(leakage(question, entry, ['6.8MB'])).toBeGreaterThan(LEAKAGE_THRESHOLD);
  });

  it('is unchanged when nothing is exempted', () => {
    const entry = 'the tags_with_counts column reached 6.8MB';
    const question = 'why was the column slow';
    expect(leakage(question, entry, [])).toBe(leakage(question, entry));
  });
});
