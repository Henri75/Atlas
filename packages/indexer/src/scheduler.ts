import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  Catalog, encodeClaudePath, matchClaudeDirToProject, claudeDirFallbackSlug,
  loadMachinesFileIfPresent, selfMachine,
} from '@atlas/core';
import type { AppConfig, DiscoveredProject } from '@atlas/core';
import { readdirSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { discoverProjects, hasGitRepo } from './scanners.js';
import type { CodeRoot } from './scanners.js';
import { mirrorRootsFor, mirrorClaudeDirsFor, checkLocationDivergence } from './mirror.js';
import type { ScanJobData } from './pipeline.js';

const execFileAsync = promisify(execFile);

export const SCAN_QUEUE = 'kdbscope-scan';

/**
 * Which machine this container is. config/machines.yaml present → the entry
 * ATLAS_SELF names; absent → 'local', the legacy single-machine label (also
 * what a first multi-machine boot backfills pre-machine rows to).
 */
export function resolveSelfName(cfg: AppConfig): string {
  const mf = loadMachinesFileIfPresent(cfg.machinesFile);
  return mf ? selfMachine(mf, cfg.atlasSelf).name : 'local';
}

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
 * How long since this machine last enqueued a sync job for `<machine>`, keyed
 * in `settings` — same pattern as main.ts's `ADOPTION_TICK_KEY`: staleness is
 * checked here so a fixed jobId can still collapse duplicates while one is
 * pending, and the check is what keeps a due sync from being enqueued twice.
 */
function syncEnqueuedKey(machine: string): string {
  return `sync_enqueued:${machine}`;
}

/**
 * Match a batch of Claude project dirs (all from one machine — self or one
 * mirror) against the projects known for that machine, with a fallback slug
 * for anything unmatched. Pure and shared by the self and mirror attribution
 * passes so the matching logic exists once.
 *
 * Keyed on the MATCHED project's own `slug`+`machine` rather than the caller's
 * machine, because matching is by `hostPath` prefix and nothing stops a self
 * dir and a mirror project from sharing a slug — keying on the matched
 * project's identity is what keeps a self project's Claude dirs from bleeding
 * into a same-slug mirror project's job list (and vice versa).
 */
export interface ClaudeAttribution {
  /** Dir paths grouped by `claudeAttribKey(matchedSlug, matchedMachine)`. */
  matchedByProjectSlug: Map<string, string[]>;
  /** Ghost projects for dirs that matched nothing, tagged with `fallbackMachine`. */
  standalone: DiscoveredProject[];
}

export function claudeAttribKey(slug: string, machine?: string): string {
  return `${slug} ${machine ?? ''}`;
}

export function attributeClaudeDirs(
  dirPaths: string[],
  projects: DiscoveredProject[],
  encodedRoots: string[],
  fallbackMachine?: string,
): ClaudeAttribution {
  const matchedByProjectSlug = new Map<string, string[]>();
  const standalone: DiscoveredProject[] = [];
  const push = (key: string, dirPath: string) => {
    matchedByProjectSlug.set(key, [...(matchedByProjectSlug.get(key) ?? []), dirPath]);
  };
  for (const dirPath of dirPaths) {
    const dirName = basename(dirPath);
    const matched = matchClaudeDirToProject(dirName, projects);
    if (matched) {
      push(claudeAttribKey(matched.slug, matched.machine), dirPath);
    } else {
      const slug = claudeDirFallbackSlug(dirName, encodedRoots);
      standalone.push({ slug, name: slug, rootPath: '', hasKdb: false, machine: fallbackMachine });
      push(claudeAttribKey(slug, fallbackMachine), dirPath);
    }
  }
  return { matchedByProjectSlug, standalone };
}

/** `git <args>` in `cwd`, or null on any failure (missing repo, no origin, …). */
async function defaultExecGit(args: string[], cwd: string): Promise<string | null> {
  try {
    // The mirror root is written by rsync, not git, so a git invocation racing
    // the next sync must never plant a lock file there (spec §4) — harmless on
    // a self root.
    const { stdout } = await execFileAsync('git', args, {
      cwd, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * A location's identity for the divergence check (spec §5): the origin URL,
 * falling back to the repo's root commit for an origin-less repo (a local-only
 * checkout still has a stable fingerprint two machines can be compared on).
 */
async function originUrlFor(
  cwd: string,
  execGit: (args: string[], cwd: string) => Promise<string | null>,
): Promise<string | null> {
  const url = await execGit(['-c', 'safe.directory=*', 'remote', 'get-url', 'origin'], cwd);
  if (url) return url;
  return execGit(['-c', 'safe.directory=*', 'rev-list', '--max-parents=0', 'HEAD', '-n', '1'], cwd);
}

/**
 * One scheduler tick: enqueue sync jobs for the fleet, discover self + mirror
 * projects, map Claude dirs (per machine), enqueue one scan job per
 * (project, source), and warn on cross-machine origin divergence.
 * Deterministic jobIds keep the queue free of duplicates while a previous
 * identical job is still pending.
 */
export async function scheduleScans(
  cfg: AppConfig,
  catalog: Catalog,
  queue: Queue<ScanJobData>,
  opts: {
    full?: boolean;
    project?: string;
    /** Test seam: defaults to the real `mirrorRootsFor(mf, self)`. Real mirror
     * paths live under /data/remote, unreachable outside the container. */
    mirrorRoots?: CodeRoot[];
    /** Test seam: defaults to the real `mirrorClaudeDirsFor(mf, self)`. */
    mirrorClaude?: { machine: string; dir: string; encodedRoots: string[] }[];
    /** Test seam: defaults to a real `git` invocation. Used by the
     * divergence check's per-location origin-URL lookup. */
    execGit?: (args: string[], cwd: string) => Promise<string | null>;
  } = {},
): Promise<number> {
  const self = resolveSelfName(cfg);
  const mf = loadMachinesFileIfPresent(cfg.machinesFile);
  const execGit = opts.execGit ?? defaultExecGit;

  // 1. Sync jobs: one per enabled non-self machine, cadence-gated so a
  // 5-minute scan tick does not re-enqueue a sync every time it runs.
  if (mf) {
    const now = Date.now();
    for (const m of mf.machines) {
      if (!m.enabled || m.name === self) continue;
      const key = syncEnqueuedKey(m.name);
      const last = Number(await catalog.getSetting(key).catch(() => null)) || 0;
      if (now - last < mf.sync.intervalMin * 60_000) continue;
      await catalog.setSetting(key, String(now)).catch(() => {});
      await queue.add(`sync/${m.name}`, { sync: m.name } as unknown as ScanJobData, {
        jobId: `sync--${m.name}`,
        removeOnComplete: true,
        removeOnFail: true,
      });
    }
  }

  // 2. Discovery: self roots (untagged — legacy behaviour) + every synced
  // mirror root (machine-tagged by mirrorRootsFor). The same slug can appear
  // twice here — once untagged, once per mirror machine — and that is by
  // design: it is the same project, discovered on two machines.
  const mirrorRoots = opts.mirrorRoots ?? (mf ? mirrorRootsFor(mf, self) : []);
  const projects = discoverProjects([...cfg.codeRoots, ...mirrorRoots]);

  // 3. Claude attribution, per machine. Self dirs match against the FULL
  // discovered list (self + mirror projects) exactly as before — matching is
  // by hostPath, so mirror projects with remote hostPaths only ever match a
  // mirror-originated Claude dir. Each mirror's dirs get their own pass
  // against that machine's `encodedRoots` for the fallback-slug case.
  const codeRootEnc = cfg.codeRoots.map((r) => encodeClaudePath(r.host ?? r.container));
  let selfClaudeDirNames: string[] = [];
  try {
    selfClaudeDirNames = readdirSync(cfg.claudeProjectsDir).filter((n) => !n.startsWith('.'));
  } catch {
    selfClaudeDirNames = []; // mount missing — kdb/git/docs still work
  }
  const selfClaudePaths = selfClaudeDirNames.map((n) => join(cfg.claudeProjectsDir, n));

  const claudeDirsByProject = new Map<string, string[]>();
  const standalone: DiscoveredProject[] = [];
  const mergeAttribution = (attrib: ClaudeAttribution) => {
    for (const [key, dirs] of attrib.matchedByProjectSlug) {
      claudeDirsByProject.set(key, [...(claudeDirsByProject.get(key) ?? []), ...dirs]);
    }
    standalone.push(...attrib.standalone);
  };
  mergeAttribution(attributeClaudeDirs(selfClaudePaths, projects, codeRootEnc, undefined));

  const mirrorClaude = opts.mirrorClaude ?? (mf ? mirrorClaudeDirsFor(mf, self) : []);
  for (const mc of mirrorClaude) {
    let names: string[] = [];
    try {
      names = readdirSync(mc.dir).filter((n) => !n.startsWith('.'));
    } catch {
      names = [];
    }
    const paths = names.map((n) => join(mc.dir, n));
    mergeAttribution(attributeClaudeDirs(paths, projects, mc.encodedRoots, mc.machine));
  }

  let enqueued = 0;
  /** Locations written this tick, per project id — fuel for the divergence check. */
  const locationsByProjectId = new Map<number, { machine: string; rootPath: string }[]>();
  const all = [...projects, ...standalone];
  for (const p of all) {
    if (opts.project && p.slug !== opts.project) continue;
    const isSelfProject = p.machine === undefined;
    const machineName = isSelfProject ? self : p.machine!;
    const projectId = await catalog.upsertProject(
      { slug: p.slug, name: p.name, rootPath: p.rootPath, hasKdb: p.hasKdb },
      { isSelf: isSelfProject },
    );
    // Standalone/ghost entries carry rootPath '' — they have no location to
    // record, only a Claude transcript dir with nothing on disk to match.
    if (p.rootPath) {
      await catalog.upsertProjectLocation({
        projectId, machine: machineName, rootPath: p.rootPath, hostPath: p.hostPath ?? '', hasKdb: p.hasKdb,
      });
      const locs = locationsByProjectId.get(projectId) ?? [];
      locs.push({ machine: machineName, rootPath: p.rootPath });
      locationsByProjectId.set(projectId, locs);
    }

    const base = {
      projectSlug: p.slug,
      projectName: p.name,
      rootPath: p.rootPath,
      hasKdb: p.hasKdb,
      full: opts.full,
      machine: machineName,
      isSelf: isSelfProject,
    };
    // A mirror source shares its slug with the self project (or another
    // mirror) more often than not, so the job key must carry the machine too
    // — otherwise two machines' kdb/git/doc jobs collide on one deterministic id.
    const keySuffix = isSelfProject ? '' : `@${p.machine}`;
    const jobs: { data: ScanJobData; key: string }[] = [];
    if (p.hasKdb) jobs.push({ data: { ...base, sourceType: 'kdb' }, key: `kdb${keySuffix}` });
    if (p.rootPath && hasGitRepo(p.rootPath)) {
      jobs.push({ data: { ...base, sourceType: 'git_commit' }, key: `git_commit${keySuffix}` });
    }
    if (p.rootPath) jobs.push({ data: { ...base, sourceType: 'doc' }, key: `doc${keySuffix}` });

    // One job per Claude directory rather than one per project: a project with
    // several transcript dirs otherwise becomes a single hours-long job that
    // BullMQ cannot track or retry independently.
    for (const dir of claudeDirsByProject.get(claudeAttribKey(p.slug, p.machine)) ?? []) {
      jobs.push({
        data: { ...base, sourceType: 'claude_session', claudeDirs: [dir] },
        key: `claude_session__${basename(dir)}${keySuffix}`,
      });
    }

    for (const { data, key } of jobs) {
      await queue.add(`${data.projectSlug}/${key}`, data, {
        // The id is deterministic so an identical *pending* job is not queued
        // twice. It must be released the moment the job finishes: BullMQ
        // treats an add() for a retained id as a silent no-op, which would stop
        // every later scan of that source from ever running.
        //
        // Both exits, for the same reason. Retaining failures looked like free
        // debugging history and cost three days of indexing on 2026-07-29: a
        // Postgres restart failed one job per source, and the 48 retained
        // failures reserved those ids permanently. Every project but deepcast
        // stopped updating while the scheduler kept reporting 140 jobs enqueued
        // a tick. A failed scan is retried by the next tick anyway — BullMQ has
        // already spent `attempts` by the time it lands here — and the failure
        // itself is recorded in `index_errors`, which outlives the queue.
        jobId: scanJobId(data.projectSlug, key, opts.full),
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
      enqueued++;
    }
  }

  // 4. Divergence check (spec §5): cheap, so only projects this tick actually
  // saw 2+ locations on. The same slug on two machines is treated as one
  // project — right for a genuinely shared checkout, silently wrong for two
  // unrelated repos that happen to share a dir basename. This is the warning,
  // not the fix: slugOverrides is the operator's fix.
  for (const [projectId, locs] of locationsByProjectId) {
    if (locs.length < 2) continue;
    const withOrigins: { machine: string; originUrl: string | null }[] = [];
    for (const loc of locs) {
      if (!existsSync(loc.rootPath)) continue; // not synced yet / not mounted
      withOrigins.push({ machine: loc.machine, originUrl: await originUrlFor(loc.rootPath, execGit) });
    }
    const warning = checkLocationDivergence(withOrigins);
    if (warning) await catalog.logError(projectId, locs[0]!.rootPath, 'divergence', warning);
  }

  // After every project is upserted, not before: a canonical project discovered
  // on this tick must be able to adopt a ghost created on an earlier one.
  const aliased = await catalog.refreshProjectAliases();
  if (aliased) console.log(`[indexer] ${aliased} project(s) linked as older locations`);

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
