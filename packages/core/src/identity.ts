import { basename } from 'node:path';
import type { Entry, EntryIdentity } from './types.js';
import { contentHash } from './ids.js';

/**
 * Machine-independent identity for dedup key v3 (spec §6). Today
 * `Catalog.dedupKey` hashes the absolute container `sourcePath`; git-synced
 * content (kdb logs, git commits, docs) is byte-identical on two machines at
 * different paths, so a path-based key double-indexes everything git syncs.
 * `applyIdentity`/`identityFromStored` compute a normalized
 * `{ scope, path, ref }` triple that `Catalog.dedupKey` hashes instead —
 * identical content on two machines then produces the same key.
 */

/** Settings marker for the v3 key migration. NEVER 'id_scheme' (spec §6). */
export const DEDUP_SCHEME = 'v3';

const LINE_REF = /^line:\d+$/;

/**
 * Shared by both `applyIdentity` and `identityFromStored` so they can't
 * independently drift on the root-relative branch.
 *
 * An empty/falsy `root` returns null rather than matching every path as a
 * prefix — `''.endsWith('/')` is false, so the naive `${root}/` prefix was
 * `'/'`, which every absolute path starts with; a ghost project's
 * `root_path=''` would then strip the leading slash off any stored path
 * (`/weird/path.md` → `weird/path.md`), a de-slashed string that can
 * genuinely collide with a real relative path — exactly what §6.3's
 * "no false collision" guarantee forbids. Trailing slashes on `root` are
 * normalized before the equality test so `/repo` and `/repo/` agree on the
 * repo-root case (`sourcePath === repoPath`) that every git commit hits.
 */
function relativeTo(p: string, root: string): string | null {
  if (!root) return null; // '' would match everything as a prefix
  const r = root.replace(/\/+$/, '');
  if (p === r) return '.';
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null;
}

/** Spec §6 table. Mutates entries in place (they are fresh from a parser). */
export function applyIdentity(entries: Entry[], ctx: { rootPath?: string; claudeDirName?: string }): void {
  for (const e of entries) {
    if (e.sourceType === 'claude_session') {
      // File identity is global (session UUIDs); slug deliberately absent so
      // Migration-Assistant copies dedup instead of re-embedding (spec §6).
      const dir = ctx.claudeDirName ?? basename(e.sourcePath.replace(/\/[^/]+$/, ''));
      e.identity = { scope: 'claude', path: `${dir}/${basename(e.sourcePath)}`, ref: e.sourceRef ?? '' };
      continue;
    }
    const rel = relativeTo(e.sourcePath, ctx.rootPath ?? '');
    e.identity = {
      scope: e.projectSlug,
      path: rel ?? e.sourcePath,          // conservative fallback (spec §6.3)
      ref: e.sourceRef ?? '',             // shas/anchors stay; line refs replaced below
    };
  }
}

/**
 * Replace unstable line refs with content-occurrence ordinals (spec §6).
 *
 * MUST run after `applyIdentity` — it rewrites `identity.ref` in place, so an
 * entry without `identity` yet has nothing to rewrite. A `line:<n>`-ref entry
 * missing `identity` throws rather than silently skipping: a silent no-op
 * here would leave that entry's `identity.ref` as the raw, position-shifting
 * line number, quietly disabling cross-machine dedup for it instead of
 * failing loudly at the call site that got the order wrong.
 */
export function assignOccurrenceOrdinals(entries: Entry[]): void {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!LINE_REF.test(e.sourceRef ?? '')) continue;
    if (!e.identity) {
      throw new Error(
        `assignOccurrenceOrdinals: entry with sourceRef "${e.sourceRef}" has no identity — call applyIdentity first`,
      );
    }
    const k = `${e.identity.path}\x1f${e.title}\x1f${contentHash(e.body)}`;
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    e.identity.ref = `occ:${n}`;
  }
}

/** The last two `/`-segments of `path` — always the `<dir>/<file>` shape. */
function lastTwoSegments(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

/**
 * Recover a stored claude transcript's `<dirName>/<fileName>` identity path.
 * Strips whichever of `claudeDirs` prefixes the stored path (each is a full
 * claude-projects-root path, self or remote), then reduces to the last two
 * segments of what's left — so a match always emits exactly `<dir>/<file>`,
 * same shape as its `applyIdentity` twin, even if the matched prefix left
 * more than two segments behind. When no prefix matches (an unknown or moved
 * mount) the same last-two-segments reduction applies to the full path.
 */
function claudeRelativePath(sourcePath: string, claudeDirs: string[]): string {
  for (const dir of claudeDirs) {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    if (sourcePath.startsWith(prefix)) return lastTwoSegments(sourcePath.slice(prefix.length));
  }
  return lastTwoSegments(sourcePath);
}

/**
 * The migration-side twin of `applyIdentity`: derives the same identity
 * triple from stored columns instead of a live parse, so the v3 migration can
 * recompute dedup keys for existing rows without re-running the parsers.
 * MUST agree with `applyIdentity` on every source type — see the agreement
 * test in test/core/identity.test.ts.
 *
 * Line refs are returned raw (unlike `applyIdentity` + `assignOccurrenceOrdinals`
 * combined): assigning ordinals at migration time is a grouping pass over all
 * rows sharing (project, path, title, contentHash), which is the migration's
 * job (Task 9), not this per-row lookup's.
 */
export function identityFromStored(
  row: { source_type: string; source_path: string; source_ref: string | null; title: string; body: string },
  projectSlug: string,
  roots: string[],
  claudeDirs: string[],
): EntryIdentity {
  if (row.source_type === 'claude_session') {
    return {
      scope: 'claude',
      path: claudeRelativePath(row.source_path, claudeDirs),
      ref: row.source_ref ?? '',
    };
  }
  let rel: string | null = null;
  // Longest root first: a nested project root must win over a shorter parent
  // root that would also match as a prefix.
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    rel = relativeTo(row.source_path, root);
    if (rel !== null) break;
  }
  return {
    scope: projectSlug,
    path: rel ?? row.source_path,       // conservative fallback (spec §6.3)
    ref: row.source_ref ?? '',
  };
}
