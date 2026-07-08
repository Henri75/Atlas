import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { DiscoveredProject, SourceType } from '@kdbscope/core';
import { slugify } from '@kdbscope/core';

/**
 * Filesystem discovery. Everything here is read-only and defensive: a
 * permission error on one directory must never kill a scan.
 */

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'venv', '.venv',
  'target', 'vendor', '__pycache__', '.next', '.turbo', 'data',
]);

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

/** Projects = depth-1 dirs with kdb/ or .git, plus depth-2 dirs with kdb/. */
export function discoverProjects(codeRoot: string): DiscoveredProject[] {
  const projects: DiscoveredProject[] = [];
  for (const name of safeReaddir(codeRoot)) {
    if (name.startsWith('.') || IGNORED_DIRS.has(name)) continue;
    const root = join(codeRoot, name);
    if (!isDir(root)) continue;
    const hasKdb = isDir(join(root, 'kdb'));
    const hasGit = isDir(join(root, '.git'));
    if (hasKdb || hasGit) {
      projects.push({ slug: slugify(name), name, rootPath: root, hasKdb });
    }
    // Nested projects one level down (e.g. DeepCast/Lycos, Fun/populous).
    for (const sub of safeReaddir(root)) {
      if (sub.startsWith('.') || IGNORED_DIRS.has(sub)) continue;
      const subRoot = join(root, sub);
      if (!isDir(subRoot) || !isDir(join(subRoot, 'kdb'))) continue;
      projects.push({
        slug: slugify(`${name}-${sub}`),
        name: `${name}/${sub}`,
        rootPath: subRoot,
        hasKdb: true,
      });
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

/** Doc files: README + docs/ + adr, shallow walk, capped. */
export function listDocFiles(projectRoot: string, cap = 400): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= cap || depth > 4) return;
    for (const name of safeReaddir(dir)) {
      if (name.startsWith('.') || IGNORED_DIRS.has(name) || name === 'kdb') continue;
      const p = join(dir, name);
      if (isDir(p)) walk(p, depth + 1);
      else if (name.endsWith('.md') && out.length < cap) out.push(p);
    }
  };
  // Root-level *.md + docs tree.
  for (const name of safeReaddir(projectRoot)) {
    if (name.endsWith('.md')) out.push(join(projectRoot, name));
  }
  if (isDir(join(projectRoot, 'docs'))) walk(join(projectRoot, 'docs'), 0);
  return out.slice(0, cap);
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
