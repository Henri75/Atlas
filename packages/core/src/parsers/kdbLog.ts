import { createHash } from 'node:crypto';

import type { Entry } from '../types.js';

/**
 * Parsers for the append-only KDB log formats defined in the user's global
 * CLAUDE.md (§2): changelog lines, session blocks, component blocks, backlog lines.
 * Formats verified against real files (DeepCast/kdb, 2026-07-09).
 */

export interface ParseCtx {
  projectSlug: string;
  sourcePath: string;
  /** Component name (from the file name) for component logs. */
  component?: string;
}

/** "2026-07-08 22:37 UTC" | "2026-07-08" → ISO 8601, or undefined. */
export function parseKdbStamp(s: string): string | undefined {
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?\s*(?:UTC)?)?$/);
  if (!m) return undefined;
  return `${m[1]}T${m[2] ?? '00:00'}:00Z`;
}

const CHANGELOG_RE =
  /^-\s*\[([A-Z-]+)\]\s*-\s*\[([^\]]+)\]\s*-\s*\[([^\]]+)\]\s*-\s*\[([^\]]+)\]\s*-\s*(.+)$/;

export function parseChangelog(text: string, ctx: ParseCtx): Entry[] {
  const entries: Entry[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    const m = line.match(CHANGELOG_RE);
    if (!m) continue;
    const [, status, stamp, taskType, component, rest] = m;
    const desc = rest!.replace(/^\[/, '').replace(/\]\s*$/, '');
    entries.push({
      projectSlug: ctx.projectSlug,
      sourceType: 'kdb_changelog',
      component: component!.trim(),
      title: `[${status}] ${taskType} — ${desc.slice(0, 140)}`,
      body: desc,
      occurredAt: parseKdbStamp(stamp!),
      sourcePath: ctx.sourcePath,
      sourceRef: `line:${i + 1}`,
      meta: { status, taskType },
    });
  }
  return entries;
}

/** Split "---"-delimited blocks that start with "### [stamp]". */
function splitBlocks(text: string): { header: string; body: string }[] {
  const blocks: { header: string; body: string }[] = [];
  for (const raw of text.split(/^---\s*$/m)) {
    const block = raw.trim();
    const m = block.match(/^###\s*\[([^\]]+)\](?:\s*-\s*(.*))?/);
    if (!m) continue;
    blocks.push({ header: m[1]!, body: block });
  }
  return blocks;
}

export function parseSessionLog(text: string, ctx: ParseCtx): Entry[] {
  return splitBlocks(text).map((b) => {
    const prompt = b.body.match(/\*\*User Prompt Summary:\*\*\s*\n>\s*([\s\S]*?)(?=\n\*\*|$)/)?.[1];
    const title = (prompt ?? b.body).replace(/\s+/g, ' ').trim().slice(0, 140);
    return {
      projectSlug: ctx.projectSlug,
      sourceType: 'kdb_session' as const,
      title: title || `Session ${b.header}`,
      body: b.body,
      occurredAt: parseKdbStamp(b.header),
      sourcePath: ctx.sourcePath,
    };
  });
}

export function parseComponentLog(text: string, ctx: ParseCtx): Entry[] {
  const component = ctx.component ?? 'unknown';
  const entries: Entry[] = [];
  for (const raw of text.split(/^---\s*$/m)) {
    const block = raw.trim();
    const m = block.match(/^###\s*\[([^\]]+)\]\s*-\s*(.*)/);
    if (!m) continue;
    entries.push({
      projectSlug: ctx.projectSlug,
      sourceType: 'kdb_component',
      component,
      title: `${component}: ${m[2]!.replace(/[[\]]/g, '').trim().slice(0, 140)}`,
      body: block,
      occurredAt: parseKdbStamp(m[1]!),
      sourcePath: ctx.sourcePath,
      meta: { status: block.match(/\*\*Status:\*\*\s*\n?-?\s*([A-Za-z-]+)/)?.[1] },
    });
  }
  return entries;
}

const BACKLOG_RE = /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(?:\[([^\]]+)\])?\s*(.+)$/;

/**
 * Bump to force a re-parse of unchanged backlog files (mirrors
 * DOCS_PARSER_VERSION). v2: unstructured lines, resolution markers, lineHash.
 */
export const BACKLOG_PARSER_VERSION = 2;

/** A backlog line that resolves/drops/reopens another line rather than logging new work. */
export interface BacklogMarker {
  kind: 'resolved' | 'dropped' | 'reopened';
  /** Absolute line number of the target item (structured markers only). */
  targetLine?: number;
  /** First 6 hex chars of SHA-256 of the target's trimmed line (optional in hand-written markers). */
  targetHash?: string;
  /** Ad-hoc pre-convention marker (DONE:/RESOLVED:/…); target unknown, linked by fuzzy match. */
  legacy?: boolean;
}

const STRUCTURED_MARKER_RE = /^(RESOLVED|DROPPED|REOPENED)\s*\[L(\d+)(?:#([0-9a-fA-F]{6}))?\]\s*:/;
const LEGACY_MARKER_RE = /^(DONE|RESOLVED|FIXED|WONTFIX|OBSOLETE)\s*:/;

function detectMarker(desc: string): BacklogMarker | undefined {
  const s = desc.match(STRUCTURED_MARKER_RE);
  if (s) {
    const kind = s[1]!.toLowerCase() as BacklogMarker['kind'];
    const marker: BacklogMarker = { kind, targetLine: Number(s[2]) };
    if (s[3]) marker.targetHash = s[3].toLowerCase();
    return marker;
  }
  const l = desc.match(LEGACY_MARKER_RE);
  if (l) {
    const word = l[1]!.toUpperCase();
    return { kind: word === 'WONTFIX' || word === 'OBSOLETE' ? 'dropped' : 'resolved', legacy: true };
  }
  return undefined;
}

/** First 6 hex chars of SHA-256 of the trimmed line — the `#<hash6>` in marker refs. */
export function backlogLineHash(line: string): string {
  return createHash('sha256').update(line.trimEnd()).digest('hex').slice(0, 6);
}

export function parseBacklog(text: string, ctx: ParseCtx): Entry[] {
  const entries: Entry[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = raw.match(BACKLOG_RE);
    const meta: Record<string, unknown> = { lineHash: backlogLineHash(raw) };
    let desc: string;
    let date: string | undefined;
    let component: string | undefined;
    if (m) {
      date = m[1];
      component = m[2];
      desc = m[3]!;
    } else {
      desc = trimmed;
      meta.unstructured = true;
    }
    const marker = detectMarker(desc);
    if (marker) meta.marker = marker;
    entries.push({
      projectSlug: ctx.projectSlug,
      sourceType: 'kdb_backlog',
      component: component?.trim(),
      title: desc.slice(0, 140),
      body: desc,
      occurredAt: date ? parseKdbStamp(date) : undefined,
      sourcePath: ctx.sourcePath,
      sourceRef: `line:${i + 1}`,
      meta,
    });
  }
  return entries;
}
