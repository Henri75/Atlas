/** Shared domain types. Single source of truth for every service. */

export type SourceType =
  | 'kdb_changelog'
  | 'kdb_session'
  | 'kdb_component'
  | 'kdb_backlog'
  | 'kdb_report'
  | 'claude_session'
  | 'git_commit'
  | 'doc';

export const ALL_SOURCE_TYPES: SourceType[] = [
  'kdb_changelog',
  'kdb_session',
  'kdb_component',
  'kdb_backlog',
  'kdb_report',
  'claude_session',
  'git_commit',
  'doc',
];

export interface Project {
  /**
   * Canonical slug when this project is an older location of another (a moved
   * checkout). Its entries are real and unique — scoping to the canonical slug
   * includes them automatically.
   */
  aliasOf?: string;
  id: number;
  slug: string;
  name: string;
  rootPath: string;
  hasKdb: boolean;
  discoveredAt: string;
}

/** Browsable unit: one changelog line, one session block, one commit, one doc section… */
export interface Entry {
  projectSlug: string;
  sourceType: SourceType;
  /** kdb component name or service name when known. */
  component?: string;
  /** Claude Code session id when the entry comes from a transcript. */
  sessionId?: string;
  title: string;
  body: string;
  /** ISO timestamp of when the recorded event happened (not indexing time). */
  occurredAt?: string;
  /** Absolute path of the source file the entry was parsed from. */
  sourcePath: string;
  /** Locator inside the source: commit sha, byte offset, heading anchor… */
  sourceRef?: string;
  meta?: Record<string, unknown>;
  /**
   * Machine-independent identity for dedup key v3 (spec §6): set by
   * `applyIdentity`/`identityFromStored` in identity.ts. Absent means the
   * pipeline never ran identity normalization — `Catalog.dedupKey` then falls
   * back to the legacy v2-shaped key from `projectSlug`/`sourcePath`/`sourceRef`.
   */
  identity?: { scope: string; path: string; ref: string };
}

export interface StoredEntry extends Entry {
  id: number;
  projectId: number;
}

export interface SessionMeta {
  sessionId: string;
  cwd?: string;
  /** From a `summary` event, when Claude wrote one. */
  title?: string;
  /** Fallback label when there is no summary — most sessions have none. */
  firstPrompt?: string;
  startedAt?: string;
  endedAt?: string;
  promptCount: number;
  /** Tool invocations that changed something (edits, commands, agents). */
  actionCount: number;
  filesTouched: string[];
}

/**
 * How a captured session message was classified at parse time, so search can
 * ask for insights or summaries directly rather than guessing from prose.
 */
export type EntryKind =
  | 'prompt'
  | 'plan'
  | 'insight'
  | 'summary'
  | 'action'
  | 'response';

export const ALL_ENTRY_KINDS: EntryKind[] = [
  'prompt',
  'plan',
  'insight',
  'summary',
  'action',
  'response',
];

export interface SearchFilters {
  /** Single project. Kept for back-compat (CLI, MCP); prefer `projects`. */
  project?: string;
  /**
   * Restrict to any of these projects. Empty/undefined means all.
   *
   * Wins over `project` when non-empty — the same precedence `sourceTypes` has
   * over `sourceType`, so both filters read the same way at every call site.
   */
  projects?: string[];
  /** Single source type. Kept for back-compat; prefer sourceTypes for a subset. */
  sourceType?: SourceType;
  /** Restrict to any of these source types. Empty/undefined means all. */
  sourceTypes?: SourceType[];
  component?: string;
  /** Only meaningful for claude_session entries. */
  kind?: EntryKind;
  since?: string;
  until?: string;
  /** 'active' excludes archived docs; 'archived' targets them. Default: both. */
  docStatus?: 'active' | 'archived';
}

export interface SearchHit {
  entryId: number;
  score: number;
  projectSlug: string;
  sourceType: SourceType;
  component?: string;
  sessionId?: string;
  title: string;
  snippet: string;
  occurredAt?: string;
  sourcePath: string;
  sourceRef?: string;
  /**
   * Doc staleness: 'archived' (archive-style path, downranked) or 'aging'
   * (old but untouched, label only). Absent = active or not a doc.
   */
  docStatus?: 'aging' | 'archived';
  /** Months since last modification; only set for doc hits with a date. */
  ageMonths?: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** 'hybrid' | 'sparse-only' | 'fts' — how the query was actually served. */
  mode: string;
  degraded: boolean;
  tookMs: number;
}

export interface AskSource {
  n: number;
  entryId: number;
  title: string;
  projectSlug: string;
  sourceType: SourceType;
  sourcePath: string;
  occurredAt?: string;
}

/**
 * Emitted when a question was scoped to one project but nothing matched there,
 * so retrieval was retried across all projects. Lets the caller tell the user
 * "nothing in <requested>; here is what I found elsewhere" instead of a
 * misleading "no such thing exists" — the failure mode where a feature built in
 * a sibling project (e.g. asking about G2P scoped to `deepcast`) looked absent.
 */
export interface ScopeFallback {
  /**
   * The project(s) the caller asked to scope to. A list, because a scope can now
   * hold several: widening fires only when *none* of them matched, so the user
   * needs to see the whole set that came up empty, not just one of them.
   */
  requested: string[];
  /** True once the search was widened to every project. */
  usedAllProjects: true;
}

/**
 * The projects a filter selects, as one list — `projects` if given, else the
 * singular `project`, else empty (meaning *all*).
 *
 * Shared by both search paths (Qdrant and the Postgres FTS fallback) so they can
 * never disagree about precedence. They degrade into one another, and a filter
 * that means different things depending on which backend answered would be a
 * genuinely nasty bug to chase.
 */
export function selectedProjects(filters: SearchFilters): string[] {
  if (filters.projects?.length) return filters.projects;
  return filters.project ? [filters.project] : [];
}

/**
 * What the index actually holds for one project — measured, never inferred.
 *
 * Exists because a model can only observe the k blocks it was handed, yet the
 * old prompt invited it to describe what the *index* lacks. On 2026-07-25 it
 * answered "the indexed history for July 2026 concludes on 2026-07-15" purely
 * because its 14 retrieved blocks stopped there, while 34,825 newer entries sat
 * in the catalog. Coverage is reported per project because the recommended
 * default is an unscoped ask, and an index-wide "current to 2026-07-25" says
 * nothing about whether *this* project is covered.
 */
export interface ProjectCoverage {
  projectSlug: string;
  entries: number;
  /** Oldest/newest entry timestamps; absent if the project has no dated entries. */
  oldest?: string;
  newest?: string;
}

/**
 * Entry counts for a date range the question named.
 *
 * `padded` matters as much as `exact`: people record events after they happen,
 * so an incident on the 21st is usually written up on the 22nd. A bare
 * "0 entries on 2026-07-21" is true and still sends the reader to a dead end.
 */
export interface WindowCoverage {
  since: string;
  until: string;
  exact: number;
  paddedSince: string;
  paddedUntil: string;
  padded: number;
}

/**
 * The conditions an answer was produced under, as data rather than prose.
 *
 * A consuming agent must be able to check whether retrieval was degraded or the
 * window was empty without parsing hedges out of English.
 */
export interface RetrievalReport {
  /** 'hybrid' | 'sparse-only' | 'fts' — how retrieval actually ran. */
  mode: string;
  /**
   * True when retrieval ran without dense vectors (embedder or Qdrant down).
   * Previously discarded, so Ask could answer from materially worse retrieval
   * and still report itself healthy.
   */
  degraded: boolean;
  coverage: ProjectCoverage[];
  /** Present only when the question named a date or range. */
  window?: WindowCoverage;
}

export interface AskResult {
  answer: string;
  sources: AskSource[];
  model: string;
  degraded: boolean;
  /** Present only when the project scope was widened to find any answer. */
  scopeFallback?: ScopeFallback;
  /** What was measured and how retrieval ran; absent only on a total miss. */
  retrieval?: RetrievalReport;
  /**
   * What the completion cost. Absent when the LLM never answered (no match, or
   * a degraded reply built from sources alone), so its presence is itself the
   * signal that a real generation happened.
   */
  metrics?: import('./ask.js').AskMetrics;
}

export interface TimelineItem {
  entryId: number;
  sourceType: SourceType;
  component?: string;
  sessionId?: string;
  title: string;
  occurredAt: string;
  sourcePath: string;
  /** Which project this came from — a merged feed is unreadable without it. */
  projectSlug: string;
}

export interface IndexStats {
  projects: number;
  entries: number;
  chunks: number;
  /** Lifetime total; historical, and healed problems stay counted. */
  errors: number;
  /** Errors in the last hour — the number that answers "is it failing now?". */
  recentErrors: number;
  /**
   * Entries in the catalog with no vectors in the active collection: indexed,
   * but invisible to search until the reconciler reaches them.
   *
   * The signal that was missing on 2026-07-25, when two whole documents sat
   * unsearchable while every other field here read healthy. Non-zero is not
   * necessarily alarming (a fresh entry is briefly uncovered); non-zero and
   * *not falling* means search is lying by omission.
   */
  unsearchableEntries: number;
  lastRunAt?: string;
  bySource: Record<string, number>;
}
