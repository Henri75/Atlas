import { describe, expect, it } from 'vitest';
import {
  EmptyReplyError,
  JudgeFormatError,
  RUBRIC,
  buildJudgeUser,
  parseJudgeReply,
  stratifiedSubsample,
} from '@atlas/eval/judge.js';
import type { Candidate } from '@atlas/eval/judge.js';
import type { Grade } from '@atlas/eval/metrics.js';
import type { QueryClass } from '@atlas/eval/types.js';

const allowed = new Set([1, 2, 3]);

describe('parseJudgeReply', () => {
  it('reads a clean array', () => {
    const out = parseJudgeReply('[{"n":1,"grade":3,"why":"answers it"}]', allowed);
    expect(out).toEqual([{ n: 1, grade: 3, why: 'answers it' }]);
  });

  it('reads an array inside a markdown fence', () => {
    const out = parseJudgeReply('```json\n[{"n":2,"grade":0,"why":"no"}]\n```', allowed);
    expect(out).toEqual([{ n: 2, grade: 0, why: 'no' }]);
  });

  it('reads an array wrapped in prose on both sides', () => {
    const out = parseJudgeReply(
      'Here are my grades:\n[{"n":1,"grade":2,"why":"partial"}]\nLet me know if you need more.',
      allowed,
    );
    expect(out[0]!.grade).toBe(2);
  });

  it('accepts a partial reply rather than discarding the work', () => {
    // A truncated completion loses the tail; the graded head is still valid, and
    // the caller re-asks only for what is missing.
    const out = parseJudgeReply('[{"n":1,"grade":3,"why":"a"},{"n":2,"grade":1,"why":"b"}]', allowed);
    expect(out.map((g) => g.n)).toEqual([1, 2]);
  });

  /**
   * Dropped rather than coerced. Clamping a grade of 7 to 3, or accepting a
   * candidate number nobody was shown, would fabricate a label — and every metric
   * downstream is a function of these labels.
   */
  it('drops out-of-range grades and unknown candidate numbers', () => {
    const out = parseJudgeReply(
      '[{"n":1,"grade":7,"why":"x"},{"n":99,"grade":3,"why":"y"},{"n":3,"grade":2,"why":"ok"}]',
      allowed,
    );
    expect(out).toEqual([{ n: 3, grade: 2, why: 'ok' }]);
  });

  it('keeps the first grade when a candidate is graded twice', () => {
    const out = parseJudgeReply('[{"n":1,"grade":3,"why":"first"},{"n":1,"grade":0,"why":"second"}]', allowed);
    expect(out).toEqual([{ n: 1, grade: 3, why: 'first' }]);
  });

  it('truncates a rambling reason instead of storing an essay', () => {
    const out = parseJudgeReply(`[{"n":1,"grade":3,"why":"${'x'.repeat(400)}"}]`, allowed);
    expect(out[0]!.why.length).toBe(120);
  });

  /**
   * The distinction matters for retry policy: a blank completion is a heavy-model
   * hiccup worth retrying verbatim, while a malformed one needs a repair
   * instruction. Both are retryable; only one is worth rewriting the prompt for.
   */
  it('separates an empty completion from a malformed one', () => {
    expect(() => parseJudgeReply('   ', allowed)).toThrow(EmptyReplyError);
    expect(() => parseJudgeReply('I cannot grade these.', allowed)).toThrow(JudgeFormatError);
    expect(() => parseJudgeReply('[not json]', allowed)).toThrow(JudgeFormatError);
    expect(() => parseJudgeReply('{"n":1,"grade":3}', allowed)).toThrow(JudgeFormatError);
  });

  it('throws rather than returning nothing when every grade was invalid', () => {
    // Silently returning [] would let the caller mark everything unjudged without
    // ever retrying, turning a fixable formatting slip into lost labels.
    expect(() => parseJudgeReply('[{"n":42,"grade":3,"why":"x"}]', allowed)).toThrow(JudgeFormatError);
  });

  it('never yields a grade outside 0..3', () => {
    const out = parseJudgeReply('[{"n":1,"grade":0,"why":""},{"n":2,"grade":3,"why":""}]', allowed);
    for (const g of out) expect([0, 1, 2, 3]).toContain(g.grade);
  });
});

describe('the rubric', () => {
  /**
   * These three anchors are the difference between a judge that measures
   * relevance and one that measures lexical overlap. Each is asserted because
   * losing one to an edit would silently change every number in the harness.
   */
  it('tells the judge that asking a question is not answering it', () => {
    expect(RUBRIC).toMatch(/ASKS this question/);
    expect(RUBRIC).toMatch(/Matching the question's words is not answering it/);
  });

  it('tells the judge to reject a different instance of the same kind of event', () => {
    expect(RUBRIC).toMatch(/DIFFERENT instance/);
  });

  it('tells the judge that write-ups postdate the events they describe', () => {
    expect(RUBRIC).toMatch(/timestamped days later/);
    expect(RUBRIC).toMatch(/recorded after it happens/);
  });

  it('asks for bare JSON, since a fence costs a parse attempt', () => {
    expect(RUBRIC).toMatch(/ONLY a JSON array/);
  });
});

describe('buildJudgeUser', () => {
  const candidate = (over: Partial<Candidate> = {}): Candidate => ({
    entryId: 1,
    sourceType: 'kdb_component',
    projectSlug: 'deepcast',
    title: 'analyzer-worker: queue had no consumer',
    body: 'full body text',
    occurredAt: '2026-07-21T10:00:00.000Z',
    ...over,
  });

  it('numbers candidates from 1 and shows type, project and date', () => {
    const prompt = buildJudgeUser('why?', 'incident', [candidate()]);
    expect(prompt).toContain('[1] deepcast / kdb_component (2026-07-21)');
    expect(prompt).toContain('analyzer-worker: queue had no consumer');
  });

  it('tells the judge what kind of question it is', () => {
    expect(buildJudgeUser('when?', 'temporal', [candidate()])).toContain('Question (temporal):');
  });

  /**
   * No rank and no score reach the judge. A judge shown the ranking it is
   * grading would let the current ranking bless itself, and every variant would
   * inherit that endorsement.
   */
  it('leaks neither rank nor score', () => {
    const prompt = buildJudgeUser('q', 'intent', [candidate(), candidate({ entryId: 2 })]);
    expect(prompt).not.toMatch(/score/i);
    expect(prompt).not.toMatch(/\brank\b/i);
  });

  it('truncates long bodies', () => {
    const prompt = buildJudgeUser('q', 'intent', [candidate({ body: 'y'.repeat(3000) })]);
    expect(prompt).toContain('…');
    expect(prompt.length).toBeLessThan(1500);
  });

  it('omits the date for an undated entry rather than inventing one', () => {
    const prompt = buildJudgeUser('q', 'intent', [candidate({ occurredAt: undefined })]);
    expect(prompt).toContain('[1] deepcast / kdb_component\n');
  });
});

describe('stratifiedSubsample', () => {
  const label = (grade: Grade, cls: QueryClass, id: number) => ({ grade, cls, id });

  /**
   * Most of a candidate pool is irrelevant, so a uniform sample would be almost
   * all grade 0 and the agreement statistic would be flattered by easy consensus
   * on obvious negatives — understating label noise exactly where decisions live.
   */
  it('covers every grade even when one dominates the pool', () => {
    const labels = [
      ...Array.from({ length: 60 }, (_, i) => label(0, 'definitional', i)),
      label(3, 'definitional', 100),
      label(2, 'definitional', 101),
    ];
    const picked = stratifiedSubsample(labels, 0.25, 1);
    expect(picked.some((l) => l.grade === 3)).toBe(true);
    expect(picked.some((l) => l.grade === 2)).toBe(true);
    expect(picked.filter((l) => l.grade === 0)).toHaveLength(15);
  });

  it('separates strata by class as well as grade', () => {
    const labels = [
      ...Array.from({ length: 8 }, (_, i) => label(3, 'temporal', i)),
      ...Array.from({ length: 8 }, (_, i) => label(3, 'definitional', i + 100)),
    ];
    const picked = stratifiedSubsample(labels, 0.5, 1);
    expect(picked.filter((l) => l.cls === 'temporal')).toHaveLength(4);
    expect(picked.filter((l) => l.cls === 'definitional')).toHaveLength(4);
  });

  it('is reproducible for a seed', () => {
    const labels = Array.from({ length: 20 }, (_, i) => label((i % 4) as Grade, 'intent', i));
    expect(stratifiedSubsample(labels, 0.3, 5)).toEqual(stratifiedSubsample(labels, 0.3, 5));
  });

  it('handles an empty set', () => {
    expect(stratifiedSubsample([], 0.25, 1)).toEqual([]);
  });
});
