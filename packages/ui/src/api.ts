import type {
  AskMetrics,
  AskResult,
  CachedAdoption,
  ComponentRow,
  Dashboard,
  MachinesResponse,
  ProjectRow,
  SearchResult,
  SessionRow,
  Stats,
  TimelineItem,
  UsageCallDetail,
  UsageCallPage,
  UsageInsights,
  UsageStats,
} from './types';

/** Typed fetch client. Same-origin /api (nginx proxies to the api service). */

/**
 * Every request identifies itself. The API records all traffic now, and an
 * unlabelled caller is logged as `unknown` — which should mean "a curl or a
 * script", not "the UI forgot to say so". Naming ourselves keeps `unknown` a
 * meaningful category instead of a bucket the browser quietly fills.
 */
const CLIENT_HEADERS = { 'x-atlas-client': 'ui' };

/**
 * The token from TokenGate, if this instance requires one (spec §7). Read
 * fresh on every call rather than cached in a module variable: TokenGate
 * writes it and reloads, so a stale in-memory copy is never actually
 * observable, but re-reading also means no import-order dependency on when
 * TokenGate ran.
 */
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('atlasToken');
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * A 401 means the stored token is missing or wrong. Every call site funnels
 * through here so one 401, anywhere, reliably pops the prompt — App.tsx
 * listens for this event and renders TokenGate.
 */
function flagIfUnauthorized(res: Response): void {
  if (res.status === 401) window.dispatchEvent(new CustomEvent('atlas:unauthorized'));
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { ...CLIENT_HEADERS, ...authHeaders() } });
  flagIfUnauthorized(res);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CLIENT_HEADERS, ...authHeaders() },
    body: JSON.stringify(body),
  });
  flagIfUnauthorized(res);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Events emitted by POST /api/ask/stream (mirrors core's AskEvent). */
export type AskEvent =
  | { type: 'sources'; sources: AskResult['sources']; scopeFallback?: AskResult['scopeFallback'] }
  | { type: 'delta'; text: string }
  // `metrics` is absent when the LLM never answered (no headers, no usage).
  | { type: 'done'; model: string; degraded: boolean; metrics?: AskMetrics }
  | { type: 'error'; message: string };

/**
 * Consume the Ask SSE stream. Yields each event as it arrives so the caller
 * can paint sources immediately and append answer text progressively.
 */
export async function* askStream(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<AskEvent, void, unknown> {
  const res = await fetch('/api/ask/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CLIENT_HEADERS, ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  flagIfUnauthorized(res);
  if (!res.ok || !res.body) throw new Error(`${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const record = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!record.startsWith('data:')) continue;
        try {
          yield JSON.parse(record.slice(5).trim()) as AskEvent;
        } catch {
          // Ignore a malformed frame rather than aborting the answer.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const api = {
  search: (params: Record<string, unknown>) => get<SearchResult>(`/api/search${qs(params)}`),
  ask: (body: Record<string, unknown>) => post<AskResult>('/api/ask', body),
  askStream,
  projects: () => get<ProjectRow[]>('/api/projects'),
  /**
   * The activity feed for one project or many, merged newest-first.
   *
   * Uses the collection route (`/api/timeline?projects=…`), not the per-project
   * resource path — a slug means *one* project, and `a,b` in that position would
   * be a category error. The per-project route still exists and is what the CLI
   * and the MCP server call.
   */
  timeline: (slugs: string[], params: Record<string, unknown> = {}) =>
    get<{ items: TimelineItem[] }>(
      `/api/timeline${qs({ projects: slugs.join(','), ...params })}`,
    ),
  components: (slug: string) =>
    get<{ components: ComponentRow[] }>(`/api/projects/${slug}/components`),
  componentHistory: (slug: string, name: string) =>
    get<{ entries: any[] }>(`/api/projects/${slug}/components/${encodeURIComponent(name)}`),
  sessions: (slug: string) => get<{ sessions: SessionRow[] }>(`/api/projects/${slug}/sessions`),
  session: (id: string) => get<{ session: SessionRow; entries: any[] }>(`/api/sessions/${id}`),
  stats: () => get<Stats>('/api/stats'),
  dashboard: () => get<Dashboard>('/api/dashboard'),
  /**
   * The committed machine fleet joined with live sync health. Legacy mode
   * (no config/machines.yaml) answers `{ self: 'local', machines: [] }`
   * rather than 404ing — callers branch on the array length, not on a status.
   */
  machines: () => get<MachinesResponse>('/api/machines'),
  reindex: (body: Record<string, unknown> = {}) =>
    post<{ enqueued: number }>('/api/admin/reindex', body),

  /** Aggregated usage. `classes` empty means unfiltered, not "nothing". */
  usage: (days: number, classes: string[]) =>
    get<UsageStats>(`/api/admin/usage${qs({ days, class: classes.join(',') })}`),
  usageCalls: (params: Record<string, unknown>) =>
    get<UsageCallPage>(`/api/admin/usage/calls${qs(params)}`),
  usageInsights: (days: number) => get<UsageInsights>(`/api/admin/usage/insights${qs({ days })}`),
  usageCall: (id: number) => get<UsageCallDetail>(`/api/admin/usage/calls/${id}`),
  adoption: () => get<CachedAdoption>('/api/admin/adoption'),
  refreshAdoption: () => post<{ enqueued: number }>('/api/admin/adoption/refresh', {}),
};
