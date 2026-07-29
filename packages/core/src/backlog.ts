import type { BacklogMarker } from './parsers/kdbLog.js';
import type { SearchHit } from './types.js';

/**
 * Query-time derivation of backlog status (spec 2026-07-29). The parser stores
 * what each line proves about itself (markers, lineHash); everything that
 * needs to look across lines — ref verification, fuzzy legacy linking,
 * verdict overlay, latest-signal-wins — happens here, on request, so matcher
 * improvements never require a reindex (docs-staleness ADR precedent).
 */

export interface BacklogSourceEntry {
  id: number;
  body: string;
  component?: string;
  occurredAt?: string;
  sourceRef?: string;
  meta?: Record<string, unknown>;
}

export interface BacklogVerdict {
  sourcePath: string;
  line: number;
  status: 'confirmed-open' | 'likely-resolved' | 'confirmed-resolved' | 'inconclusive';
  confidence: number;
  note?: string;
  citations?: number[];
  reviewer: string;
  reviewedAt: string;
}

export type BacklogLint =
  | 'relocated'
  | 'ref-mismatch'
  | 'broken-link'
  | 'superseded-marker'
  | 'unstructured'
  | 'not-written-back'
  | 'stale-review'
  | 'likely-resolved'
  | 'inconclusive';

export interface AppliedMarker {
  kind: BacklogMarker['kind'];
  /** Line number of the marker line itself. */
  markerLine: number;
  /** The marker entry's own date, when dated. */
  date?: string;
  via: 'ref' | 'relocated' | 'fuzzy';
  /** Containment score for fuzzy links. */
  score?: number;
}

export interface BacklogItemView {
  line: number;
  entryId: number;
  text: string;
  component?: string;
  date?: string;
  /** Hash of the physical line, echoed into proposed marker refs. */
  lineHash?: string;
  status: 'open' | 'resolved' | 'dropped';
  provenance: 'structured' | 'reviewed' | 'heuristic' | 'default';
  markers: AppliedMarker[];
  verdict?: BacklogVerdict;
  lints: BacklogLint[];
}

export interface UnlinkedMarkerView {
  line: number;
  kind: BacklogMarker['kind'];
  text: string;
  lints: BacklogLint[];
  candidates: { line: number; score: number; text: string }[];
}

export interface BacklogViewOpts {
  /** Minimum token containment for a legacy fuzzy link. */
  threshold?: number;
  /** Runner-up within this of the best score → ambiguous, no link. */
  nearTie?: number;
  /** Newest indexed activity in the project; verdicts older than it get stale-review. */
  latestActivityAt?: string;
}

export interface BacklogView {
  items: BacklogItemView[];
  unlinked: UnlinkedMarkerView[];
  counts: { open: number; resolved: number; dropped: number };
}

const STRUCTURED_PREFIX_RE = /^(RESOLVED|DROPPED|REOPENED)\s*\[[^\]]*\]\s*:\s*/;
const LEGACY_PREFIX_RE = /^(DONE|RESOLVED|FIXED|WONTFIX|OBSOLETE)\s*:\s*/;
/** Similarity floor under which a hash-less structured ref is flagged ref-mismatch. */
const REF_MISMATCH_BAR = 0.2;

function lineNo(e: BacklogSourceEntry): number {
  return Number(/^line:(\d+)$/.exec(e.sourceRef ?? '')?.[1] ?? 0);
}

/** Light suffix strip so "persisted" matches "persist", "settings" "setting". */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3).map(stem),
  );
}

/** Share of the marker summary's tokens found in the candidate item. */
export function tokenContainment(summary: string, candidate: string): number {
  const a = tokens(summary);
  if (!a.size) return 0;
  const b = tokens(candidate);
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size;
}

function markerSummary(body: string): string {
  return body.replace(STRUCTURED_PREFIX_RE, '').replace(LEGACY_PREFIX_RE, '');
}

interface WorkItem {
  entry: BacklogSourceEntry;
  line: number;
  lineHash?: string;
  view: BacklogItemView;
}

export function buildBacklogView(
  entries: BacklogSourceEntry[],
  verdicts: BacklogVerdict[],
  opts: BacklogViewOpts = {},
): BacklogView {
  const threshold = opts.threshold ?? 0.5;
  const nearTie = opts.nearTie ?? 0.1;

  const items: WorkItem[] = [];
  const markers: { entry: BacklogSourceEntry; line: number; marker: BacklogMarker }[] = [];
  for (const entry of entries) {
    const marker = entry.meta?.marker as BacklogMarker | undefined;
    const line = lineNo(entry);
    if (marker) {
      markers.push({ entry, line, marker });
      continue;
    }
    items.push({
      entry,
      line,
      lineHash: entry.meta?.lineHash as string | undefined,
      view: {
        line,
        entryId: entry.id,
        text: entry.body,
        component: entry.component,
        date: entry.occurredAt,
        lineHash: entry.meta?.lineHash as string | undefined,
        status: 'open',
        provenance: 'default',
        markers: [],
        lints: entry.meta?.unstructured ? ['unstructured'] : [],
      },
    });
  }
  const byLine = new Map(items.map((i) => [i.line, i]));

  const unlinked: UnlinkedMarkerView[] = [];
  const unlink = (
    m: { entry: BacklogSourceEntry; line: number; marker: BacklogMarker },
    lints: BacklogLint[],
    candidates: UnlinkedMarkerView['candidates'] = [],
  ) => unlinked.push({ line: m.line, kind: m.marker.kind, text: m.entry.body, lints, candidates });

  const apply = (
    target: WorkItem,
    m: { entry: BacklogSourceEntry; line: number; marker: BacklogMarker },
    via: AppliedMarker['via'],
    score?: number,
  ) => {
    const applied: AppliedMarker = { kind: m.marker.kind, markerLine: m.line, via };
    if (m.entry.occurredAt) applied.date = m.entry.occurredAt;
    if (score !== undefined) applied.score = score;
    if (via === 'relocated' && !target.view.lints.includes('relocated')) target.view.lints.push('relocated');
    target.view.markers.push(applied);
  };

  for (const m of markers.sort((a, b) => a.line - b.line)) {
    const summary = markerSummary(m.entry.body);
    if (!m.marker.legacy && m.marker.targetLine !== undefined) {
      const target = byLine.get(m.marker.targetLine);
      const hash = m.marker.targetHash;
      if (target && (!hash || target.lineHash === hash)) {
        if (!hash && tokenContainment(summary, target.entry.body) < REF_MISMATCH_BAR) {
          target.view.lints.push('ref-mismatch');
        }
        apply(target, m, 'ref');
        continue;
      }
      // Wrong or dangling line number: the hash can still identify the item.
      const relocated = hash ? items.filter((i) => i.lineHash === hash) : [];
      if (relocated.length === 1) apply(relocated[0]!, m, 'relocated');
      else unlink(m, ['broken-link']);
      continue;
    }
    // Legacy marker: fuzzy containment against earlier lines only.
    let pool = items.filter((i) => i.line < m.line);
    if (m.entry.component) {
      const sameComponent = pool.filter((i) => i.entry.component === m.entry.component);
      if (sameComponent.some((i) => tokenContainment(summary, i.entry.body) >= threshold)) pool = sameComponent;
    }
    const scored = pool
      .map((i) => ({ item: i, score: tokenContainment(summary, i.entry.body) }))
      .filter((s) => s.score >= threshold)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) {
      unlink(m, []);
    } else if (scored.length > 1 && scored[0]!.score - scored[1]!.score <= nearTie) {
      unlink(m, [], scored.map((s) => ({ line: s.item.line, score: s.score, text: s.item.entry.body })));
    } else {
      apply(scored[0]!.item, m, 'fuzzy', scored[0]!.score);
    }
  }

  const latestVerdict = new Map<number, BacklogVerdict>();
  for (const v of verdicts) {
    const cur = latestVerdict.get(v.line);
    if (!cur || v.reviewedAt > cur.reviewedAt) latestVerdict.set(v.line, v);
  }

  for (const item of items) {
    const applied = item.view.markers.sort((a, b) => a.markerLine - b.markerLine);
    if (applied.length > 1) item.view.lints.push('superseded-marker');
    const last = applied[applied.length - 1];
    if (last) {
      item.view.status = last.kind === 'reopened' ? 'open' : last.kind;
      item.view.provenance = last.via === 'fuzzy' ? 'heuristic' : 'structured';
    }

    const verdict = latestVerdict.get(item.line);
    if (verdict) {
      item.view.verdict = verdict;
      if (opts.latestActivityAt && verdict.reviewedAt < opts.latestActivityAt) {
        item.view.lints.push('stale-review');
      }
      // The file wins unless the verdict is strictly newer than the last marker's date.
      const markerTime = last ? (last.date ?? '9999-12-31T00:00:00Z') : undefined;
      const verdictWins = !last || verdict.reviewedAt > markerTime!;
      if (verdictWins) {
        if (verdict.status === 'confirmed-resolved') {
          item.view.status = 'resolved';
          item.view.provenance = 'reviewed';
          if (!applied.some((a) => a.kind === 'resolved')) item.view.lints.push('not-written-back');
        } else if (verdict.status === 'confirmed-open') {
          item.view.status = 'open';
          item.view.provenance = 'reviewed';
        } else {
          item.view.lints.push(verdict.status);
        }
      }
    }
  }

  const counts = { open: 0, resolved: 0, dropped: 0 };
  for (const i of items) counts[i.view.status]++;
  return { items: items.map((i) => i.view), unlinked, counts };
}

export interface BacklogProjectView {
  items: (BacklogItemView & { sourcePath: string })[];
  unlinked: (UnlinkedMarkerView & { sourcePath: string })[];
  counts: BacklogView['counts'];
  latestActivityAt?: string;
}

/**
 * Assemble the status view for one project from the catalog. In practice a
 * project has exactly one backlog.log (the scanner matches that name only),
 * but line refs are per-file, so grouping by sourcePath keeps the derivation
 * honest if that ever changes.
 */
export async function loadBacklogView(
  catalog: {
    projectIdBySlug(slug: string): Promise<number | null>;
    backlogEntries(projectId: number): Promise<(BacklogSourceEntry & { sourcePath: string })[]>;
    backlogVerdicts(projectId: number): Promise<(Omit<BacklogVerdict, 'status'> & { status: string })[]>;
    latestActivityAt(projectId: number): Promise<string | undefined>;
  },
  slug: string,
  opts: BacklogViewOpts = {},
): Promise<BacklogProjectView | null> {
  const projectId = await catalog.projectIdBySlug(slug);
  if (projectId === null) return null;
  const [entries, verdicts, latestActivityAt] = await Promise.all([
    catalog.backlogEntries(projectId),
    catalog.backlogVerdicts(projectId),
    catalog.latestActivityAt(projectId),
  ]);
  const byPath = new Map<string, (BacklogSourceEntry & { sourcePath: string })[]>();
  for (const e of entries) {
    const group = byPath.get(e.sourcePath) ?? [];
    group.push(e);
    byPath.set(e.sourcePath, group);
  }
  const out: BacklogProjectView = {
    items: [],
    unlinked: [],
    counts: { open: 0, resolved: 0, dropped: 0 },
    latestActivityAt,
  };
  for (const [sourcePath, group] of byPath) {
    const view = buildBacklogView(
      group,
      (verdicts as BacklogVerdict[]).filter((v) => v.sourcePath === sourcePath),
      { ...opts, latestActivityAt },
    );
    out.items.push(...view.items.map((i) => ({ ...i, sourcePath })));
    out.unlinked.push(...view.unlinked.map((u) => ({ ...u, sourcePath })));
    out.counts.open += view.counts.open;
    out.counts.resolved += view.counts.resolved;
    out.counts.dropped += view.counts.dropped;
  }
  return out;
}

/**
 * The exact line a caller should append to the project's backlog.log to make
 * a verdict durable. Emitting it from one place keeps every surface (CLI,
 * MCP, API) protocol-conformant, hash included.
 */
export function proposeMarkerLine(
  kind: BacklogMarker['kind'],
  item: { line: number; lineHash?: string },
  summary: string,
  /** YYYY-MM-DD. Passed in, not computed — server and tests own the clock. */
  date: string,
  evidence?: string,
): string {
  const ref = item.lineHash ? `L${item.line}#${item.lineHash}` : `L${item.line}`;
  const tail = evidence ? ` (evidence: ${evidence})` : '';
  return `- [${date}] ${kind.toUpperCase()} [${ref}]: ${summary}${tail}`;
}

export interface JudgeVerdict {
  status: BacklogVerdict['status'];
  confidence: number;
  reasoning: string;
  /** Short human evidence note for the proposed marker line. */
  evidence?: string;
  citations: number[];
}

const JUDGE_STATUSES = new Set(['confirmed-open', 'likely-resolved', 'confirmed-resolved', 'inconclusive']);

/**
 * Written for the mid-size models that serve Ask: numbered evidence blocks,
 * explicit date framing, JSON-only output with a fixed schema.
 */
export function buildBacklogJudgePrompt(
  item: { line: number; text: string; date?: string },
  hits: SearchHit[],
): string {
  const blocks = hits.map((h) => {
    const date = h.occurredAt ? ` (${h.occurredAt.slice(0, 10)})` : '';
    return `[${h.entryId}] ${h.sourceType}${date}\n${h.snippet}`;
  });
  return [
    `Backlog item (logged ${item.date?.slice(0, 10) ?? 'undated'}, line ${item.line}):`,
    item.text,
    '',
    'Evidence from the project history (changelogs, session logs, commits):',
    blocks.length ? blocks.join('\n\n') : '(nothing relevant was found)',
    '',
    'Did later work address this item? Judge ONLY from the evidence above.',
    'Answer with JSON only, no prose around it:',
    '{"status": "confirmed-resolved" | "likely-resolved" | "confirmed-open" | "inconclusive",',
    ' "confidence": 0.0-1.0,',
    ' "reasoning": "<one or two sentences>",',
    ' "evidence": "<short pointer, e.g. changelog 2026-05-08 or commit abc123>",',
    ' "citations": [<entry ids of the blocks you relied on>]}',
    'Use confirmed-resolved only when the evidence names this exact problem as done.',
    'Use confirmed-open when the evidence shows it was NOT addressed. When the evidence is silent, use inconclusive.',
  ].join('\n');
}

/** Tolerant of fences and stray prose; anything unparseable becomes inconclusive. */
export function parseJudgeVerdict(raw: string, validEntryIds: Set<number>): JudgeVerdict {
  const inconclusive: JudgeVerdict = {
    status: 'inconclusive',
    confidence: 0,
    reasoning: 'model output was not a valid verdict',
    citations: [],
  };
  const json = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!json) return inconclusive;
  try {
    const v = JSON.parse(json);
    if (!JUDGE_STATUSES.has(v.status)) return inconclusive;
    return {
      status: v.status,
      confidence: Math.min(1, Math.max(0, Number(v.confidence) || 0)),
      reasoning: typeof v.reasoning === 'string' ? v.reasoning.slice(0, 1000) : '',
      evidence: typeof v.evidence === 'string' ? v.evidence.slice(0, 200) : undefined,
      citations: (Array.isArray(v.citations) ? v.citations : [])
        .filter((c: unknown) => typeof c === 'number' && validEntryIds.has(c)),
    };
  } catch {
    return inconclusive;
  }
}
