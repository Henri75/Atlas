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
  /**
   * Which embedder is actually serving. Separate from `health` because it is
   * not a reachability question: during the 2026-07-29 fallback every service
   * showed running, correctly, while the index was being rebuilt by the wrong
   * model.
   */
  embedderHealth: {
    name: string | null;
    model: string | null;
    dim: number | null;
    configured: string;
    fallback: boolean;
    /**
     * The embedder the API itself can query the active collection with, or null
     * when it refused the one it resolved. The fields above describe the
     * *indexer*; these two describe search, and the two can disagree — the API
     * resolves its own provider, in its own process, and can lose that race
     * alone.
     */
    serving: { name: string; model: string; dim: number } | null;
    searchDegraded: boolean;
  };
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
  /**
   * Entries indexed but with no vectors in the active collection — present in
   * the catalog, invisible to search until the reconciler reaches them.
   * Non-zero briefly is normal; non-zero and not falling means search is
   * incomplete for reasons a query cannot reveal.
   */
  unsearchableEntries: number;
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

/* ---------------------------------------------------------------------------
 * Usage monitoring. Mirrors core/src/usage.ts — the UI cannot import from core
 * (it builds for the browser), so these shapes are restated and must move
 * together with it.
 * ------------------------------------------------------------------------- */

export type RouteClass = 'query' | 'read' | 'write' | 'status' | 'admin' | 'other';

/**
 * Route classes and how the monitor presents them. `noise: true` is hidden by
 * default — polling is recorded in full but would otherwise dominate every
 * count, which is the whole reason the classification exists.
 */
export const ROUTE_CLASS_META: Record<
  RouteClass,
  { label: string; hint: string; color: string; noise?: boolean }
> = {
  query: { label: 'query', hint: 'search & ask — consumes the index', color: 'var(--color-kdb)' },
  read: { label: 'read', hint: 'navigation and follow-up reads', color: 'var(--color-claude)' },
  write: { label: 'write', hint: 'mutates durable state', color: 'var(--color-git)' },
  status: { label: 'status', hint: 'health and polling', color: 'var(--color-faint)', noise: true },
  admin: { label: 'admin', hint: 'operations, incl. this page', color: 'var(--color-doc)', noise: true },
  other: { label: 'other', hint: 'unclassified — a route was added without a class', color: 'var(--color-report)' },
};

export interface UsageTopHit {
  entryId: number;
  score?: number;
  title: string;
  projectSlug: string;
  sourceType: string;
}

export interface UsageReply {
  answer?: string;
  resultCount?: number;
  topHits?: UsageTopHit[];
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  ttftMs?: number;
  degraded?: boolean;
  error?: string;
}

export interface UsageCallRow {
  id: number;
  at: string;
  client: string;
  tool?: string;
  method: string;
  path: string;
  query?: string;
  status: number;
  durationMs: number;
  routeClass: RouteClass;
  hasReply: boolean;
}

export interface UsageCallDetail extends UsageCallRow {
  reply?: UsageReply;
}

export interface UsageCursor {
  at: string;
  id: number;
}

export interface UsageFacet {
  key: string;
  calls: number;
}

export interface UsageCallPage {
  calls: UsageCallRow[];
  /** Size of the whole filtered set, independent of how far you have scrolled. */
  total: number;
  facets: { byClient: UsageFacet[]; byTool: UsageFacet[] };
  /** Absent when the last page was short — provably nothing follows. */
  nextCursor?: UsageCursor;
}

export interface UsageInsights {
  days: number;
  ask: {
    calls: number;
    aborted: number;
    failed: number;
    degraded: number;
    zeroSource: number;
    p50Ms: number;
    p95Ms: number;
    promptTokens: number;
    completionTokens: number;
    avgTtftMs: number;
  };
  search: {
    calls: number;
    zeroResult: number;
    p50Ms: number;
    p95Ms: number;
    medianResults: number;
  };
  latency: { bucket: string; calls: number }[];
  topQueries: { query: string; path: string; calls: number; lastAt: string }[];
  models: { model: string; calls: number; completionTokens: number }[];
  byDow: { dow: number; calls: number }[];
}

/** Display order for latency buckets; SQL returns them unordered. */
export const LATENCY_BUCKETS = [
  '<100ms',
  '100-500ms',
  '0.5-1s',
  '1-3s',
  '3-10s',
  '10-30s',
  '>30s',
] as const;

export interface UsageToolStat {
  client: string;
  tool: string;
  calls: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  errors: number;
  lastAt: string;
}

export interface UsageStats {
  days: number;
  calls: number;
  errors: number;
  clients: number;
  p50Ms: number;
  p95Ms: number;
  byTool: UsageToolStat[];
  byDay: { day: string; client: string; calls: number }[];
  byClass: { routeClass: RouteClass; calls: number }[];
  byHour: { hour: number; calls: number }[];
}

export interface TriggerHit {
  rule: string;
  tool: 'assessor' | 'atlas';
  excerpt: string;
  at?: string;
}

export interface ToolAdoption {
  sessionsUsed: number;
  totalCalls: number;
  sessionsMissed: number;
  /** null when nothing qualified — "no opportunity" is not "never fired". */
  fireRate: number | null;
  topMissedRules: { rule: string; count: number }[];
}

export interface SessionAdoption {
  sessionId: string;
  project: string;
  cwd?: string;
  startedAt?: string;
  endedAt?: string;
  turns: number;
  assessorCalls: number;
  atlasCalls: number;
  triggers: TriggerHit[];
  missedAssessor: TriggerHit[];
  missedAtlas: TriggerHit[];
  admittedNotThoughtOf: boolean;
}

export interface AdoptionReport {
  generatedAt: string;
  sessionsScanned: number;
  sessionsWithTriggers: number;
  assessor: ToolAdoption;
  atlas: ToolAdoption;
  sessions: SessionAdoption[];
}

export interface CachedAdoption {
  report: AdoptionReport | null;
  computedAt: string | null;
  /** True when no report exists yet — distinct from a report that found nothing. */
  pending?: boolean;
  tookMs?: number;
}
