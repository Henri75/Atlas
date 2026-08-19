import type pg from 'pg';
import { Catalog } from './catalog.js';
import { DEDUP_SCHEME, identityFromStored } from './identity.js';
import { contentHash } from './ids.js';
import type { Entry } from './types.js';

/**
 * The in-place dedup key v3 migration (spec §6, "Migration — in place").
 *
 * Every existing row's `dedup_key` is recomputed from the stored columns
 * through the same `identityFromStored` + `Catalog.dedupKey` pair the live
 * pipeline uses, so the catalog stops keying on absolute container paths and
 * starts keying on machine-independent identity. Nothing is re-parsed, nothing
 * is re-embedded and no vector moves: Qdrant point ids hash the **stored**
 * `source_path` under the frozen v2 namespace (`ids.ts`) and the payload never
 * carried the dedup key, so rewriting keys in Postgres leaves the collection
 * untouched.
 *
 * Three properties this file exists to guarantee:
 *  - **Own marker.** `settings.dedup_scheme`, NEVER `settings.id_scheme` —
 *    that one is compared against `ID_SCHEME` at every indexer boot and a
 *    mismatch TRUNCATEs the catalog and drops the collection (`main.ts`).
 *  - **Own lock.** `pg_advisory_lock(732016)` for the whole run, never
 *    `732015`: the API takes that at boot for schema DDL, and holding it for a
 *    multi-minute migration would wedge every API restart.
 *  - **Resumable.** A cursor (last fully processed `(project_id, source_path)`
 *    pair) means a crash costs at most one batch, and every step is written so
 *    that redoing it converges on the same state.
 */

/** Settings key holding the migration marker. */
export const DEDUP_SCHEME_KEY = 'dedup_scheme';
/** Settings key holding the resume cursor (JSON `[project_id, source_path]`). */
export const DEDUP_CURSOR_KEY = 'dedup_cursor';
/**
 * The migration's own advisory lock. NOT 732015 (`Catalog.migrate`, and the
 * API at boot) — see the file header.
 */
export const DEDUP_MIGRATION_LOCK = 732016;

/**
 * Transient index for the sweep. Without it the per-file SELECT is a bitmap
 * heap scan of the whole project: measured on the live catalog (474k entries,
 * 16.5k files) one such lookup took 832ms, which is hours across the catalog
 * while the indexer is blocked from scanning. Created under the lock, dropped
 * once the marker is stamped; a crash leaves it in place, which only makes the
 * resumed pass faster.
 */
const MIGRATION_INDEX = 'entries_dedup_migration_path';

/** Files per cursor advance. Whole files, so an ordinal group never splits. */
const DEFAULT_BATCH = 2000;
/** Rows per batched UPDATE statement (2 params each, well under PG's 65535). */
const UPDATE_CHUNK = 500;
/** How often the sweep reports progress, in files. */
const LOG_EVERY_FILES = 500;

const LINE_REF = /^line:(\d+)$/;
/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** One `entries` row, exactly as the migration SELECTs it. */
export interface MigrationEntryRow {
  id: number;
  project_id: number;
  source_type: string;
  source_path: string;
  source_ref: string | null;
  title: string;
  body: string;
}

/** What a project contributes to identity: its slug, and its root on THIS machine. */
export interface MigrationProject {
  slug: string;
  rootPath: string;
}

export interface PlannedRekey {
  id: number;
  scope: string;
  path: string;
  ref: string;
  newKey: string;
  /**
   * Set when a LOWER id in the same batch already claims `newKey`: the two
   * rows are byte-identical by construction (the key hashes title + content),
   * so this row is a duplicate and the lower id survives (spec §6.4).
   */
  duplicateOf?: number;
}

/**
 * Report counters, not state. They describe THIS run: a pass resumed from a
 * cursor never sees the files behind it, and re-counts the one page it redoes,
 * so the numbers from a resumed run are a floor rather than a catalog total.
 * Nothing branches on them.
 */
export interface DedupMigrationStats {
  scanned: number;
  rekeyed: number;
  collisions: number;
  /** Groups of more than one row sharing (path, title, content) — spec §6.3
   *  keeps them all, with distinct ordinals, and asks for them to be eyeballed. */
  ordinalGroups: number;
}

export interface DedupMigrationOptions {
  batchSize?: number;
  log?: (s: string) => void;
  /**
   * Every claude-projects root that stored paths may sit under: this machine's
   * mount plus each mirrored machine's. Passing a dir that does not exist is
   * harmless — `identityFromStored` falls back to the last two path segments,
   * which is the same `<dir>/<file>` shape a matched prefix produces.
   */
  claudeDirs?: string[];
}

function zeroStats(): DedupMigrationStats {
  return { scanned: 0, rekeyed: 0, collisions: 0, ordinalGroups: 0 };
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === UNIQUE_VIOLATION;
}

/**
 * Recompute the v3 key for every row of ONE file (one `(project_id,
 * source_path)` pair) — pure, so the whole ordinal rule is unit-testable
 * without a database.
 *
 * `line:<n>` refs are position-dependent and must not enter identity (a git
 * merge of two machines' append-only logs interleaves their tails and shifts
 * every line below). They are replaced by a content-occurrence ordinal: the
 * k-th row sharing `(scope, normalized path, title, contentHash(body))`,
 * ranked by parsed line number with the id as tiebreak (spec §6.3). Rows whose
 * ref is content-derived already (commit shas, doc anchors) keep it, and rows
 * whose path matches no known root keep their stored path — that case
 * recomputes to exactly the legacy key, so it is a no-op UPDATE rather than a
 * risk.
 *
 * Ranking is by (line, id) rather than by input order on purpose: the plan for
 * a set of rows must not depend on how they arrived, or a resumed pass could
 * assign different ordinals to the same rows and re-key content that was
 * already correct.
 */
export function planRekey(
  rows: MigrationEntryRow[],
  projectsById: Map<number, MigrationProject>,
  claudeDirs: string[],
): Map<number, PlannedRekey> {
  const prepared = rows.map((row) => {
    const project = projectsById.get(row.project_id);
    if (!project) {
      // Impossible through the FK, so it means the project snapshot is stale
      // or wrong. Guessing a scope here would write keys that the live
      // pipeline will never reproduce — fail loudly, the cursor makes it
      // resumable.
      throw new Error(`dedup migration: row ${row.id} names project ${row.project_id}, which was not loaded`);
    }
    const roots = project.rootPath ? [project.rootPath] : [];
    const identity = identityFromStored(row, project.slug, roots, claudeDirs);
    const line = LINE_REF.exec(row.source_ref ?? '');
    return { row, slug: project.slug, identity, line: line ? Number(line[1]) : null };
  });

  // Ordinals: group the line-ref rows by content identity, then rank.
  const groups = new Map<string, typeof prepared>();
  for (const p of prepared) {
    if (p.line === null) continue;
    const key = `${p.identity.scope}\x1f${p.identity.path}\x1f${p.row.title}\x1f${contentHash(p.row.body)}`;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.line! - b.line!) || (a.row.id - b.row.id));
    list.forEach((p, i) => {
      p.identity.ref = `occ:${i + 1}`;
    });
  }

  // Lowest id first, so the first claimant of a key is always the survivor.
  const plan = new Map<number, PlannedRekey>();
  const claimedBy = new Map<string, number>();
  for (const p of [...prepared].sort((a, b) => a.row.id - b.row.id)) {
    // Through `Catalog.dedupKey`, not a local hash: this must produce EXACTLY
    // the key `insertEntries` will compute for the same content later, and one
    // shared implementation is the only way that stays true. `identity` is
    // always set here, so `projectSlug` is carried for honesty, not for the key
    // (dedupKey reads it only on the no-identity fallback path).
    const newKey = Catalog.dedupKey({
      projectSlug: p.slug,
      sourceType: p.row.source_type as Entry['sourceType'],
      title: p.row.title,
      body: p.row.body,
      sourcePath: p.row.source_path,
      sourceRef: p.row.source_ref ?? undefined,
      identity: p.identity,
    });
    const owner = claimedBy.get(newKey);
    if (owner === undefined) claimedBy.set(newKey, p.row.id);
    plan.set(p.row.id, {
      id: p.row.id,
      scope: p.identity.scope,
      path: p.identity.path,
      ref: p.identity.ref,
      newKey,
      ...(owner === undefined ? {} : { duplicateOf: owner }),
    });
  }
  return plan;
}

/** `[0, '']` for an unset/garbled cursor — restarting is always safe. */
function cursorPair(raw: string | null): [number, string] {
  if (!raw) return [0, ''];
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'string') {
      return [v[0], v[1]];
    }
  } catch {
    // fall through
  }
  return [0, ''];
}

type Vectors = { deleteByEntryIds(entryIds: number[]): Promise<void> } | null;

/**
 * Retire one row: Qdrant points FIRST, the Postgres row SECOND (spec §6.4).
 *
 * The order is the whole point. A crash between the two leaves a Postgres row
 * whose points are gone — the resumed pass re-processes that row, collides
 * again, deletes the (already absent) points again and finishes the job. The
 * reverse order leaves points that nothing can ever reclaim, because
 * `auditVectorCoverage` walks entries and an entry that no longer exists is
 * never looked for.
 */
async function retire(client: pg.PoolClient, vectors: Vectors, id: number): Promise<void> {
  if (vectors) await vectors.deleteByEntryIds([id]);
  await client.query('DELETE FROM entries WHERE id = $1', [id]);
}

/**
 * One statement for up to `UPDATE_CHUNK` rows. `IS DISTINCT FROM` makes a row
 * that already carries its target key cost nothing — no write, no WAL, no
 * index churn — which is what turns a resumed pass into a cheap no-op, and
 * makes `rowCount` an honest count of rows actually moved.
 */
async function bulkRekey(client: pg.PoolClient, slice: PlannedRekey[]): Promise<number> {
  const params: unknown[] = [];
  const tuples = slice.map((r, i) => {
    params.push(r.id, r.newKey);
    return `($${i * 2 + 1}::bigint, $${i * 2 + 2}::text)`;
  });
  const res = await client.query(
    `UPDATE entries SET dedup_key = v.k
       FROM (VALUES ${tuples.join(',')}) AS v(id, k)
      WHERE entries.id = v.id AND entries.dedup_key IS DISTINCT FROM v.k`,
    params,
  );
  return res.rowCount ?? 0;
}

/**
 * Rekey a single row, resolving whatever already holds its key.
 *
 * Only reached when the batched statement hit a unique violation, so it can
 * afford a savepoint and a round trip per row. Two attempts is the ceiling on
 * purpose: `dedup_key` is UNIQUE, so a key has exactly one holder, and once
 * that holder is resolved a second violation would mean something else is
 * writing to the catalog — which nothing is, at this point in boot.
 */
async function rekeyOne(
  client: pg.PoolClient,
  vectors: Vectors,
  planned: PlannedRekey,
  source: MigrationEntryRow,
  stats: DedupMigrationStats,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await client.query('SAVEPOINT dedup_row');
    try {
      const res = await client.query(
        'UPDATE entries SET dedup_key = $1 WHERE id = $2 AND dedup_key IS DISTINCT FROM $1',
        [planned.newKey, planned.id],
      );
      await client.query('RELEASE SAVEPOINT dedup_row');
      stats.rekeyed += res.rowCount ?? 0;
      return;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // The failed statement poisons the transaction; the savepoint is what
      // lets the rest of the file's rows carry on in it.
      await client.query('ROLLBACK TO SAVEPOINT dedup_row');
      await client.query('RELEASE SAVEPOINT dedup_row');

      const held = await client.query('SELECT id, title, body FROM entries WHERE dedup_key = $1', [
        planned.newKey,
      ]);
      const holder = held.rows[0] as { id: number; title: string; body: string } | undefined;
      if (!holder) continue;                    // holder vanished — retry the update
      if (holder.id === planned.id) return;     // already ours (guarded UPDATE would not have raised)

      /**
       * The safety net for the one mistake this migration could not undo.
       * A genuine duplicate shares title and body — both are hashed into the
       * key, so a holder whose content differs is NOT a duplicate and deleting
       * it would destroy unique content. That is unreachable by construction
       * (a v3 key is built from a project-relative or claude path and can
       * therefore never equal some other row's absolute-path v2 key), which is
       * exactly why reaching it must stop the run rather than "handle" it: the
       * cursor keeps the position, so a fixed build resumes where this left off.
       */
      if (holder.title !== source.title || contentHash(holder.body) !== contentHash(source.body)) {
        // Names the file, not just the ids: this throw wedges the indexer in a
        // restart loop, and the operator's first question is which file to go
        // and look at. Entry ids alone cannot be resolved to one without a
        // database session.
        throw new Error(
          `dedup migration: entry ${planned.id}'s v3 key is already held by entry ${holder.id}, ` +
            'whose title/body differ — refusing to delete content that is not a duplicate ' +
            `(processing project ${source.project_id}, ${source.source_path})`,
        );
      }

      stats.collisions++;
      const loser = Math.max(holder.id, planned.id);
      await retire(client, vectors, loser);
      if (loser === planned.id) return;         // our row was the duplicate; nothing left to rekey
    }
  }
  throw new Error(
    `dedup migration: entry ${planned.id} still collides after its key holder was resolved ` +
      `(processing project ${source.project_id}, ${source.source_path})`,
  );
}

/**
 * Apply one file's plan in one transaction.
 *
 * The Qdrant deletes inside it are not transactional, and deliberately so: the
 * spec's ordering only has to survive a crash, and it does — a rolled-back
 * transaction leaves rows whose points are already gone, which the resumed
 * pass re-processes and re-converges.
 */
async function applyPlan(
  client: pg.PoolClient,
  vectors: Vectors,
  plan: Map<number, PlannedRekey>,
  byId: Map<number, MigrationEntryRow>,
  stats: DedupMigrationStats,
): Promise<void> {
  const planned = [...plan.values()];
  if (!planned.length) return;

  // A group of k identical rows produces exactly one `occ:2`, so counting
  // those counts the groups larger than one without re-deriving them.
  for (const r of planned) if (r.ref === 'occ:2') stats.ordinalGroups++;

  await client.query('BEGIN');
  try {
    for (const r of planned) {
      if (r.duplicateOf === undefined) continue;
      await retire(client, vectors, r.id);
      stats.collisions++;
    }
    const live = planned.filter((r) => r.duplicateOf === undefined);
    for (let i = 0; i < live.length; i += UPDATE_CHUNK) {
      const slice = live.slice(i, i + UPDATE_CHUNK);
      await client.query('SAVEPOINT dedup_slice');
      try {
        stats.rekeyed += await bulkRekey(client, slice);
        await client.query('RELEASE SAVEPOINT dedup_slice');
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        await client.query('ROLLBACK TO SAVEPOINT dedup_slice');
        await client.query('RELEASE SAVEPOINT dedup_slice');
        // The batched statement cannot say WHICH row collided, so the whole
        // slice is redone row by row — every row that does not collide still
        // lands, and the one that does gets its holder resolved.
        for (const r of slice) await rekeyOne(client, vectors, r, byId.get(r.id)!, stats);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

async function loadProjects(client: pg.PoolClient): Promise<Map<number, MigrationProject>> {
  const r = await client.query('SELECT id, slug, root_path FROM projects');
  return new Map(
    (r.rows as { id: number; slug: string; root_path: string }[]).map((p) => [
      p.id,
      { slug: p.slug, rootPath: p.root_path },
    ]),
  );
}

/**
 * Run the v3 migration to completion. Idempotent (returns immediately once the
 * marker is stamped) and resumable (cursor in `settings.dedup_cursor`).
 *
 * `vectors` targets the collection search is currently served from, or is
 * `null` when no collection has ever been published — in which case nothing
 * was ever embedded, there are no points to delete, and the Postgres-only path
 * is complete rather than a shortcut.
 */
export async function runDedupMigration(
  catalog: Catalog,
  vectors: Vectors,
  opts: DedupMigrationOptions = {},
): Promise<DedupMigrationStats> {
  const stats = zeroStats();
  const batch = opts.batchSize ?? DEFAULT_BATCH;
  const log = opts.log ?? ((s: string) => console.log(s));
  const claudeDirs = opts.claudeDirs ?? ['/data/claude/projects'];

  if ((await catalog.getSetting(DEDUP_SCHEME_KEY)) === DEDUP_SCHEME) return stats;

  const client = await catalog.pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(${DEDUP_MIGRATION_LOCK})`);
    // Re-read under the lock: whoever held it may have been another boot of
    // this same migration, finishing it while we waited.
    if ((await catalog.getSetting(DEDUP_SCHEME_KEY)) === DEDUP_SCHEME) return stats;

    await client.query(
      `CREATE INDEX IF NOT EXISTS ${MIGRATION_INDEX} ON entries (project_id, source_path)`,
    );
    const projectsById = await loadProjects(client);
    let [curProject, curPath] = cursorPair(await catalog.getSetting(DEDUP_CURSOR_KEY));
    let files = 0;

    for (;;) {
      // Whole files at a time, so an ordinal group is never split across a
      // cursor advance and can never be ranked against half of itself.
      const page = await client.query(
        `SELECT DISTINCT project_id, source_path FROM entries
          WHERE (project_id, source_path) > ($1::int, $2::text)
          ORDER BY project_id, source_path LIMIT $3`,
        [curProject, curPath, batch],
      );
      if (!page.rows.length) break;

      for (const f of page.rows as { project_id: number; source_path: string }[]) {
        const res = await client.query(
          `SELECT id, project_id, source_type, source_path, source_ref, title, body
             FROM entries WHERE project_id = $1 AND source_path = $2 ORDER BY id`,
          [f.project_id, f.source_path],
        );
        const rows = res.rows as MigrationEntryRow[];
        const plan = planRekey(rows, projectsById, claudeDirs);
        await applyPlan(client, vectors, plan, new Map(rows.map((r) => [r.id, r])), stats);
        stats.scanned += rows.length;
        if (++files % LOG_EVERY_FILES === 0) {
          log(`[dedup-v3] ${files} files, ${stats.scanned} entries scanned, ${stats.rekeyed} rekeyed`);
        }
      }

      // Advanced only once every file in the page is committed: a crash costs
      // one page of re-processing, never a skipped file.
      const last = page.rows.at(-1) as { project_id: number; source_path: string };
      [curProject, curPath] = [last.project_id, last.source_path];
      await catalog.setSetting(DEDUP_CURSOR_KEY, JSON.stringify([curProject, curPath]));
      log(
        `[dedup-v3] ${stats.scanned} scanned, ${stats.rekeyed} rekeyed, ` +
          `${stats.collisions} collisions, ${stats.ordinalGroups} ordinal groups`,
      );
    }

    /**
     * The marker is the LAST thing this migration writes — after the final
     * page, and after the cursor is cleared. Stamping it any earlier ends the
     * migration permanently: a crash mid-sweep would leave a half-migrated
     * catalog that never runs this again, and every row still on a v2 key
     * would re-insert as a duplicate forever, compounding. The window this
     * ordering opens instead is cheap and bounded — a crash between the two
     * costs one full rescan whose every UPDATE is a guarded no-op.
     */
    await catalog.setSetting(DEDUP_CURSOR_KEY, '');
    await catalog.setSetting(DEDUP_SCHEME_KEY, DEDUP_SCHEME);
    await client.query(`DROP INDEX IF EXISTS ${MIGRATION_INDEX}`).catch(() => {});
    return stats;
  } finally {
    let unlocked = true;
    await client
      .query(`SELECT pg_advisory_unlock(${DEDUP_MIGRATION_LOCK})`)
      .catch(() => {
        unlocked = false;
      });
    // A connection handed back to the pool while still holding 732016 would
    // block every later boot's migration for as long as the pool keeps it
    // alive. If the unlock did not land, destroy the connection instead —
    // Postgres drops session-level advisory locks when the session ends.
    client.release(unlocked ? undefined : new Error('dedup migration: advisory lock not released'));
  }
}
