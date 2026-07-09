import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../packages/api/src/app.js';
import type { ApiDeps } from '../../packages/api/src/app.js';

function makeDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    catalog: {
      stats: async () => ({
        projects: 2, entries: 10, chunks: 0, errors: 841, recentErrors: 0, bySource: {},
      }),
      listProjects: async () => [{ slug: 'deepcast', name: 'DeepCast', entryCount: 10 }],
      timeline: async () => [{ entryId: 1, title: 't', occurredAt: '2026-07-08T00:00:00Z' }],
      components: async () => [{ component: 'video-import', count: 3 }],
      componentHistory: async () => [{ id: 1, title: 'x' }],
      sessionsList: async () => [{ id: 'abc' }],
      sessionDetail: async (id: string) =>
        id === 'abc' ? { session: { id: 'abc' }, entries: [] } : null,
      getEntries: async (ids: number[]) =>
        new Map(ids.filter((i) => i === 1).map((i) => [i, { id: i, title: 'entry' }])),
      recentErrors: async () => [{ id: 1, message: 'boom' }],
      getSetting: async () => null,
    } as any,
    search: { search: async () => ({ hits: [], mode: 'hybrid', degraded: false, tookMs: 5 }) } as any,
    ask: { ask: async () => ({ answer: '42 [1]', sources: [], model: 'm', degraded: false }) } as any,
    enqueueScan: vi.fn(async () => 1),
    vectorCount: async () => 123,
    meta: () => ({ embedder: 'ollama/nomic-embed-text', collection: 'kdbscope_x' }),
    queueCounts: async () => ({ waiting: 5, active: 2, delayed: 1, failed: 0, completed: 90 }),
    pathMappings: [{ containerRoot: '/data/code', hostRoot: '/Users/nasta/__CODING NEW' }],
    ...overrides,
  };
}

describe('api routes', () => {
  it('GET /api/health', async () => {
    const res = await buildApp(makeDeps()).request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('GET /api/stats merges catalog stats + vector count + meta + queue depth', async () => {
    const res = await buildApp(makeDeps()).request('/api/stats');
    const body = await res.json();
    expect(body).toMatchObject({ projects: 2, chunks: 123, collection: 'kdbscope_x' });
    expect(body.queue).toMatchObject({ waiting: 5, active: 2 });
    // pending = waiting + active + delayed, the number that matters to a user.
    expect(body.pending).toBe(8);
    expect(body.backfill).toBeNull();
    // A healed system reports 0 recent errors despite a large lifetime count.
    expect(body).toMatchObject({ errors: 841, recentErrors: 0 });
  });

  it('GET /api/stats surfaces an in-progress re-embed', async () => {
    const deps = makeDeps();
    deps.catalog.getSetting = async () =>
      JSON.stringify({ done: 4000, total: 74202, etaSec: 1980 });
    const body = await (await buildApp(deps).request('/api/stats')).json();
    expect(body.backfill).toEqual({ done: 4000, total: 74202, etaSec: 1980 });
  });

  it('GET /api/stats still renders when Redis is unreachable', async () => {
    const deps = makeDeps({ queueCounts: async () => null });
    const body = await (await buildApp(deps).request('/api/stats')).json();
    expect(body.queue).toBeNull();
    expect(body.pending).toBeNull();
    expect(body.projects).toBe(2);
  });

  it('GET /api/search requires q', async () => {
    const res = await buildApp(makeDeps()).request('/api/search');
    expect(res.status).toBe(400);
  });

  it('GET /api/search passes filters through', async () => {
    const search = { search: vi.fn(async () => ({ hits: [], mode: 'hybrid', degraded: false, tookMs: 1 })) };
    const app = buildApp(makeDeps({ search: search as any }));
    const res = await app.request('/api/search?q=bug&project=deepcast&source=git_commit&limit=5');
    expect(res.status).toBe(200);
    expect(search.search).toHaveBeenCalledWith(
      'bug',
      expect.objectContaining({ project: 'deepcast', sourceType: 'git_commit' }),
      5,
    );
  });

  it('POST /api/ask requires question', async () => {
    const res = await buildApp(makeDeps()).request('/api/ask', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/ask returns synthesized answer', async () => {
    const res = await buildApp(makeDeps()).request('/api/ask', {
      method: 'POST',
      body: JSON.stringify({ question: 'what changed?' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(await res.json()).toMatchObject({ answer: '42 [1]' });
  });

  it('POST /api/ask/stream requires question', async () => {
    const res = await buildApp(makeDeps()).request('/api/ask/stream', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/ask/stream emits SSE frames with sources then deltas then done', async () => {
    async function* fakeStream() {
      yield { type: 'sources', sources: [{ n: 1, entryId: 1 }] };
      yield { type: 'delta', text: 'Hello' };
      yield { type: 'done', model: 'm', degraded: false };
    }
    const deps = makeDeps({ ask: { askStream: () => fakeStream() } as any });
    const res = await buildApp(deps).request('/api/ask/stream', {
      method: 'POST',
      body: JSON.stringify({ question: 'q' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // nginx would otherwise buffer the whole answer and defeat streaming.
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const body = await res.text();
    const events = body
      .split('\n\n')
      .filter((r) => r.startsWith('data:'))
      .map((r) => JSON.parse(r.slice(5).trim()));

    expect(events.map((e) => e.type)).toEqual(['sources', 'delta', 'done']);
    expect(events[1].text).toBe('Hello');
  });

  it('GET /api/sessions/:id 404s on unknown session', async () => {
    const res = await buildApp(makeDeps()).request('/api/sessions/nope');
    expect(res.status).toBe(404);
  });

  it('POST /api/admin/reindex enqueues with flags', async () => {
    const deps = makeDeps();
    const res = await buildApp(deps).request('/api/admin/reindex', {
      method: 'POST',
      body: JSON.stringify({ project: 'deepcast', full: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(await res.json()).toEqual({ enqueued: 1 });
    expect(deps.enqueueScan).toHaveBeenCalledWith({ project: 'deepcast', full: true });
  });

  it('GET /api/entries/:id hydrates or 404s', async () => {
    const app = buildApp(makeDeps());
    expect((await app.request('/api/entries/1')).status).toBe(200);
    expect((await app.request('/api/entries/9')).status).toBe(404);
  });

  it('GET /api/entries/:id survives a row with no source path', async () => {
    // A malformed row must not 500 the endpoint.
    const res = await buildApp(makeDeps()).request('/api/entries/1');
    expect(res.status).toBe(200);
    expect((await res.json()).hostPath).toBeUndefined();
  });

  it('GET /api/entries/:id returns the host path and an editor link', async () => {
    const deps = makeDeps();
    deps.catalog.getEntries = async () =>
      new Map([
        [1, { id: 1, title: 'e', body: 'full body', source_path: '/data/code/DeepCast/kdb/changelog.log', source_ref: 'line:12' }],
      ]);
    const body = await (await buildApp(deps).request('/api/entries/1')).json();
    expect(body.hostPath).toBe('/Users/nasta/__CODING NEW/DeepCast/kdb/changelog.log');
    expect(body.editorUrl).toContain('vscode://file/Users/nasta/__CODING%20NEW');
    expect(body.editorUrl).toMatch(/:12$/);
    expect(body.body).toBe('full body');
  });

  it('GET /api/search decorates every hit with a host path', async () => {
    const hit = {
      entryId: 1,
      score: 1,
      projectSlug: 'deepcast',
      sourceType: 'git_commit',
      title: 't',
      snippet: 's',
      sourcePath: '/data/code/DeepCast',
      sourceRef: 'aaa111',
    };
    const deps = makeDeps({
      search: { search: async () => ({ hits: [hit], mode: 'hybrid', degraded: false, tookMs: 1 }) } as any,
    });
    const body = await (await buildApp(deps).request('/api/search?q=x')).json();
    expect(body.hits[0].hostPath).toBe('/Users/nasta/__CODING NEW/DeepCast');
    // A commit sha is not a line number.
    expect(body.hits[0].editorUrl).not.toContain(':aaa111');
  });
});
