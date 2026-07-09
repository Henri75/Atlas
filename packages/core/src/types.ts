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
}

export interface StoredEntry extends Entry {
  id: number;
  projectId: number;
}

export interface SessionMeta {
  sessionId: string;
  cwd?: string;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  promptCount: number;
  filesTouched: string[];
}

export interface SearchFilters {
  project?: string;
  sourceType?: SourceType;
  component?: string;
  since?: string;
  until?: string;
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

export interface AskResult {
  answer: string;
  sources: AskSource[];
  model: string;
  degraded: boolean;
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

export interface IndexStats {
  projects: number;
  entries: number;
  chunks: number;
  /** Lifetime total; historical, and healed problems stay counted. */
  errors: number;
  /** Errors in the last hour — the number that answers "is it failing now?". */
  recentErrors: number;
  lastRunAt?: string;
  bySource: Record<string, number>;
}
