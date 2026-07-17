/** UI-side mirrors of the API payloads (kept dependency-free of core). */

export type SourceType =
  | 'kdb_changelog'
  | 'kdb_session'
  | 'kdb_component'
  | 'kdb_backlog'
  | 'kdb_report'
  | 'claude_session'
  | 'git_commit'
  | 'doc';

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
  /** 'archived' (downranked) or 'aging' (label only); absent = active. */
  docStatus?: 'aging' | 'archived';
  ageMonths?: number;
}

export interface SearchResult {
  hits: SearchHit[];
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

export interface ScopeFallback {
  /** Every project the scope asked for — widening fires only if none matched. */
  requested: string[];
  usedAllProjects: true;
}

/**
 * What an answer cost, as measured by the API (never estimated here).
 *
 * Every field past `model` is optional: a gateway may not report usage, and a
 * failed call reports nothing at all. Render what is present; never show a zero
 * in place of a number nobody measured.
 */
export interface AskMetrics {
  /** The model that actually answered — gateways substitute by routing policy. */
  model: string;
  /** True when the served model differs from the one the config requested. */
  substituted: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Milliseconds until the first token — the latency a user actually feels. */
  ttftMs?: number;
  totalMs?: number;
  tokensPerSec?: number;
  /** > 1 means the gateway failed over internally before succeeding. */
  attempts?: number;
  requestId?: string;
}

export interface AskResult {
  answer: string;
  sources: AskSource[];
  model: string;
  degraded: boolean;
  /** Set when a project scope matched nothing and the search widened to all. */
  scopeFallback?: ScopeFallback;
}

export interface ProjectRow {
  slug: string;
  name: string;
  rootPath: string;
  hasKdb: boolean;
  entryCount: number;
}

export interface TimelineItem {
  entryId: number;
  sourceType: SourceType;
  component?: string;
  sessionId?: string;
  title: string;
  occurredAt: string;
  sourcePath: string;
  /** Present on merged multi-project feeds so each row can say where it came from. */
  projectSlug?: string;
}

export interface ComponentRow {
  component: string;
  count: number;
  lastAt?: string;
}

export interface SessionRow {
  id: string;
  title?: string;
  cwd?: string;
  started_at?: string;
  ended_at?: string;
  prompt_count: number;
  action_count: number;
  files_touched: string[];
}

/** How a captured session message was classified at parse time. */
export type EntryKind =
  | 'prompt'
  | 'plan'
  | 'insight'
  | 'summary'
  | 'action'
  | 'response';

/** Alias kept for the session views, which speak in terms of messages. */
export type SessionEntryKind = EntryKind;

export interface CollectionSize {
  name: string;
  bytes: number;
  active: boolean;
}

export interface StorageUsage {
  /** null means "cannot tell" — never render it as 0. */
  postgresBytes: number | null;
  qdrantBytes: number | null;
  redisMemoryBytes: number | null;
  collections: CollectionSize[];
}

export interface SourceDetailRow {
  sourceType: SourceType;
  entries: number;
  files: number;
  /** Raw content size in characters (length(body)), not bytes on disk. */
  volumeChars: number;
  lastIndexedAt?: string;
}

export interface ActivityPoint {
  /** YYYY-MM-DD, indexing day (created_at), not event day. */
  day: string;
  sourceType: SourceType;
  count: number;
}

export interface RunRow {
  id: number;
  kind: string;
  startedAt?: string;
  finishedAt?: string;
  stats: { enqueued?: number } & Record<string, unknown>;
}

export interface Dashboard extends Stats {
  sessions: number;
  storage: StorageUsage;
  health: Record<string, boolean>;
  vectors: { points: number; vectors: number; segments: number } | null;
  sourceDetail: SourceDetailRow[];
  activity: ActivityPoint[];
  runs: RunRow[];
  archivedDocs: number;
}

export interface Stats {
  projects: number;
  entries: number;
  chunks: number;
  errors: number;
  recentErrors: number;
  lastRunAt?: string;
  bySource: Record<string, number>;
  embedder: string;
  collection: string;
  /** Scan jobs waiting + active + delayed; null when Redis is unreachable. */
  pending: number | null;
  queue: Record<string, number> | null;
  /** Present only while the vector collection is being rebuilt. */
  backfill: { done: number; total: number; etaSec: number } | null;
}

export const SOURCE_META: Record<SourceType, { label: string; color: string }> = {
  kdb_changelog: { label: 'CHANGELOG', color: 'var(--color-kdb)' },
  kdb_session: { label: 'KDB SESSION', color: 'var(--color-kdb)' },
  kdb_component: { label: 'COMPONENT', color: 'var(--color-kdb)' },
  kdb_backlog: { label: 'BACKLOG', color: 'var(--color-kdb)' },
  kdb_report: { label: 'REPORT', color: 'var(--color-report)' },
  claude_session: { label: 'CLAUDE', color: 'var(--color-claude)' },
  git_commit: { label: 'COMMIT', color: 'var(--color-git)' },
  doc: { label: 'DOC', color: 'var(--color-doc)' },
};
