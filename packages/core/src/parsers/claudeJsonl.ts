import type { Entry, SessionMeta } from '../types.js';

/**
 * Distiller for Claude Code session transcripts (~/.claude/projects/<dir>/<session>.jsonl).
 *
 * Volume control is the whole game here (11 GB raw): we keep user prompts,
 * substantial assistant prose, and the list of files edited; we drop tool
 * results, thinking blocks, progress events, attachments and base64 payloads.
 * Event shapes verified against real transcripts (2026-07-09).
 */

export interface ClaudeParseCtx {
  projectSlug: string;
  sourcePath: string;
  sessionId: string;
}

const MAX_BODY = 8_000;
const MIN_ASSISTANT_CHARS = 280;
const MAX_ENTRIES_PER_SESSION = 800;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function isNoisePrompt(text: string): boolean {
  const t = text.trimStart();
  return (
    t.length < 3 ||
    t.startsWith('<') || // command wrappers, system-injected XML
    t.startsWith('Caveat:') ||
    t.startsWith('[Request interrupted')
  );
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
    filesTouched: [],
  };

  for (const line of lines) {
    if (entries.length >= MAX_ENTRIES_PER_SESSION) break;
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // torn tail line of a live session — next scan picks it up
    }

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
      entries.push({
        projectSlug: ctx.projectSlug,
        sourceType: 'claude_session',
        sessionId: ctx.sessionId,
        title: `Prompt: ${text.replace(/\s+/g, ' ').trim().slice(0, 140)}`,
        body: text.slice(0, MAX_BODY),
        occurredAt: ts,
        sourcePath: ctx.sourcePath,
        meta: { kind: 'prompt' },
      });
      continue;
    }

    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      const texts: string[] = [];
      for (const block of ev.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        if (block?.type === 'tool_use' && EDIT_TOOLS.has(block.name)) {
          const p = block.input?.file_path ?? block.input?.notebook_path;
          if (typeof p === 'string') filesTouched.add(p);
        }
      }
      const joined = texts.join('\n').trim();
      if (joined.length >= MIN_ASSISTANT_CHARS) {
        entries.push({
          projectSlug: ctx.projectSlug,
          sourceType: 'claude_session',
          sessionId: ctx.sessionId,
          title: `Assistant: ${joined.replace(/\s+/g, ' ').slice(0, 140)}`,
          body: joined.slice(0, MAX_BODY),
          occurredAt: ts,
          sourcePath: ctx.sourcePath,
          meta: { kind: 'response' },
        });
      }
    }
  }

  meta.filesTouched = [...filesTouched].sort();
  return { entries, meta };
}
