import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DETECTORS,
  MIN_SAMPLE_FOR_SIGNIFICANCE,
  analyzeAdoption,
  analyzeTranscript,
  compareAdoption,
} from '../../packages/core/src/adoption.js';

/**
 * These pin the measurement itself. The whole point of reading transcripts rather
 * than asking the agent is that the number is trustworthy — a detector that
 * silently stops matching, or a fire rate that counts "no opportunity" as "never
 * fired", would quietly mislead exactly the tuning decisions it exists to inform.
 */

let root: string;

const assistant = (text: string, ts = '2026-07-19T10:00:00Z') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    cwd: '/repo',
    message: { content: [{ type: 'text', text }] },
  });

const toolUse = (name: string, input: unknown = {}, ts = '2026-07-19T10:00:00Z') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    cwd: '/repo',
    message: { content: [{ type: 'tool_use', name, input }] },
  });

const user = (text: string) =>
  JSON.stringify({ type: 'user', timestamp: '2026-07-19T09:59:00Z', message: { content: [{ type: 'text', text }] } });

/** Sessions below minTurns are ignored, so pad to clear the floor. */
const padding = (n = 6) => Array.from({ length: n }, () => assistant('routine work'));

async function writeSession(project: string, id: string, lines: string[]) {
  const dir = join(root, project);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
  return join(dir, `${id}.jsonl`);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'adoption-'));
});

describe('tier 1 — usage counting', () => {
  it('counts MCP calls to each service', async () => {
    const f = await writeSession('-repo-a', 'sess-usage', [
      ...padding(),
      toolUse('mcp__assessor__assess', { content: 'x' }),
      toolUse('mcp__atlas__atlas_ask', { question: 'y' }),
      toolUse('mcp__atlas__atlas_search', { query: 'z' }),
      toolUse('Bash', { command: 'ls' }),
    ]);
    const s = (await analyzeTranscript(f))!;
    expect(s.assessorCalls).toBe(1);
    expect(s.atlasCalls).toBe(2);
  });

  /**
   * The MCP tools drop out of a running session when either server restarts, so
   * agents fall back to curling the HTTP API. That is still using the tool and
   * must not read as a miss.
   */
  it('counts direct HTTP calls to either service as use', async () => {
    const f = await writeSession('-repo-a', 'sess-http', [
      ...padding(),
      toolUse('Bash', { command: 'curl -s http://127.0.0.1:8710/api/ask -d {}' }),
      toolUse('Bash', { command: 'curl -s http://localhost:8770/mcp' }),
    ]);
    const s = (await analyzeTranscript(f))!;
    expect(s.atlasCalls).toBe(1);
    expect(s.assessorCalls).toBe(1);
  });

  it('survives a truncated trailing line from a live session', async () => {
    const dir = join(root, '-repo-a');
    await mkdir(dir, { recursive: true });
    const p = join(dir, 'sess-partial.jsonl');
    await writeFile(p, [...padding(), toolUse('mcp__assessor__assess'), '{"type":"assis'].join('\n'));
    const s = await analyzeTranscript(p);
    expect(s?.assessorCalls).toBe(1);
  });
});

describe('tier 2 — trigger detection', () => {
  it('flags a WHY claim only after a git/grep lookup (the seam)', async () => {
    const withLookup = await writeSession('-repo-b', 'sess-seam', [
      ...padding(),
      toolUse('Bash', { command: 'git log -S sortBy --oneline' }),
      assistant('The rewrite must have collapsed the two dates into one field.'),
    ]);
    const s = (await analyzeTranscript(withLookup))!;
    expect(s.triggers.map((t) => t.rule)).toContain('why-after-lookup');
    expect(s.missedAtlas.length).toBeGreaterThan(0);

    // Same sentence with no prior lookup is not the seam — don't cry wolf.
    const noLookup = await writeSession('-repo-b', 'sess-noseam', [
      ...padding(),
      assistant('The rewrite must have collapsed the two dates into one field.'),
    ]);
    const s2 = (await analyzeTranscript(noLookup))!;
    expect(s2.triggers.map((t) => t.rule)).not.toContain('why-after-lookup');
  });

  it('flags talking past a failure signal', async () => {
    const f = await writeSession('-repo-b', 'sess-test', [
      ...padding(),
      assistant('My test assertion was wrong — the instructions changed legitimately.'),
    ]);
    const s = (await analyzeTranscript(f))!;
    expect(s.triggers.map((t) => t.rule)).toContain('failure-signal-talked-past');
    expect(s.missedAssessor.length).toBe(1);
  });

  it('does not blame the agent for the user’s wording', async () => {
    const f = await writeSession('-repo-b', 'sess-userword', [
      ...padding(),
      user('presumably the rewrite broke it, and the test is wrong'),
    ]);
    const s = (await analyzeTranscript(f))!;
    expect(s.triggers).toHaveLength(0);
  });

  it('counts one hit per rule per session, not per restatement', async () => {
    const f = await writeSession('-repo-b', 'sess-dupe', [
      ...padding(),
      assistant('I considered X but rejected it for latency.'),
      assistant('Again: I considered X but rejected it for latency.'),
      assistant('As said, I considered X but rejected it.'),
    ]);
    const s = (await analyzeTranscript(f))!;
    expect(s.triggers.filter((t) => t.rule === 'rejected-alternative')).toHaveLength(1);
  });

  /** A trigger the agent DID answer is not a miss. */
  it('does not report a miss when the tool was actually called', async () => {
    const f = await writeSession('-repo-b', 'sess-answered', [
      ...padding(),
      assistant('I considered X but rejected it.'),
      toolUse('mcp__assessor__assess', { content: 'review this' }),
    ]);
    const s = (await analyzeTranscript(f))!;
    expect(s.triggers.length).toBeGreaterThan(0);
    expect(s.missedAssessor).toHaveLength(0);
  });

  it('surfaces an admitted "did not think of it"', async () => {
    const f = await writeSession('-repo-b', 'sess-admit', [
      ...padding(),
      assistant('Atlas usage: none — did not think of it.'),
    ]);
    expect((await analyzeTranscript(f))!.admittedNotThoughtOf).toBe(true);
  });

  it('keeps an excerpt so a human can check the match', async () => {
    const f = await writeSession('-repo-b', 'sess-excerpt', [
      ...padding(),
      assistant('Looking at it now, my test assertion was wrong because the prose moved.'),
    ]);
    const s = (await analyzeTranscript(f))!;
    expect(s.triggers[0].excerpt).toContain('test assertion was wrong');
  });
});

describe('report aggregation', () => {
  it('separates "no opportunity" from "never fired"', async () => {
    // A quiet session: no triggers, no calls. Fire rate must be null, not 0 —
    // rendering it as 0% would read as a failure that never had a chance to occur.
    await writeSession('-repo-quiet', 'sess-quiet', padding(8));
    const r = await analyzeAdoption({ root, project: '-repo-quiet' });
    expect(r.sessionsScanned).toBe(1);
    expect(r.assessor.fireRate).toBeNull();
    expect(r.atlas.fireRate).toBeNull();
  });

  it('computes fire rate over used + missed sessions', async () => {
    await writeSession('-repo-rate', 'used', [
      ...padding(),
      assistant('I considered X but rejected it.'),
      toolUse('mcp__assessor__assess'),
    ]);
    await writeSession('-repo-rate', 'missed', [
      ...padding(),
      assistant('I considered Y but rejected it.'),
    ]);
    const r = await analyzeAdoption({ root, project: '-repo-rate' });
    expect(r.assessor.sessionsUsed).toBe(1);
    expect(r.assessor.sessionsMissed).toBe(1);
    expect(r.assessor.fireRate).toBe(0.5);
    expect(r.assessor.topMissedRules[0]).toEqual({ rule: 'rejected-alternative', count: 1 });
  });

  it('ignores trivial sessions below the turn floor', async () => {
    await writeSession('-repo-tiny', 'tiny', [assistant('I considered X but rejected it.')]);
    const r = await analyzeAdoption({ root, project: '-repo-tiny', minTurns: 5 });
    expect(r.sessionsScanned).toBe(0);
  });

  it('returns an empty report rather than throwing when there are no transcripts', async () => {
    const r = await analyzeAdoption({ root: join(root, 'does-not-exist') });
    expect(r.sessionsScanned).toBe(0);
    expect(r.sessions).toEqual([]);
  });
});

describe('detector hygiene', () => {
  /**
   * Detectors mirror the triggers documented in each server's SERVER_INSTRUCTIONS.
   * A trigger with no detector is invisible to measurement, which is how a tuning
   * loop silently stops working.
   */
  it('covers both tools and has no duplicate rule names', () => {
    const names = DETECTORS.map((d) => d.rule);
    expect(new Set(names).size).toBe(names.length);
    expect(DETECTORS.some((d) => d.tool === 'assessor')).toBe(true);
    expect(DETECTORS.some((d) => d.tool === 'atlas')).toBe(true);
  });

  it('does not fire on ordinary engineering prose', async () => {
    const f = await writeSession('-repo-clean', 'sess-clean', [
      ...padding(),
      assistant('Added the index, ran the suite, 42 tests pass. Committed as abc123.'),
      assistant('The endpoint returns 200 and the payload shape matches the schema.'),
    ]);
    const s = (await analyzeTranscript(f))!;
    expect(s.triggers).toHaveLength(0);
  });

  /**
   * Regression: the first detector pass ran against 3,760 real transcripts and
   * produced 175 past-behavior hits and 38 failure-signal hits that were almost
   * entirely routine phrasing. A detector that floods the report gets the report
   * ignored, so these two lines are pinned as NON-matches.
   */
  it('ignores the routine "nothing regressed" after a test run', async () => {
    const f = await writeSession('-repo-clean', 'sess-regress', [
      ...padding(),
      assistant('Let me run the full suite one more time to be sure nothing regressed.'),
      assistant('All green — no regressions.'),
    ]);
    const s = (await analyzeTranscript(f))!;
    expect(s.triggers.map((t) => t.rule)).not.toContain('past-behavior-report');
  });

  it('ignores ordinary test-writing, flags only blaming the test', async () => {
    const ordinary = await writeSession('-repo-clean', 'sess-writing', [
      ...padding(),
      assistant('Now update the test to also verify the OS whitelist guard.'),
      assistant('I extended the test to cover the empty-input case.'),
    ]);
    expect((await analyzeTranscript(ordinary))!.triggers.map((t) => t.rule)).not.toContain(
      'failure-signal-talked-past',
    );

    const blaming = await writeSession('-repo-clean', 'sess-blaming', [
      ...padding(),
      assistant('The test was wrong, not the code — it asserts the old 60s threshold.'),
    ]);
    expect((await analyzeTranscript(blaming))!.triggers.map((t) => t.rule)).toContain(
      'failure-signal-talked-past',
    );
  });

  it('still catches a genuine past-behavior report', async () => {
    const f = await writeSession('-repo-clean', 'sess-genuine', [
      ...padding(),
      assistant('It worked before the redesign — the wall rendered at Low quality fine.'),
    ]);
    expect((await analyzeTranscript(f))!.triggers.map((t) => t.rule)).toContain(
      'past-behavior-report',
    );
  });
});

/**
 * Real-transcript false positive: "strict schema rejected it" is the SYSTEM
 * rejecting input, not the agent discarding an alternative it weighed.
 */
describe('detector precision (from real-transcript tuning)', () => {
  it('does not read a system rejection as a weighed alternative', async () => {
    const f = await writeSession('-repo-fp', 'sess-schema', [
      ...padding(),
      assistant('LLM returned min_rating 4.3 (float) — the strict schema rejected it. Fixed with coercion.'),
    ]);
    expect((await analyzeTranscript(f))!.triggers.map((t) => t.rule)).not.toContain(
      'rejected-alternative',
    );
  });

  it('still catches the agent discarding an alternative', async () => {
    const f = await writeSession('-repo-fp', 'sess-real', [
      ...padding(),
      assistant('I considered a v2 tool but rejected it — two ambiguous tools in one surface.'),
    ]);
    expect((await analyzeTranscript(f))!.triggers.map((t) => t.rule)).toContain(
      'rejected-alternative',
    );
  });
});

/**
 * --compare exists to answer "did that instruction edit work?". The danger is
 * that fire rate is a ratio over a handful of sessions and swings wildly at low
 * n — a comparison that reports +100% off 3 sessions would manufacture exactly
 * the false confidence this tool is supposed to remove. These pin the guard.
 */
describe('compareAdoption', () => {
  const dated = (text: string, ts: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      cwd: '/repo',
      message: { content: [{ type: 'text', text }] },
    });
  const datedTool = (name: string, ts: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      cwd: '/repo',
      message: { content: [{ type: 'tool_use', name, input: {} }] },
    });
  const pad = (ts: string, n = 6) => Array.from({ length: n }, () => dated('routine', ts));

  it('splits cleanly at the boundary — no session in both windows', async () => {
    const proj = '-repo-cmp-split';
    await writeSession(proj, 'old', [
      ...pad('2026-06-01T10:00:00Z'),
      dated('I considered X but rejected it.', '2026-06-01T10:00:00Z'),
    ]);
    await writeSession(proj, 'new', [
      ...pad('2026-08-01T10:00:00Z'),
      dated('I considered Y but rejected it.', '2026-08-01T10:00:00Z'),
    ]);
    const c = await compareAdoption('2026-07-01', { root, project: proj });
    expect(c.before.report.sessionsScanned).toBe(1);
    expect(c.after.report.sessionsScanned).toBe(1);
  });

  it('flags a small sample instead of reporting a confident swing', async () => {
    const proj = '-repo-cmp-small';
    await writeSession(proj, 'b1', [
      ...pad('2026-06-01T10:00:00Z'),
      dated('I considered X but rejected it.', '2026-06-01T10:00:00Z'),
    ]);
    await writeSession(proj, 'a1', [
      ...pad('2026-08-01T10:00:00Z'),
      dated('I considered Y but rejected it.', '2026-08-01T10:00:00Z'),
      datedTool('mcp__assessor__assess', '2026-08-01T10:00:00Z'),
    ]);
    const c = await compareAdoption('2026-07-01', { root, project: proj });
    // The movement is real (0% -> 100%) but rests on one session per window.
    expect(c.assessor.fireRateDelta).toBe(1);
    expect(c.assessor.significant).toBe(false);
    expect(c.caveats.join(' ')).toMatch(/Sample too small/);
  });

  it('marks a comparison significant once both windows are big enough', async () => {
    const proj = '-repo-cmp-big';
    for (let i = 0; i < MIN_SAMPLE_FOR_SIGNIFICANCE; i++) {
      await writeSession(proj, `b${i}`, [
        ...pad('2026-06-01T10:00:00Z'),
        dated('I considered X but rejected it.', '2026-06-01T10:00:00Z'),
      ]);
      await writeSession(proj, `a${i}`, [
        ...pad('2026-08-01T10:00:00Z'),
        dated('I considered Y but rejected it.', '2026-08-01T10:00:00Z'),
        datedTool('mcp__assessor__assess', '2026-08-01T10:00:00Z'),
      ]);
    }
    const c = await compareAdoption('2026-07-01', { root, project: proj });
    expect(c.assessor.beforeN).toBeGreaterThanOrEqual(MIN_SAMPLE_FOR_SIGNIFICANCE);
    expect(c.assessor.significant).toBe(true);
    expect(c.assessor.before.fireRate).toBe(0);
    expect(c.assessor.after.fireRate).toBe(1);
  });

  it('reports which rules moved in each direction', async () => {
    const proj = '-repo-cmp-rules';
    await writeSession(proj, 'old1', [
      ...pad('2026-06-01T10:00:00Z'),
      dated('The test was wrong, not the code.', '2026-06-01T10:00:00Z'),
    ]);
    await writeSession(proj, 'new1', [
      ...pad('2026-08-01T10:00:00Z'),
      dated('I considered Y but rejected it.', '2026-08-01T10:00:00Z'),
    ]);
    const c = await compareAdoption('2026-07-01', { root, project: proj });
    expect(c.improvedRules.map((r) => r.rule)).toContain('failure-signal-talked-past');
    expect(c.regressedRules.map((r) => r.rule)).toContain('rejected-alternative');
  });

  it('warns when the windows differ wildly in size', async () => {
    const proj = '-repo-cmp-lop';
    await writeSession(proj, 'b', pad('2026-06-01T10:00:00Z'));
    for (let i = 0; i < 5; i++) {
      await writeSession(proj, `a${i}`, pad('2026-08-01T10:00:00Z'));
    }
    const c = await compareAdoption('2026-07-01', { root, project: proj });
    expect(c.caveats.join(' ')).toMatch(/differ a lot in size/);
  });

  it('always carries the heuristic caveat', async () => {
    const c = await compareAdoption('2026-07-01', { root, project: '-repo-cmp-split' });
    expect(c.caveats.join(' ')).toMatch(/heuristic candidates/);
  });
});
