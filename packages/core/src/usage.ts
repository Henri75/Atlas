/**
 * Usage telemetry: the shapes and the one piece of judgment that turns a raw
 * request path into something a monitor can group by.
 *
 * Atlas logs every `/api/*` request, polling included. That is deliberate — the
 * previous rule ("only requests carrying x-atlas-client") kept the table clean
 * by making the user's own use of Atlas invisible, which is a strange trade for
 * a tool whose whole subject is what happened. Noise is handled at *read* time
 * instead: classify the route, then let the reader hide the classes it does not
 * care about.
 *
 * The classification is of the ROUTE, never the intent. `/api/dashboard` is
 * `status` whether a 15-second timer fired or a human opened the page, and a
 * column claiming to tell those apart would be inventing evidence. What the
 * route costs and what it consumes are facts; why it was called is not.
 */

export const ROUTE_CLASSES = ['query', 'read', 'write', 'status', 'admin', 'other'] as const;
export type RouteClass = (typeof ROUTE_CLASSES)[number];

/**
 * Route patterns, most specific first. `:x` matches exactly one path segment.
 *
 * Segment-wise matching rather than substring or prefix tests, because slugs are
 * user-controlled: a project named `admin` must not push its ordinary reads into
 * the operational bucket, and `/api/projects/search/timeline` is a timeline read,
 * not a query.
 */
const PATTERNS: [pattern: string, cls: RouteClass][] = [
  // Consumes the index, and for ask the LLM too. The expensive, interesting work.
  ['/api/search', 'query'],
  ['/api/ask', 'query'],
  ['/api/ask/stream', 'query'],
  ['/api/projects/:slug/backlog/review', 'query'],

  // Mutates durable state. Rare, and worth being able to isolate.
  ['/api/projects/:slug/backlog/verdict', 'write'],

  // Health and polling.
  ['/api/health', 'status'],
  ['/api/stats', 'status'],
  ['/api/dashboard', 'status'],

  // Cheap catalog reads: navigation, and the follow-ups after a search.
  ['/api/projects', 'read'],
  ['/api/timeline', 'read'],
  ['/api/projects/:slug/timeline', 'read'],
  ['/api/projects/:slug/components', 'read'],
  ['/api/projects/:slug/components/:name', 'read'],
  ['/api/projects/:slug/sessions', 'read'],
  ['/api/projects/:slug/backlog', 'read'],
  ['/api/sessions/:id', 'read'],
  ['/api/entries/:id', 'read'],
];

const SEGMENTED = PATTERNS.map(([pattern, cls]) => [pattern.split('/').filter(Boolean), cls] as const);

/**
 * Classify one request path. Never throws: an unrecognised path is `other`,
 * which is a visible bucket rather than a silent misfiling into `read`. A
 * growing `other` count is the signal that a route was added without being
 * classified here.
 */
export function routeClass(path: string): RouteClass {
  const segments = (path || '').split('?')[0]!.split('/').filter(Boolean);
  if (segments.length === 0) return 'other';

  // Everything operational lives under one prefix, and it is ours, not a slug.
  if (segments[0] === 'api' && segments[1] === 'admin') return 'admin';

  for (const [pattern, cls] of SEGMENTED) {
    if (pattern.length !== segments.length) continue;
    if (pattern.every((p, i) => p.startsWith(':') || p === segments[i])) return cls;
  }
  return 'other';
}

/** One recorded API call, before it is written. */
export interface UsageCall {
  client: string;
  tool?: string;
  method: string;
  path: string;
  query?: string;
  status: number;
  durationMs: number;
}

/**
 * What Atlas replied. Every field is optional because most routes have no reply
 * worth keeping — a row exists only when there is something to say.
 */
export interface UsageReply {
  /** Ask: the full synthesized answer. */
  answer?: string;
  /** Search: hits returned. Ask: sources cited. */
  resultCount?: number;
  topHits?: UsageTopHit[];
  /** The model that actually answered, which a gateway may substitute. */
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  ttftMs?: number;
  /** The call succeeded but the answer is degraded (e.g. the LLM was down). */
  degraded?: boolean;
  /** The real failure message. Clients still receive a generic error. */
  error?: string;
}

export interface UsageTopHit {
  entryId: number;
  /** Absent for ask sources, which are cited rather than scored. */
  score?: number;
  title: string;
  projectSlug: string;
  sourceType: string;
}

/**
 * Outcome codes for a streamed answer, which cannot use the wire status.
 *
 * `/api/ask/stream` flushes 200 headers before it knows whether the answer will
 * succeed, so the HTTP status is decided too early to be informative. These
 * record the OUTCOME instead — what actually happened to the question — and both
 * are values we own in an INT column, never bytes sent to a client.
 *
 * Without this, a stream that failed and a stream that answered perfectly are
 * both status 200, and the error rate — the one number this table exists to keep
 * honest — silently excludes every streamed failure.
 */
/** nginx's "client closed request". An ask abandoned mid-answer. */
export const STATUS_CLIENT_ABORTED = 499;
/** The stream reported an error, or threw, after headers were already sent. */
export const STATUS_STREAM_FAILED = 500;

/** How many hits to keep per call. Enough to judge relevance, not a second index. */
export const TOP_HITS_KEPT = 5;

export interface UsageCallRow extends UsageCall {
  id: number;
  at: string;
  routeClass: RouteClass;
  hasReply: boolean;
}

export interface UsageCallDetail extends UsageCallRow {
  reply?: UsageReply;
}

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
