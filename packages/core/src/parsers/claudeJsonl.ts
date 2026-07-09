import type { Entry, EntryKind, SessionMeta } from '../types.js';

/**
 * Distiller for Claude Code session transcripts (~/.claude/projects/<dir>/<session>.jsonl).
 *
 * Volume control matters (11 GB raw), but *kind* is a far better filter than
 * length. We keep every user prompt and every piece of assistant prose, plus a
 * compact record of the actions taken; we drop tool results, thinking blocks,
 * progress events, attachments and base64 payloads — the genuinely bulky,
 * low-signal parts.
 *
 * An earlier version dropped assistant messages under 280 characters. On real
 * transcripts that discarded ~53% of Claude's replies (a short "No security
 * findings." is exactly what you want to find later) and saved only ~7% of the
 * prose volume. Each captured message is classified so search can ask for
 * insights, plans or summaries directly.
 *
 * Event shapes verified against real transcripts (2026-07-09).
 */

/**
 * Bump when the rule that turns a source file into entries changes: existing
 * rows were produced by the old rule and no rescan will replace them, so the
 * derived index has to be rebuilt.
 *
 * v2 keeps every assistant message (the 280-char filter discarded ~53% of
 * them), records tool actions, and classifies each message by kind.
 */
export const EXTRACTION_SCHEME = 'v2';

export interface ClaudeParseCtx {
  projectSlug: string;
  sourcePath: string;
  sessionId: string;
}

const MAX_BODY = 8_000;
const MAX_ENTRIES_PER_SESSION = 800;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Tools whose invocation says something about what was done. */
const ACTION_TOOLS = new Set([...EDIT_TOOLS, 'Bash', 'Task', 'Agent', 'Skill']);

/**
 * What a captured message *is*, so search can filter by intent rather than by
 * guessing from prose. Derived at parse time: deterministic, free, and no LLM.
 * `EntryKind` is the single definition — search filters on the same values.
 */
export type SessionEntryKind = EntryKind;

function isNoisePrompt(text: string): boolean {
  const t = text.trimStart();
  return (
    t.length < 3 ||
    t.startsWith('<') || // command wrappers, system-injected XML
    t.startsWith('Caveat:') ||
    t.startsWith('[Request interrupted')
  );
}

/** Classify a user prompt: a pasted plan/spec reads very differently to a question. */
function classifyPrompt(text: string): SessionEntryKind {
  return /^(implement|execute) the following plan\b|^#+\s|\bhere is the (plan|spec)\b/im.test(
    text.slice(0, 400),
  )
    ? 'plan'
    : 'prompt';
}

/** Classify assistant prose by the structures it actually uses. */
function classifyAssistant(text: string): SessionEntryKind {
  if (/★\s*Insight/.test(text)) return 'insight';
  if (/^#{1,3}\s*Summary\b|^\*\*What I did\*\*/im.test(text)) return 'summary';
  return 'response';
}

const KIND_LABEL: Record<SessionEntryKind, string> = {
  prompt: 'Prompt',
  plan: 'Plan',
  insight: 'Insight',
  summary: 'Summary',
  action: 'Action',
  response: 'Assistant',
};

/**
 * A short, searchable description of what a tool call touched — a file path or
 * the head of a command. Never the diff or the command body: those are the bulk
 * we are deliberately not importing.
 */
function describeToolTarget(name: string, input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const path = input.file_path ?? input.notebook_path;
  if (typeof path === 'string') return path;
  if (typeof input.command === 'string') {
    return input.command.split('\n')[0]!.trim().slice(0, 80);
  }
  if (typeof input.description === 'string') return input.description.slice(0, 80);
  if (typeof input.skill === 'string') return input.skill;
  return undefined;
}

export function distillClaudeJsonl(
  lines: Iterable<string>,
  ctx: ClaudeParseCtx,
): { entries: Entry[]; meta: SessionMeta } {
  const entries: Entry[] = [];
  const filesTouched = new Set<string>();
  const meta: SessionMeta = {
    sessionId: ctx.sessionId,
    promptCount: 0,
    actionCount: 0,
    filesTouched: [],
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // torn tail line of a live session — next scan picks it up
    }

    // The entry cap bounds what we *keep*, never what we *read*. Session
    // metadata (title, prompt count, timespan, files touched) must be gathered
    // from the whole stream: Claude writes the `summary` event at either end of
    // the file, so bailing out early silently loses the title.
    const atCap = entries.length >= MAX_ENTRIES_PER_SESSION;

    const ts: string | undefined = ev.timestamp;
    if (ts) {
      meta.startedAt ??= ts;
      meta.endedAt = ts;
    }
    if (ev.cwd && !meta.cwd) meta.cwd = ev.cwd;

    if (ev.type === 'summary' && typeof ev.summary === 'string') {
      meta.title ??= ev.summary;
      continue;
    }

    if (ev.type === 'user' && typeof ev.message?.content === 'string') {
      const text = ev.message.content as string;
      if (isNoisePrompt(text)) continue;
      meta.promptCount++;
      // Most sessions never get a `summary` event. The first prompt is a far
      // better label than a raw UUID; a real summary still wins over it.
      meta.firstPrompt ??= text.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!atCap) {
        const kind = classifyPrompt(text);
        entries.push({
          projectSlug: ctx.projectSlug,
          sourceType: 'claude_session',
          sessionId: ctx.sessionId,
          title: `${kind === 'plan' ? 'Plan' : 'Prompt'}: ${text.replace(/\s+/g, ' ').trim().slice(0, 140)}`,
          body: text.slice(0, MAX_BODY),
          occurredAt: ts,
          sourcePath: ctx.sourcePath,
          meta: { kind },
        });
      }
      continue;
    }

    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      const texts: string[] = [];
      const actions: string[] = [];

      for (const block of ev.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        if (block?.type !== 'tool_use') continue;

        if (EDIT_TOOLS.has(block.name)) {
          const p = block.input?.file_path ?? block.input?.notebook_path;
          if (typeof p === 'string') filesTouched.add(p);
        }
        if (ACTION_TOOLS.has(block.name)) {
          const target = describeToolTarget(block.name, block.input);
          actions.push(target ? `${block.name}: ${target}` : block.name);
          meta.actionCount++;
        }
      }

      // Every piece of prose is kept: a short "No security findings." is
      // exactly the kind of thing you go looking for months later.
      const joined = texts.join('\n').trim();
      if (!atCap && joined) {
        const kind = classifyAssistant(joined);
        entries.push({
          projectSlug: ctx.projectSlug,
          sourceType: 'claude_session',
          sessionId: ctx.sessionId,
          title: `${KIND_LABEL[kind]}: ${joined.replace(/\s+/g, ' ').slice(0, 140)}`,
          body: joined.slice(0, MAX_BODY),
          occurredAt: ts,
          sourcePath: ctx.sourcePath,
          meta: { kind },
        });
      }

      // One entry per turn, not per call: "what was done" stays searchable
      // without re-importing every diff and command body.
      if (!atCap && actions.length) {
        entries.push({
          projectSlug: ctx.projectSlug,
          sourceType: 'claude_session',
          sessionId: ctx.sessionId,
          title: `Action: ${actions.join(' · ').slice(0, 140)}`,
          body: actions.join('\n').slice(0, MAX_BODY),
          occurredAt: ts,
          sourcePath: ctx.sourcePath,
          meta: { kind: 'action', tools: actions.length },
        });
      }
    }
  }

  meta.filesTouched = [...filesTouched].sort();
  return { entries, meta };
}
