/**
 * Project discovery + mapping of ~/.claude/projects dir names back to projects.
 *
 * Claude Code encodes a project cwd as a dir name by replacing every character
 * outside [A-Za-z0-9-] with '-' (verified: "/Users/nasta/__CODING NEW/DeepCast"
 * → "-Users-nasta---CODING-NEW-DeepCast"). The encoding is lossy, so we match
 * by encoding known project paths and comparing prefixes, never by decoding.
 */

export interface DiscoveredProject {
  slug: string;
  name: string;
  /** Path inside the container, where the indexer reads files. */
  rootPath: string;
  /** The same tree as the user sees it. Claude dir names encode this one. */
  hostPath?: string;
  hasKdb: boolean;
}

/**
 * Bump when the rule that attributes a source to a project changes: existing
 * rows then hang off the wrong project and the derived index must be rebuilt.
 * v2 matches Claude transcript dirs on the host path rather than the container
 * path, which stopped every project being split in two.
 */
export const PROJECT_GROUPING = 'v2';

export function encodeClaudePath(p: string): string {
  return p.replace(/[^A-Za-z0-9-]/g, '-');
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';
}

/**
 * Match a Claude project dir name to the project owning it (deepest wins,
 * so "…-DeepCast-Lycos" maps to DeepCast/Lycos if that is a known project,
 * else to DeepCast). Returns null when nothing matches.
 *
 * Matching uses `hostPath`: Claude Code encodes the session's cwd as the user
 * saw it, not the container path the indexer reads from. Comparing container
 * paths matches nothing, and every project silently ends up split in two —
 * once from its files, once from its transcripts.
 */
export function matchClaudeDirToProject<T extends { rootPath: string; hostPath?: string }>(
  dirName: string,
  projects: T[],
): T | null {
  let best: T | null = null;
  let bestLen = 0;
  for (const p of projects) {
    const enc = encodeClaudePath(p.hostPath ?? p.rootPath);
    if ((dirName === enc || dirName.startsWith(enc + '-')) && enc.length > bestLen) {
      best = p;
      bestLen = enc.length;
    }
  }
  return best;
}

/**
 * Fallback slug for Claude dirs that match no known project: sessions from a
 * folder we don't index, or from a machine whose paths differ. Strips whichever
 * known root prefixes it, so the slug is the project name rather than its
 * whole absolute path.
 */
export function claudeDirFallbackSlug(
  dirName: string,
  encodedRoots: string | string[],
): string {
  const roots = (Array.isArray(encodedRoots) ? encodedRoots : [encodedRoots])
    .filter(Boolean)
    // Longest first: a nested root must win over its parent.
    .sort((a, b) => b.length - a.length);

  let tail = dirName;
  for (const root of roots) {
    if (dirName.startsWith(root + '-')) {
      tail = dirName.slice(root.length + 1);
      break;
    }
  }
  return slugify(tail.replace(/^-+/, ''));
}

/**
 * Resolve a ghost project slug to the canonical project it is an older location
 * of, or null if it stands on its own.
 *
 * When a repo moves, its existing Claude transcript directories no longer match
 * any configured code root, so `claudeDirFallbackSlug` derives a slug from the
 * entire old path — "users-nasta-documents-coding-new-deepcast" for what is
 * simply DeepCast. Those entries are the only copy of that era's history (27,300
 * of them as of 2026-07-26), yet a search scoped to "deepcast" missed every one,
 * and the MCP instructions told agents to discard them as duplicates.
 *
 * Matching on slugs alone is sufficient and stable: both slugs are derived from
 * the same trailing path segments, so a moved checkout's slug always *ends with*
 * its canonical slug. Requiring a `-` boundary stops "notdeepcast" matching
 * "deepcast"; requiring a real `rootPath` stops one ghost aliasing onto another
 * and chaining; taking the longest match keeps DeepCast/Lycos out of DeepCast.
 *
 * No tie-breaking is needed: `projects.slug` is UNIQUE, so at most one project
 * can carry the longest matching suffix.
 */
export function resolveProjectAlias<T extends { slug: string; rootPath: string }>(
  slug: string,
  projects: T[],
): string | null {
  let best: string | null = null;
  for (const p of projects) {
    // Only a discovered project can be an alias target, and never itself.
    if (!p.rootPath || p.slug === slug) continue;
    if (!slug.endsWith(`-${p.slug}`)) continue;
    if (p.slug.length > (best?.length ?? 0)) best = p.slug;
  }
  return best;
}
