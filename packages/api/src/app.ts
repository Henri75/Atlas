import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AskService, Catalog, SearchService, SourceType } from '@kdbscope/core';

/**
 * REST surface. Dependencies are injected so route logic is unit-testable
 * without Postgres/Qdrant/Redis (see test/api/routes.test.ts).
 */
export interface ApiDeps {
  catalog: Catalog;
  search: SearchService;
  ask: AskService;
  /** Enqueue scan jobs; returns number of jobs enqueued. */
  enqueueScan: (opts: { project?: string; full?: boolean }) => Promise<number>;
  /** Point count of the active Qdrant collection (0 when unavailable). */
  vectorCount: () => Promise<number>;
  meta: { embedder: string; collection: string };
}

export function buildApp(deps: ApiDeps): Hono {
  const app = new Hono();
  app.use('/api/*', cors());

  app.get('/api/health', (c) => c.json({ ok: true, service: 'kdbscope-api' }));

  app.get('/api/stats', async (c) => {
    const [stats, chunks] = await Promise.all([deps.catalog.stats(), deps.vectorCount()]);
    return c.json({ ...stats, chunks, ...deps.meta });
  });

  app.get('/api/search', async (c) => {
    const q = c.req.query('q')?.trim();
    if (!q) return c.json({ error: 'q is required' }, 400);
    const result = await deps.search.search(
      q,
      {
        project: c.req.query('project') || undefined,
        sourceType: (c.req.query('source') as SourceType) || undefined,
        component: c.req.query('component') || undefined,
        since: c.req.query('since') || undefined,
        until: c.req.query('until') || undefined,
      },
      Math.min(Number(c.req.query('limit') ?? 20), 100),
    );
    return c.json(result);
  });

  app.post('/api/ask', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return c.json({ error: 'question is required' }, 400);
    const result = await deps.ask.ask(
      question,
      { project: body.project, sourceType: body.source, component: body.component },
      Math.min(Number(body.k ?? 12), 30),
    );
    return c.json(result);
  });

  app.get('/api/projects', async (c) => c.json(await deps.catalog.listProjects()));

  app.get('/api/projects/:slug/timeline', async (c) => {
    const sources = c.req.query('sources')?.split(',').filter(Boolean) as SourceType[] | undefined;
    const items = await deps.catalog.timeline(c.req.param('slug'), {
      limit: Number(c.req.query('limit') ?? 50),
      before: c.req.query('before') || undefined,
      sources,
    });
    return c.json({ items });
  });

  app.get('/api/projects/:slug/components', async (c) =>
    c.json({ components: await deps.catalog.components(c.req.param('slug')) }),
  );

  app.get('/api/projects/:slug/components/:name', async (c) =>
    c.json({
      component: c.req.param('name'),
      entries: await deps.catalog.componentHistory(c.req.param('slug'), c.req.param('name')),
    }),
  );

  app.get('/api/projects/:slug/sessions', async (c) =>
    c.json({ sessions: await deps.catalog.sessionsList(c.req.param('slug')) }),
  );

  app.get('/api/sessions/:id', async (c) => {
    const detail = await deps.catalog.sessionDetail(c.req.param('id'));
    if (!detail) return c.json({ error: 'session not found' }, 404);
    return c.json(detail);
  });

  app.get('/api/entries/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const rows = await deps.catalog.getEntries([id]);
    const row = rows.get(id);
    if (!row) return c.json({ error: 'entry not found' }, 404);
    return c.json(row);
  });

  app.post('/api/admin/reindex', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const enqueued = await deps.enqueueScan({
      project: typeof body.project === 'string' ? body.project : undefined,
      full: body.full === true,
    });
    return c.json({ enqueued });
  });

  app.get('/api/admin/errors', async (c) =>
    c.json({ errors: await deps.catalog.recentErrors() }),
  );

  app.onError((err, c) => {
    // Details go to the service log only — clients get a generic error.
    console.error('[api] error:', err);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
