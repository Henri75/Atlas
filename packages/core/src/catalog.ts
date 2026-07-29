import pg from 'pg';
import {
  selectedProjects,
  type Entry,
  type IndexStats,
  type Project,
  type ProjectCoverage,
  type SearchFilters,
  type SearchHit,
  type SessionMeta,
  type SourceType,
  type TimelineItem,
} from './types.js';
import { contentHash, deterministicUuid } from './ids.js';
import { resolveProjectAlias } from './discovery.js';
import { tokenize } from './sparse.js';
import {
  TOP_HITS_KEPT,
  routeClass,
  type RouteClass,
  type UsageCall,
  type UsageCallDetail,
  type UsageCallPage,
  type UsageCallQuery,
  type UsageCallRow,
  type UsageInsights,
  type UsageReply,
  type UsageStats,
} from './usage.js';

/**
 * Postgres catalog: projects, scan state, entries, sessions, errors, runs.
 * Entries carry a deterministic dedup_key so re-scans are idempotent, and a
 * generated tsvector column that serves as the search fallback when Qdrant
 * is unavailable.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL DEFAULT '',
  has_kdb BOOLEAN NOT NULL DEFAULT false,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scan_state (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  path TEXT NOT NULL,
  mtime_ms BIGINT NOT NULL DEFAULT 0,
  size BIGINT NOT NULL DEFAULT 0,
  byte_offset BIGINT NOT NULL DEFAULT 0,
  ref TEXT,
  last_scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_type, path)
);

CREATE TABLE IF NOT EXISTS entries (
  id BIGSERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  component TEXT,
  session_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  occurred_at TIMESTAMPTZ,
  source_path TEXT NOT NULL,
  source_ref TEXT,
  meta JSONB NOT NULL DEFAULT '{}',
  dedup_key TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fts tsvector GENERATED ALWAYS AS
    (to_tsvector('english', left(title || ' ' || body, 200000))) STORED
);
CREATE INDEX IF NOT EXISTS entries_project_time ON entries (project_id, occurred_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS entries_source_type ON entries (source_type);
CREATE INDEX IF NOT EXISTS entries_component ON entries (component) WHERE component IS NOT NULL;
CREATE INDEX IF NOT EXISTS entries_session ON entries (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entries_fts ON entries USING gin (fts);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT,
  cwd TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  prompt_count INT NOT NULL DEFAULT 0,
  action_count INT NOT NULL DEFAULT 0,
  files_touched JSONB NOT NULL DEFAULT '[]',
  source_path TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions (project_id, started_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS index_errors (
  id BIGSERIAL PRIMARY KEY,
  project_id INT,
  path TEXT NOT NULL,
  stage TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS index_runs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  stats JSONB NOT NULL DEFAULT '{}'
);

-- Usage telemetry: one row per API call. EVERY request is recorded, polling
-- included — the earlier "only requests carrying x-atlas-client" rule kept this
-- table clean by making the user's own use of Atlas invisible, a poor trade for
-- a tool whose entire subject is what happened. Noise is separated at READ time
-- by route_class instead (see core/src/usage.ts).
CREATE TABLE IF NOT EXISTS usage_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  client TEXT NOT NULL,
  tool TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  query TEXT,
  status INT NOT NULL,
  duration_ms INT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_log_at_idx ON usage_log (at DESC);

-- What Atlas replied. A separate 1:1 table rather than columns on usage_log,
-- because the overwhelming majority of rows (reads, polls, health checks) carry
-- no reply at all, and a mostly-null TEXT column would be dragged through every
-- aggregate query on the hot table.
--
-- ON DELETE CASCADE keeps pruning a single-table operation, and makes it
-- impossible to end up holding answer text orphaned from the question that
-- produced it.
CREATE TABLE IF NOT EXISTS usage_reply (
  call_id BIGINT PRIMARY KEY REFERENCES usage_log(id) ON DELETE CASCADE,
  answer TEXT,
  result_count INT,
  top_hits JSONB,
  model TEXT,
  prompt_tokens INT,
  completion_tokens INT,
  ttft_ms INT,
  degraded BOOLEAN,
  error TEXT
);

-- Backlog review verdicts. Durable working state (usage_log precedent): it
-- survives reindexing, but the canonical durable record is the marker line the
-- caller appends to the project's backlog.log — losing this table only loses
-- verdicts never written back, and those items honestly revert to open.
CREATE TABLE IF NOT EXISTS backlog_review (
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL,
  line INT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  note TEXT,
  citations JSONB NOT NULL DEFAULT '[]',
  reviewer TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, source_path, line)
);

-- CREATE TABLE IF NOT EXISTS never adds a column to a table that already
-- exists, so new columns need an explicit, idempotent ALTER.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS action_count INT NOT NULL DEFAULT 0;

-- Which Qdrant collection this entry's vectors were written to. NULL, or any
-- value other than the active collection, means "not searchable right now".
--
-- Collection-valued rather than a timestamp on purpose: the name encodes
-- provider/model/dimension, so switching the embedding model invalidates every
-- row for free. A vectorized_at timestamp would report full coverage against
-- a brand-new empty collection and silently skip the rebuild.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS vectorized_in TEXT;

-- A project that is an older location of another (a moved checkout). Its Claude
-- transcripts no longer match any code root, so they were filed under a slug
-- derived from the whole old path. The entries are real and unique -- the only
-- copy of that era -- so rather than re-attributing them (which would rewrite
-- every dedup_key and risk duplicating the catalog on the next scan) the scope
-- of a search simply expands to include them.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS alias_of INT REFERENCES projects(id);
-- The reconciler's hot query. Partial, so it stays tiny while coverage is whole.
CREATE INDEX IF NOT EXISTS entries_unvectorized ON entries (id) WHERE vectorized_in IS NULL;

-- What kind of route this call hit: query | read | write | status | admin | other.
-- Derived from the path by routeClass() (core/src/usage.ts), never by the caller,
-- so it cannot disagree with itself across clients.
--
-- Storing a derived value is safe here precisely because it is a PURE function of
-- a column we also keep: resyncRouteClasses() recomputes the whole column from
-- path whenever the classifier improves, so an early misclassification is never
-- baked in. Rows predating this column read as 'other' until that first resync.
ALTER TABLE usage_log ADD COLUMN IF NOT EXISTS route_class TEXT NOT NULL DEFAULT 'other';

-- The rest of what the gateway reports about an answer, from the same
-- x-g2p-reply-* headers that carry the served model. attempts > 1 means the
-- gateway failed over internally before it succeeded; request_id is the only
-- way to line one of our answers up against the gateway own logs when it
-- turns out to have been wrong.
ALTER TABLE usage_reply ADD COLUMN IF NOT EXISTS attempts INT;
ALTER TABLE usage_reply ADD COLUMN IF NOT EXISTS request_id TEXT;
-- The monitor's hot query: one class, newest first.
CREATE INDEX IF NOT EXISTS usage_log_class_at_idx ON usage_log (route_class, at DESC);
`;

export interface ScanState {
  mtimeMs: number;
  size: number;
  byteOffset: number;
  ref?: string;
}

export interface InsertedEntry {
  id: number;
  entry: Entry;
}

/**
 * Build a full-text query that finds documents matching *some* of the words.
 *
 * `websearch_to_tsquery` was used here, and it ANDs every unquoted term:
 * `worker pool resize procedure supervisorctl stopwaitsecs` becomes
 * `'worker' & 'pool' & 'resiz' & 'procedur' & 'supervisorctl' & 'stopwaitsec'`,
 * which requires all six in one entry. Measured against the live index: that
 * query matched **0** entries, while `worker pool resize` matched 31 and
 * `supervisorctl` alone matched 182.
 *
 * The consequence was worse than a bad ranking. This is the degraded path taken
 * when Qdrant is unreachable, and an empty result is returned as
 * `{ hits: [], mode: 'fts' }` — indistinguishable, to any caller, from "the index
 * genuinely holds nothing about this". A broken fallback presented itself as a
 * confident negative answer, which is the failure class
 * `20260725-ask-answer-trust-contract.md` exists to eliminate.
 *
 * OR semantics with `ts_rank` ordering is the standard shape for a
 * natural-language query: every term contributes to the score, entries matching
 * more of them rank higher, and matching one still beats matching none.
 *
 * Terms come from `tokenize`, the sparse encoder's own tokeniser, so the two
 * keyword paths cannot disagree about what counts as a term — the same reasoning
 * that keeps the filter translation identical across the vector and FTS paths.
 * It also removes the injection surface: tokens are `[a-z0-9_.]` only, so nothing
 * reaches `to_tsquery`'s parser that could be read as an operator.
 *
 * **Terms are deliberately not quoted**, now that a token may contain `.`.
 * Postgres' english parser splits a measurement into its number and its unit —
 * `to_tsvector('english', '6.8MB')` is `'6.8':1 'mb':2` — and correspondingly
 * parses the bare term `6.8mb` into the adjacency query `'6.8' <-> 'mb'`, which
 * matches. Quoting it would instead ask for a single lexeme `'6.8mb'` that no
 * tsvector in the index contains, turning a working term into a guaranteed miss.
 * Dotted names (`deepcast.io`, `127.0.0.1`, `v1.18.2`) already parse as one
 * lexeme and need no help.
 */
export function ftsQuery(q: string): string {
  const terms = tokenize(q);
  // No usable terms (all stopwords, or punctuation only) yields a query that
  // matches nothing — correct, and it must not be a syntax error.
  if (!terms.length) return '';
  return terms.join(' | ');
}

/** Shared by every query that rebuilds an Entry from the catalog. */
const ENTRY_COLUMNS = `e.id, e.source_type, e.component, e.session_id, e.title, e.body,
              e.occurred_at, e.source_path, e.source_ref, e.meta, p.slug`;

/** Row → Entry. Kept in one place so re-embedding paths cannot drift apart. */
function rowToEntry(row: any): Entry & { id: number } {
  return {
    id: row.id,
    projectSlug: row.slug,
    sourceType: row.source_type,
    component: row.component ?? undefined,
    sessionId: row.session_id ?? undefined,
    title: row.title,
    body: row.body,
    occurredAt: row.occurred_at?.toISOString(),
    sourcePath: row.source_path,
    sourceRef: row.source_ref ?? undefined,
    // Without meta a collection rebuild would drop kind/doc_status payloads.
    meta: row.meta ?? undefined,
  };
}

export class Catalog {
  readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    // BIGSERIAL/int8 come back as strings by default; our ids fit safely in a
    // double, and string ids silently break Map lookups during search hydration.
    pg.types.setTypeParser(20, (v) => parseInt(v, 10));
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  }

  async migrate(): Promise<void> {
    // Several services migrate on boot; an advisory lock serializes them
    // (concurrent CREATE TABLE IF NOT EXISTS races on pg_type otherwise).
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(732015)');
      await client.query(SCHEMA);
    } finally {
      await client.query('SELECT pg_advisory_unlock(732015)').catch(() => {});
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertProject(p: {
    slug: string;
    name: string;
    rootPath: string;
    hasKdb: boolean;
  }): Promise<number> {
    const r = await this.pool.query(
      `INSERT INTO projects (slug, name, root_path, has_kdb) VALUES ($1,$2,$3,$4)
       ON CONFLICT (slug) DO UPDATE SET root_path = EXCLUDED.root_path, has_kdb = EXCLUDED.has_kdb
       RETURNING id`,
      [p.slug, p.name, p.rootPath, p.hasKdb],
    );
    return r.rows[0].id;
  }

  /**
   * Record one API call and, when there is one, what Atlas replied.
   *
   * Callers fire-and-forget this — usage telemetry must never be able to slow
   * down or fail the request it measures.
   *
   * Both rows go in ONE data-modifying CTE rather than an explicit transaction.
   * A single statement is atomic by definition, so there is no BEGIN/COMMIT to
   * leak and no connection to check out, and it costs one round trip instead of
   * three. The alternative shape — insert the call here, UPDATE it with the
   * reply later — races: this write is fire-and-forget and unordered, so the
   * UPDATE could target a row that does not exist yet.
   *
   * The trailing `WHERE $18` is what makes the reply optional: a data-modifying
   * CTE always runs, so the outer INSERT selects zero rows when there is nothing
   * to say, and the call row is still written.
   */
  async recordCall(call: UsageCall, reply?: UsageReply): Promise<void> {
    await this.pool.query(
      `WITH c AS (
         INSERT INTO usage_log (client, tool, method, path, query, status, duration_ms, route_class)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id
       )
       INSERT INTO usage_reply
         (call_id, answer, result_count, top_hits, model, prompt_tokens, completion_tokens, ttft_ms, degraded, error, attempts, request_id)
       SELECT c.id, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19 FROM c WHERE $20`,
      [
        // Clamped to the column widths in one place, so an oversized tool name
        // or path is truncated here rather than at every call site.
        call.client.slice(0, 40),
        call.tool?.slice(0, 80) ?? null,
        call.method,
        call.path.slice(0, 300),
        call.query?.slice(0, 500) ?? null,
        call.status,
        Math.round(call.durationMs),
        routeClass(call.path),
        // `answer` is deliberately NOT truncated: it is the record this table
        // exists for, it lives in TEXT, and the LLM's own max_tokens already
        // bounds it. An error message is a different thing and is clamped.
        reply?.answer ?? null,
        reply?.resultCount ?? null,
        reply?.topHits ? JSON.stringify(reply.topHits.slice(0, TOP_HITS_KEPT)) : null,
        reply?.model?.slice(0, 120) ?? null,
        reply?.promptTokens ?? null,
        reply?.completionTokens ?? null,
        reply?.ttftMs == null ? null : Math.round(reply.ttftMs),
        reply?.degraded ?? null,
        reply?.error?.slice(0, 500) ?? null,
        reply?.attempts ?? null,
        reply?.requestId?.slice(0, 120) ?? null,
        // Always last: the guard that makes the reply INSERT select no rows.
        // Appending new columns before it keeps that positional contract, which
        // the write-path tests assert against.
        reply != null,
      ],
    );
  }

  /**
   * Recompute `route_class` for every row from its stored `path`.
   *
   * This is what makes storing a derived value safe: improving routeClass() (or
   * adding a route that used to land in 'other') retro-applies to the whole
   * history instead of leaving a permanent seam at the deploy boundary. Same
   * shape as the backlog parser-version resync. Returns rows changed.
   */
  async resyncRouteClasses(): Promise<number> {
    const r = await this.pool.query(`SELECT id, path FROM usage_log`);
    const byClass = new Map<string, number[]>();
    for (const row of r.rows as { id: number; path: string }[]) {
      const cls = routeClass(row.path);
      const ids = byClass.get(cls) ?? [];
      ids.push(row.id);
      byClass.set(cls, ids);
    }
    let changed = 0;
    for (const [cls, ids] of byClass) {
      const u = await this.pool.query(
        `UPDATE usage_log SET route_class = $1 WHERE id = ANY($2::bigint[]) AND route_class <> $1`,
        [cls, ids],
      );
      changed += u.rowCount ?? 0;
    }
    return changed;
  }

  /** One row per (project, backlog file, line); a re-review replaces the verdict. */
  async upsertBacklogVerdict(
    projectId: number,
    v: {
      sourcePath: string;
      line: number;
      status: string;
      confidence: number;
      note?: string;
      citations?: number[];
      reviewer: string;
    },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO backlog_review (project_id, source_path, line, status, confidence, note, citations, reviewer, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT (project_id, source_path, line) DO UPDATE
       SET status=$4, confidence=$5, note=$6, citations=$7, reviewer=$8, reviewed_at=now()`,
      [
        projectId,
        v.sourcePath,
        v.line,
        v.status,
        v.confidence,
        v.note?.slice(0, 2000) ?? null,
        JSON.stringify(v.citations ?? []),
        v.reviewer.slice(0, 80),
      ],
    );
  }

  async backlogVerdicts(projectId: number): Promise<
    {
      sourcePath: string;
      line: number;
      status: string;
      confidence: number;
      note?: string;
      citations: number[];
      reviewer: string;
      reviewedAt: string;
    }[]
  > {
    const r = await this.pool.query(
      `SELECT source_path, line, status, confidence, note, citations, reviewer, reviewed_at
       FROM backlog_review WHERE project_id=$1`,
      [projectId],
    );
    return r.rows.map((row) => ({
      sourcePath: row.source_path,
      line: row.line,
      status: row.status,
      confidence: row.confidence,
      note: row.note ?? undefined,
      citations: row.citations ?? [],
      reviewer: row.reviewer,
      reviewedAt: new Date(row.reviewed_at).toISOString(),
    }));
  }

  /** The project's kdb_backlog entries in file order, for the status view. */
  async backlogEntries(projectId: number): Promise<
    {
      id: number;
      body: string;
      component?: string;
      occurredAt?: string;
      sourcePath: string;
      sourceRef?: string;
      meta?: Record<string, unknown>;
    }[]
  > {
    const r = await this.pool.query(
      `SELECT id, body, component, occurred_at, source_path, source_ref, meta
       FROM entries WHERE project_id=$1 AND source_type='kdb_backlog'
       ORDER BY source_path, id`,
      [projectId],
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      body: row.body,
      component: row.component ?? undefined,
      occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : undefined,
      sourcePath: row.source_path,
      sourceRef: row.source_ref ?? undefined,
      meta: row.meta ?? undefined,
    }));
  }

  /** Newest indexed activity in the project — the freshness bar for stale-review badges. */
  async latestActivityAt(projectId: number): Promise<string | undefined> {
    const r = await this.pool.query(
      `SELECT max(occurred_at) AS at FROM entries WHERE project_id=$1`,
      [projectId],
    );
    return r.rows[0]?.at ? new Date(r.rows[0].at).toISOString() : undefined;
  }

  /**
   * Re-parsing only inserts NEW dedup keys, so rows that already existed keep
   * their old meta (no lineHash/marker). Fix them in place — Postgres only;
   * the vector payload does not carry backlog meta. Docs-backfill precedent.
   */
  async syncBacklogMeta(projectId: number, entries: Entry[]): Promise<number> {
    if (!entries.length) return 0;
    const keys = entries.map((e) => Catalog.dedupKey(e));
    const metas = entries.map((e) => JSON.stringify(e.meta ?? {}));
    const r = await this.pool.query(
      `UPDATE entries e SET meta = u.meta::jsonb
       FROM unnest($2::text[], $3::text[]) AS u(dedup_key, meta)
       WHERE e.project_id=$1 AND e.dedup_key = u.dedup_key AND e.meta <> u.meta::jsonb`,
      [projectId, keys, metas],
    );
    return r.rowCount ?? 0;
  }

  /**
   * Aggregate the usage log for monitoring: who calls what, how often, how
   * slow, and how often it errors. `tool` falls back to the path so CLI and UI
   * calls (which carry no tool header) still group meaningfully.
   *
   * Percentiles rather than averages alone, because the average is the one
   * statistic a 95-second outlier can quietly dominate: `atlas_ask` averages
   * ~35s against a much lower median, and reading only the mean makes every ask
   * look slow. Both are returned so neither has to be inferred.
   *
   * `classes` filters which route classes count. The caller passes it because
   * "how much is Atlas used" and "how much is Atlas polled" are different
   * questions over the same table, and the answer must not silently pick one.
   */
  async usageStats(days = 7, classes?: RouteClass[]): Promise<UsageStats> {
    const interval = `${Math.min(Math.max(1, days), 365)} days`;
    // An empty list would mean "no classes" and return nothing, which reads as
    // "Atlas is unused" rather than "you filtered everything out". Treat it as
    // unfiltered, matching the absent case.
    const filter = classes?.length ? classes : null;
    const args = [interval, filter];
    const scope = `FROM usage_log
       WHERE at > now() - $1::interval
         AND ($2::text[] IS NULL OR route_class = ANY($2::text[]))`;

    const [byTool, byDay, byClass, byHour, totals] = await Promise.all([
      this.pool.query(
        `SELECT client, coalesce(tool, path) AS tool, count(*)::int AS calls,
                avg(duration_ms)::int AS avg_ms,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS p50_ms,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms,
                max(duration_ms)::int AS max_ms,
                count(*) FILTER (WHERE status >= 400)::int AS errors,
                max(at) AS last_at
         ${scope}
         GROUP BY client, coalesce(tool, path)
         ORDER BY calls DESC`,
        args,
      ),
      this.pool.query(
        `SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, client, count(*)::int AS calls
         ${scope}
         GROUP BY day, client ORDER BY day DESC`,
        args,
      ),
      // Deliberately NOT filtered by `classes`: this breakdown is how the reader
      // discovers what a filter is currently hiding. Filtering it would make the
      // excluded classes disappear from the one view that names them.
      this.pool.query(
        `SELECT route_class, count(*)::int AS calls
         FROM usage_log WHERE at > now() - $1::interval
         GROUP BY route_class ORDER BY calls DESC`,
        [interval],
      ),
      this.pool.query(
        `SELECT extract(hour FROM at AT TIME ZONE 'UTC')::int AS hour, count(*)::int AS calls
         ${scope}
         GROUP BY hour ORDER BY hour`,
        args,
      ),
      this.pool.query(
        `SELECT count(*)::int AS calls,
                count(*) FILTER (WHERE status >= 400)::int AS errors,
                count(DISTINCT client)::int AS clients,
                coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p50_ms,
                coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms
         ${scope}`,
        args,
      ),
    ]);

    const t = totals.rows[0] ?? {};
    return {
      days,
      calls: t.calls ?? 0,
      errors: t.errors ?? 0,
      clients: t.clients ?? 0,
      p50Ms: t.p50_ms ?? 0,
      p95Ms: t.p95_ms ?? 0,
      byTool: byTool.rows.map((r: any) => ({
        client: r.client,
        tool: r.tool,
        calls: r.calls,
        avgMs: r.avg_ms ?? 0,
        p50Ms: r.p50_ms ?? 0,
        p95Ms: r.p95_ms ?? 0,
        maxMs: r.max_ms ?? 0,
        errors: r.errors,
        lastAt: r.last_at ? new Date(r.last_at).toISOString() : '',
      })),
      byDay: byDay.rows,
      byClass: byClass.rows.map((r: any) => ({ routeClass: r.route_class, calls: r.calls })),
      byHour: byHour.rows,
    };
  }

  /**
   * One page of raw calls, newest first — the forensic view. At a few hundred
   * calls a month the useful instrument is reading the actual traffic, not only
   * summarising it.
   *
   * `hasReply` comes from an EXISTS rather than a join so the (potentially very
   * large) answer text is never dragged into a list query. The body is fetched
   * one row at a time by `usageCall`.
   */
  async listUsageCalls(opts: UsageCallQuery = {}): Promise<UsageCallPage> {
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
    const where: string[] = [];
    const p: unknown[] = [];
    const add = (sql: string, val: unknown) => {
      p.push(val);
      where.push(sql.replace(/\$\?/g, `$${p.length}`));
    };

    if (opts.client) add('client = $?', opts.client);
    if (opts.tool) add('coalesce(tool, path) = $?', opts.tool);
    if (opts.classes?.length) add('route_class = ANY($?::text[])', opts.classes);
    if (opts.status === 'error') where.push('status >= 400');
    if (opts.status === 'ok') where.push('status < 400');
    if (opts.since) add('at >= $?::timestamptz', opts.since);
    if (opts.until) add('at < $?::timestamptz', opts.until);
    // Matches the question text, not the path: this box exists to answer "what
    // did anyone ask about pgbouncer", and ILIKE keeps it a plain substring so
    // a typed regex character cannot blow up the query.
    if (opts.q) add('query ILIKE $?', `%${opts.q}%`);

    /**
     * Drop the rows that carry no information about what anyone wanted:
     * `/api/projects` (the scope bar refetching its list) and any call with no
     * query text at all.
     *
     * Applied in SQL rather than in the browser on purpose. Filtering after the
     * fetch would make `total` and the facet counts describe a different set
     * from the rows beneath them, and every infinite-scroll page would return an
     * unpredictable number of visible rows — sometimes zero, which reads as
     * "the end" when it is not.
     */
    if (opts.hideNoise) {
      where.push("path <> '/api/projects'");
      where.push("query IS NOT NULL AND query <> ''");
    }

    /**
     * Keyset cursor, not OFFSET. This table gains rows continuously (health
     * checks land every few seconds), so an OFFSET page is measured from a top
     * that has moved: page 2 re-serves rows already shown and skips others.
     * `(at, id)` names a position in the data instead of a count from the top,
     * so it stays correct however many rows arrive mid-scroll. `id` breaks ties
     * because `at` is not unique.
     */
    if (opts.cursor) {
      p.push(opts.cursor.at, opts.cursor.id);
      where.push(`(l.at, l.id) < ($${p.length - 1}::timestamptz, $${p.length}::bigint)`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // The cursor bound must not narrow the totals or the facets: those describe
    // the whole filtered set, not the page. Hence a second clause without it.
    const scopeWhere = where.filter((w) => !w.includes('(l.at, l.id) <'));
    const scopeClause = scopeWhere.length ? `WHERE ${scopeWhere.join(' AND ')}` : '';
    const scopeParams = opts.cursor ? p.slice(0, -2) : p;

    const [rows, count, byClient, byTool] = await Promise.all([
      this.pool.query(
        `SELECT l.id, l.at, l.client, l.tool, l.method, l.path, l.query, l.status,
                l.duration_ms, l.route_class,
                EXISTS (SELECT 1 FROM usage_reply r WHERE r.call_id = l.id) AS has_reply
         FROM usage_log l ${clause}
         ORDER BY l.at DESC, l.id DESC
         LIMIT ${limit}`,
        p,
      ),
      this.pool.query(`SELECT count(*)::int AS n FROM usage_log l ${scopeClause}`, scopeParams),
      // Facets over the filtered set, so the headline counts always add up to
      // what the list is actually showing.
      this.pool.query(
        `SELECT l.client AS key, count(*)::int AS calls FROM usage_log l ${scopeClause}
         GROUP BY l.client ORDER BY calls DESC`,
        scopeParams,
      ),
      this.pool.query(
        `SELECT coalesce(l.tool, l.path) AS key, count(*)::int AS calls FROM usage_log l ${scopeClause}
         GROUP BY coalesce(l.tool, l.path) ORDER BY calls DESC LIMIT 25`,
        scopeParams,
      ),
    ]);

    const calls = rows.rows.map((r: any) => this.toCallRow(r));
    const last = calls.at(-1);
    return {
      calls,
      total: count.rows[0]?.n ?? 0,
      facets: {
        byClient: byClient.rows.map((r: any) => ({ key: r.key ?? 'unknown', calls: r.calls })),
        byTool: byTool.rows.map((r: any) => ({ key: r.key ?? '—', calls: r.calls })),
      },
      // Absent when this page was not full: there is provably nothing after it,
      // so the client can stop rather than fetch once more to discover empty.
      nextCursor: calls.length === limit && last ? { at: last.at, id: last.id } : undefined,
    };
  }

  /**
   * Aggregates for the Stats tab: not "how many calls" (the Overview answers
   * that) but "is Atlas actually working for anyone".
   *
   * The two numbers worth the query are `zeroResult` and `zeroSource` — searches
   * and asks that returned nothing. Volume charts look identical whether every
   * answer landed or none did; those two are the difference.
   */
  async usageInsights(days = 30): Promise<UsageInsights> {
    const interval = `${Math.min(Math.max(1, days), 365)} days`;
    const a = [interval];

    const [ask, search, latency, topQueries, models, byDow] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::int AS calls,
                count(*) FILTER (WHERE l.status = 499)::int AS aborted,
                count(*) FILTER (WHERE l.status >= 500)::int AS failed,
                count(*) FILTER (WHERE r.degraded)::int AS degraded,
                count(*) FILTER (WHERE r.result_count = 0)::int AS zero_source,
                coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY l.duration_ms),0)::int AS p50_ms,
                coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY l.duration_ms),0)::int AS p95_ms,
                coalesce(sum(r.prompt_tokens),0)::int AS prompt_tokens,
                coalesce(sum(r.completion_tokens),0)::int AS completion_tokens,
                coalesce(avg(r.ttft_ms),0)::int AS avg_ttft_ms
         FROM usage_log l LEFT JOIN usage_reply r ON r.call_id = l.id
         WHERE l.at > now() - $1::interval AND l.path IN ('/api/ask','/api/ask/stream')`,
        a,
      ),
      this.pool.query(
        `SELECT count(*)::int AS calls,
                count(*) FILTER (WHERE r.result_count = 0)::int AS zero_result,
                coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY l.duration_ms),0)::int AS p50_ms,
                coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY l.duration_ms),0)::int AS p95_ms,
                coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.result_count),0)::int AS median_results
         FROM usage_log l LEFT JOIN usage_reply r ON r.call_id = l.id
         WHERE l.at > now() - $1::interval AND l.path = '/api/search'`,
        a,
      ),
      // Log-ish buckets by hand rather than width_bucket: latency here spans
      // 1ms to 95s, and equal-width buckets would put everything in one.
      this.pool.query(
        `SELECT bucket, count(*)::int AS calls FROM (
           SELECT CASE
             WHEN duration_ms <   100 THEN '<100ms'
             WHEN duration_ms <   500 THEN '100-500ms'
             WHEN duration_ms <  1000 THEN '0.5-1s'
             WHEN duration_ms <  3000 THEN '1-3s'
             WHEN duration_ms < 10000 THEN '3-10s'
             WHEN duration_ms < 30000 THEN '10-30s'
             ELSE '>30s' END AS bucket
           FROM usage_log
           WHERE at > now() - $1::interval AND route_class IN ('query','read','write')
         ) b GROUP BY bucket`,
        a,
      ),
      this.pool.query(
        `SELECT query, min(path) AS path, count(*)::int AS calls, max(at) AS last_at
         FROM usage_log
         WHERE at > now() - $1::interval AND route_class = 'query'
           AND query IS NOT NULL AND query <> ''
         GROUP BY query ORDER BY calls DESC, last_at DESC LIMIT 15`,
        a,
      ),
      this.pool.query(
        `SELECT r.model, count(*)::int AS calls,
                coalesce(sum(r.completion_tokens),0)::int AS completion_tokens
         FROM usage_reply r JOIN usage_log l ON l.id = r.call_id
         WHERE l.at > now() - $1::interval AND r.model IS NOT NULL
         GROUP BY r.model ORDER BY calls DESC`,
        a,
      ),
      this.pool.query(
        `SELECT extract(isodow FROM at AT TIME ZONE 'UTC')::int AS dow, count(*)::int AS calls
         FROM usage_log
         WHERE at > now() - $1::interval AND route_class IN ('query','read','write')
         GROUP BY dow ORDER BY dow`,
        a,
      ),
    ]);

    const askRow = ask.rows[0] ?? {};
    const searchRow = search.rows[0] ?? {};
    return {
      days,
      ask: {
        calls: askRow.calls ?? 0,
        aborted: askRow.aborted ?? 0,
        failed: askRow.failed ?? 0,
        degraded: askRow.degraded ?? 0,
        zeroSource: askRow.zero_source ?? 0,
        p50Ms: askRow.p50_ms ?? 0,
        p95Ms: askRow.p95_ms ?? 0,
        promptTokens: askRow.prompt_tokens ?? 0,
        completionTokens: askRow.completion_tokens ?? 0,
        avgTtftMs: askRow.avg_ttft_ms ?? 0,
      },
      search: {
        calls: searchRow.calls ?? 0,
        zeroResult: searchRow.zero_result ?? 0,
        p50Ms: searchRow.p50_ms ?? 0,
        p95Ms: searchRow.p95_ms ?? 0,
        medianResults: searchRow.median_results ?? 0,
      },
      latency: latency.rows.map((r: any) => ({ bucket: r.bucket, calls: r.calls })),
      topQueries: topQueries.rows.map((r: any) => ({
        query: r.query,
        path: r.path,
        calls: r.calls,
        lastAt: new Date(r.last_at).toISOString(),
      })),
      models: models.rows.map((r: any) => ({
        model: r.model,
        calls: r.calls,
        completionTokens: r.completion_tokens,
      })),
      byDow: byDow.rows.map((r: any) => ({ dow: r.dow, calls: r.calls })),
    };
  }

  /** One call with its full reply, or null if the id is unknown. */
  async usageCall(id: number): Promise<UsageCallDetail | null> {
    const r = await this.pool.query(
      `SELECT l.id, l.at, l.client, l.tool, l.method, l.path, l.query, l.status,
              l.duration_ms, l.route_class,
              (r.call_id IS NOT NULL) AS has_reply,
              r.answer, r.result_count, r.top_hits, r.model,
              r.prompt_tokens, r.completion_tokens, r.ttft_ms, r.degraded, r.error,
              r.attempts, r.request_id
       FROM usage_log l LEFT JOIN usage_reply r ON r.call_id = l.id
       WHERE l.id = $1`,
      [id],
    );
    const row: any = r.rows[0];
    if (!row) return null;
    const detail: UsageCallDetail = this.toCallRow(row);
    if (row.has_reply) {
      detail.reply = {
        answer: row.answer ?? undefined,
        resultCount: row.result_count ?? undefined,
        topHits: row.top_hits ?? undefined,
        model: row.model ?? undefined,
        promptTokens: row.prompt_tokens ?? undefined,
        completionTokens: row.completion_tokens ?? undefined,
        ttftMs: row.ttft_ms ?? undefined,
        degraded: row.degraded ?? undefined,
        error: row.error ?? undefined,
        attempts: row.attempts ?? undefined,
        requestId: row.request_id ?? undefined,
      };
    }
    return detail;
  }

  private toCallRow(r: any): UsageCallRow {
    return {
      id: Number(r.id),
      at: new Date(r.at).toISOString(),
      client: r.client,
      tool: r.tool ?? undefined,
      method: r.method,
      path: r.path,
      query: r.query ?? undefined,
      status: r.status,
      durationMs: r.duration_ms,
      routeClass: r.route_class as RouteClass,
      hasReply: Boolean(r.has_reply),
    };
  }

  /** Delete calls older than `days`. The unscheduled escape hatch; replies cascade. */
  async pruneUsage(days: number): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM usage_log WHERE at < now() - $1::interval`,
      [`${Math.max(1, Math.floor(days))} days`],
    );
    return r.rowCount ?? 0;
  }

  /**
   * Cheap existence probe so per-project routes can 404 on a typo'd slug
   * instead of returning an empty 200 that reads as "project has no data".
   */
  async projectExists(slug: string): Promise<boolean> {
    const r = await this.pool.query('SELECT 1 FROM projects WHERE slug = $1', [slug]);
    return r.rows.length > 0;
  }

  async listProjects(): Promise<(Project & { entryCount: number })[]> {
    const r = await this.pool.query(
      `SELECT p.id, p.slug, p.name, p.root_path, p.has_kdb, p.discovered_at,
              c.slug AS alias_of_slug, count(e.id)::int AS entry_count
       FROM projects p
       LEFT JOIN entries e ON e.project_id = p.id
       LEFT JOIN projects c ON p.alias_of = c.id
       GROUP BY p.id, c.slug ORDER BY entry_count DESC, p.slug`,
    );
    return r.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      rootPath: row.root_path,
      hasKdb: row.has_kdb,
      discoveredAt: row.discovered_at?.toISOString?.() ?? String(row.discovered_at),
      ...(row.alias_of_slug ? { aliasOf: row.alias_of_slug } : {}),
      entryCount: row.entry_count,
    }));
  }

  async projectIdBySlug(slug: string): Promise<number | null> {
    const r = await this.pool.query('SELECT id FROM projects WHERE slug = $1', [slug]);
    return r.rows[0]?.id ?? null;
  }

  async getScanState(
    projectId: number,
    sourceType: string,
    path: string,
  ): Promise<ScanState | null> {
    const r = await this.pool.query(
      `SELECT mtime_ms, size, byte_offset, ref FROM scan_state
       WHERE project_id=$1 AND source_type=$2 AND path=$3`,
      [projectId, sourceType, path],
    );
    if (!r.rows[0]) return null;
    return {
      mtimeMs: Number(r.rows[0].mtime_ms),
      size: Number(r.rows[0].size),
      byteOffset: Number(r.rows[0].byte_offset),
      ref: r.rows[0].ref ?? undefined,
    };
  }

  async setScanState(
    projectId: number,
    sourceType: string,
    path: string,
    s: ScanState,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO scan_state (project_id, source_type, path, mtime_ms, size, byte_offset, ref, last_scanned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (project_id, source_type, path) DO UPDATE
       SET mtime_ms=$4, size=$5, byte_offset=$6, ref=$7, last_scanned_at=now()`,
      [projectId, sourceType, path, s.mtimeMs, s.size, s.byteOffset, s.ref ?? null],
    );
  }

  static dedupKey(e: Entry): string {
    return deterministicUuid(
      e.projectSlug,
      e.sourcePath,
      e.sourceRef ?? '',
      e.title,
      contentHash(e.body),
    );
  }

  /**
   * Idempotent bulk insert; returns ids of NEW entries only (existing ones are
   * skipped). One multi-row INSERT per chunk instead of a round-trip per entry
   * — a single transcript emits tens of thousands of entries, and the old
   * per-row loop made that many sequential awaited queries the dominant indexer
   * cost. RETURNING with ON CONFLICT DO NOTHING yields only the rows actually
   * inserted, so `dedup_key` rides back with each id to re-pair it to its Entry.
   */
  async insertEntries(projectId: number, entries: Entry[]): Promise<InsertedEntry[]> {
    if (!entries.length) return [];

    // Two identical dedup_keys in ONE statement would make ON CONFLICT try to
    // affect the same row twice; collapse them here so the DB never sees a
    // within-statement clash. First occurrence wins — they are byte-identical
    // by construction (the key hashes the content), so which one is arbitrary.
    const byKey = new Map<string, { entry: Entry; key: string }>();
    for (const e of entries) {
      const key = Catalog.dedupKey(e);
      if (!byKey.has(key)) byKey.set(key, { entry: e, key });
    }
    const rows = [...byKey.values()];

    // 11 params/row against Postgres's 65535-parameter ceiling → cap the chunk
    // well under it so a huge file still fits in whole statements.
    const COLS = 11;
    const MAX_ROWS = Math.floor(60000 / COLS); // ~5454
    const out: InsertedEntry[] = [];

    for (let start = 0; start < rows.length; start += MAX_ROWS) {
      const slice = rows.slice(start, start + MAX_ROWS);
      const params: unknown[] = [];
      const tuples = slice.map(({ entry: e, key }, i) => {
        const b = i * COLS;
        params.push(
          projectId,
          e.sourceType,
          e.component ?? null,
          e.sessionId ?? null,
          e.title,
          e.body,
          e.occurredAt ?? null,
          e.sourcePath,
          e.sourceRef ?? null,
          JSON.stringify(e.meta ?? {}),
          key,
        );
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`;
      });
      const r = await this.pool.query(
        `INSERT INTO entries (project_id, source_type, component, session_id, title, body,
                              occurred_at, source_path, source_ref, meta, dedup_key)
         VALUES ${tuples.join(',')}
         ON CONFLICT (dedup_key) DO NOTHING
         RETURNING id, dedup_key`,
        params,
      );
      // Re-pair each inserted id with its Entry via dedup_key.
      const entryByKey = new Map(slice.map((s) => [s.key, s.entry]));
      for (const row of r.rows) {
        const entry = entryByKey.get(row.dedup_key);
        if (entry) out.push({ id: row.id, entry });
      }
    }
    return out;
  }

  /**
   * Record that these entries are fully embedded into `collection`.
   *
   * Called only after the upsert of their final chunk resolves — see
   * indexEntries. Marking earlier would recreate the failure this column
   * exists to prevent.
   */
  /**
   * Recompute which projects are older locations of which, from slugs alone.
   *
   * Idempotent and cheap (tens of rows), so it runs on every scheduler tick:
   * a project discovered later must be able to adopt a ghost that was created
   * before it existed.
   */
  async refreshProjectAliases(): Promise<number> {
    const r = await this.pool.query('SELECT id, slug, root_path FROM projects');
    const rows = r.rows.map((x) => ({ id: x.id, slug: x.slug, rootPath: x.root_path }));
    const byId = new Map(rows.map((p) => [p.slug, p.id]));

    let linked = 0;
    for (const p of rows) {
      // Only ghosts can be aliases; a discovered project is authoritative.
      const target = p.rootPath ? null : resolveProjectAlias(p.slug, rows);
      const targetId = target ? (byId.get(target) ?? null) : null;
      await this.pool.query('UPDATE projects SET alias_of = $2 WHERE id = $1 AND alias_of IS DISTINCT FROM $2', [
        p.id,
        targetId,
      ]);
      if (targetId) linked++;
    }
    return linked;
  }

  /**
   * Widen a set of project slugs to include the older locations of each.
   *
   * Without this, scoping to "deepcast" silently excluded 27,300 entries filed
   * under the slugs of paths the repo used to live at — the failure that made
   * scoped search untrustworthy and led the MCP instructions to tell agents to
   * ignore real history.
   */
  async expandProjectScope(slugs: string[]): Promise<string[]> {
    if (!slugs.length) return slugs;
    const r = await this.pool.query(
      `SELECT a.slug FROM projects a JOIN projects c ON a.alias_of = c.id WHERE c.slug = ANY($1)`,
      [slugs],
    );
    return [...new Set([...slugs, ...r.rows.map((x) => x.slug)])];
  }

  /**
   * What the index holds for each named project: entry count and the span of
   * `occurred_at`. Empty list means every project.
   *
   * This is the measurement that replaces the model guessing at coverage from
   * its retrieved sample. Cheap: one grouped aggregate over an indexed column.
   */
  async coverage(projects: string[] = []): Promise<ProjectCoverage[]> {
    const scoped = projects.length > 0;
    const r = await this.pool.query(
      `SELECT p.slug, count(*)::int AS n, min(e.occurred_at) AS oldest, max(e.occurred_at) AS newest
         FROM entries e JOIN projects p ON p.id = e.project_id
        ${scoped ? 'WHERE p.slug = ANY($1)' : ''}
        GROUP BY p.slug ORDER BY n DESC`,
      scoped ? [projects] : [],
    );
    return r.rows.map((row) => ({
      projectSlug: row.slug,
      entries: row.n,
      oldest: row.oldest?.toISOString(),
      newest: row.newest?.toISOString(),
    }));
  }

  /** How many entries are timestamped inside a window, for the named projects. */
  async countInWindow(projects: string[], since: string, until: string): Promise<number> {
    const scoped = projects.length > 0;
    const r = await this.pool.query(
      `SELECT count(*)::int AS n
         FROM entries e JOIN projects p ON p.id = e.project_id
        WHERE e.occurred_at >= $1 AND e.occurred_at <= $2
        ${scoped ? 'AND p.slug = ANY($3)' : ''}`,
      scoped ? [since, until, projects] : [since, until],
    );
    return r.rows[0].n;
  }

  async markVectorized(ids: number[], collection: string): Promise<void> {
    if (!ids.length) return;
    await this.pool.query('UPDATE entries SET vectorized_in = $2 WHERE id = ANY($1)', [
      ids,
      collection,
    ]);
  }

  /**
   * Drop the coverage mark for entries whose vectors are gone.
   *
   * The catalog column cannot observe loss on the Qdrant side (a dropped
   * collection, an orphan-reclaim bug, a restore from an older snapshot), so
   * the deep audit clears the mark and lets the ordinary reconciler re-embed.
   */
  async clearVectorized(ids: number[]): Promise<void> {
    if (!ids.length) return;
    await this.pool.query('UPDATE entries SET vectorized_in = NULL WHERE id = ANY($1)', [ids]);
  }

  /** Entries not searchable in `collection` — the reconciler's backlog size. */
  async countUncovered(collection: string): Promise<number> {
    const r = await this.pool.query(
      'SELECT count(*)::int AS n FROM entries WHERE vectorized_in IS DISTINCT FROM $1',
      [collection],
    );
    return r.rows[0].n;
  }

  /**
   * One page of entries that are not searchable in `collection`, by ascending
   * id so the caller can page with a keyset cursor.
   *
   * `IS DISTINCT FROM` rather than `<>` is load-bearing: `<>` is NULL for a
   * NULL left-hand side, so the never-embedded rows — the whole point of this
   * query — would silently not match.
   */
  async uncoveredEntriesAfter(
    collection: string,
    cursor: number,
    limit: number,
  ): Promise<(Entry & { id: number })[]> {
    const r = await this.pool.query(
      `SELECT ${ENTRY_COLUMNS}
       FROM entries e JOIN projects p ON p.id = e.project_id
       WHERE e.vectorized_in IS DISTINCT FROM $1 AND e.id > $2
       ORDER BY e.id ASC LIMIT $3`,
      [collection, cursor, limit],
    );
    return r.rows.map(rowToEntry);
  }

  /**
   * Bring stored doc entries of one file in line with its current archive
   * classification. Needed because insertEntries is ON CONFLICT DO NOTHING:
   * a re-parse never touches rows that already exist. Returns the ids that
   * actually changed so the caller can patch their vector payloads.
   */
  async syncDocStatus(
    projectId: number,
    sourcePath: string,
    archived: boolean,
  ): Promise<number[]> {
    const r = archived
      ? await this.pool.query(
          `UPDATE entries SET meta = meta || '{"docStatus":"archived"}'::jsonb
           WHERE project_id=$1 AND source_path=$2 AND source_type='doc'
             AND meta->>'docStatus' IS DISTINCT FROM 'archived'
           RETURNING id`,
          [projectId, sourcePath],
        )
      : await this.pool.query(
          `UPDATE entries SET meta = meta - 'docStatus'
           WHERE project_id=$1 AND source_path=$2 AND source_type='doc'
             AND meta ? 'docStatus'
           RETURNING id`,
          [projectId, sourcePath],
        );
    return r.rows.map((row) => row.id);
  }

  async upsertSession(projectId: number, meta: SessionMeta, sourcePath: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, project_id, title, cwd, started_at, ended_at, prompt_count, action_count, files_touched, source_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET title=COALESCE(EXCLUDED.title, sessions.title),
         ended_at=EXCLUDED.ended_at, prompt_count=EXCLUDED.prompt_count,
         action_count=EXCLUDED.action_count, files_touched=EXCLUDED.files_touched`,
      [
        meta.sessionId,
        projectId,
        meta.title ?? null,
        meta.cwd ?? null,
        meta.startedAt ?? null,
        meta.endedAt ?? null,
        meta.promptCount,
        meta.actionCount ?? 0,
        JSON.stringify(meta.filesTouched),
        sourcePath,
      ],
    );
  }

  /**
   * A project's activity feed — or several projects', merged chronologically.
   *
   * Accepts one slug or many. The signature is *widened*, never changed: the CLI
   * and the MCP server both call the single-slug form through
   * `/api/projects/:slug/timeline`, and neither has a test that would have caught
   * a break (the MCP suite only asserts the tool is listed).
   */
  async timeline(
    slug: string | string[],
    opts: { limit?: number; before?: string; sources?: SourceType[] } = {},
  ): Promise<TimelineItem[]> {
    const slugs = Array.isArray(slug) ? slug : [slug];
    const limit = Math.min(opts.limit ?? 50, 200);
    const params: unknown[] = [slugs, limit];
    // ANY() covers both cases, so one query serves a single project and a merge.
    let where = `p.slug = ANY($1) AND e.occurred_at IS NOT NULL`;
    if (opts.before) {
      params.push(opts.before);
      where += ` AND e.occurred_at < $${params.length}`;
    }
    if (opts.sources?.length) {
      params.push(opts.sources);
      where += ` AND e.source_type = ANY($${params.length})`;
    }
    const r = await this.pool.query(
      // p.slug rides along so a merged feed can say which project each row came
      // from — without it, a multi-project timeline is unreadable.
      `SELECT e.id, e.source_type, e.component, e.session_id, e.title, e.occurred_at, e.source_path,
              p.slug AS project_slug
       FROM entries e JOIN projects p ON p.id = e.project_id
       WHERE ${where}
       ORDER BY e.occurred_at DESC, e.id DESC LIMIT $2`,
      params,
    );
    return r.rows.map((row) => ({
      entryId: row.id,
      sourceType: row.source_type,
      component: row.component ?? undefined,
      sessionId: row.session_id ?? undefined,
      title: row.title,
      occurredAt: row.occurred_at.toISOString(),
      sourcePath: row.source_path,
      projectSlug: row.project_slug,
    }));
  }

  async components(slug: string): Promise<{ component: string; count: number; lastAt?: string }[]> {
    const r = await this.pool.query(
      `SELECT e.component, count(*)::int AS count, max(e.occurred_at) AS last_at
       FROM entries e JOIN projects p ON p.id = e.project_id
       WHERE p.slug = $1 AND e.component IS NOT NULL
       GROUP BY e.component ORDER BY last_at DESC NULLS LAST`,
      [slug],
    );
    return r.rows.map((row) => ({
      component: row.component,
      count: row.count,
      lastAt: row.last_at?.toISOString(),
    }));
  }

  async componentHistory(slug: string, component: string, limit = 100) {
    const r = await this.pool.query(
      `SELECT e.id, e.source_type, e.title, e.body, e.occurred_at, e.source_path, e.source_ref, e.meta
       FROM entries e JOIN projects p ON p.id = e.project_id
       WHERE p.slug = $1 AND e.component = $2
       ORDER BY e.occurred_at DESC NULLS LAST, e.id DESC LIMIT $3`,
      [slug, component, limit],
    );
    return r.rows;
  }

  async sessionsList(slug: string, limit = 50) {
    const r = await this.pool.query(
      `SELECT s.id, s.title, s.cwd, s.started_at, s.ended_at, s.prompt_count,
              s.action_count, s.files_touched
       FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE p.slug = $1 ORDER BY s.started_at DESC NULLS LAST LIMIT $2`,
      [slug, limit],
    );
    return r.rows;
  }

  async getSessionRow(sessionId: string) {
    const r = await this.pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    return r.rows[0] ?? null;
  }

  /**
   * `limit`/`offset` exist for context-budgeted consumers (the MCP server): a
   * long session serialises to tens of thousands of tokens, which no agent can
   * afford in one tool result. `totalEntries` is always the real count, so a
   * caller can tell "that was everything" from "there are more pages".
   */
  async sessionDetail(sessionId: string, opts: { limit?: number; offset?: number } = {}) {
    const s = await this.pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (!s.rows[0]) return null;
    const limit = Math.min(Math.max(1, opts.limit ?? 1000), 1000);
    const offset = Math.max(0, opts.offset ?? 0);
    const [e, total] = await Promise.all([
      this.pool.query(
        `SELECT id, title, body, occurred_at, meta FROM entries
         WHERE session_id = $1 ORDER BY occurred_at ASC NULLS LAST, id ASC LIMIT $2 OFFSET $3`,
        [sessionId, limit, offset],
      ),
      this.pool.query('SELECT count(*)::int AS n FROM entries WHERE session_id = $1', [sessionId]),
    ]);
    return { session: s.rows[0], entries: e.rows, totalEntries: total.rows[0].n };
  }

  /**
   * Page through every entry by ascending id, for rebuilding a vector
   * collection from the catalog. Keyset pagination (id > cursor) keeps this
   * O(1) per page regardless of how deep we are.
   */
  async entriesAfter(cursor: number, limit: number): Promise<(Entry & { id: number })[]> {
    const r = await this.pool.query(
      `SELECT ${ENTRY_COLUMNS}
       FROM entries e JOIN projects p ON p.id = e.project_id
       WHERE e.id > $1 ORDER BY e.id ASC LIMIT $2`,
      [cursor, limit],
    );
    return r.rows.map(rowToEntry);
  }

  /**
   * Like `entriesAfter`, but only entries whose vectors are believed present in
   * `collection`.
   *
   * For rewriting existing vectors in place. Qdrant's update-vectors endpoint
   * rejects the *entire batch* if any point id is unknown, so a pass that walked
   * every entry would let one never-embedded row destroy the whole page it landed
   * in. `vectorized_in` is the record of what was actually written, which is
   * exactly the set that can be updated.
   */
  async vectorizedEntriesAfter(
    collection: string,
    cursor: number,
    limit: number,
  ): Promise<(Entry & { id: number })[]> {
    const r = await this.pool.query(
      `SELECT ${ENTRY_COLUMNS}
       FROM entries e JOIN projects p ON p.id = e.project_id
       WHERE e.vectorized_in = $1 AND e.id > $2 ORDER BY e.id ASC LIMIT $3`,
      [collection, cursor, limit],
    );
    return r.rows.map(rowToEntry);
  }

  /**
   * Page through every entry with its body and its coverage mark, for the deep
   * audit.
   *
   * The audit has to derive the point ids each entry *should* have, and that
   * needs the text — chunking is what decides how many points there are. That is
   * 158 MB of title+body across ~327k rows on the current corpus, streamed once,
   * which is affordable precisely because the audit is gated behind "the cheap
   * count says something is missing" rather than run every boot.
   *
   * This replaced an `entryCoverage()` that returned every id and mark in a
   * single query with no text. That view could only ever answer "does this entry
   * have *any* points" — the question that let entry 7707 read as covered while
   * a chunk was missing — so it is gone rather than kept alongside.
   */
  async entriesWithCoverageAfter(
    cursor: number,
    limit: number,
  ): Promise<(Entry & { id: number; vectorizedIn: string | null })[]> {
    const r = await this.pool.query(
      `SELECT ${ENTRY_COLUMNS}, e.vectorized_in
       FROM entries e JOIN projects p ON p.id = e.project_id
       WHERE e.id > $1 ORDER BY e.id ASC LIMIT $2`,
      [cursor, limit],
    );
    return r.rows.map((row) => ({ ...rowToEntry(row), vectorizedIn: row.vectorized_in }));
  }

  /** How many entries `vectorizedEntriesAfter` will walk — the rebuild's total. */
  async countVectorized(collection: string): Promise<number> {
    const r = await this.pool.query(
      'SELECT count(*)::int AS n FROM entries WHERE vectorized_in = $1',
      [collection],
    );
    return r.rows[0].n;
  }

  /** On-disk size of the catalog database. */
  async databaseSize(): Promise<number | null> {
    try {
      const r = await this.pool.query('SELECT pg_database_size(current_database()) AS b');
      return Number(r.rows[0].b);
    } catch {
      return null;
    }
  }

  /** Cheap liveness probe used by the dashboard. */
  async reachable(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async countSessions(): Promise<number> {
    const r = await this.pool.query('SELECT count(*)::int AS c FROM sessions');
    return r.rows[0].c;
  }

  async countEntries(): Promise<number> {
    const r = await this.pool.query('SELECT count(*)::int AS c FROM entries');
    return r.rows[0].c;
  }

  /** Entries at or below an id — how much of a resumed backfill is already done. */
  async countEntriesUpTo(id: number): Promise<number> {
    const r = await this.pool.query('SELECT count(*)::int AS c FROM entries WHERE id <= $1', [id]);
    return r.rows[0].c;
  }

  async getEntries(ids: number[]): Promise<Map<number, any>> {
    if (!ids.length) return new Map();
    const r = await this.pool.query(
      `SELECT e.id, e.source_type, e.component, e.session_id, e.title, e.body,
              e.occurred_at, e.source_path, e.source_ref, e.meta, p.slug
       FROM entries e JOIN projects p ON p.id = e.project_id WHERE e.id = ANY($1)`,
      [ids],
    );
    return new Map(r.rows.map((row) => [row.id, row]));
  }

  /** Degraded-mode keyword search when Qdrant is unavailable. */
  async ftsSearch(q: string, filters: SearchFilters, limit = 20): Promise<SearchHit[]> {
    const params: unknown[] = [ftsQuery(q)];
    let where = `e.fts @@ to_tsquery('english', $1)`;
    // Mirrors the vector path exactly (see buildQdrantFilter): one project is an
    // equality, several are an ANY. The two paths degrade into one another, so a
    // filter that meant different things on each would be a vicious bug.
    const projects = selectedProjects(filters);
    if (projects.length === 1) {
      params.push(projects[0]);
      where += ` AND p.slug = $${params.length}`;
    } else if (projects.length > 1) {
      params.push(projects);
      where += ` AND p.slug = ANY($${params.length})`;
    }
    // A subset (sourceTypes) wins over the single sourceType, which stays for
    // back-compat. One value → equality; several → ANY(array).
    const types = filters.sourceTypes?.length
      ? filters.sourceTypes
      : filters.sourceType
        ? [filters.sourceType]
        : [];
    if (types.length === 1) {
      params.push(types[0]);
      where += ` AND e.source_type = $${params.length}`;
    } else if (types.length > 1) {
      params.push(types);
      where += ` AND e.source_type = ANY($${params.length})`;
    }
    if (filters.component) {
      params.push(filters.component);
      where += ` AND e.component = $${params.length}`;
    }
    if (filters.kind) {
      // meta is JSONB; at this scale a plain key lookup needs no extra index.
      params.push(filters.kind);
      where += ` AND e.meta->>'kind' = $${params.length}`;
    }
    if (filters.docStatus === 'archived') {
      where += ` AND e.meta->>'docStatus' = 'archived'`;
    } else if (filters.docStatus === 'active') {
      where += ` AND e.meta->>'docStatus' IS DISTINCT FROM 'archived'`;
    }
    params.push(limit);
    const r = await this.pool.query(
      `SELECT e.id, e.source_type, e.component, e.session_id, e.title, e.body,
              e.occurred_at, e.source_path, e.source_ref, e.meta, p.slug,
              ts_rank(e.fts, to_tsquery('english', $1)) AS rank
       FROM entries e JOIN projects p ON p.id = e.project_id
       WHERE ${where} ORDER BY rank DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows.map((row) => ({
      entryId: row.id,
      score: Number(row.rank),
      projectSlug: row.slug,
      sourceType: row.source_type,
      component: row.component ?? undefined,
      sessionId: row.session_id ?? undefined,
      title: row.title,
      snippet: String(row.body).slice(0, 280),
      occurredAt: row.occurred_at?.toISOString(),
      sourcePath: row.source_path,
      sourceRef: row.source_ref ?? undefined,
      // Same decoration contract as the vector path (SearchService.finalize).
      ...(row.meta?.docStatus === 'archived' ? { docStatus: 'archived' as const } : {}),
    }));
  }

  async stats(): Promise<IndexStats> {
    const [proj, ent, err, recentErr, run, bySource, unsearchable] = await Promise.all([
      this.pool.query('SELECT count(*)::int AS c FROM projects'),
      this.pool.query('SELECT count(*)::int AS c FROM entries'),
      this.pool.query('SELECT count(*)::int AS c FROM index_errors'),
      // "Is it failing now?" — a lifetime counter never resets and gets ignored.
      this.pool.query(
        "SELECT count(*)::int AS c FROM index_errors WHERE created_at > now() - interval '1 hour'",
      ),
      this.pool.query('SELECT max(finished_at) AS t FROM index_runs'),
      this.pool.query('SELECT source_type, count(*)::int AS c FROM entries GROUP BY source_type'),
      // Guarded on the setting existing: with no active collection published
      // yet, every row would compare unequal and this would report the whole
      // catalog as unsearchable on a fresh install.
      this.pool.query(
        `SELECT count(*)::int AS c
           FROM entries e, (SELECT value FROM settings WHERE key = 'active_collection') s
          WHERE e.vectorized_in IS DISTINCT FROM s.value`,
      ),
    ]);
    return {
      projects: proj.rows[0].c,
      entries: ent.rows[0].c,
      chunks: 0, // filled in by the API layer from Qdrant
      errors: err.rows[0].c,
      recentErrors: recentErr.rows[0].c,
      // The cross join yields no row when active_collection is unset.
      unsearchableEntries: unsearchable.rows[0]?.c ?? 0,
      lastRunAt: run.rows[0].t?.toISOString(),
      bySource: Object.fromEntries(bySource.rows.map((r2) => [r2.source_type, r2.c])),
    };
  }

  /**
   * Per-source inventory for the dashboard: how many entries and distinct
   * files, how much raw content, and when something was last indexed.
   * length(body) is characters, not bytes — close enough for a size bar and
   * far cheaper than octet_length over 100k rows.
   */
  async sourceDetail(): Promise<
    {
      sourceType: string;
      entries: number;
      files: number;
      volumeChars: number;
      lastIndexedAt?: string;
    }[]
  > {
    const r = await this.pool.query(
      `SELECT source_type, count(*)::int AS entries,
              count(DISTINCT source_path)::int AS files,
              coalesce(sum(length(body)),0)::bigint AS volume,
              max(created_at) AS last_at
       FROM entries GROUP BY source_type ORDER BY entries DESC`,
    );
    return r.rows.map((row) => ({
      sourceType: row.source_type,
      entries: row.entries,
      files: row.files,
      volumeChars: Number(row.volume),
      lastIndexedAt: row.last_at?.toISOString(),
    }));
  }

  /**
   * Entries indexed per day per source. created_at is INDEXING time — exactly
   * what "is the indexer doing anything?" asks, unlike occurred_at which is
   * when the recorded event happened.
   */
  async indexingActivity(
    days = 30,
  ): Promise<{ day: string; sourceType: string; count: number }[]> {
    const r = await this.pool.query(
      `SELECT date_trunc('day', created_at)::date AS day, source_type, count(*)::int AS c
       FROM entries WHERE created_at > now() - ($1 || ' days')::interval
       GROUP BY 1, 2 ORDER BY 1`,
      [days],
    );
    return r.rows.map((row) => ({
      day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day),
      sourceType: row.source_type,
      count: row.c,
    }));
  }

  async recentRuns(limit = 10): Promise<
    { id: number; kind: string; startedAt?: string; finishedAt?: string; stats: unknown }[]
  > {
    const r = await this.pool.query(
      'SELECT id, kind, started_at, finished_at, stats FROM index_runs ORDER BY id DESC LIMIT $1',
      [limit],
    );
    return r.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      startedAt: row.started_at?.toISOString(),
      finishedAt: row.finished_at?.toISOString(),
      stats: row.stats,
    }));
  }

  async archivedDocsCount(): Promise<number> {
    const r = await this.pool.query(
      `SELECT count(*)::int AS c FROM entries
       WHERE source_type = 'doc' AND meta->>'docStatus' = 'archived'`,
    );
    return r.rows[0].c;
  }

  /**
   * Drop everything derived from the source files: entries, their scan state,
   * and session rows. Safe because all of it is regenerated by re-parsing the
   * read-only mounts — the index is a cache, never the source of truth.
   * Used when the id scheme changes and old dedup keys can no longer match.
   */
  async resetDerivedData(): Promise<void> {
    // `projects` too: how sources are attributed to a project can change, and
    // a stale project row would linger with no entries (or the wrong ones).
    await this.pool.query(
      'TRUNCATE projects, entries, scan_state, sessions RESTART IDENTITY CASCADE',
    );
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`,
      [key, value],
    );
  }

  async getSetting(key: string): Promise<string | null> {
    const r = await this.pool.query('SELECT value FROM settings WHERE key=$1', [key]);
    return r.rows[0]?.value ?? null;
  }

  async logError(projectId: number | null, path: string, stage: string, message: string) {
    await this.pool.query(
      'INSERT INTO index_errors (project_id, path, stage, message) VALUES ($1,$2,$3,$4)',
      [projectId, path, stage, message.slice(0, 2000)],
    );
  }

  async recentErrors(limit = 50) {
    const r = await this.pool.query(
      'SELECT * FROM index_errors ORDER BY id DESC LIMIT $1',
      [limit],
    );
    return r.rows;
  }

  async startRun(kind: string): Promise<number> {
    const r = await this.pool.query(
      'INSERT INTO index_runs (kind) VALUES ($1) RETURNING id',
      [kind],
    );
    return r.rows[0].id;
  }

  async finishRun(id: number, stats: Record<string, unknown>) {
    await this.pool.query(
      'UPDATE index_runs SET finished_at = now(), stats = $2 WHERE id = $1',
      [id, JSON.stringify(stats)],
    );
  }
}
