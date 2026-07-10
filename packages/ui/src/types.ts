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

export interface AskResult {
  answer: string;
  sources: AskSource[];
  model: string;
  degraded: boolean;
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

export interface Dashboard extends Stats {
  sessions: number;
  storage: StorageUsage;
  health: Record<string, boolean>;
  vectors: { points: number; vectors: number; segments: number } | null;
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
