import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  ADOPTION_REPORT_KEY,
  ROUTE_CLASSES,
  STATUS_CLIENT_ABORTED,
  STATUS_STREAM_FAILED,
  TOP_HITS_KEPT,
  editorUrl,
  embedderStatus,
  lineFromSourceRef,
  loadBacklogView,
  proposeMarkerLine,
  toHostPath,
} from '@atlas/core';
import type {
  AskEvent,
  AskMetrics,
  AskResult,
  AskService,
  AskSource,
  BacklogReviewService,
  Catalog,
  EntryKind,
  PathMapping,
  RouteClass,
  SearchHit,
  SearchService,
  SourceType,
  StorageUsage,
  UsageReply,
} from '@atlas/core';

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
  /**
   * Ask the indexer to recompute the adoption report. Separate from enqueueScan
   * because it is not a scan: it reads transcripts this container cannot see and
   * writes a cached report, rather than touching the index at all.
   */
  enqueueAdoption: () => Promise<number>;
  /** Point count of the active Qdrant collection (0 when unavailable). */
  vectorCount: () => Promise<number>;
  /** Read at request time — the active collection can change at runtime. */
  meta: () => { embedder: string; collection: string };
  /** Scan-queue depth by job state; null when Redis is unreachable. */
  queueCounts: () => Promise<Record<string, number> | null>;
  /** Container→host path mounts, for editor deep links. */
  pathMappings: PathMapping[];
  /** Disk/memory used by each store; nulls where a figure is unknowable. */
  storage: () => Promise<StorageUsage>;
  /** Which dependencies the API can actually reach — that is what search needs. */
  health: () => Promise<Record<string, boolean>>;
  /** Vector count of the active collection, distinct from the chunk count. */
  vectorStats: () => Promise<{ points: number; vectors: number; segments: number } | null>;
  /**
   * The configured embeddings provider, verbatim ('auto', 'ollama', …).
   *
   * Needed to tell a fallback from a choice: only `auto` can settle for a
   * provider nobody named, so the dashboard cannot judge the running embedder
   * without knowing what was asked for.
   */
  embeddingsProvider: string;
  /**
   * The embedder *this process* can query the active collection with, or null
   * when it refused the one it resolved.
   *
   * Distinct from `active_embedder`, which the indexer writes about itself. The
   * two disagree exactly when the API lost the provider race on its own — and
   * that disagreement is invisible in every other field: the indexer is fine,
   * every dependency is reachable, and search has quietly moved to the Postgres
   * scan.
   */
  servingEmbedder: () => { name: string; model: string; dim: number } | null;
  /** Evidence gathering + LLM judgment for backlog reviews. */
  backlogReview: BacklogReviewService;
  /** Fuzzy-link floor for legacy DONE:/RESOLVED: markers (config SSoT). */
  backlogMatchThreshold: number;
}

export interface BackfillProgress {
  done: number;
  total: number;
  etaSec: number;
}

/**
 * Slots a handler fills for usage telemetry.
 *
 * `usageQuery`: the text this request asked about. GET routes carry it in the
 * URL, which the middleware can read for itself. POST routes carry it in the
 * body, and reading the body in middleware either consumes the stream or depends
 * on Hono's internal body cache. So the handler — which has already parsed it —
 * hands it over explicitly.
 *
 * `usageReply`: what Atlas answered. Same reasoning, one step later: only the
 * handler has the result in hand.
 *
 * `usageDeferred`: set by a route that records ITSELF. Only the streaming ask
 * needs it — see the route for why the middleware cannot do that job.
 *
 * `usageError`: the real failure message, stashed by the error handler so the
 * client can still receive a generic 500 while the log keeps the truth.
 */
type UsageVars = {
  usageQuery?: string;
  usageReply?: UsageReply;
  usageDeferred?: boolean;
  usageError?: string;
};

export function buildApp(deps: ApiDeps): Hono<{ Variables: UsageVars }> {
  const app = new Hono<{ Variables: UsageVars }>();
  app.use('/api/*', cors());

  /**
   * Usage telemetry. EVERY `/api/*` request is recorded, polling included.
   *
   * The previous rule — record only requests carrying `x-atlas-client` — kept
   * the table clean by making the user's own use of Atlas invisible, which is a
   * poor trade for a tool whose entire subject is what happened. Noise is
   * separated at READ time by `route_class` (core/src/usage.ts) instead, so the
   * rows exist and the reader chooses.
   *
   * The write is fire-and-forget: telemetry must never slow down or fail the
   * call it measures, so errors are swallowed after a console note.
   *
   * `usageQuery` matters more than it looks: every `atlas_ask` call ever made
   * recorded an empty `query`, because ask is a POST and only the URL was read.
   * The questions agents actually ask Atlas — the most valuable record this table
   * could hold, and the seed for the retrieval evaluation query set — were being
   * dropped on the floor.
   */
  app.use('/api/*', async (c, next) => {
    const startedAt = Date.now();
    await next();
    // A route that records itself has already promised to write a complete row
    // with an accurate duration; writing one here too would double-count it.
    if (c.get('usageDeferred')) return;

    const url = new URL(c.req.url);
    const error = c.get('usageError');
    const reply = c.get('usageReply');
    void deps.catalog
      .recordCall(
        {
          // An unlabelled caller is real and worth naming: a curl, a script, or
          // an agent following the "fall back to the REST API" instruction.
          client: c.req.header('x-atlas-client') ?? 'unknown',
          tool: c.req.header('x-atlas-tool'),
          method: c.req.method,
          path: url.pathname,
          // Whatever the handler recorded, else the URL query for GET routes.
          // `recordCall` truncates to the column width, so a long question is
          // clipped in one place rather than at every call site.
          query: c.get('usageQuery') ?? (url.search ? url.search.slice(1) : undefined),
          status: c.res.status,
          durationMs: Date.now() - startedAt,
        },
        error ? { ...reply, error } : reply,
      )
      .catch((e: unknown) => console.error('[api] usage log failed:', e));
  });

  /**
   * Parse the `source` param, which may be a single type or a comma-separated
   * subset ("doc,kdb_component"). A lone value stays in `sourceType` for
   * back-compat; a subset becomes `sourceTypes`. Callers spread the result into
   * their filter object.
   */
  const parseSources = (
    raw?: string | string[],
  ): { sourceType?: SourceType; sourceTypes?: SourceType[] } => {
    // Accept both the GET query string ("doc,kdb_component") and a JSON body
    // array (["doc","kdb_component"]) so search and ask share one parser.
    const list = (Array.isArray(raw) ? raw : (raw ?? '').split(','))
      .map((s) => String(s).trim())
      .filter(Boolean) as SourceType[];
    if (list.length === 0) return {};
    if (list.length === 1) return { sourceType: list[0] };
    return { sourceTypes: list };
  };

  /**
   * Parse `project`, which may be one slug or a comma-separated set
   * ("deepcast,atlas") on GET, or a JSON array on POST. Deliberately the mirror
   * image of parseSources: the two filters behave identically, so they should
   * also *read* identically at every call site.
   */
  const parseProjects = (
    raw?: string | string[],
  ): { project?: string; projects?: string[] } => {
    const list = (Array.isArray(raw) ? raw : (raw ?? '').split(','))
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (list.length === 0) return {};
    if (list.length === 1) return { project: list[0] };
    return { projects: list };
  };

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

  app.get('/api/health', (c) => c.json({ ok: true, service: 'atlas-api' }));

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

  /**
   * Everything the dashboard shows. Kept out of `/api/stats` on purpose: this
   * walks Qdrant's storage directory and probes every dependency, which is far
   * too slow for the footer that polls every 30 seconds.
   */
  app.get('/api/dashboard', async (c) => {
    const [stats, chunks, queue, storage, health, vectors, sessions, sourceDetail, activity, runs, archivedDocs] =
      await Promise.all([
        deps.catalog.stats(),
        deps.vectorCount(),
        deps.queueCounts(),
        deps.storage(),
        deps.health(),
        deps.vectorStats(),
        deps.catalog.countSessions().catch(() => 0),
        deps.catalog.sourceDetail().catch(() => []),
        deps.catalog.indexingActivity().catch(() => []),
        deps.catalog.recentRuns().catch(() => []),
        deps.catalog.archivedDocsCount().catch(() => 0),
      ]);
    const pending = queue ? (queue.waiting ?? 0) + (queue.active ?? 0) + (queue.delayed ?? 0) : null;
    // Which embedder is actually serving, and whether that is the one asked for.
    // `health` answers reachability, which stayed green throughout the
    // 2026-07-29 fallback: everything was reachable, the vectors were just being
    // rebuilt by the wrong model. Degradation that looks healthy needs its own
    // field, not a boolean in with the dependencies.
    //
    // `serving` is this process's own answer to the same question. The indexer
    // can be perfectly healthy while the API lost the provider race by itself,
    // and every other field on this response would still read green.
    const serving = deps.servingEmbedder();
    const embedderHealth = {
      ...embedderStatus(
        deps.embeddingsProvider,
        await deps.catalog.getSetting('active_embedder').catch(() => null),
      ),
      serving,
      searchDegraded: !serving,
    };
    return c.json({
      ...stats,
      chunks,
      sessions,
      ...deps.meta(),
      queue,
      pending,
      storage,
      health,
      embedderHealth,
      vectors,
      sourceDetail,
      activity,
      runs,
      archivedDocs,
    });
  });

  app.get('/api/search', async (c) => {
    const q = c.req.query('q')?.trim();
    if (!q) return c.json({ error: 'q is required' }, 400);
    const result = await deps.search.search(
      q,
      {
        ...parseProjects(c.req.query('project')),
        ...parseSources(c.req.query('source')),
        component: c.req.query('component') || undefined,
        kind: (c.req.query('kind') as EntryKind) || undefined,
        since: c.req.query('since') || undefined,
        until: c.req.query('until') || undefined,
        docStatus: (c.req.query('docStatus') as 'active' | 'archived') || undefined,
      },
      Math.min(Number(c.req.query('limit') ?? 20), 100),
    );
    c.set('usageReply', searchReply(result.hits));
    return c.json({ ...result, hits: result.hits.map(withSource) });
  });

  /**
   * Turn a result into the reply we keep. Deliberately lossy: enough to judge
   * later whether the answer was any good, never enough to be a second index.
   */
  const searchReply = (hits: SearchHit[]): UsageReply => ({
    resultCount: hits.length,
    topHits: hits.slice(0, TOP_HITS_KEPT).map((h) => ({
      entryId: h.entryId,
      score: h.score,
      title: h.title,
      projectSlug: h.projectSlug,
      sourceType: h.sourceType,
    })),
  });

  const askReply = (r: AskResult): UsageReply => ({
    answer: r.answer,
    resultCount: r.sources.length,
    // Ask sources are cited, not scored, so `score` is honestly absent rather
    // than filled with a placeholder that would sort as a real ranking.
    topHits: r.sources.slice(0, TOP_HITS_KEPT).map((s) => ({
      entryId: s.entryId,
      title: s.title,
      projectSlug: s.projectSlug,
      sourceType: s.sourceType,
    })),
    model: r.metrics?.model ?? r.model,
    promptTokens: r.metrics?.promptTokens,
    completionTokens: r.metrics?.completionTokens,
    ttftMs: r.metrics?.ttftMs,
    degraded: r.degraded,
  });

  /**
   * Conversation history arrives from the browser, so it is whitelisted rather
   * than trusted: only user/assistant turns with string content. Accepting a
   * `system` role would let a client rewrite the instructions.
   */
  const sanitizeHistory = (raw: unknown) =>
    (Array.isArray(raw) ? raw : [])
      .filter(
        (t: any) =>
          t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string',
      )
      .slice(-24)
      .map((t: any) => ({ role: t.role, content: t.content.slice(0, 20_000) }));

  app.post('/api/ask', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return c.json({ error: 'question is required' }, 400);
    c.set('usageQuery', question);
    const result = await deps.ask.ask(
      question,
      { ...parseProjects(body.project), ...parseSources(body.source), component: body.component, kind: body.kind, since: body.since, until: body.until, docStatus: body.docStatus },
      Math.min(Number(body.k ?? 12), 30),
      sanitizeHistory(body.history),
    );
    c.set('usageReply', askReply(result));
    return c.json(result);
  });

  /**
   * Streaming Ask over SSE. Emits `sources`, then a run of `delta` events,
   * then `done`. Errors after headers are sent surface as a final `done`
   * with degraded: true (the generator handles it), so the client always
   * terminates cleanly.
   *
   * This route records its OWN usage. The middleware cannot: it measures around
   * `await next()`, which here resolves the moment the ReadableStream is handed
   * back — before a single token exists. Left to the middleware this route would
   * log time-to-headers as its duration (milliseconds, for an answer that takes
   * half a minute) and could never see the answer text at all.
   */
  app.post('/api/ask/stream', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    // Deliberately BEFORE usageDeferred is set: an early 400 returns here, and
    // the middleware must still log it. Setting the flag on entry would make
    // every malformed request vanish from the record entirely.
    if (!question) return c.json({ error: 'question is required' }, 400);
    c.set('usageQuery', question);
    c.set('usageDeferred', true);

    const events = deps.ask.askStream(
      question,
      { ...parseProjects(body.project), ...parseSources(body.source), component: body.component, kind: body.kind, since: body.since, until: body.until, docStatus: body.docStatus },
      Math.min(Number(body.k ?? 12), 30),
      sanitizeHistory(body.history),
    );

    const startedAt = Date.now();
    let answer = '';
    let sources: AskSource[] = [];
    let meta: { model?: string; degraded?: boolean; metrics?: AskMetrics } = {};
    let streamError: string | undefined;
    let recorded = false;

    /**
     * Written once, on whichever end arrives first. `recorded` guards the case
     * where cancel fires after close — one question must produce one row.
     *
     * If the process dies mid-stream neither path runs and nothing is written.
     * That is deliberate: the alternative, inserting a row up front, would
     * misreport every interrupted answer as a completed one.
     */
    const record = (status: number) => {
      if (recorded) return;
      recorded = true;
      const reply: UsageReply = {
        // Empty string, not stored as an answer: a stream that produced no prose
        // has no answer, and '' would render as an empty "Atlas answered".
        ...(answer ? { answer } : {}),
        resultCount: sources.length,
        topHits: sources.slice(0, TOP_HITS_KEPT).map((s) => ({
          entryId: s.entryId,
          title: s.title,
          projectSlug: s.projectSlug,
          sourceType: s.sourceType,
        })),
        model: meta.metrics?.model ?? meta.model,
        promptTokens: meta.metrics?.promptTokens,
        completionTokens: meta.metrics?.completionTokens,
        ttftMs: meta.metrics?.ttftMs,
        degraded: meta.degraded,
        error: streamError,
      };
      // Nothing happened at all (disconnect before the first event): a reply row
      // of all-nulls says less than no reply row.
      const empty = !answer && sources.length === 0 && !streamError;
      void deps.catalog
        .recordCall(
          {
            client: c.req.header('x-atlas-client') ?? 'unknown',
            tool: c.req.header('x-atlas-tool'),
            method: 'POST',
            path: '/api/ask/stream',
            query: question,
            status,
            durationMs: Date.now() - startedAt,
          },
          empty ? undefined : reply,
        )
        .catch((e: unknown) => console.error('[api] usage log failed:', e));
    };

    const stream = new ReadableStream({
      async pull(controller) {
        let next: IteratorResult<AskEvent, unknown>;
        try {
          next = await events.next();
        } catch (e) {
          /**
           * A throw out of the generator errors the stream, and `cancel` does
           * NOT fire for an errored stream — so without this the one failure
           * mode most worth recording would leave no row at all.
           */
          streamError = (e as Error)?.message ?? String(e);
          record(STATUS_STREAM_FAILED);
          controller.error(e);
          return;
        }
        if (next.done) {
          controller.close();
          // A stream that reported an error is a failed answer even though the
          // wire status was 200 — headers flush before the failure is known.
          // Recording 200 would hide every streamed failure from the error rate,
          // which is the one number this table exists to keep honest. Same
          // precedent as 499 for an abort: `status` is the outcome of the call,
          // not the byte that happened to go out.
          record(streamError ? STATUS_STREAM_FAILED : 200);
          return;
        }
        const event = next.value;
        // Accumulate as it goes, so an abort still has whatever was produced.
        if (event.type === 'sources') sources = event.sources;
        else if (event.type === 'delta') answer += event.text;
        else if (event.type === 'done') meta = event;
        // Previously unhandled, which meant a failed stream was recorded as a
        // clean 200 with an empty answer — a successful-looking ask that
        // returned nothing. Found when Postgres went down mid-test and the
        // stream correctly emitted this event.
        else if (event.type === 'error') streamError = event.message;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      },
      cancel: () => {
        void events.return?.(undefined);
        // A question asked and abandoned mid-answer is a finding, not an
        // absence: it says the reply was not worth waiting for. 499 is nginx's
        // client-closed convention, in an INT column we own.
        record(STATUS_CLIENT_ABORTED);
      },
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

  const timelineOpts = (c: { req: { query: (k: string) => string | undefined } }) => ({
    limit: Number(c.req.query('limit') ?? 50),
    before: c.req.query('before') || undefined,
    sources: c.req.query('sources')?.split(',').filter(Boolean) as SourceType[] | undefined,
  });

  /**
   * A typo'd slug used to return an empty 200, indistinguishable from a real
   * project with no data — an agent (or a script) then concludes "nothing
   * happened here" instead of "I misspelled the project". Every per-project
   * route now 404s with a hint instead.
   */
  const requireProject = async (slug: string): Promise<Response | null> => {
    if (await deps.catalog.projectExists(slug)) return null;
    return Response.json(
      { error: `unknown project slug "${slug}" — list valid slugs via /api/projects` },
      { status: 404 },
    );
  };

  /**
   * A project's feed, as a *resource*. Unchanged and load-bearing: both the CLI
   * (`atlas timeline`) and the MCP server call this path. Multi-project belongs
   * on the collection route below, not crammed into a slug that means "one".
   */
  app.get('/api/projects/:slug/timeline', async (c) => {
    const missing = await requireProject(c.req.param('slug'));
    if (missing) return missing;
    const items = await deps.catalog.timeline(c.req.param('slug'), timelineOpts(c));
    return c.json({ items });
  });

  /**
   * The feed as a *filter*: one project, several, or all. `projects=a,b` merges
   * them chronologically; each item carries its own `projectSlug` so a merged
   * feed can say where every row came from.
   */
  app.get('/api/timeline', async (c) => {
    const { project, projects } = parseProjects(c.req.query('projects'));
    const slugs = projects ?? (project ? [project] : []);
    if (!slugs.length) return c.json({ error: 'projects is required' }, 400);
    const items = await deps.catalog.timeline(slugs, timelineOpts(c));
    return c.json({ items });
  });

  /**
   * Cap entry bodies at `maxBody` chars for context-budgeted consumers (MCP).
   * Truncated rows are flagged rather than silently shortened: the entry `id`
   * plus `bodyTruncated: true` tells an agent exactly which entry to re-fetch
   * in full via /api/entries/:id. No param (the UI, the CLI) = untouched.
   */
  const capBodies = <T extends { body?: string }>(rows: T[], maxBody?: number): T[] => {
    if (!maxBody || maxBody <= 0) return rows;
    return rows.map((r) =>
      typeof r.body === 'string' && r.body.length > maxBody
        ? { ...r, body: r.body.slice(0, maxBody), bodyTruncated: true }
        : r,
    );
  };

  app.get('/api/projects/:slug/components', async (c) => {
    const missing = await requireProject(c.req.param('slug'));
    if (missing) return missing;
    return c.json({ components: await deps.catalog.components(c.req.param('slug')) });
  });

  app.get('/api/projects/:slug/components/:name', async (c) => {
    const missing = await requireProject(c.req.param('slug'));
    if (missing) return missing;
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const entries = await deps.catalog.componentHistory(
      c.req.param('slug'),
      c.req.param('name'),
      limit,
    );
    return c.json({
      component: c.req.param('name'),
      entries: capBodies(entries, Number(c.req.query('max_body')) || undefined),
    });
  });

  app.get('/api/projects/:slug/sessions', async (c) => {
    const missing = await requireProject(c.req.param('slug'));
    if (missing) return missing;
    return c.json({ sessions: await deps.catalog.sessionsList(c.req.param('slug')) });
  });

  /**
   * Backlog status view, derived at request time (docs-staleness precedent):
   * marker linking, fuzzy legacy matching and verdict overlay always reflect
   * the current matcher — nothing here is frozen into the index.
   */
  app.get('/api/projects/:slug/backlog', async (c) => {
    const slug = c.req.param('slug');
    const missing = await requireProject(slug);
    if (missing) return missing;
    const view = await loadBacklogView(deps.catalog, slug, {
      threshold: deps.backlogMatchThreshold,
    });
    if (!view) return c.json({ error: 'project not found' }, 404);
    return c.json({
      ...view,
      items: view.items.map((i) => withSource({ ...i, sourceRef: `line:${i.line}` })),
      unlinked: view.unlinked.map((u) => withSource({ ...u, sourceRef: `line:${u.line}` })),
    });
  });

  const VERDICT_STATUSES = new Set([
    'confirmed-open',
    'likely-resolved',
    'confirmed-resolved',
    'inconclusive',
  ]);
  const MARKER_KINDS = new Set(['resolved', 'dropped', 'reopened']);

  /**
   * The write-back line for a verdict — the piece that makes it durable once
   * the caller appends it to the project's backlog.log. Only emitted when the
   * verdict actually warrants a marker: confirmed-resolved → RESOLVED, and
   * confirmed-open against a file that says resolved → REOPENED.
   */
  const markerProposalFor = (
    item: { line: number; lineHash?: string; text: string; status: string },
    verdict: { status: string; evidence?: string; reasoning?: string },
  ): string | undefined => {
    const today = new Date().toISOString().slice(0, 10);
    if (verdict.status === 'confirmed-resolved') {
      // The reviewer's own words when there are any. The protocol asks the
      // marker to restate the item, and a one-line reason for calling it done
      // does that better than the first 120 characters of the original — which
      // is what the explicit `propose` path below already preferred, leaving
      // the commoner path with the worse summary.
      const summary = verdict.reasoning?.trim() || item.text;
      return proposeMarkerLine('resolved', item, summary, today, verdict.evidence);
    }
    if (verdict.status === 'confirmed-open' && item.status === 'resolved') {
      const why = verdict.reasoning?.slice(0, 120) || 'review found it unresolved';
      return proposeMarkerLine('reopened', item, why, today, verdict.evidence);
    }
    return undefined;
  };

  const findBacklogItem = async (slug: string, line: number, sourcePath?: string) => {
    const view = await loadBacklogView(deps.catalog, slug, {
      threshold: deps.backlogMatchThreshold,
    });
    return view?.items.find((i) => i.line === line && (!sourcePath || i.sourcePath === sourcePath));
  };

  /**
   * Review one item: gather evidence from the project's other sources, then
   * (unless judge:false) let the LLM rule on it. Evidence-only serves MCP
   * agents — a coding agent judges better than the mid-size Ask model, and can
   * verify in the code itself. LLM failures return the evidence with an
   * explicit error rather than a fabricated verdict (ask answer-trust ADR).
   */
  app.post('/api/projects/:slug/backlog/review', async (c) => {
    const slug = c.req.param('slug');
    const missing = await requireProject(slug);
    if (missing) return missing;
    const body = await c.req.json().catch(() => ({}));
    const line = Number(body.line);
    if (!Number.isInteger(line) || line < 1) {
      return c.json({ error: 'line (a positive integer) is required' }, 400);
    }
    const item = await findBacklogItem(slug, line, body.sourcePath);
    if (!item) {
      return c.json(
        { error: `no backlog item at line ${line} — list items via GET /api/projects/${slug}/backlog` },
        404,
      );
    }
    c.set('usageQuery', `backlog L${line}: ${item.text.slice(0, 200)}`);
    const evidence = await deps.backlogReview.evidence(
      slug,
      item.text,
      Math.min(Number(body.k ?? 8), 20),
    );
    const base = { item, evidence: evidence.map(withSource) };
    if (body.judge === false) return c.json(base);
    try {
      const verdict = await deps.backlogReview.judge(
        { line: item.line, text: item.text, date: item.date },
        evidence,
      );
      const projectId = await deps.catalog.projectIdBySlug(slug);
      if (projectId !== null) {
        await deps.catalog.upsertBacklogVerdict(projectId, {
          sourcePath: item.sourcePath,
          line: item.line,
          status: verdict.status,
          confidence: verdict.confidence,
          note: verdict.reasoning,
          citations: verdict.citations,
          reviewer: `atlas-llm:${verdict.model}`,
        });
      }
      return c.json({ ...base, verdict, proposedLine: markerProposalFor(item, verdict) });
    } catch (e) {
      return c.json(
        { ...base, error: 'llm_unavailable', detail: (e as Error).message.slice(0, 300) },
        503,
      );
    }
  });

  /**
   * Record a caller's own verdict (MCP agents after they judged the evidence,
   * possibly against the code itself). The response's proposedLine is what the
   * caller appends via the project's blessed helper — Atlas never writes
   * project files.
   */
  app.post('/api/projects/:slug/backlog/verdict', async (c) => {
    const slug = c.req.param('slug');
    const missing = await requireProject(slug);
    if (missing) return missing;
    const body = await c.req.json().catch(() => ({}));
    const line = Number(body.line);
    if (!Number.isInteger(line) || line < 1) {
      return c.json({ error: 'line (a positive integer) is required' }, 400);
    }
    if (!VERDICT_STATUSES.has(body.status)) {
      return c.json({ error: `status must be one of: ${[...VERDICT_STATUSES].join(', ')}` }, 400);
    }
    if (body.propose !== undefined && !MARKER_KINDS.has(body.propose)) {
      return c.json({ error: `propose must be one of: ${[...MARKER_KINDS].join(', ')}` }, 400);
    }
    const item = await findBacklogItem(slug, line, body.sourcePath);
    if (!item) {
      return c.json(
        { error: `no backlog item at line ${line} — list items via GET /api/projects/${slug}/backlog` },
        404,
      );
    }
    const projectId = await deps.catalog.projectIdBySlug(slug);
    if (projectId === null) return c.json({ error: 'project not found' }, 404);
    const client = c.req.header('x-atlas-client') ?? 'unknown';
    await deps.catalog.upsertBacklogVerdict(projectId, {
      sourcePath: item.sourcePath,
      line: item.line,
      status: body.status,
      confidence: Math.min(1, Math.max(0, Number(body.confidence ?? 0.5))),
      note: typeof body.note === 'string' ? body.note : undefined,
      citations: (Array.isArray(body.citations) ? body.citations : []).filter(
        (x: unknown) => typeof x === 'number' && Number.isInteger(x),
      ),
      reviewer: `agent:${client}`,
    });
    // An explicit `propose` overrides the default mapping — e.g. an agent that
    // decided an item is obsolete asks for the DROPPED line outright.
    const proposedLine = body.propose
      ? proposeMarkerLine(
          body.propose,
          item,
          (typeof body.note === 'string' && body.note.trim()) || item.text,
          new Date().toISOString().slice(0, 10),
          typeof body.evidence === 'string' ? body.evidence : undefined,
        )
      : markerProposalFor(item, {
          status: body.status,
          evidence: typeof body.evidence === 'string' ? body.evidence : undefined,
          reasoning: typeof body.note === 'string' ? body.note : undefined,
        });
    return c.json({ ok: true, proposedLine });
  });

  app.get('/api/sessions/:id', async (c) => {
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined;
    const detail = await deps.catalog.sessionDetail(c.req.param('id'), { limit, offset });
    if (!detail) return c.json({ error: 'session not found' }, 404);
    return c.json({
      ...detail,
      entries: capBodies(detail.entries, Number(c.req.query('max_body')) || undefined),
    });
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

  /**
   * Parse a `class` filter ("query,read"). Unknown names are dropped rather
   * than 400ing: a monitoring filter is a view preference, and failing the whole
   * request over one stale bookmark would be a poor trade.
   */
  const parseClasses = (raw?: string): RouteClass[] | undefined => {
    const list = (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is RouteClass => (ROUTE_CLASSES as readonly string[]).includes(s));
    return list.length ? list : undefined;
  };

  const parseDays = (raw?: string) => {
    const n = Number(raw ?? 7);
    return Number.isFinite(n) ? n : 7;
  };

  /** Aggregated usage telemetry: who calls what, latency, error rate. */
  app.get('/api/admin/usage', async (c) =>
    c.json(await deps.catalog.usageStats(parseDays(c.req.query('days')), parseClasses(c.req.query('class')))),
  );

  /** Raw calls, newest first — the forensic view behind the aggregates. */
  app.get('/api/admin/usage/calls', async (c) => {
    const num = (k: string) => (c.req.query(k) ? Number(c.req.query(k)) : undefined);
    const status = c.req.query('status');
    return c.json(
      await deps.catalog.listUsageCalls({
        limit: num('limit'),
        offset: num('offset'),
        client: c.req.query('client') || undefined,
        tool: c.req.query('tool') || undefined,
        classes: parseClasses(c.req.query('class')),
        status: status === 'ok' || status === 'error' ? status : undefined,
        since: c.req.query('since') || undefined,
        until: c.req.query('until') || undefined,
        q: c.req.query('q') || undefined,
      }),
    );
  });

  /** One call with the full reply Atlas gave it. */
  app.get('/api/admin/usage/calls/:id', async (c) => {
    const call = await deps.catalog.usageCall(Number(c.req.param('id')));
    if (!call) return c.json({ error: 'call not found' }, 404);
    return c.json(call);
  });

  /**
   * Tool adoption. Served from cache only: the analysis walks every Claude
   * transcript on the machine, and this container cannot even see them —
   * `~/.claude/projects` is mounted into the indexer alone. The indexer computes
   * it and stores the report; this route just reads it.
   */
  app.get('/api/admin/adoption', async (c) => {
    const raw = await deps.catalog.getSetting(ADOPTION_REPORT_KEY).catch(() => null);
    if (!raw) {
      // An absent report and an empty one are different findings. Saying so
      // keeps "not computed yet" from rendering as "nobody uses Atlas".
      return c.json({ report: null, computedAt: null, pending: true });
    }
    try {
      return c.json(JSON.parse(raw));
    } catch {
      return c.json({ report: null, computedAt: null, pending: true });
    }
  });

  /** Ask the indexer to recompute adoption; returns before it finishes. */
  app.post('/api/admin/adoption/refresh', async (c) => {
    const enqueued = await deps.enqueueAdoption();
    return c.json({ enqueued });
  });

  app.onError((err, c) => {
    // Details go to the service log only — clients get a generic error. The
    // message is stashed for telemetry so the usage record keeps the truth the
    // response body is not allowed to carry.
    console.error('[api] error:', err);
    c.set('usageError', (err as Error)?.message ?? String(err));
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
