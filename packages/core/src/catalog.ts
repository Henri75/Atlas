import pg from 'pg';
import type {
  Entry,
  IndexStats,
  Project,
  SearchFilters,
  SearchHit,
  SessionMeta,
  SourceType,
  TimelineItem,
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

CREATE TABLE IF NOT EXISTS index_runs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  stats JSONB NOT NULL DEFAULT '{}'
);
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
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA);
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

  /** Idempotent bulk insert; returns ids of NEW entries only (existing ones are skipped). */
  async insertEntries(projectId: number, entries: Entry[]): Promise<InsertedEntry[]> {
    const out: InsertedEntry[] = [];
    for (const e of entries) {
      const r = await this.pool.query(
        `INSERT INTO entries (project_id, source_type, component, session_id, title, body,
                              occurred_at, source_path, source_ref, meta, dedup_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (dedup_key) DO NOTHING
         RETURNING id`,
        [
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
          Catalog.dedupKey(e),
        ],
      );
      if (r.rows[0]) out.push({ id: r.rows[0].id, entry: e });
    }
    return out;
  }

  async upsertSession(projectId: number, meta: SessionMeta, sourcePath: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, project_id, title, cwd, started_at, ended_at, prompt_count, files_touched, source_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET title=COALESCE(EXCLUDED.title, sessions.title),
         ended_at=EXCLUDED.ended_at, prompt_count=EXCLUDED.prompt_count,
         files_touched=EXCLUDED.files_touched`,
      [
        meta.sessionId,
        projectId,
        meta.title ?? null,
        meta.cwd ?? null,
        meta.startedAt ?? null,
        meta.endedAt ?? null,
        meta.promptCount,
        JSON.stringify(meta.filesTouched),
        sourcePath,
      ],
    );
  }

  async timeline(
    slug: string,
    opts: { limit?: number; before?: string; sources?: SourceType[] } = {},
  ): Promise<TimelineItem[]> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const params: unknown[] = [slug, limit];
    let where = `p.slug = $1 AND e.occurred_at IS NOT NULL`;
    if (opts.before) {
      params.push(opts.before);
      where += ` AND e.occurred_at < $${params.length}`;
    }
    if (opts.sources?.length) {
      params.push(opts.sources);
      where += ` AND e.source_type = ANY($${params.length})`;
    }
    const r = await this.pool.query(
      `SELECT e.id, e.source_type, e.component, e.session_id, e.title, e.occurred_at, e.source_path
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
      `SELECT s.id, s.title, s.cwd, s.started_at, s.ended_at, s.prompt_count, s.files_touched
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

  async sessionDetail(sessionId: string) {
    const s = await this.pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (!s.rows[0]) return null;
    const e = await this.pool.query(
      `SELECT id, title, body, occurred_at, meta FROM entries
       WHERE session_id = $1 ORDER BY occurred_at ASC NULLS LAST, id ASC LIMIT 1000`,
      [sessionId],
    );
    return { session: s.rows[0], entries: e.rows };
  }

  async getEntries(ids: number[]): Promise<Map<number, any>> {
    if (!ids.length) return new Map();
    const r = await this.pool.query(
      `SELECT e.id, e.source_type, e.component, e.session_id, e.title, e.body,
              e.occurred_at, e.source_path, e.source_ref, p.slug
       FROM entries e JOIN projects p ON p.id = e.project_id WHERE e.id = ANY($1)`,
      [ids],
    );
    return new Map(r.rows.map((row) => [row.id, row]));
  }

  /** Degraded-mode keyword search when Qdrant is unavailable. */
  async ftsSearch(q: string, filters: SearchFilters, limit = 20): Promise<SearchHit[]> {
    const params: unknown[] = [q];
    let where = `e.fts @@ websearch_to_tsquery('english', $1)`;
    if (filters.project) {
      params.push(filters.project);
      where += ` AND p.slug = $${params.length}`;
    }
    if (filters.sourceType) {
      params.push(filters.sourceType);
      where += ` AND e.source_type = $${params.length}`;
    }
    if (filters.component) {
      params.push(filters.component);
      where += ` AND e.component = $${params.length}`;
    }
    params.push(limit);
    const r = await this.pool.query(
      `SELECT e.id, e.source_type, e.component, e.session_id, e.title, e.body,
              e.occurred_at, e.source_path, e.source_ref, p.slug,
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
    }));
  }

  async stats(): Promise<IndexStats> {
    const [proj, ent, err, run, bySource] = await Promise.all([
      this.pool.query('SELECT count(*)::int AS c FROM projects'),
      this.pool.query('SELECT count(*)::int AS c FROM entries'),
      this.pool.query('SELECT count(*)::int AS c FROM index_errors'),
      this.pool.query('SELECT max(finished_at) AS t FROM index_runs'),
      this.pool.query('SELECT source_type, count(*)::int AS c FROM entries GROUP BY source_type'),
    ]);
    return {
      projects: proj.rows[0].c,
      entries: ent.rows[0].c,
      chunks: 0, // filled in by the API layer from Qdrant
      errors: err.rows[0].c,
      lastRunAt: run.rows[0].t?.toISOString(),
      bySource: Object.fromEntries(bySource.rows.map((r2) => [r2.source_type, r2.c])),
    };
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
