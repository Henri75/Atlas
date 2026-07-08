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
  files_touched: string[];
}

export interface Stats {
  projects: number;
  entries: number;
  chunks: number;
  errors: number;
  lastRunAt?: string;
  bySource: Record<string, number>;
  embedder: string;
  collection: string;
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
