/**
 * Tool-adoption analysis over Claude Code transcripts.
 *
 * The problem this solves: we tune the Assessor/Atlas MCP instructions based on
 * whether agents actually call those tools at the moments that warrant it — and
 * until now the only evidence was agents' own self-reports. Those are unreliable
 * by construction: an agent that never noticed a trigger will, when asked, produce
 * a fluent post-hoc justification indistinguishable from a real decision. That is
 * precisely the confabulation the "report the skip you ACTUALLY made" instruction
 * exists to counter, and it cannot be fixed by asking harder.
 *
 * So we do not ask. Transcripts under ~/.claude/projects record every tool call
 * AND the surrounding assistant text, with timestamps. Both signals we need are
 * already on disk:
 *
 *   TIER 1 (usage): did this session call assessor/atlas at all? Counted from
 *   tool_use blocks — deterministic, no model cooperation, and retrospective over
 *   every session ever run rather than only those after a hook was installed.
 *
 *   TIER 2 (missed triggers): did the session contain evidence that a documented
 *   trigger applied? Matched against the same conditions encoded in the server
 *   instructions (editing a failing test, asserting WHY after a git command,
 *   hedging about history). A match with no corresponding call is a CANDIDATE
 *   miss — the denominator that usage counts alone cannot give us.
 *
 * Tier 2 is a heuristic and is reported as candidates, never verdicts. Expect
 * false positives: not every "presumably" after a git command is an unverified
 * intent claim. The value is a short, checkable list, not a score.
 *
 * Everything here is read-only and local: it opens transcript files the user
 * already has and writes nothing back.
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

export interface TriggerHit {
  /** Which documented trigger matched. */
  rule: string;
  /** Which tool the trigger points at. */
  tool: 'assessor' | 'atlas';
  /** Trimmed excerpt so a human can judge the match without opening the file. */
  excerpt: string;
  at?: string;
}

export interface SessionAdoption {
  sessionId: string;
  project: string;
  cwd?: string;
  startedAt?: string;
  endedAt?: string;
  /** Assistant turns — a proxy for session size, so tiny sessions can be filtered. */
  turns: number;
  assessorCalls: number;
  atlasCalls: number;
  /** Tier 2: trigger evidence found in the transcript text. */
  triggers: TriggerHit[];
  /** Trigger evidence for a tool that was never called in this session. */
  missedAssessor: TriggerHit[];
  missedAtlas: TriggerHit[];
  /** The agent said it skipped without noticing — the highest-value signal. */
  admittedNotThoughtOf: boolean;
}

export interface AdoptionReport {
  generatedAt: string;
  sessionsScanned: number;
  sessionsWithTriggers: number;
  assessor: ToolAdoption;
  atlas: ToolAdoption;
  /** Sessions with candidate misses, worst first. */
  sessions: SessionAdoption[];
}

export interface ToolAdoption {
  sessionsUsed: number;
  totalCalls: number;
  /** Sessions where a trigger fired AND the tool was never called. */
  sessionsMissed: number;
  /** sessionsUsed / (sessionsUsed + sessionsMissed) — the number we tune against. */
  fireRate: number | null;
  /** Which rules most often go unanswered; where the instructions leak. */
  topMissedRules: { rule: string; count: number }[];
}

/**
 * Tier-2 detectors, kept deliberately in sync with the triggers documented in the
 * two servers' SERVER_INSTRUCTIONS. If a trigger is added there, add it here or it
 * becomes invisible to measurement.
 *
 * Patterns are intentionally narrow. A detector that fires on everything produces
 * a list nobody reads, which is worse than no list: broad recall would bury the
 * few real misses in noise and make the report feel wrong, so it gets ignored.
 */
interface Detector {
  rule: string;
  tool: 'assessor' | 'atlas';
  re: RegExp;
  /** Requires a git/grep call earlier in the session to count (the WHAT->WHY seam). */
  needsPriorLookup?: boolean;
}

export const DETECTORS: Detector[] = [
  // --- Atlas: history asserted rather than looked up -------------------------
  {
    rule: 'why-after-lookup',
    tool: 'atlas',
    // The seam: git said WHAT, the agent is now asserting WHY.
    re: /\b(?:presumably|likely because|probably because|this was probably|must have been|the rewrite (?:must have|collapsed|simplified))\b/i,
    needsPriorLookup: true,
  },
  {
    rule: 'unverified-history-claim',
    tool: 'atlas',
    re: /\b(?:I (?:could not|couldn't) verify|not independently verified|inference from (?:reading )?the code)\b/i,
  },
  {
    rule: 'past-behavior-report',
    tool: 'atlas',
    // Deliberately narrow. The first version included a bare /regressed/, which
    // matched the routine "…and nothing regressed" every agent writes after a
    // test run: 175 hits on real transcripts, essentially all noise. A detector
    // that floods the report gets the whole report ignored, so this now requires
    // an assertion that something USED to behave differently — the thing whose
    // history is worth looking up.
    re: /\b(?:it (?:worked|used to work)\s+(?:before|fine|until)|used to (?:work|be)\b(?!\s*(?:like|the same))|worked before the (?:redesign|rewrite|change)|we (?:tried|did) this before|this (?:regressed|used to)|has regressed|regression (?:from|introduced by))\b/i,
  },

  // --- Assessor: decisions made without an independent read ------------------
  {
    rule: 'failure-signal-talked-past',
    tool: 'assessor',
    // Must express that the TEST is at fault, not merely that a test is being
    // edited. "Update the test to also cover X" is ordinary test-writing; the
    // earlier /update(d|ing)? the test to/ matched it and produced mostly noise.
    // What matters is the agent concluding the failing signal is wrong.
    re: /\b(?:the test(?:'s| was| is|s were| assertion(?: was)?)?\s*(?:was|is|were)?\s*wrong|test rot\b|my (?:test )?assertion was wrong|relax(?:ed|ing) the assertion|assertion was too strict|the test,? not the code|wrong,? not the code)/i,
  },
  {
    rule: 'rejected-alternative',
    tool: 'assessor',
    // {1,60} not {3,60}: a short subject ("I considered X but rejected it")
    // silently failed to match, and an under-matching detector is the worst
    // failure here — it produces a clean report that reads as "no misses".
    //
    // A bare /rejected (it|that|this)/ was dropped: on real transcripts it hit
    // "strict schema rejected it", where "reject" is the SYSTEM's behavior, not
    // the agent discarding an alternative. The subject must be the agent.
    re: /\b(?:I considered .{1,60}?\b(?:but|and rejected)|considered and rejected|I rejected (?:it|that|this)\b|(?:I|we) decided against|weighed .{1,40}? and (?:chose|went with))\b/i,
  },
  {
    rule: 'invented-rule-in-shared-code',
    tool: 'assessor',
    re: /\b(?:defaults? to|falls? back to|precedence order|tie-?break)\b.{0,80}\b(?:I (?:chose|picked|decided)|seems? (?:right|sensible)|felt right)\b/i,
  },
  {
    rule: 'breaking-change-accepted',
    tool: 'assessor',
    re: /\b(?:this is (?:a )?breaking|breaking change|accepted (?:the )?break)\b/i,
  },
];

/** The agent volunteering that it simply forgot — worth surfacing on its own. */
const NOT_THOUGHT_OF = /did not think of it|didn't think of it|never crossed my mind|it simply hadn't crossed/i;

/** Evidence the agent had already looked something up with git/grep. */
const PRIOR_LOOKUP = /\b(?:git log|git show|git blame|git diff|rg |grep -)/;

const ASSESSOR_TOOL = /^mcp__assessor__/;
const ATLAS_TOOL = /^mcp__atlas__/;
/** Direct HTTP calls to either service count as use — the MCP tools can drop mid-session. */
const DIRECT_API = /\b(?:127\.0\.0\.1|localhost):(?:8710|8711|8770)\b/;

function excerpt(text: string, match: RegExpMatchArray): string {
  const i = Math.max(0, (match.index ?? 0) - 90);
  return text.slice(i, (match.index ?? 0) + 150).replace(/\s+/g, ' ').trim();
}

/**
 * Scan one transcript. Streams line-by-line: these files reach tens of MB and
 * loading one wholesale to count a handful of matches is needless memory.
 */
export async function analyzeTranscript(path: string): Promise<SessionAdoption | null> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

  const s: SessionAdoption = {
    sessionId: basename(path).replace(/\.jsonl$/, ''),
    project: basename(path.split('/').slice(-2)[0] ?? ''),
    turns: 0,
    assessorCalls: 0,
    atlasCalls: 0,
    triggers: [],
    missedAssessor: [],
    missedAtlas: [],
    admittedNotThoughtOf: false,
  };

  let sawLookup = false;
  let any = false;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // A partially-written trailing line is normal on a live session.
    }
    if (d.type !== 'assistant' && d.type !== 'user') continue;
    any = true;
    if (d.cwd && !s.cwd) s.cwd = d.cwd;
    if (d.timestamp) {
      if (!s.startedAt) s.startedAt = d.timestamp;
      s.endedAt = d.timestamp;
    }

    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    if (d.type === 'assistant') s.turns++;

    for (const b of content) {
      if (!b || typeof b !== 'object') continue;

      if (b.type === 'tool_use') {
        const name = String(b.name ?? '');
        if (ASSESSOR_TOOL.test(name)) s.assessorCalls++;
        else if (ATLAS_TOOL.test(name)) s.atlasCalls++;
        const raw = JSON.stringify(b.input ?? {});
        if (PRIOR_LOOKUP.test(raw)) sawLookup = true;
        // curl/fetch straight at either service still counts as using it.
        if (DIRECT_API.test(raw)) {
          if (/8770/.test(raw)) s.assessorCalls++;
          else s.atlasCalls++;
        }
        continue;
      }

      if (b.type !== 'text' || typeof b.text !== 'string') continue;
      const text: string = b.text;
      if (d.type === 'assistant' && NOT_THOUGHT_OF.test(text)) s.admittedNotThoughtOf = true;

      // Only assistant prose is scanned for triggers: user text describes what
      // they want, not what the agent concluded, and matching it would blame the
      // agent for the user's phrasing.
      if (d.type !== 'assistant') continue;
      for (const det of DETECTORS) {
        if (det.needsPriorLookup && !sawLookup) continue;
        const m = text.match(det.re);
        if (!m) continue;
        // One hit per rule per session: the same reasoning restated across turns
        // is one missed call, not five.
        if (s.triggers.some((t) => t.rule === det.rule)) continue;
        s.triggers.push({
          rule: det.rule,
          tool: det.tool,
          excerpt: excerpt(text, m),
          at: d.timestamp,
        });
      }
    }
  }

  if (!any) return null;
  s.missedAssessor = s.assessorCalls === 0 ? s.triggers.filter((t) => t.tool === 'assessor') : [];
  s.missedAtlas = s.atlasCalls === 0 ? s.triggers.filter((t) => t.tool === 'atlas') : [];
  return s;
}

async function* transcriptFiles(root: string): AsyncGenerator<string> {
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return; // No transcripts on this machine yet.
  }
  for (const dir of dirs) {
    const full = join(root, dir);
    try {
      if (!(await stat(full)).isDirectory()) continue;
      for (const f of await readdir(full)) {
        if (f.endsWith('.jsonl')) yield join(full, f);
      }
    } catch {
      continue;
    }
  }
}

export interface AdoptionOptions {
  /** Transcript root; defaults to ~/.claude/projects. */
  root?: string;
  /** Only sessions starting on/after this ISO date. */
  since?: string;
  /** Only sessions starting BEFORE this ISO date (exclusive upper bound). */
  until?: string;
  /** Substring filter on the project directory name. */
  project?: string;
  /** Ignore sessions below this many assistant turns (trivial one-shot runs). */
  minTurns?: number;
}

/** Per-tool before/after movement, with the sample size that produced it. */
export interface ToolDelta {
  before: ToolAdoption;
  after: ToolAdoption;
  /** after.fireRate - before.fireRate; null if either window had no opportunity. */
  fireRateDelta: number | null;
  /** Qualifying sessions (used + missed) per window — the n behind the rates. */
  beforeN: number;
  afterN: number;
  /**
   * False when either window is too small for the delta to mean anything.
   * A jump from 0/1 to 3/3 is not evidence, and a comparison that reports it
   * as +100% invites exactly the over-reading this tool exists to prevent.
   */
  significant: boolean;
}

export interface AdoptionComparison {
  generatedAt: string;
  before: { since?: string; until: string; report: AdoptionReport };
  after: { since: string; until?: string; report: AdoptionReport };
  assessor: ToolDelta;
  atlas: ToolDelta;
  /** Rules that got worse, best-to-worst by increase in miss count. */
  regressedRules: { rule: string; before: number; after: number }[];
  /** Rules that improved. */
  improvedRules: { rule: string; before: number; after: number }[];
  /** Plain-language caveats that must accompany any reading of this. */
  caveats: string[];
}

/** Below this many qualifying sessions in a window, a rate delta is noise. */
export const MIN_SAMPLE_FOR_SIGNIFICANCE = 10;

/**
 * Compare two time windows, split at `at`. Used to check whether an instruction
 * change moved the needle: run the same command either side of the edit date.
 *
 * Deliberately conservative about significance. These are small samples from one
 * machine, and fire rate is a ratio over a handful of sessions — it swings wildly
 * at low n. The comparison therefore reports the raw movement AND whether the
 * sample supports reading anything into it, so a 3-session window cannot be
 * mistaken for a result.
 */
export async function compareAdoption(
  at: string,
  opts: AdoptionOptions = {},
): Promise<AdoptionComparison> {
  const [before, after] = await Promise.all([
    analyzeAdoption({ ...opts, until: at }),
    analyzeAdoption({ ...opts, since: at }),
  ]);

  const delta = (which: 'assessor' | 'atlas'): ToolDelta => {
    const b = before[which];
    const a = after[which];
    const beforeN = b.sessionsUsed + b.sessionsMissed;
    const afterN = a.sessionsUsed + a.sessionsMissed;
    return {
      before: b,
      after: a,
      fireRateDelta:
        b.fireRate === null || a.fireRate === null
          ? null
          : Number((a.fireRate - b.fireRate).toFixed(3)),
      beforeN,
      afterN,
      significant:
        beforeN >= MIN_SAMPLE_FOR_SIGNIFICANCE && afterN >= MIN_SAMPLE_FOR_SIGNIFICANCE,
    };
  };

  const rulesOf = (r: AdoptionReport) => {
    const m = new Map<string, number>();
    for (const t of [...r.assessor.topMissedRules, ...r.atlas.topMissedRules]) {
      m.set(t.rule, (m.get(t.rule) ?? 0) + t.count);
    }
    return m;
  };
  const rb = rulesOf(before);
  const ra = rulesOf(after);
  const moved = [...new Set([...rb.keys(), ...ra.keys()])].map((rule) => ({
    rule,
    before: rb.get(rule) ?? 0,
    after: ra.get(rule) ?? 0,
  }));

  const caveats: string[] = [];
  const assessor = delta('assessor');
  const atlas = delta('atlas');
  if (!assessor.significant || !atlas.significant) {
    caveats.push(
      `Sample too small for a reliable rate comparison (need >= ${MIN_SAMPLE_FOR_SIGNIFICANCE} ` +
        'qualifying sessions per window). Read the raw counts, not the percentage.',
    );
  }
  if (before.sessionsScanned === 0 || after.sessionsScanned === 0) {
    caveats.push('One window contains no sessions at all — nothing to compare.');
  }
  // Miss counts scale with volume, so a window with far more sessions will show
  // more misses even at an identical rate. Say so rather than let the raw
  // rule deltas be read as behavior change.
  const ratio =
    before.sessionsScanned && after.sessionsScanned
      ? after.sessionsScanned / before.sessionsScanned
      : null;
  if (ratio !== null && (ratio > 2 || ratio < 0.5)) {
    caveats.push(
      `Windows differ a lot in size (${before.sessionsScanned} vs ${after.sessionsScanned} ` +
        'sessions); rule counts are absolute, so compare rates rather than counts.',
    );
  }
  caveats.push(
    'Tier-2 hits are heuristic candidates; a rate change can reflect changed phrasing ' +
      'rather than changed behavior.',
  );

  return {
    generatedAt: new Date().toISOString(),
    before: { since: opts.since, until: at, report: before },
    after: { since: at, until: opts.until, report: after },
    assessor,
    atlas,
    regressedRules: moved.filter((r) => r.after > r.before).sort((a, b) => b.after - b.before - (a.after - a.before)),
    improvedRules: moved.filter((r) => r.after < r.before).sort((a, b) => a.after - a.before - (b.after - b.before)),
    caveats,
  };
}

export async function analyzeAdoption(opts: AdoptionOptions = {}): Promise<AdoptionReport> {
  const root = opts.root ?? join(homedir(), '.claude', 'projects');
  const minTurns = opts.minTurns ?? 5;
  const sessions: SessionAdoption[] = [];

  for await (const file of transcriptFiles(root)) {
    if (opts.project && !file.includes(opts.project)) continue;
    let s: SessionAdoption | null = null;
    try {
      s = await analyzeTranscript(file);
    } catch {
      continue; // An unreadable transcript must not abort the whole report.
    }
    if (!s || s.turns < minTurns) continue;
    if (opts.since && (s.startedAt ?? '') < opts.since) continue;
    // Exclusive upper bound so `until: X` and `since: X` partition cleanly with
    // no session counted in both windows of a comparison.
    if (opts.until && (s.startedAt ?? '') >= opts.until) continue;
    sessions.push(s);
  }

  const tally = (which: 'assessor' | 'atlas'): ToolAdoption => {
    const callsKey = which === 'assessor' ? 'assessorCalls' : 'atlasCalls';
    const missKey = which === 'assessor' ? 'missedAssessor' : 'missedAtlas';
    const used = sessions.filter((s) => s[callsKey] > 0);
    const missed = sessions.filter((s) => s[missKey].length > 0);
    const rules = new Map<string, number>();
    for (const s of missed) {
      for (const t of s[missKey]) rules.set(t.rule, (rules.get(t.rule) ?? 0) + 1);
    }
    const denom = used.length + missed.length;
    return {
      sessionsUsed: used.length,
      totalCalls: sessions.reduce((n, s) => n + s[callsKey], 0),
      sessionsMissed: missed.length,
      // Null rather than 0 when nothing qualified: "no opportunities" and "never
      // fired" are different findings and must not render as the same number.
      fireRate: denom ? Number((used.length / denom).toFixed(3)) : null,
      topMissedRules: [...rules.entries()]
        .map(([rule, count]) => ({ rule, count }))
        .sort((a, b) => b.count - a.count),
    };
  };

  return {
    generatedAt: new Date().toISOString(),
    sessionsScanned: sessions.length,
    sessionsWithTriggers: sessions.filter((s) => s.triggers.length > 0).length,
    assessor: tally('assessor'),
    atlas: tally('atlas'),
    sessions: sessions
      .filter((s) => s.missedAssessor.length || s.missedAtlas.length || s.admittedNotThoughtOf)
      .sort(
        (a, b) =>
          b.missedAssessor.length + b.missedAtlas.length -
          (a.missedAssessor.length + a.missedAtlas.length),
      ),
  };
}
