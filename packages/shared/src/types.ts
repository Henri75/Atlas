/** API payload mirrors shared by the web UI and the native app. */

export type SourceType =
  | 'kdb_changelog'
  | 'kdb_session'
  | 'kdb_component'
  | 'kdb_backlog'
  | 'kdb_report'
  | 'claude_session'
  | 'git_commit'
  | 'doc';

/**
 * The Atlas palette, as raw values — color is data: each source type owns a
 * hue. The web maps these onto CSS custom properties of the same name; the
 * native app binds them directly. One table, so the two platforms cannot drift.
 */
export const PALETTE = {
  bg: '#0e1116',
  panel: '#161b22',
  panel2: '#1c232c',
  line: '#262d37',
  ink: '#e6edf3',
  muted: '#8b949e',
  faint: '#58626d',

  kdb: '#e3b341',
  claude: '#539bf5',
  git: '#57ab5a',
  doc: '#a371f7',
  report: '#e0823d',
} as const;

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
  /**
   * Which machine this entry was FIRST INGESTED FROM (spec §6) — provenance,
   * not presence. Absent for a legacy pre-machine-model entry that has not
   * been backfilled, or in single-machine mode.
   */
  machine?: string;
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
  /** Every machine this project has been seen on (spec §5); absent pre-fleet. */
  locations?: { machine: string; hostPath: string; hasKdb: boolean }[];
}

/* ---------------------------------------------------------------------------
 * Machines — mirrors GET /api/machines (packages/api/src/app.ts). Legacy
 * single-machine installs answer `{ self: 'local', machines: [] }` rather
 * than 404ing, so an empty array means "no fleet configured", not "loading".
 * ------------------------------------------------------------------------- */

/** machine_sync row, joined onto its machine by name; null = never attempted. */
export interface MachineSync {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  status: 'running' | 'ok' | 'unreachable' | 'error' | string;
  bytes: number | null;
  durationMs: number | null;
  error: string | null;
}

export interface MachineRow {
  name: string;
  address: string;
  user: string;
  codeRoots: string[];
  claudeProjects: string;
  enabled: boolean;
  sync: MachineSync | null;
}

export interface MachinesResponse {
  self: string;
  machines: MachineRow[];
  /**
   * Minutes between sync ticks, read from config/machines.yaml (or its
   * schema default) — absent only in legacy mode, where there is no loaded
   * fleet file to read one from and the feature itself is off. Consumers
   * fall back to their own copy of the same default rather than treating
   * absence as zero.
   */
  syncIntervalMin?: number;
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

/** A classified session/entry record as returned by the history and component routes. */
export interface EntryRecord {
  id: number | string;
  title?: string;
  body: string;
  source_type?: SourceType;
  occurred_at?: string;
  meta?: { kind?: EntryKind } & Record<string, unknown>;
}

/** The full record behind a search snippet — GET /api/entries/:id. */
export interface FullEntry {
  id: number;
  title: string;
  body: string;
  slug: string;
  source_type: SourceType;
  component?: string;
  session_id?: string;
  occurred_at?: string;
  hostPath: string;
  editorUrl: string;
  /** First-ingested-from provenance (spec §6); absent pre-fleet or unbackfilled. */
  machine?: string;
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
  kdb_changelog: { label: 'CHANGELOG', color: PALETTE.kdb },
  kdb_session: { label: 'KDB SESSION', color: PALETTE.kdb },
  kdb_component: { label: 'COMPONENT', color: PALETTE.kdb },
  kdb_backlog: { label: 'BACKLOG', color: PALETTE.kdb },
  kdb_report: { label: 'REPORT', color: PALETTE.report },
  claude_session: { label: 'CLAUDE', color: PALETTE.claude },
  git_commit: { label: 'COMMIT', color: PALETTE.git },
  doc: { label: 'DOC', color: PALETTE.doc },
};

/* ---------------------------------------------------------------------------
 * Usage monitoring. Mirrors core/src/usage.ts.
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
  query: { label: 'query', hint: 'search & ask — consumes the index', color: PALETTE.kdb },
  read: { label: 'read', hint: 'navigation and follow-up reads', color: PALETTE.claude },
  write: { label: 'write', hint: 'mutates durable state', color: PALETTE.git },
  status: { label: 'status', hint: 'health and polling', color: PALETTE.faint, noise: true },
  admin: { label: 'admin', hint: 'operations, incl. this page', color: PALETTE.doc, noise: true },
  other: { label: 'other', hint: 'unclassified — a route was added without a class', color: PALETTE.report },
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
  attempts?: number;
  requestId?: string;
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

/* ---------------------------------------------------------------------------
 * Chart color families. Colors live here as hex so every platform renders
 * identical hues; per-platform renderers decide bars vs strokes.
 * ------------------------------------------------------------------------- */

/** Colour per usage client. Semantic, and stable across every chart. */
export const CLIENT_COLORS: Record<string, string> = {
  mcp: PALETTE.claude,
  cli: PALETTE.git,
  ui: PALETTE.doc,
  unknown: PALETTE.faint,
};

export const clientColor = (client: string): string => CLIENT_COLORS[client] ?? PALETTE.kdb;

/** Daily indexing activity, grouped into the app's source color families. */
export const ACTIVITY_FAMILIES: {
  key: string;
  label: string;
  color: string;
  types: SourceType[];
}[] = [
  { key: 'kdb', label: 'KDB', color: PALETTE.kdb, types: ['kdb_changelog', 'kdb_session', 'kdb_component', 'kdb_backlog'] },
  { key: 'report', label: 'REPORT', color: PALETTE.report, types: ['kdb_report'] },
  { key: 'claude', label: 'CLAUDE', color: PALETTE.claude, types: ['claude_session'] },
  { key: 'git', label: 'COMMIT', color: PALETTE.git, types: ['git_commit'] },
  { key: 'doc', label: 'DOC', color: PALETTE.doc, types: ['doc'] },
];

/** Colour and label per session message kind; actions are the "what was done" trail. */
export const ENTRY_KIND_META: Record<EntryKind, { label: string; color: string }> = {
  prompt: { label: 'YOU', color: PALETTE.git },
  plan: { label: 'PLAN', color: PALETTE.doc },
  insight: { label: 'INSIGHT', color: PALETTE.kdb },
  summary: { label: 'SUMMARY', color: PALETTE.report },
  action: { label: 'DID', color: PALETTE.muted },
  response: { label: 'CLAUDE', color: PALETTE.claude },
};
