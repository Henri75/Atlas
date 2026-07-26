import { describe, expect, it } from 'vitest';
import { rerankForContext } from '@atlas/core';
import type { SearchHit } from '@atlas/core';

/**
 * The regression these guard: a tool that indexes its own operators'
 * conversations ranks debugging transcripts about "feature X" above the doc
 * that explains X, because the transcript echoes the question verbatim. Ask
 * then answers from chatter. rerankForContext must promote the doc into the
 * window and stop sessions from filling it.
 */

const hit = (id: number, score: number, sourceType: SearchHit['sourceType']): SearchHit => ({
  entryId: id,
  score,
  projectSlug: 'p',
  sourceType,
  title: `t${id}`,
  snippet: 's',
  sourcePath: `/x${id}`,
});

describe('rerankForContext', () => {
  it('promotes an authoritative doc over higher-scoring session chatter', () => {
    // Sessions out-score the doc on raw relevance, exactly the drain-feature bug.
    const pool = [
      hit(1, 0.99, 'claude_session'),
      hit(2, 0.98, 'claude_session'),
      hit(3, 0.97, 'claude_session'),
      hit(4, 0.6, 'doc'), // the block that actually explains the feature
    ];
    const out = rerankForContext(pool, 4);
    expect(out.map((h) => h.entryId)).toContain(4);
    // With the weight, the doc (0.6*1.35=0.81) beats a 0.8-weighted session.
    expect(out[0].sourceType).toBe('doc');
  });

  it('caps claude_session blocks at half the window when better types exist', () => {
    const pool = [
      hit(1, 0.99, 'claude_session'),
      hit(2, 0.98, 'claude_session'),
      hit(3, 0.97, 'claude_session'),
      hit(4, 0.96, 'claude_session'),
      hit(5, 0.5, 'doc'),
      hit(6, 0.5, 'kdb_component'),
    ];
    const out = rerankForContext(pool, 4);
    const sessions = out.filter((h) => h.sourceType === 'claude_session').length;
    expect(sessions).toBeLessThanOrEqual(2); // floor(4 * 0.5)
    // Freed slots go to the authoritative sources.
    expect(out.some((h) => h.sourceType === 'doc')).toBe(true);
    expect(out.some((h) => h.sourceType === 'kdb_component')).toBe(true);
  });

  it('still fills the window from sessions when nothing else matches', () => {
    const pool = [
      hit(1, 0.9, 'claude_session'),
      hit(2, 0.8, 'claude_session'),
      hit(3, 0.7, 'claude_session'),
    ];
    const out = rerankForContext(pool, 3);
    // A genuinely session-only answer must not be starved by the cap.
    expect(out).toHaveLength(3);
  });

  it('never returns more than k', () => {
    const pool = Array.from({ length: 20 }, (_, i) => hit(i, 1 - i / 100, 'doc'));
    expect(rerankForContext(pool, 8)).toHaveLength(8);
  });
});

/**
 * Near-duplicate suppression.
 *
 * In the 2026-07-15 incident three of the fourteen context blocks were distinct
 * entries with identical titles and timestamps — the same session summary
 * recorded three times. They consumed a fifth of the window and contributed one
 * fact between them.
 */
describe('rerankForContext near-duplicate suppression', () => {
  const dup = (id: number, score: number, title: string, occurredAt: string): SearchHit => ({
    entryId: id,
    score,
    projectSlug: 'p',
    sourceType: 'claude_session',
    title,
    snippet: 's',
    occurredAt,
    sourcePath: `/x${id}`,
  });

  it('keeps only the best of several entries sharing a title and timestamp', () => {
    const pool = [
      dup(1, 0.9, 'Summary: comprehensive root cause analysis', '2025-11-25T10:55:42.276Z'),
      dup(2, 0.8, 'Summary: comprehensive root cause analysis', '2025-11-25T10:55:42.276Z'),
      dup(3, 0.7, 'Summary: comprehensive root cause analysis', '2025-11-25T10:55:42.276Z'),
      hit(4, 0.5, 'doc'),
      hit(5, 0.4, 'kdb_component'),
    ];
    const out = rerankForContext(pool, 5);
    const ids = out.map((h) => h.entryId);
    // Exactly one of the triplet survives, and it is the highest-scoring one.
    expect(ids.filter((i) => [1, 2, 3].includes(i))).toEqual([1]);
    // The freed slots go to material that actually says something else.
    expect(ids).toContain(4);
    expect(ids).toContain(5);
  });

  it('does not collapse same-titled entries from different times', () => {
    const pool = [
      dup(1, 0.9, 'Prompt: continue', '2026-07-01T10:00:00.000Z'),
      dup(2, 0.8, 'Prompt: continue', '2026-07-20T10:00:00.000Z'),
    ];
    expect(rerankForContext(pool, 5)).toHaveLength(2);
  });

  it('never returns an empty window just because everything looked duplicated', () => {
    const pool = [
      dup(1, 0.9, 'same', '2026-07-01T10:00:00.000Z'),
      dup(2, 0.8, 'same', '2026-07-01T10:00:00.000Z'),
    ];
    expect(rerankForContext(pool, 5).length).toBeGreaterThan(0);
  });
});

/**
 * Recency.
 *
 * Ranking had no time term at all, so a question about last week competed
 * head-to-head with two years of history on pure similarity. The correction
 * must stay gentle: 20260710-docs-staleness-query-time.md deliberately keeps
 * old-but-current docs ranking well ("an old runbook that simply never needed
 * edits must not be buried"), and a blanket recency boost would quietly reverse
 * that decision.
 */
describe('rerankForContext recency', () => {
  const aged = (id: number, score: number, daysAgo: number): SearchHit => ({
    entryId: id,
    score,
    projectSlug: 'p',
    sourceType: 'kdb_component',
    title: `t${id}`,
    snippet: 's',
    occurredAt: new Date(Date.now() - daysAgo * 864e5).toISOString(),
    sourcePath: `/x${id}`,
  });

  it('breaks a near-tie in favour of the more recent entry', () => {
    const out = rerankForContext([aged(1, 0.8, 900), aged(2, 0.8, 1)], 2);
    expect(out[0]!.entryId).toBe(2);
  });

  it('does not let recency overturn a clearly better match', () => {
    // A far stronger old hit must still win: the boost is a tie-breaker, not a
    // re-ranking axis. Otherwise "what is X" starts answering from yesterday's
    // chatter instead of the doc that defines X.
    const out = rerankForContext([aged(1, 0.95, 900), aged(2, 0.45, 1)], 2);
    expect(out[0]!.entryId).toBe(1);
  });

  /**
   * An undated entry ranks as though it were old — factor 1.0, the limit a very
   * old dated entry approaches — rather than being docked for having no
   * timestamp. Absence of a date says nothing about age, and several source
   * types routinely lack one, so a penalty would bury them wholesale.
   */
  it('treats an undated entry as maximally old rather than dropping it', () => {
    const undated: SearchHit = { ...hit(9, 0.8, 'kdb_component') };
    // A better raw score still wins despite carrying no date.
    expect(rerankForContext([undated, aged(2, 0.7, 400)], 2)[0]!.entryId).toBe(9);
    // Against an equally-scored ancient entry it sits immediately alongside,
    // not far below: undated is the floor of the recency curve (factor 1.0, the
    // limit dated entries approach), never a penalty beneath it.
    const out = rerankForContext([undated, aged(3, 0.8, 900)], 2);
    expect(out.map((h) => h.entryId).sort()).toEqual([3, 9]);
  });
});
