import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { DiscoveredProject, SourceType } from '@atlas/core';
import { isArchivedDocPath, slugify } from '@atlas/core';

/**
 * Filesystem discovery. Everything here is read-only and defensive: a
 * permission error on one directory must never kill a scan.
 */

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'venv', '.venv',
  'target', 'vendor', '__pycache__', '.next', '.turbo', 'data',
]);

export const SCANNER_IGNORED_DIRS = [...IGNORED_DIRS] as readonly string[];

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A tree to scan: where it is mounted, and where the user sees it. */
export interface CodeRoot {
  container: string;
  host?: string;
  /** The fleet machine this root belongs to. Absent = self/legacy. */
  machine?: string;
  /** dir-basename -> slug, for a top-level dir whose default slug collides
   * with an unrelated project elsewhere in the fleet (spec §5). Applies to
   * top-level dirs only; nested projects always use the plain slug. */
  slugOverrides?: Record<string, string>;
}

/**
 * Projects = depth-1 dirs with kdb/ or .git, plus depth-2 dirs with kdb/,
 * across every configured root.
 *
 * `hostPath` matters: Claude Code encodes a session's *host* cwd into its
 * directory name, so attributing sessions to projects has to compare host
 * paths. Comparing container paths silently matches nothing and every project
 * ends up duplicated — once from its files, once from its transcripts.
 */
export function discoverProjects(codeRoots: CodeRoot[]): DiscoveredProject[] {
  const projects: DiscoveredProject[] = [];
  // Keyed on (slug, machine): the same slug on two DIFFERENT machines is the
  // same project discovered twice (both kept — the scheduler upserts one
  // projects row + two locations); the same slug twice on ONE machine is a
  // genuine collision (first wins, warns).
  const seen = new Map<string, DiscoveredProject>();

  const add = (p: DiscoveredProject) => {
    const key = `${p.slug} ${p.machine ?? ''}`;
    const existing = seen.get(key);
    if (existing) {
      console.warn(
        `discoverProjects: slug "${p.slug}"${p.machine ? ` on machine "${p.machine}"` : ''} ` +
        `found at both ${existing.rootPath} and ${p.rootPath} — keeping the first, dropping the second`,
      );
      return;
    }
    seen.set(key, p);
    projects.push(p);
  };

  for (const { container, host, machine, slugOverrides } of codeRoots) {
    const toHost = (p: string) => (host ? join(host, p.slice(container.length + 1)) : undefined);

    for (const name of safeReaddir(container)) {
      if (name.startsWith('.') || IGNORED_DIRS.has(name)) continue;
      const root = join(container, name);
      if (!isDir(root)) continue;
      const hasKdb = isDir(join(root, 'kdb'));
      const hasGit = isDir(join(root, '.git'));
      if (hasKdb || hasGit) {
        add({
          slug: slugOverrides?.[name] ?? slugify(name),
          name,
          rootPath: root,
          hostPath: toHost(root),
          hasKdb,
          machine,
        });
      }
      // Nested projects one level down (e.g. DeepCast/Lycos, Fun/populous).
      // slugOverrides apply to top-level dirs only.
      for (const sub of safeReaddir(root)) {
        if (sub.startsWith('.') || IGNORED_DIRS.has(sub)) continue;
        const subRoot = join(root, sub);
        if (!isDir(subRoot) || !isDir(join(subRoot, 'kdb'))) continue;
        add({
          slug: slugify(`${name}-${sub}`),
          name: `${name}/${sub}`,
          rootPath: subRoot,
          hostPath: toHost(subRoot),
          hasKdb: true,
          machine,
        });
      }
    }
  }
  return projects;
}

export interface KdbFile {
  sourceType: SourceType;
  path: string;
  component?: string;
}

/** Generated views (*.md twins of *.log) and locks are skipped. */
export function listKdbFiles(projectRoot: string): KdbFile[] {
  const kdbDir = join(projectRoot, 'kdb');
  if (!isDir(kdbDir)) return [];
  const files: KdbFile[] = [];
  const generatedMd = new Set(['index.md', 'changelog.md', 'session.md', 'backlog.md']);

  for (const name of safeReaddir(kdbDir)) {
    const p = join(kdbDir, name);
    if (name === 'changelog.log') files.push({ sourceType: 'kdb_changelog', path: p });
    else if (name === 'session.log') files.push({ sourceType: 'kdb_session', path: p });
    else if (name === 'backlog.log') files.push({ sourceType: 'kdb_backlog', path: p });
    else if (name.endsWith('.md') && !generatedMd.has(name)) {
      files.push({ sourceType: 'kdb_report', path: p });
    }
  }
  const compDir = join(kdbDir, 'components');
  for (const name of safeReaddir(compDir)) {
    if (!name.endsWith('.log')) continue;
    files.push({
      sourceType: 'kdb_component',
      path: join(compDir, name),
      component: basename(name, '.log'),
    });
  }
  return files;
}

export interface DocFile {
  path: string;
  /** Lives under an archive-style location (docs/archive, _legacy, Previous…). */
  archived: boolean;
}

/**
 * Doc files: README + root *.md + docs/ tree. The cap is a runaway guard, not
 * a quota — files beyond it are counted in `dropped` so the caller can warn
 * instead of truncating silently (DeepCast once lost 80+ files to a cap of 400).
 */
export function listDocFiles(
  projectRoot: string,
  cap = 2000,
): { files: DocFile[]; dropped: number } {
  const files: DocFile[] = [];
  let dropped = 0;
  const add = (p: string) => {
    if (files.length >= cap) {
      dropped++;
      return;
    }
    // Classified on the project-relative path: a project ROOT named "Old"
    // must not archive its whole tree.
    files.push({ path: p, archived: isArchivedDocPath(p.slice(projectRoot.length + 1)) });
  };
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    for (const name of safeReaddir(dir)) {
      if (name.startsWith('.') || IGNORED_DIRS.has(name) || name === 'kdb') continue;
      const p = join(dir, name);
      if (isDir(p)) walk(p, depth + 1);
      else if (name.endsWith('.md')) add(p);
    }
  };
  // Root-level *.md + docs tree.
  for (const name of safeReaddir(projectRoot)) {
    if (name.endsWith('.md')) add(join(projectRoot, name));
  }
  if (isDir(join(projectRoot, 'docs'))) walk(join(projectRoot, 'docs'), 0);
  return { files, dropped };
}

/** All *.jsonl session transcripts inside a Claude project dir. */
export function listSessionFiles(claudeDir: string): string[] {
  return safeReaddir(claudeDir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => join(claudeDir, n));
}

export function hasGitRepo(projectRoot: string): boolean {
  return existsSync(join(projectRoot, '.git'));
}
