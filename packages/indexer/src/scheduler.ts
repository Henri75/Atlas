import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { Catalog, encodeClaudePath, matchClaudeDirToProject, claudeDirFallbackSlug } from '@kdbscope/core';
import type { AppConfig, DiscoveredProject } from '@kdbscope/core';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { discoverProjects, hasGitRepo } from './scanners.js';
import type { ScanJobData } from './pipeline.js';

export const SCAN_QUEUE = 'kdbscope-scan';

/**
 * Deterministic job id, so an identical pending job is never queued twice.
 * BullMQ rejects ':' in custom ids, and project slugs/dir names can contain
 * almost anything, so everything outside [A-Za-z0-9_-] is normalised.
 */
export function scanJobId(projectSlug: string, key: string, full?: boolean): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-');
  return `${safe(projectSlug)}--${safe(key)}--${full ? 'full' : 'inc'}`;
}

/**
 * One scheduler tick: discover projects, map Claude dirs, enqueue one job per
 * (project, source). Deterministic jobIds keep the queue free of duplicates
 * while a previous identical job is still pending.
 */
export async function scheduleScans(
  cfg: AppConfig,
  catalog: Catalog,
  queue: Queue<ScanJobData>,
  opts: { full?: boolean; project?: string } = {},
): Promise<number> {
  const projects = discoverProjects(cfg.codeRoot);

  // Map every Claude project dir to its owning project (deepest match wins);
  // unmatched dirs become standalone "projects" so no history is invisible.
  const claudeDirsByProject = new Map<string, string[]>();
  const codeRootEnc = encodeClaudePath(cfg.codeRoot);
  let claudeDirNames: string[] = [];
  try {
    claudeDirNames = readdirSync(cfg.claudeProjectsDir).filter((n) => !n.startsWith('.'));
  } catch {
    claudeDirNames = []; // mount missing — kdb/git/docs still work
  }
  const standalone: DiscoveredProject[] = [];
  for (const dirName of claudeDirNames) {
    const matched = matchClaudeDirToProject(dirName, projects);
    if (matched) {
      const list = claudeDirsByProject.get(matched.slug) ?? [];
      list.push(join(cfg.claudeProjectsDir, dirName));
      claudeDirsByProject.set(matched.slug, list);
    } else {
      const slug = claudeDirFallbackSlug(dirName, codeRootEnc);
      const p: DiscoveredProject = { slug, name: slug, rootPath: '', hasKdb: false };
      standalone.push(p);
      claudeDirsByProject.set(slug, [
        ...(claudeDirsByProject.get(slug) ?? []),
        join(cfg.claudeProjectsDir, dirName),
      ]);
    }
  }

  let enqueued = 0;
  const all = [...projects, ...standalone];
  for (const p of all) {
    if (opts.project && p.slug !== opts.project) continue;
    await catalog.upsertProject({ slug: p.slug, name: p.name, rootPath: p.rootPath, hasKdb: p.hasKdb });

    const base = {
      projectSlug: p.slug,
      projectName: p.name,
      rootPath: p.rootPath,
      hasKdb: p.hasKdb,
      full: opts.full,
    };
    const jobs: { data: ScanJobData; key: string }[] = [];
    if (p.hasKdb) jobs.push({ data: { ...base, sourceType: 'kdb' }, key: 'kdb' });
    if (p.rootPath && hasGitRepo(p.rootPath)) {
      jobs.push({ data: { ...base, sourceType: 'git_commit' }, key: 'git_commit' });
    }
    if (p.rootPath) jobs.push({ data: { ...base, sourceType: 'doc' }, key: 'doc' });

    // One job per Claude directory rather than one per project: a project with
    // several transcript dirs otherwise becomes a single hours-long job that
    // BullMQ cannot track or retry independently.
    for (const dir of claudeDirsByProject.get(p.slug) ?? []) {
      jobs.push({
        data: { ...base, sourceType: 'claude_session', claudeDirs: [dir] },
        key: `claude_session__${basename(dir)}`,
      });
    }

    for (const { data, key } of jobs) {
      await queue.add(`${data.projectSlug}/${key}`, data, {
        // The id is deterministic so an identical *pending* job is not queued
        // twice. It must be released the moment the job finishes: BullMQ
        // treats an add() for a retained completed id as a silent no-op, which
        // would stop every later scan of that source from ever running.
        jobId: scanJobId(data.projectSlug, key, opts.full),
        removeOnComplete: true,
        removeOnFail: 500,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
      enqueued++;
    }
  }
  return enqueued;
}

/** Redis-lock so only one replica schedules per tick. */
export async function withSchedulerLock(
  redis: Redis,
  fn: () => Promise<void>,
): Promise<boolean> {
  const got = await redis.set('kdbscope:scheduler-lock', String(process.pid), 'EX', 55, 'NX');
  if (!got) return false;
  try {
    await fn();
  } finally {
    await redis.del('kdbscope:scheduler-lock');
  }
  return true;
}
