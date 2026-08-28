import { createHash } from 'node:crypto';
import { loadBacklogView, tokenContainment } from './backlog.js';
import type { Catalog } from './catalog.js';
import type { AppConfig } from './config.js';
import { chatCompleteWithUsage, type LlmUsage } from './llm.js';
import { EXTRACTION_SCHEME } from './parsers/claudeJsonl.js';
import { cardFacts, substanceOf } from './sessionSearch.js';
import { tokenize } from './sparse.js';
import type { EntryKind, SessionCard, SessionRowFull, SourceType } from './types.js';

/**
 * Session insights: what a session did, decided, and left unfinished.
 *
 * Two layers, and the split is the whole design.
 *
 * The **facts layer** is derived, deterministic and free. It costs no tokens,
 * cannot hallucinate, and is complete on its own — you can read a whole report
 * with the LLM switched off and still know what happened. Most of it is already
 * classified: the transcript parser labels every message `prompt` / `plan` /
 * `insight` / `summary` / `action` / `response` at parse time, so "what did I
 * ask for" and "what did Claude conclude" are index lookups, not inferences.
 *
 * The **narrative layer** is one LLM call over that evidence. It answers the
 * questions the facts genuinely cannot — which decisions were made and why,
 * what broke and what fixed it, which of the loose ends actually matter. Every
 * field it produces is flagged `derived: 'llm'` all the way to the UI, and if
 * the model is unreachable the report still renders, marked unavailable, rather
 * than failing. That is the contract in
 * docs/adr/20260725-ask-answer-trust-contract.md applied to this surface.
 *
 * The budget matters more than it looks. The largest session in this corpus is
 * 1,304 entries; serialised whole it is megabytes. So the prompt is built ONLY
 * from prompts and distilled prose, hard-capped, and never from raw `response`
 * or `action` bodies.
 */

/**
 * Bump whenever the prompt or the parse contract changes.
 *
 * Without this in the cache key, improving the prompt would leave every
 * previously generated report served forever from cache — the fix would appear
 * to have done nothing, which is the worst kind of caching bug because it looks
 * like the change failed rather than like the cache is stale.
 */
export const INSIGHT_PROMPT_VERSION = 'v1';

export type SectionSource = 'facts' | 'llm' | 'mixed';

export interface SectionDef {
  id: string;
  /** Where the content comes from — surfaced in the UI, not just documentation. */
  source: SectionSource;
  /** Included when the caller does not name any sections. */
  byDefault: boolean;
}

/**
 * The section registry. Canonical here; `@atlas/shared` carries the matching
 * labels for both clients and a test pins the two id lists together.
 */
export const SESSION_INSIGHT_SECTIONS: SectionDef[] = [
  { id: 'overview', source: 'facts', byDefault: true },
  { id: 'goals', source: 'facts', byDefault: true },
  { id: 'did', source: 'facts', byDefault: true },
  { id: 'highlights', source: 'facts', byDefault: true },
  { id: 'decisions', source: 'llm', byDefault: true },
  { id: 'problems', source: 'llm', byDefault: true },
  { id: 'followups', source: 'mixed', byDefault: true },
  { id: 'backlog', source: 'facts', byDefault: true },
  { id: 'trail', source: 'facts', byDefault: true },
];

export const ALL_SECTION_IDS = SESSION_INSIGHT_SECTIONS.map((s) => s.id);
export const DEFAULT_SECTION_IDS = SESSION_INSIGHT_SECTIONS.filter((s) => s.byDefault).map((s) => s.id);
const LLM_SECTIONS = new Set(
  SESSION_INSIGHT_SECTIONS.filter((s) => s.source !== 'facts').map((s) => s.id),
);

/**
 * Resolve a requested section list.
 *
 * An unknown id is dropped rather than rejected: section ids are a growing
 * vocabulary and a client pinned to an older build must degrade to the sections
 * it does know, not fail the whole report. Requesting nothing valid falls back
 * to the defaults for the same reason.
 */
export function resolveSections(requested?: string[] | null): string[] {
  if (!requested?.length) return [...DEFAULT_SECTION_IDS];
  const valid = requested.filter((id) => ALL_SECTION_IDS.includes(id));
  return valid.length ? [...new Set(valid)] : [...DEFAULT_SECTION_IDS];
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** Tool names the transcript parser records as actions. */
const KNOWN_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'Agent', 'Skill']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface ParsedAction {
  tool: string;
  target?: string;
}

/**
 * Parse one line of an `action` entry body.
 *
 * The parser writes `"<Tool>: <target>"`, and the target is frequently a shell
 * command that contains its own colons — `Bash: git commit -m "fix: thing"`.
 * Splitting on the LAST colon, or on every colon, mangles exactly the commands
 * worth reporting, so this splits on the first `: ` only and validates the tool
 * against the known set rather than trusting whatever preceded it.
 */
export function parseActionLine(line: string): ParsedAction | null {
  const text = (line ?? '').trim();
  if (!text) return null;
  const sep = text.indexOf(': ');
  if (sep === -1) return KNOWN_TOOLS.has(text) ? { tool: text } : null;
  const tool = text.slice(0, sep);
  if (!KNOWN_TOOLS.has(tool)) return null;
  const target = text.slice(sep + 2).trim();
  return target ? { tool, target } : { tool };
}

/**
 * The head of a shell command — what was run, not how.
 *
 * Measured against the real action trail, which is why this is more careful
 * than it first looks. A naive version that split only on `&&` and skipped the
 * word `cd` reported the top command of a 303-action session as **`DeepCast;`
 * 145 times**: the commands were `cd /Users/serge/_CODING/DeepCast; make x`,
 * so `cd` was skipped, its PATH ARGUMENT was not, and the histogram named a
 * directory instead of a tool.
 *
 * So: every shell separator is a separator, `cd` consumes its argument, and
 * assignments and wrappers are stepped over. A command that yields nothing
 * usable returns '' and is dropped rather than contributing a junk row — the
 * transcript parser truncates targets at 80 characters, so a long one-liner
 * can genuinely have no readable verb left in it.
 */
/**
 * Shell keywords and wrappers that are never the tool being run.
 *
 * `for`/`do`/`done` show up because a one-liner is split on `;` and truncated
 * at 80 characters by the transcript parser, so a loop's fragment can end up
 * as the last segment. Reporting them alongside `docker` and `git` is the same
 * mistake as reporting a directory: the histogram should name what ran.
 */
const NOT_A_COMMAND = new Set([
  'sudo', 'time', 'command', 'exec', 'env', 'nohup', 'xargs',
  'do', 'done', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'if', 'case', 'esac',
]);

export function commandName(cmd: string): string {
  // Segments are scanned from the RIGHT, and the first one yielding a real
  // command wins. Taking only the last segment was almost right — it is what
  // turns `cd x && make test` into `make` — but it fails on a loop, where the
  // last segment is `done`: `for f in a b; do rg "$f"; done` has to report
  // `rg`. Walking right-to-left keeps the navigation-then-verb case and fixes
  // the loop case with the same rule.
  const segments = (cmd ?? '').split(/&&|\|\||;|\|/);
  for (let s = segments.length - 1; s >= 0; s--) {
    const words = segments[s]!.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      if (word.includes('=')) continue; // FOO=bar prefix
      if (word === 'cd' || word === 'pushd') {
        i++; // and the directory it navigates to
        continue;
      }
      if (NOT_A_COMMAND.has(word)) continue;
      if (word.startsWith('-')) continue;
      const name = word.replace(/^["']/, '').split('/').pop() ?? '';
      if (name) return name;
    }
  }
  return '';
}

export interface ActionRollup {
  tools: { name: string; count: number }[];
  files: { path: string; count: number }[];
  commands: { name: string; count: number }[];
  agents: string[];
  totalActions: number;
}

/** What the session actually did, from the 164k-entry action trail. */
export function rollupActions(bodies: string[]): ActionRollup {
  const tools = new Map<string, number>();
  const files = new Map<string, number>();
  const commands = new Map<string, number>();
  const agents = new Set<string>();
  let total = 0;

  for (const body of bodies) {
    for (const line of (body ?? '').split('\n')) {
      const a = parseActionLine(line);
      if (!a) continue;
      total++;
      tools.set(a.tool, (tools.get(a.tool) ?? 0) + 1);
      if (!a.target) continue;
      if (EDIT_TOOLS.has(a.tool)) files.set(a.target, (files.get(a.target) ?? 0) + 1);
      else if (a.tool === 'Bash') {
        const name = commandName(a.target);
        if (name) commands.set(name, (commands.get(name) ?? 0) + 1);
      } else agents.add(a.target);
    }
  }

  const top = (m: Map<string, number>, key: string, n: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, count]) => ({ [key]: k, count }) as any);

  return {
    tools: top(tools, 'name', 10),
    files: top(files, 'path', 20),
    commands: top(commands, 'name', 12),
    agents: [...agents].slice(0, 10),
    totalActions: total,
  };
}

/**
 * Phrases that mark work deliberately left undone.
 *
 * Chosen from what this codebase's own conventions actually write: `TEMPORARY
 * PATCH` is a required marker here, and an appended `backlog.log` line is how a
 * deferred item is recorded. Detection is literal and case-insensitive — a
 * regex that tried to be clever about English would produce false positives in
 * a corpus that is mostly code and shell output.
 */
export const FOLLOWUP_MARKERS: { id: string; re: RegExp }[] = [
  { id: 'temporary-patch', re: /TEMPORARY PATCH/i },
  { id: 'todo', re: /\bTODO\b/ },
  { id: 'fixme', re: /\bFIXME\b/ },
  { id: 'backlog', re: /backlog\.log/i },
  { id: 'unverified', re: /\bunverified\b/i },
  { id: 'next-step', re: /\bnext steps?\b/i },
  { id: 'follow-up', re: /\bfollow[- ]ups?\b/i },
  { id: 'deferred', re: /\bdeferred\b/i },
  { id: 'not-done', re: /\b(not done|left out|still needs|remains? open)\b/i },
];

export interface FollowupMarker {
  entryId: number;
  marker: string;
  sentence: string;
  occurredAt?: string;
}

/**
 * Find loose ends in the transcript, with the sentence that contains them.
 *
 * The sentence, not the whole message: a marker with no context is unactionable
 * and a whole message is unreadable in a list. This is evidence for the
 * narrative layer AND a standalone answer when the LLM is off — which is why it
 * is always returned alongside the distilled version, never replaced by it.
 */
export function scanFollowups(
  entries: { id: number; body: string; occurredAt?: string }[],
  max = 25,
): FollowupMarker[] {
  const out: FollowupMarker[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    for (const sentence of String(e.body ?? '').split(/(?<=[.!?\n])\s+/)) {
      const trimmed = sentence.trim();
      if (!trimmed || trimmed.length > 400) continue;
      for (const m of FOLLOWUP_MARKERS) {
        if (!m.re.test(trimmed)) continue;
        const key = `${m.id}:${trimmed.slice(0, 120)}`;
        if (seen.has(key)) break;
        seen.add(key);
        out.push({ entryId: e.id, marker: m.id, sentence: trimmed.slice(0, 400), occurredAt: e.occurredAt });
        break; // one marker per sentence is enough to make it actionable
      }
      if (out.length >= max) return out;
    }
  }
  return out;
}

export interface SessionInsightFacts {
  overview: SessionCard & { kindCounts: Record<string, number> };
  goals?: { entryId: number; occurredAt?: string; text: string }[];
  did?: ActionRollup;
  highlights?: { entryId: number; kind: EntryKind; occurredAt?: string; text: string }[];
  followupMarkers?: FollowupMarker[];
  backlog?: { line: number; text: string; status: string; sourcePath: string; overlap: number }[];
  trail?: {
    entryId: number;
    sourceType: SourceType;
    title: string;
    occurredAt?: string;
    sourceRef?: string;
    /** Files this record and the session both touched — why it is in the trail. */
    sharedFiles?: string[];
  }[];
}

export interface SessionNarrative {
  headline?: string;
  summary?: string[];
  decisions?: { text: string; why?: string }[];
  problems?: { text: string; resolution?: string }[];
  followups?: { text: string; confidence?: string }[];
}

export interface SessionInsightReport {
  sessionId: string;
  sections: string[];
  facts: SessionInsightFacts;
  narrative?: SessionNarrative;
  llm: { status: 'off' | 'ok' | 'unavailable'; reason?: string; model?: string; usage?: LlmUsage };
  generatedAt: string;
  cached: boolean;
}

/** Sentences of prose kept per highlight, and characters per prompt. */
const HIGHLIGHT_CHARS = 1200;
const PROMPT_CHARS = 600;
/** Total characters of evidence handed to the model. */
export const NARRATIVE_INPUT_BUDGET = 14_000;
/** Minimum token containment for calling a backlog item "touched" by a session. */
const BACKLOG_OVERLAP = 0.35;

export interface InsightOptions {
  sections?: string[];
  llm?: boolean;
  refresh?: boolean;
}

export class SessionInsightsService {
  /**
   * In-flight report generations, keyed by cache key.
   *
   * Opening the same session on the phone and the laptop within a second of
   * each other is an ordinary thing to do, and without this it buys two
   * identical completions. Keyed by the same key the cache uses, so two callers
   * only share a promise when they would have shared a cache row.
   */
  private inflight = new Map<string, Promise<SessionInsightReport>>();

  constructor(
    private catalog: Catalog,
    private llmCfg: AppConfig['llm'],
    private opts: { clientId?: string; backlogThreshold?: number } = {},
  ) {}

  async insights(sessionId: string, options: InsightOptions = {}): Promise<SessionInsightReport | null> {
    const [row] = await this.catalog.sessionRows([sessionId]);
    if (!row) return null;

    const sections = resolveSections(options.sections);
    const wantsLlm = options.llm !== false && sections.some((s) => LLM_SECTIONS.has(s));
    const key = insightsCacheKey({
      sessionId,
      sections,
      llm: wantsLlm,
      model: this.llmCfg.model,
      entryCount: row.entryCount,
      endedAt: row.endedAt,
    });

    if (!options.refresh) {
      const hit = await this.catalog.getSessionInsights(sessionId, key).catch(() => null);
      if (hit) return { ...(hit.payload as SessionInsightReport), generatedAt: hit.generatedAt, cached: true };
      const pending = this.inflight.get(key);
      if (pending) return pending;
    }

    const run = this.generate(row, sections, wantsLlm, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  private async generate(
    row: SessionRowFull,
    sections: string[],
    wantsLlm: boolean,
    key: string,
  ): Promise<SessionInsightReport> {
    const { facts, evidence: gathered } = await this.buildFacts(row, sections);

    let narrative: SessionNarrative | undefined;
    let llm: SessionInsightReport['llm'] = { status: 'off' };
    if (wantsLlm) {
      const evidence = buildNarrativeInput(gathered);
      if (!evidence.trim()) {
        // A session with no prompts and no prose has nothing for a model to
        // read. Saying so is honest; sending an empty prompt and printing
        // whatever comes back is the failure mode this avoids.
        llm = { status: 'unavailable', reason: 'session holds no prose to summarise' };
      } else {
        try {
          const { content, usage } = await chatCompleteWithUsage(
            this.llmCfg,
            [
              { role: 'system', content: NARRATIVE_SYSTEM },
              { role: 'user', content: buildNarrativePrompt(evidence, sections) },
            ],
            { maxTokens: 1600, temperature: 0.1, clientId: this.opts.clientId },
          );
          narrative = parseNarrative(content);
          llm = { status: 'ok', model: usage?.model, usage };
        } catch (e) {
          llm = { status: 'unavailable', reason: (e as Error).message.slice(0, 200) };
        }
      }
    }

    const report: SessionInsightReport = {
      sessionId: row.sessionId,
      sections,
      facts,
      ...(narrative ? { narrative } : {}),
      llm,
      generatedAt: new Date().toISOString(),
      cached: false,
    };

    // A failed LLM call must not be cached: the next request would serve the
    // failure as if it were the answer, and a transient gateway blip would
    // become a permanently degraded report.
    if (llm.status !== 'unavailable') {
      await this.catalog.putSessionInsights(row.sessionId, key, report).catch(() => {});
    }
    return report;
  }

  /**
   * Gather everything, then present only what was asked for.
   *
   * The two are deliberately separate objects. The narrative layer reads the
   * EVIDENCE, and the caller sees the FACTS — and a caller who asks only for
   * `decisions` still needs the prompts and prose to be gathered, because that
   * is what the model reasons over. An earlier version gated the gathering and
   * the presentation on the same condition, so `sections=decisions` handed the
   * model an empty evidence block and reported "session holds no prose to
   * summarise" on a session full of it.
   */
  private async buildFacts(
    row: SessionRowFull,
    sections: string[],
  ): Promise<{ facts: SessionInsightFacts; evidence: SessionInsightFacts }> {
    const want = new Set(sections);
    const kindCounts = await this.catalog.sessionKindCounts(row.sessionId).catch(() => ({}));
    const facts: SessionInsightFacts = {
      overview: {
        ...cardFacts(row, substanceOf(row)),
        score: 0,
        why: [],
        excerpts: [],
        kindCounts,
      },
    };

    // The narrative layer reads goals and highlights, so they are gathered
    // whenever any LLM section was asked for even if the caller hid them.
    const needsProse = want.has('goals') || want.has('highlights') || sections.some((s) => LLM_SECTIONS.has(s));

    const [prompts, highlights, actions] = await Promise.all([
      needsProse ? this.catalog.sessionEntriesByKind(row.sessionId, ['prompt'], 25).catch(() => []) : [],
      needsProse
        ? this.catalog.sessionEntriesByKind(row.sessionId, ['insight', 'summary', 'plan'], 20).catch(() => [])
        : [],
      want.has('did') ? this.catalog.sessionEntriesByKind(row.sessionId, ['action'], 400).catch(() => []) : [],
    ]);

    facts.goals = prompts.map((p) => ({
      entryId: p.id,
      occurredAt: p.occurredAt,
      text: p.body.slice(0, PROMPT_CHARS),
    }));
    facts.highlights = highlights.map((h) => ({
      entryId: h.id,
      kind: (h.kind ?? 'response') as EntryKind,
      occurredAt: h.occurredAt,
      text: h.body.slice(0, HIGHLIGHT_CHARS),
    }));
    if (want.has('did')) facts.did = rollupActions(actions.map((a) => a.body));

    // Scanned over the prose the session produced, not the action trail: a
    // marker inside a file path is a filename, not a loose end.
    facts.followupMarkers = scanFollowups([...prompts, ...highlights]);

    const needsTrail = want.has('trail') || sections.some((x) => LLM_SECTIONS.has(x));
    if (needsTrail && row.startedAt) {
      const from = row.startedAt;
      // A session's work is usually recorded shortly AFTER it ends — the commit
      // and the changelog line land last. A window that stopped at endedAt
      // would systematically miss the very entries this section exists to find.
      const to = new Date(
        (row.endedAt ? Date.parse(row.endedAt) : Date.parse(row.startedAt)) + 6 * 3600_000,
      ).toISOString();
      const trail = await this.catalog
        .entriesInWindow(row.projectId, from, to, ['git_commit', 'kdb_changelog', 'kdb_component', 'kdb_session'], 120)
        .catch(() => []);
      // A busy project records a lot in six hours, and most of it belongs to
      // other work. Where the session touched files, entries that touched the
      // SAME files come first — a commit sharing a file is this session's
      // trail, a commit that merely happened nearby is background. Sessions
      // with no files (72% of them) keep the plain chronological window, which
      // is still honest: it is "what was recorded around this", and it says so.
      const own = new Set(await this.catalog.normalizeFiles(row.filesTouched).catch(() => []));
      const scored = await Promise.all(
        trail.map(async (t) => {
          const files: string[] = Array.isArray(t.meta?.files) ? t.meta.files : [];
          const shared = own.size && files.length
            ? (await this.catalog.normalizeFiles(files).catch(() => [])).filter((p) => own.has(p))
            : [];
          return { t, shared };
        }),
      );
      scored.sort((a, b) => b.shared.length - a.shared.length);
      facts.trail = scored.slice(0, 30).map(({ t, shared }) => ({
        entryId: t.id,
        sourceType: t.sourceType,
        title: t.title,
        occurredAt: t.occurredAt,
        sourceRef: t.sourceRef,
        ...(shared.length ? { sharedFiles: shared.slice(0, 5) } : {}),
      }));
    }

    if (want.has('backlog')) {
      facts.backlog = await this.relatedBacklog(row, [...prompts, ...highlights]).catch(() => []);
    }

    // `facts` above is the complete picture; the presented view drops the
    // sections the caller did not ask for, without ever having withheld them
    // from the model.
    const presented: SessionInsightFacts = { overview: facts.overview };
    if (want.has('goals')) presented.goals = facts.goals;
    if (want.has('highlights')) presented.highlights = facts.highlights;
    if (want.has('did')) presented.did = facts.did;
    if (want.has('followups')) presented.followupMarkers = facts.followupMarkers;
    if (want.has('backlog')) presented.backlog = facts.backlog;
    if (want.has('trail')) presented.trail = facts.trail;

    return { facts: presented, evidence: facts };
  }

  /**
   * Open backlog items this session plausibly touched.
   *
   * Heuristic and labelled as such: token containment between the item's text
   * and the session's own prose, above a deliberately high threshold. It is
   * offered as "you may have worked on these", never as a resolution claim —
   * deciding an item is done is what `atlas_backlog_verdict` is for, and it
   * requires reading the code.
   */
  private async relatedBacklog(
    row: SessionRowFull,
    prose: { body: string }[],
  ): Promise<NonNullable<SessionInsightFacts['backlog']>> {
    const text = prose.map((p) => p.body).join(' ').slice(0, 20_000);
    if (tokenize(text).length < 5) return [];
    const view = await loadBacklogView(this.catalog, row.projectSlug, {
      threshold: this.opts.backlogThreshold ?? 0.5,
    });
    if (!view) return [];
    return view.items
      .filter((i) => i.status === 'open')
      .map((i) => ({
        line: i.line,
        text: i.text,
        status: i.status,
        sourcePath: i.sourcePath,
        overlap: tokenContainment(i.text, text),
      }))
      .filter((i) => i.overlap >= BACKLOG_OVERLAP)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 5);
  }
}

/**
 * Cache identity for one report.
 *
 * Everything that can change the OUTPUT is in the key, including the session's
 * own size: a session that is still running grows, and a report generated
 * halfway through it is genuinely a different report. Missing any of these
 * would serve a confidently stale answer, which is worse than a slow one.
 */
export function insightsCacheKey(input: {
  sessionId: string;
  sections: string[];
  llm: boolean;
  model: string;
  entryCount: number;
  endedAt?: string;
}): string {
  const material = JSON.stringify({
    s: input.sessionId,
    sec: [...input.sections].sort(),
    llm: input.llm,
    m: input.model,
    n: input.entryCount,
    e: input.endedAt ?? '',
    scheme: EXTRACTION_SCHEME,
    prompt: INSIGHT_PROMPT_VERSION,
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

const NARRATIVE_SYSTEM =
  'You summarise one recorded software-engineering session for the engineer who ran it. ' +
  'Work only from the evidence given. Never invent a decision, a cause or a file that is not there. ' +
  'If the evidence does not support a section, return an empty array for it rather than filling it. ' +
  'Reply with ONE JSON object and nothing else — no prose, no code fence.';

/**
 * The evidence block.
 *
 * Prompts and distilled prose only, hard-capped. Raw assistant responses and
 * the action trail are excluded by construction: they are 93% of the corpus by
 * volume, they are the least distilled part of it, and including them is how a
 * 1,304-entry session turns into a multi-megabyte prompt.
 */
export function buildNarrativeInput(facts: SessionInsightFacts, budget = NARRATIVE_INPUT_BUDGET): string {
  const parts: string[] = [];
  const push = (s: string) => {
    if (parts.join('\n').length < budget) parts.push(s);
  };
  for (const g of facts.goals ?? []) push(`ASKED: ${g.text}`);
  for (const h of facts.highlights ?? []) push(`${h.kind.toUpperCase()}: ${h.text}`);
  for (const f of facts.followupMarkers ?? []) push(`LOOSE END (${f.marker}): ${f.sentence}`);
  const did = facts.did;
  if (did) {
    if (did.files.length) push(`EDITED: ${did.files.map((f) => f.path).slice(0, 15).join(', ')}`);
    if (did.commands.length) push(`RAN: ${did.commands.map((c) => `${c.name}×${c.count}`).join(', ')}`);
  }
  for (const t of facts.trail ?? []) push(`RECORDED (${t.sourceType}): ${t.title}`);
  return parts.join('\n').slice(0, budget);
}

export function buildNarrativePrompt(evidence: string, sections: string[]): string {
  const want = new Set(sections);
  const fields = ['"headline": one short line naming what this session was about', '"summary": 2-4 short sentences'];
  if (want.has('decisions')) fields.push('"decisions": [{"text": what was decided, "why": the stated reason}]');
  if (want.has('problems')) fields.push('"problems": [{"text": what went wrong, "resolution": how it ended}]');
  if (want.has('followups'))
    fields.push(
      '"followups": [{"text": what remains open, "confidence": "high"|"medium"|"low"}] — only items the evidence actually leaves unfinished',
    );
  return `Evidence from one session:\n\n${evidence}\n\nReturn JSON with exactly these fields:\n${fields
    .map((f) => `- ${f}`)
    .join('\n')}\nOmit a field entirely rather than guessing at it.`;
}

/**
 * Parse the model's reply into a narrative, tolerating the usual wrappers.
 *
 * A model that returns a code fence or a sentence of preamble has still done
 * the work; throwing that away and reporting "LLM unavailable" would be both
 * wrong and expensive. Anything genuinely unparseable returns undefined, which
 * the caller reports honestly rather than rendering as an empty report.
 */
export function parseNarrative(raw: string): SessionNarrative | undefined {
  const text = (raw ?? '').trim();
  if (!text) return undefined;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1]?.trim() ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  let parsed: any;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;

  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const strList = (v: unknown) =>
    Array.isArray(v) ? v.map(str).filter((x): x is string => !!x).slice(0, 12) : undefined;
  const objList = <K extends string>(v: unknown, keys: K[]) =>
    Array.isArray(v)
      ? v
          .map((item) => {
            if (typeof item === 'string') return { [keys[0]!]: item.trim() } as any;
            if (!item || typeof item !== 'object') return null;
            const out: any = {};
            for (const k of keys) {
              const s = str((item as any)[k]);
              if (s) out[k] = s;
            }
            return out[keys[0]!] ? out : null;
          })
          .filter(Boolean)
          .slice(0, 15)
      : undefined;

  const narrative: SessionNarrative = {};
  const headline = str(parsed.headline);
  if (headline) narrative.headline = headline;
  const summary = strList(parsed.summary) ?? (str(parsed.summary) ? [str(parsed.summary)!] : undefined);
  if (summary?.length) narrative.summary = summary;
  const decisions = objList(parsed.decisions, ['text', 'why']);
  if (decisions?.length) narrative.decisions = decisions;
  const problems = objList(parsed.problems, ['text', 'resolution']);
  if (problems?.length) narrative.problems = problems;
  const followups = objList(parsed.followups, ['text', 'confidence']);
  if (followups?.length) narrative.followups = followups;

  return Object.keys(narrative).length ? narrative : undefined;
}
