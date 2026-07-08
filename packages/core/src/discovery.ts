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
  rootPath: string;
  hasKdb: boolean;
}

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
 */
export function matchClaudeDirToProject<T extends { rootPath: string }>(
  dirName: string,
  projects: T[],
): T | null {
  let best: T | null = null;
  let bestLen = 0;
  for (const p of projects) {
    const enc = encodeClaudePath(p.rootPath);
    if ((dirName === enc || dirName.startsWith(enc + '-')) && enc.length > bestLen) {
      best = p;
      bestLen = enc.length;
    }
  }
  return best;
}

/** Fallback slug for Claude dirs that match no known project. */
export function claudeDirFallbackSlug(dirName: string, codeRootEncoded: string): string {
  const tail = dirName.startsWith(codeRootEncoded + '-')
    ? dirName.slice(codeRootEncoded.length + 1)
    : dirName;
  return slugify(tail.replace(/^-+/, ''));
}
