import { basename } from 'node:path';
import type { Entry } from './types.js';
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

function relativeTo(p: string, root: string): string | null {
  if (p === root) return '.';
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : null;
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
    const rel = ctx.rootPath ? relativeTo(e.sourcePath, ctx.rootPath) : null;
    e.identity = {
      scope: e.projectSlug,
      path: rel ?? e.sourcePath,          // conservative fallback (spec §6.3)
      ref: e.sourceRef ?? '',             // shas/anchors stay; line refs replaced below
    };
  }
}

/** Replace unstable line refs with content-occurrence ordinals (spec §6). */
export function assignOccurrenceOrdinals(entries: Entry[]): void {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!e.identity || !LINE_REF.test(e.sourceRef ?? '')) continue;
    const k = `${e.identity.path}${e.title}${contentHash(e.body)}`;
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    e.identity.ref = `occ:${n}`;
  }
}

/**
 * Recover a stored claude transcript's `<dirName>/<fileName>` identity path.
 * Strips whichever of `claudeDirs` prefixes the stored path (each is a full
 * claude-projects-root path, self or remote); when none matches (an unknown
 * or moved mount), falls back to the last two path segments — still
 * `<dirName>/<fileName>` shaped, just not verified against a known root.
 */
function claudeRelativePath(sourcePath: string, claudeDirs: string[]): string {
  for (const dir of claudeDirs) {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    if (sourcePath.startsWith(prefix)) return sourcePath.slice(prefix.length);
  }
  const parts = sourcePath.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
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
): { scope: string; path: string; ref: string } {
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
