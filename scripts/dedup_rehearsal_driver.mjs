#!/usr/bin/env node
// Dedup-v3 migration rehearsal driver (spec §6.6). Invoked by
// scripts/dedup_rehearsal.sh against a throwaway Postgres restored from a
// backups/*.dump — never a real catalog. DATABASE_URL must point at that
// scratch database.
//
// Runs the REAL `runDedupMigration` (packages/core/src/dedupMigration.ts) so
// the report reflects exactly what production would do, with vector deletes
// counted rather than executed (a `deleteByEntryIds` stub — rehearsal is
// Postgres-only, spec'd that way because the scratch container has no Qdrant
// collection to delete from).
//
// The one thing the real run genuinely cannot report is collision DETAIL: by
// the time `runDedupMigration` returns, the losing row of every collision has
// already been deleted, so there is nothing left to print an id/path from. The
// pre-pass below re-derives the full rekey plan for the whole catalog through
// the exact same exported `planRekey` the real migration calls — pure and
// read-only, so it changes nothing — and reduces it with the same "lowest id
// survives" rule `rekeyOne` applies at runtime (see that function's use of
// `Math.max(holder.id, planned.id)`). The two must agree on the collision
// COUNT; the driver cross-checks that they do and flags it loudly if not.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const corePath = join(here, '..', 'packages', 'core', 'dist', 'index.js');
const { Catalog, runDedupMigration, planRekey } = await import(corePath);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required (set by scripts/dedup_rehearsal.sh)');
  process.exit(1);
}

// Matches `runDedupMigration`'s own default (opts.claudeDirs), so the
// pre-pass and the real run compute identity the same way.
const CLAUDE_DIRS = ['/data/claude/projects'];
// Files per page of the pre-pass — same size as the real migration's
// DEFAULT_BATCH, for the same reason: a whole file per page, cheap either way.
const PAGE = 2000;

async function loadProjects(pool) {
  const r = await pool.query('SELECT id, slug, root_path FROM projects');
  return new Map(r.rows.map((p) => [p.id, { slug: p.slug, rootPath: p.root_path }]));
}

async function rowCount(pool) {
  const r = await pool.query('SELECT count(*)::int AS c FROM entries');
  return r.rows[0].c;
}

/**
 * Re-derive the v3 key for every row in the catalog, purely and read-only.
 * Returns the flat plan (for sampling) plus every collision with its loser id,
 * the id it lost to, the project slug and the identity path — the detail the
 * real run cannot produce because it deletes the loser before returning.
 */
async function prePass(pool, projectsById) {
  const allPlanned = [];
  let ordinalGroups = 0;
  let [curProject, curPath] = [0, ''];

  for (;;) {
    const filesRes = await pool.query(
      `SELECT DISTINCT project_id, source_path FROM entries
        WHERE (project_id, source_path) > ($1::int, $2::text)
        ORDER BY project_id, source_path LIMIT $3`,
      [curProject, curPath, PAGE],
    );
    if (!filesRes.rows.length) break;

    const params = [];
    const tuples = filesRes.rows.map((f, i) => {
      params.push(f.project_id, f.source_path);
      return `($${i * 2 + 1}::int, $${i * 2 + 2}::text)`;
    });
    const rowsRes = await pool.query(
      `SELECT id, project_id, source_type, source_path, source_ref, title, body
         FROM entries WHERE (project_id, source_path) IN (VALUES ${tuples.join(',')})
        ORDER BY project_id, source_path, id`,
      params,
    );

    const byFile = new Map();
    for (const row of rowsRes.rows) {
      const key = `${row.project_id}\x1f${row.source_path}`;
      const list = byFile.get(key);
      if (list) list.push(row);
      else byFile.set(key, [row]);
    }
    for (const rows of byFile.values()) {
      const plan = planRekey(rows, projectsById, CLAUDE_DIRS);
      const slug = projectsById.get(rows[0].project_id)?.slug ?? `#${rows[0].project_id}`;
      for (const r of plan.values()) {
        if (r.ref === 'occ:2') ordinalGroups++;
        allPlanned.push({ id: r.id, project: slug, newKey: r.newKey, path: r.path });
      }
    }

    const last = filesRes.rows[filesRes.rows.length - 1];
    [curProject, curPath] = [last.project_id, last.source_path];
  }

  // Every row sharing a v3 key collides; the lowest id is the one the real
  // migration keeps (planRekey does this within one file, rekeyOne does it
  // across files at runtime — both reduce to the same rule).
  const byKey = new Map();
  for (const p of allPlanned) {
    const list = byKey.get(p.newKey);
    if (list) list.push(p);
    else byKey.set(p.newKey, [p]);
  }
  const collisions = [];
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.id - b.id);
    const winner = list[0];
    for (const loser of list.slice(1)) {
      collisions.push({ loserId: loser.id, winnerId: winner.id, project: loser.project, path: loser.path });
    }
  }
  return { allPlanned, collisions, ordinalGroups };
}

async function main() {
  const catalog = new Catalog(databaseUrl);
  await catalog.migrate();

  const before = await rowCount(catalog.pool);
  const projectsById = await loadProjects(catalog.pool);

  console.log('→ pre-pass: recomputing v3 keys read-only (no writes yet)');
  const pre = await prePass(catalog.pool, projectsById);

  let wouldDelete = 0;
  const vectorsStub = {
    async deleteByEntryIds(ids) {
      wouldDelete += ids.length;
      // Counting stub only — rehearsal is Postgres-only, nothing is executed.
    },
  };

  console.log('→ running the real migration against the scratch database');
  const stats = await runDedupMigration(catalog, vectorsStub, { claudeDirs: CLAUDE_DIRS });

  const after = await rowCount(catalog.pool);

  const collisionNote =
    stats.collisions === pre.collisions.length
      ? `matches pre-pass prediction (${pre.collisions.length})`
      : `MISMATCH — pre-pass predicted ${pre.collisions.length}, investigate before trusting this run`;
  const ordinalNote =
    stats.ordinalGroups === pre.ordinalGroups
      ? 'matches pre-pass'
      : `MISMATCH — pre-pass predicted ${pre.ordinalGroups}`;

  console.log('');
  console.log('=== dedup-v3 rehearsal report ===');
  console.log(`rows before:        ${before}`);
  console.log(`rows after:         ${after}`);
  console.log(`scanned:            ${stats.scanned}`);
  console.log(`rekeyed:            ${stats.rekeyed}`);
  console.log(`collisions:         ${stats.collisions} (${collisionNote})`);
  console.log(`ordinal groups > 1: ${stats.ordinalGroups} (${ordinalNote})`);
  console.log(`would-delete point count: ${wouldDelete}`);
  console.log('');
  console.log(`collisions (${pre.collisions.length}):`);
  if (!pre.collisions.length) {
    console.log('  none');
  } else {
    for (const c of pre.collisions) {
      console.log(`  loser id=${c.loserId}  kept id=${c.winnerId}  project=${c.project}  path=${c.path}`);
    }
  }
  console.log('');
  console.log('sample recomputed keys:');
  for (const s of pre.allPlanned.slice(0, 5)) {
    console.log(`  id=${s.id}  project=${s.project}  path=${s.path}  key=${s.newKey}`);
  }
  console.log('');
  console.log(
    "If the real run wedges on a collision (restart loop), inspect the two rows it names; " +
      "stamp settings.dedup_scheme='v3' manually ONLY after verifying the catalog is complete.",
  );

  await catalog.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
