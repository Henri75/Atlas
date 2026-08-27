import type {
  CachedAdoption,
  ComponentRow,
  Dashboard,
  EntryRecord,
  FullEntry,
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
} from '@atlas/shared';
import { qs, transport } from './client';
import { askStream } from './stream';
import type { AccessCredentials } from './client';

/**
 * The typed Atlas API, mirroring packages/ui/src/api.ts route for route so the
 * two clients cannot drift. The only structural difference: the ask stream
 * needs the base URL + token from the server store, supplied by `ask()`.
 */

export const api = {
  search: (params: Record<string, unknown>) =>
    transport.get<SearchResult>(`/api/search${qs(params)}`),
  projects: () => transport.get<ProjectRow[]>('/api/projects'),
  timeline: (slugs: string[], params: Record<string, unknown> = {}) =>
    transport.get<{ items: TimelineItem[] }>(
      `/api/timeline${qs({ projects: slugs.join(','), ...params })}`,
    ),
  components: (slug: string) =>
    transport.get<{ components: ComponentRow[] }>(`/api/projects/${slug}/components`),
  componentHistory: (slug: string, name: string) =>
    transport.get<{ entries: EntryRecord[] }>(
      `/api/projects/${slug}/components/${encodeURIComponent(name)}`,
    ),
  sessions: (slug: string) =>
    transport.get<{ sessions: SessionRow[] }>(`/api/projects/${slug}/sessions`),
  session: (id: string) =>
    transport.get<{ session: SessionRow; entries: EntryRecord[] }>(`/api/sessions/${id}`),
  entry: (id: number) => transport.get<FullEntry>(`/api/entries/${id}`),
  stats: () => transport.get<Stats>('/api/stats'),
  dashboard: () => transport.get<Dashboard>('/api/dashboard'),
  machines: () => transport.get<MachinesResponse>('/api/machines'),
  reindex: (body: Record<string, unknown> = {}) =>
    transport.post<{ enqueued: number }>('/api/admin/reindex', body),

  usage: (days: number, classes: string[]) =>
    transport.get<UsageStats>(`/api/admin/usage${qs({ days, class: classes.join(',') })}`),
  usageCalls: (params: Record<string, unknown>) =>
    transport.get<UsageCallPage>(`/api/admin/usage/calls${qs(params)}`),
  usageInsights: (days: number) =>
    transport.get<UsageInsights>(`/api/admin/usage/insights${qs({ days })}`),
  usageCall: (id: number) => transport.get<UsageCallDetail>(`/api/admin/usage/calls/${id}`),
  adoption: () => transport.get<CachedAdoption>('/api/admin/adoption'),
  refreshAdoption: () => transport.post<{ enqueued: number }>('/api/admin/adoption/refresh', {}),

  /** Streaming ask — resolves the connection settings at call time. */
  ask(
    body: Record<string, unknown>,
    opts: { baseUrl: string; token: string | null; access?: AccessCredentials | null },
    signal?: AbortSignal,
  ) {
    return askStream(opts.baseUrl, opts.token, body, signal, opts.access ?? null);
  },
};
