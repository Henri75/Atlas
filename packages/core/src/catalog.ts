import pg from 'pg';
import {
  selectedProjects,
  type Entry,
  type IndexStats,
  type Project,
  type SearchFilters,
  type SearchHit,
  type SessionMeta,
  type SourceType,
  type TimelineItem,
} from './types.js';
import { contentHash, deterministicUuid } from './ids.js';

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

-- Agent-facing usage telemetry: one row per MCP/CLI API call (requests that
-- carry an x-atlas-client header). UI traffic is deliberately not recorded —
-- its 30s status polling would drown the signal this table exists to carry.
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

-- CREATE TABLE IF NOT EXISTS never adds a column to a table that already
-- exists, so new columns need an explicit, idempotent ALTER.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS action_count INT NOT NULL DEFAULT 0;
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
   * Record one agent-facing API call. Callers fire-and-forget this — usage
   * telemetry must never be able to slow down or fail the request it measures.
   */
  async logUsage(row: {
    client: string;
    tool?: string;
    method: string;
    path: string;
    query?: string;
    status: number;
    durationMs: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage_log (client, tool, method, path, query, status, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        row.client.slice(0, 40),
        row.tool?.slice(0, 80) ?? null,
        row.method,
        row.path.slice(0, 300),
        row.query?.slice(0, 500) ?? null,
        row.status,
        Math.round(row.durationMs),
      ],
    );
  }

  /**
   * Aggregate the usage log for monitoring: who calls what, how often, how
   * slow, and how often it errors. `tool` falls back to the path so CLI calls
   * (which carry no tool header) still group meaningfully.
   */
  async usageStats(days = 7) {
    const interval = `${Math.min(Math.max(1, days), 365)} days`;
    const [byTool, byDay, totals] = await Promise.all([
      this.pool.query(
        `SELECT client, coalesce(tool, path) AS tool, count(*)::int AS calls,
                avg(duration_ms)::int AS avg_ms, max(duration_ms)::int AS max_ms,
                count(*) FILTER (WHERE status >= 400)::int AS errors,
                max(at) AS last_at
         FROM usage_log WHERE at > now() - $1::interval
         GROUP BY client, coalesce(tool, path)
         ORDER BY calls DESC`,
        [interval],
      ),
      this.pool.query(
        `SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, client, count(*)::int AS calls
         FROM usage_log WHERE at > now() - $1::interval
         GROUP BY day, client ORDER BY day DESC`,
        [interval],
      ),
      this.pool.query(
        `SELECT count(*)::int AS calls,
                count(*) FILTER (WHERE status >= 400)::int AS errors,
                count(DISTINCT client)::int AS clients
         FROM usage_log WHERE at > now() - $1::interval`,
        [interval],
      ),
    ]);
    return { days, ...totals.rows[0], byTool: byTool.rows, byDay: byDay.rows };
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
              count(e.id)::int AS entry_count
       FROM projects p LEFT JOIN entries e ON e.project_id = p.id
       GROUP BY p.id ORDER BY entry_count DESC, p.slug`,
    );
    return r.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      rootPath: row.root_path,
      hasKdb: row.has_kdb,
      discoveredAt: row.discovered_at?.toISOString?.() ?? String(row.discovered_at),
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
      `SELECT e.id, e.source_type, e.component, e.session_id, e.title, e.body,
              e.occurred_at, e.source_path, e.source_ref, e.meta, p.slug
       FROM entries e JOIN projects p ON p.id = e.project_id
       WHERE e.id > $1 ORDER BY e.id ASC LIMIT $2`,
      [cursor, limit],
    );
    return r.rows.map((row) => ({
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
    }));
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
    const params: unknown[] = [q];
    let where = `e.fts @@ websearch_to_tsquery('english', $1)`;
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
              ts_rank(e.fts, websearch_to_tsquery('english', $1)) AS rank
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
    const [proj, ent, err, recentErr, run, bySource] = await Promise.all([
      this.pool.query('SELECT count(*)::int AS c FROM projects'),
      this.pool.query('SELECT count(*)::int AS c FROM entries'),
      this.pool.query('SELECT count(*)::int AS c FROM index_errors'),
      // "Is it failing now?" — a lifetime counter never resets and gets ignored.
      this.pool.query(
        "SELECT count(*)::int AS c FROM index_errors WHERE created_at > now() - interval '1 hour'",
      ),
      this.pool.query('SELECT max(finished_at) AS t FROM index_runs'),
      this.pool.query('SELECT source_type, count(*)::int AS c FROM entries GROUP BY source_type'),
    ]);
    return {
      projects: proj.rows[0].c,
      entries: ent.rows[0].c,
      chunks: 0, // filled in by the API layer from Qdrant
      errors: err.rows[0].c,
      recentErrors: recentErr.rows[0].c,
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
