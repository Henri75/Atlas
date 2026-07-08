import type {
  AskResult,
  ComponentRow,
  ProjectRow,
  SearchResult,
  SessionRow,
  Stats,
  TimelineItem,
} from './types';

/** Typed fetch client. Same-origin /api (nginx proxies to the api service). */

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

export const api = {
  search: (params: Record<string, unknown>) => get<SearchResult>(`/api/search${qs(params)}`),
  ask: (body: Record<string, unknown>) => post<AskResult>('/api/ask', body),
  projects: () => get<ProjectRow[]>('/api/projects'),
  timeline: (slug: string, params: Record<string, unknown> = {}) =>
    get<{ items: TimelineItem[] }>(`/api/projects/${slug}/timeline${qs(params)}`),
  components: (slug: string) =>
    get<{ components: ComponentRow[] }>(`/api/projects/${slug}/components`),
  componentHistory: (slug: string, name: string) =>
    get<{ entries: any[] }>(`/api/projects/${slug}/components/${encodeURIComponent(name)}`),
  sessions: (slug: string) => get<{ sessions: SessionRow[] }>(`/api/projects/${slug}/sessions`),
  session: (id: string) => get<{ session: SessionRow; entries: any[] }>(`/api/sessions/${id}`),
  stats: () => get<Stats>('/api/stats'),
  reindex: (body: Record<string, unknown> = {}) =>
    post<{ enqueued: number }>('/api/admin/reindex', body),
};
