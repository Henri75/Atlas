import type { Catalog } from './catalog.js';
import { extractDateWindow } from './questionDates.js';
import type { SearchService } from './search.js';
import { aggregateMatchScores, kindWeight, recencyTilt, substancePrior, substanceScore } from './sessionRanking.js';
import { tokenize } from './sparse.js';
import type {
  EntryKind,
  MatchReason,
  SearchHit,
  SessionCard,
  SessionExcerpt,
  SessionRowFull,
  SessionSearchFilters,
  SessionSearchResult,
} from './types.js';

/**
 * Session search: "I remember doing this — which conversation was it?"
 *
 * Atlas's existing search ranks *messages*. That is the right unit for "what
 * was said about X" and the wrong one for "which session was that", because the
 * answer to the second question is a conversation, and its evidence is spread
 * across many messages of very different kinds.
 *
 * Two legs, fused, because neither alone is sufficient:
 *
 *   - the **metadata leg** finds a session by what it IS — its id, its title,
 *     its folder, the files it touched. Pasting a session UUID must be an exact
 *     hit, not a semantic guess, and a session whose title names the thing you
 *     want must surface even if no individual message matched well.
 *   - the **content leg** finds it by what was SAID in it, through the existing
 *     hybrid index, then aggregates message scores up to the session.
 *
 * The metadata leg is additive rather than multiplicative on purpose: it can
 * introduce a session the content leg never retrieved, which is exactly what
 * happens when you search for a file path or a project name.
 */

/**
 * Entry hits pooled before grouping. See SearchService.search's `maxFetch`.
 *
 * Measured on the live index (602k chunks, 2026-08-28) rather than guessed:
 * end-to-end latency is UNCORRELATED with this number — the same query ran
 * 3.6 s at pool 80 and 1.6 s at pool 250, because the cost is dominated by
 * cold vector reads for a novel query, exactly as
 * `project_qdrant_search_latency_is_rescore_bound` describes. What the pool
 * does buy is ranking quality: it is how many sessions get real content
 * evidence rather than a metadata boost alone. So it is set for evidence, not
 * for speed. The pieces that DO scale with it are small and known: ~130 ms to
 * hydrate 250 entries, ~50 ms for the session rows.
 */
const DEFAULT_POOL = 250;

/**
 * Weight per matched metadata field.
 *
 * An id match dominates everything by a wide margin: it is an identity, not a
 * similarity, and if you pasted a session id you want that session first and
 * nothing else competing with it. A file match outranks a title match because
 * a title is one line Claude wrote about itself, while a touched file is
 * evidence of what the session actually did.
 */
const META_WEIGHTS: Record<keyof Omit<import('./types.js').SessionMetaMatch, 'sessionId'>, number> = {
  byId: 100,
  byFile: 0.35,
  byTitle: 0.3,
  // A bare word found INSIDE a path is a substring, not a path the user typed.
  // At the same weight as a real path match it put a session that touched
  // `pkg/stats/poolhealth.go` at the top of "supervisor pool wedge", above the
  // sessions actually about that. It is still worth something, but barely.
  byFileWord: 0.06,
  byCwd: 0.05,
  byProject: 0.05,
};

/** Max sessions collapsed into one thread badge before we stop looking. */
const THREAD_MAX = 12;

export interface SessionSearchOptions {
  /** Sessions returned. */
  limit?: number;
  /** Entry hits pooled before grouping (see DEFAULT_POOL). */
  pool?: number;
  /** 0 disables the recency tilt entirely. */
  recencyStrength?: number;
  /** Collapse contiguous runs of related sessions into one card. */
  thread?: boolean;
  nowMs?: number;
}

/** Strip the boilerplate the parser prefixes onto every session entry title. */
const TITLE_PREFIX = /^(Prompt|Plan|Insight|Summary|Action|Assistant):\s*/;

export class SessionSearchService {
  constructor(
    private catalog: Catalog,
    private search: SearchService,
  ) {}

  async searchSessions(
    query: string,
    filters: SessionSearchFilters = {},
    opts: SessionSearchOptions = {},
  ): Promise<SessionSearchResult> {
    const t0 = Date.now();
    const nowMs = opts.nowMs ?? t0;
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const pool = Math.min(Math.max(opts.pool ?? DEFAULT_POOL, limit), 500);

    const raw = (query ?? '').trim();
    // A date written into the query is an intent, not a search term: ranking is
    // semantic and time-blind, so "the qdrant work on 2026-07-21" would
    // otherwise rank by similarity across the whole corpus and quietly ignore
    // the date. `extractDateWindow` reads explicit dates (ISO, "21 July 2026",
    // "July 2026"); an explicit filter always wins over one inferred from the
    // text, and whatever was applied is reported back rather than done
    // silently — a narrowed result set with no visible cause reads as "Atlas
    // has nothing", which is the failure the trust contract exists to prevent.
    const window = raw ? extractDateWindow(raw) : null;
    const effective: SessionSearchFilters = {
      ...filters,
      since: filters.since ?? window?.since,
      until: filters.until ?? window?.until,
    };
    const interpreted =
      window && (effective.since === window.since || effective.until === window.until)
        ? { since: effective.since, until: effective.until }
        : undefined;

    const tokens = tokenize(raw);

    const [metaMatches, content] = await Promise.all([
      this.catalog.searchSessionsMeta(raw, tokens, effective, Math.max(limit * 3, 60)).catch(() => []),
      raw
        ? this.search
            .search(
              raw,
              {
                sourceTypes: ['claude_session'],
                projects: effective.projects,
                machine: effective.machine,
                since: effective.since,
                until: effective.until,
              },
              pool,
              { maxFetch: pool },
            )
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    const grouped = groupBySession(content?.hits ?? []);

    const ids = [...new Set([...grouped.keys(), ...metaMatches.map((m) => m.sessionId)])];
    if (!ids.length) {
      return {
        sessions: [],
        mode: content?.mode ?? 'metadata-only',
        degraded: content?.degraded ?? true,
        tookMs: Date.now() - t0,
        ...(interpreted ? { interpreted } : {}),
      };
    }

    const rows = await this.catalog.sessionRows(ids);
    const byId = new Map(rows.map((r) => [r.sessionId, r]));
    const metaById = new Map(metaMatches.map((m) => [m.sessionId, m]));

    const cards: SessionCard[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      // A hit whose session row is missing is a transcript entry whose session
      // never upserted (torn scan). Dropping it is right — a card with no facts
      // is unusable — but it must not take the whole query down.
      if (!row) continue;
      const hits = grouped.get(id) ?? [];
      const meta = metaById.get(id);

      const contentScore = aggregateMatchScores(hits.map((h) => h.score * kindWeight(h.kind)));
      const why: MatchReason[] = [];
      let metaBoost = 0;
      if (meta) {
        if (meta.byId) {
          metaBoost += META_WEIGHTS.byId;
          why.push({ kind: 'id', detail: 'session id matches', weight: META_WEIGHTS.byId });
        }
        if (meta.byFile) {
          metaBoost += META_WEIGHTS.byFile;
          why.push({ kind: 'file', detail: 'touched a matching file', weight: META_WEIGHTS.byFile });
        }
        if (meta.byFileWord) {
          metaBoost += META_WEIGHTS.byFileWord;
          why.push({
            kind: 'file',
            // Named for what it is, so a weak reason cannot read as a strong one.
            detail: 'a file name mentions it',
            weight: META_WEIGHTS.byFileWord,
          });
        }
        if (meta.byTitle) {
          metaBoost += META_WEIGHTS.byTitle;
          why.push({ kind: 'title', detail: 'title matches', weight: META_WEIGHTS.byTitle });
        }
        if (meta.byCwd) {
          metaBoost += META_WEIGHTS.byCwd;
          why.push({ kind: 'cwd', detail: 'folder matches', weight: META_WEIGHTS.byCwd });
        }
        if (meta.byProject) {
          metaBoost += META_WEIGHTS.byProject;
          why.push({ kind: 'project', detail: 'project name matches', weight: META_WEIGHTS.byProject });
        }
      }
      if (hits.length) {
        why.push({
          kind: 'message',
          detail: describeMessageMatch(hits),
          weight: contentScore,
        });
      }

      const substance = substanceOf(row);
      const score =
        (contentScore + metaBoost) *
        substancePrior(substance) *
        recencyTilt(row.startedAt, nowMs, opts.recencyStrength);

      cards.push({
        ...cardFacts(row, substance),
        score,
        why: why.sort((a, b) => b.weight - a.weight),
        excerpts: excerptsFrom(hits),
      });
    }

    cards.sort((a, b) => b.score - a.score);
    const shown = opts.thread === false ? cards.slice(0, limit) : collapseThreads(cards, limit);

    return {
      sessions: shown,
      mode: content?.mode ?? 'metadata-only',
      degraded: content ? content.degraded : true,
      tookMs: Date.now() - t0,
      ...(interpreted ? { interpreted } : {}),
    };
  }
}

/** Everything about a card that comes from the session row, not the query. */
export function cardFacts(row: SessionRowFull, substance: number): Omit<SessionCard, 'score' | 'why' | 'excerpts'> {
  const durationMs =
    row.startedAt && row.endedAt
      ? Math.max(0, Date.parse(row.endedAt) - Date.parse(row.startedAt))
      : undefined;
  return {
    sessionId: row.sessionId,
    projectSlug: row.projectSlug,
    machine: row.machine,
    // 90% of sessions carry a title (a Claude summary, or the first prompt the
    // pipeline folds in). The remaining 10% get the id rather than a blank —
    // an unlabelled row the reader cannot act on is worse than an ugly one.
    title: row.title?.trim() || `(untitled session ${row.sessionId.slice(0, 8)})`,
    cwd: row.cwd,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    ...(durationMs != null ? { durationMs } : {}),
    promptCount: row.promptCount,
    actionCount: row.actionCount,
    entryCount: row.entryCount,
    fileCount: row.filesTouched.length,
    filesTouched: row.filesTouched,
    substance,
  };
}

export function substanceOf(row: SessionRowFull): number {
  const durationMs =
    row.startedAt && row.endedAt ? Date.parse(row.endedAt) - Date.parse(row.startedAt) : 0;
  return substanceScore({
    entryCount: row.entryCount,
    actionCount: row.actionCount,
    fileCount: row.filesTouched.length,
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
  });
}

function groupBySession(hits: SearchHit[]): Map<string, SearchHit[]> {
  const out = new Map<string, SearchHit[]>();
  for (const h of hits) {
    if (!h.sessionId) continue;
    const list = out.get(h.sessionId) ?? [];
    list.push(h);
    out.set(h.sessionId, list);
  }
  return out;
}

/**
 * Say what kind of evidence matched, not just how much.
 *
 * "3 insights, 2 prompts" tells a reader something "5 messages" does not:
 * whether the session merely mentioned the thing or reasoned about it.
 */
function describeMessageMatch(hits: SearchHit[]): string {
  const counts = new Map<string, number>();
  for (const h of hits) {
    const k = h.kind ?? 'response';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * Up to three excerpts, preferring distilled prose over the action trail.
 *
 * An `action` entry's body is a list of file paths; it justifies a match but
 * reads as noise on a card. Prose is shown when there is any, and actions fill
 * in only when there is not.
 */
function excerptsFrom(hits: SearchHit[], max = 3): SessionExcerpt[] {
  const ranked = [...hits].sort(
    (a, b) => b.score * kindWeight(b.kind) - a.score * kindWeight(a.kind),
  );
  const prose = ranked.filter((h) => (h.kind ?? 'response') !== 'action');
  const chosen = (prose.length ? prose : ranked).slice(0, max);
  return chosen.map((h) => ({
    entryId: h.entryId,
    kind: (h.kind ?? 'response') as EntryKind,
    occurredAt: h.occurredAt,
    text: (h.snippet || h.title.replace(TITLE_PREFIX, '')).trim(),
  }));
}

/**
 * Collapse contiguous runs of one project's sessions into a single card.
 *
 * Claude Code splits long work across sessions — a compaction, a resume, a
 * crash — and the result is three or four near-identical rows for what the
 * user remembers as one afternoon. The best-scoring member represents the run
 * and carries the others' ids, so nothing is hidden, only folded.
 *
 * Time-and-project adjacency only, deliberately: this runs over an already
 * ranked result set, where every member is there because it matched the same
 * query, so demanding a second similarity signal would only fail to fold runs
 * that plainly belong together.
 */
export function collapseThreads(cards: SessionCard[], limit: number, gapMin = 90): SessionCard[] {
  const out: SessionCard[] = [];
  const taken = new Set<string>();
  const gapMs = gapMin * 60_000;

  for (const card of cards) {
    if (taken.has(card.sessionId)) continue;
    const members: string[] = [];
    // Anchor on the representative's window and walk outwards through the rest
    // of the result set, absorbing anything of the same project that starts (or
    // ends) within the gap of a member already in the run.
    let lo = card.startedAt ? Date.parse(card.startedAt) : NaN;
    let hi = card.endedAt ? Date.parse(card.endedAt) : lo;
    if (Number.isFinite(lo)) {
      for (const other of cards) {
        if (other === card || taken.has(other.sessionId)) continue;
        if (other.projectSlug !== card.projectSlug) continue;
        if (members.length >= THREAD_MAX) break;
        const s = other.startedAt ? Date.parse(other.startedAt) : NaN;
        const e = other.endedAt ? Date.parse(other.endedAt) : s;
        if (!Number.isFinite(s)) continue;
        if (s <= hi + gapMs && e >= lo - gapMs) {
          members.push(other.sessionId);
          taken.add(other.sessionId);
          lo = Math.min(lo, s);
          hi = Math.max(hi, e);
        }
      }
    }
    taken.add(card.sessionId);
    out.push(
      members.length
        ? { ...card, thread: { size: members.length + 1, memberIds: [card.sessionId, ...members] } }
        : card,
    );
    if (out.length >= limit) break;
  }
  return out;
}
