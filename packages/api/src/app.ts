import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { editorUrl, lineFromSourceRef, toHostPath } from '@kdbscope/core';
import type { AskService, Catalog, PathMapping, SearchService, SourceType } from '@kdbscope/core';

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
  /** Read at request time — the active collection can change at runtime. */
  meta: () => { embedder: string; collection: string };
  /** Scan-queue depth by job state; null when Redis is unreachable. */
  queueCounts: () => Promise<Record<string, number> | null>;
  /** Container→host path mounts, for editor deep links. */
  pathMappings: PathMapping[];
}

export interface BackfillProgress {
  done: number;
  total: number;
  etaSec: number;
}

export function buildApp(deps: ApiDeps): Hono {
  const app = new Hono();
  app.use('/api/*', cors());

  /**
   * Attach the host path and an editor link to anything carrying a source.
   * A row without a source path is returned untouched rather than failing the
   * whole request.
   */
  const withSource = <T extends { sourcePath?: string; sourceRef?: string }>(item: T) => {
    if (!item.sourcePath) return item;
    const hostPath = toHostPath(item.sourcePath, deps.pathMappings);
    return { ...item, hostPath, editorUrl: editorUrl(hostPath, lineFromSourceRef(item.sourceRef)) };
  };

  app.get('/api/health', (c) => c.json({ ok: true, service: 'kdbscope-api' }));

  app.get('/api/stats', async (c) => {
    const [stats, chunks, queue, backfillRaw] = await Promise.all([
      deps.catalog.stats(),
      deps.vectorCount(),
      deps.queueCounts(),
      deps.catalog.getSetting('backfill').catch(() => null),
    ]);
    // A re-embed in progress means search may be running on a partial
    // collection; the UI shows it rather than leaving the user guessing.
    let backfill: BackfillProgress | null = null;
    if (backfillRaw) {
      try {
        backfill = JSON.parse(backfillRaw) as BackfillProgress;
      } catch {
        backfill = null;
      }
    }
    const pending = queue ? (queue.waiting ?? 0) + (queue.active ?? 0) + (queue.delayed ?? 0) : null;
    return c.json({ ...stats, chunks, ...deps.meta(), queue, pending, backfill });
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
    return c.json({ ...result, hits: result.hits.map(withSource) });
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

  /**
   * Streaming Ask over SSE. Emits `sources`, then a run of `delta` events,
   * then `done`. Errors after headers are sent surface as a final `done`
   * with degraded: true (the generator handles it), so the client always
   * terminates cleanly.
   */
  app.post('/api/ask/stream', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return c.json({ error: 'question is required' }, 400);

    const events = deps.ask.askStream(
      question,
      { project: body.project, sourceType: body.source, component: body.component },
      Math.min(Number(body.k ?? 12), 30),
    );

    const stream = new ReadableStream({
      async pull(controller) {
        const { value, done } = await events.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
      },
      cancel: () => void events.return?.(undefined),
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // nginx buffers proxied responses by default, which defeats streaming.
        'x-accel-buffering': 'no',
      },
    });
  });

  app.get('/api/projects', async (c) => {
    const projects = await deps.catalog.listProjects();
    // rootPath is a container path; nobody outside the stack has that folder.
    return c.json(
      projects.map((p) => ({
        ...p,
        rootPath: p.rootPath ? toHostPath(p.rootPath, deps.pathMappings) : p.rootPath,
      })),
    );
  });

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

  /** Full entry, including the body that search results only snippet. */
  app.get('/api/entries/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const rows = await deps.catalog.getEntries([id]);
    const row = rows.get(id);
    if (!row) return c.json({ error: 'entry not found' }, 404);
    return c.json(
      withSource({ ...row, sourcePath: row.source_path, sourceRef: row.source_ref ?? undefined }),
    );
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
