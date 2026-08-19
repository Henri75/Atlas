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

/** Last-logged divergence warning for a project, so a standing divergence is
 * logged once on the tick it first appears (or changes), not every tick. */
function divergenceKey(projectId: number): string {
  return `divergence:${projectId}`;
}

/**
 * Match a batch of Claude project dirs (all from one machine — self or one
 * mirror) against `projects`, with a fallback slug for anything unmatched.
 * Pure and shared by the self and mirror attribution passes so the matching
 * logic exists once.
 *
 * `projects` MUST already be filtered to that machine's own projects before
 * calling. `matchClaudeDirToProject` picks the longest `hostPath`-encoded
 * prefix match across whatever candidates it is given, keeping the FIRST
 * candidate on a tie — and two machines with the same code-root layout (the
 * common same-user case) produce IDENTICAL encoded hostPaths for a same-slug
 * project. Matching against the combined self+mirror list let the self entry
 * (always listed first) win that tie every time, silently attributing every
 * mirror machine's Claude transcripts to the self project instead — and since
 * the self round's own dir of the same name would already occupy that job's
 * deterministic id, the stolen dir's job was a silent no-op: the remote
 * machine's transcripts were never indexed. Filtering the candidate list per
 * round, at the call site, is what spec §5 means by "matched against that
 * machine's project locations".
 *
 * Keyed on the MATCHED project's own `slug`+`machine` (which — given a
 * correctly pre-filtered `projects` — is always the calling round's own
 * machine) rather than trusting the caller to pass it separately, so a bug in
 * the filtering shows up as a wrong bucket instead of a silent merge.
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

type ExecGit = (args: string[], cwd: string) => Promise<string | null>;

async function gitOriginUrl(cwd: string, execGit: ExecGit): Promise<string | null> {
  return execGit(['-c', 'safe.directory=*', 'remote', 'get-url', 'origin'], cwd);
}

async function gitRootCommit(cwd: string, execGit: ExecGit): Promise<string | null> {
  return execGit(['-c', 'safe.directory=*', 'rev-list', '--max-parents=0', 'HEAD', '-n', '1'], cwd);
}

/**
 * A project's per-location identity for the divergence check (spec §5): each
 * location's origin URL — or, ONLY when NONE of them has one configured,
 * each location's root commit instead (a local-only checkout still has a
 * stable fingerprint two machines can be compared on).
 *
 * Never mixes the two within one comparison. A URL and a commit sha never
 * share a format, so a location with `origin` configured compared against a
 * sibling that has none (and so fell back to its root commit) would read as
 * "diverged" on every single tick — a false positive by construction, not a
 * real signal, since not having pushed a remote yet says nothing about
 * whether the two checkouts are the same project.
 */
async function originsForLocations(
  locs: { machine: string; rootPath: string }[],
  execGit: ExecGit,
): Promise<{ machine: string; originUrl: string | null }[]> {
  const existing = locs.filter((l) => existsSync(l.rootPath)); // not synced yet / not mounted
  const urls: { machine: string; originUrl: string | null }[] = [];
  for (const loc of existing) urls.push({ machine: loc.machine, originUrl: await gitOriginUrl(loc.rootPath, execGit) });
  if (urls.some((l) => l.originUrl !== null)) return urls;

  const shas: { machine: string; originUrl: string | null }[] = [];
  for (const loc of existing) shas.push({ machine: loc.machine, originUrl: await gitRootCommit(loc.rootPath, execGit) });
  return shas;
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
  // 5-minute scan tick does not re-enqueue a sync every time it runs. Skipped
  // entirely for a manual single-project rescan (opts.project) — that is a
  // per-project trigger, not a fleet-wide tick, and must not have the side
  // effect of kicking off syncs for every other machine.
  if (mf && !opts.project) {
    const now = Date.now();
    for (const m of mf.machines) {
      if (!m.enabled || m.name === self) continue;
      const key = syncEnqueuedKey(m.name);
      const last = Number(await catalog.getSetting(key).catch(() => null)) || 0;
      if (now - last < mf.sync.intervalMin * 60_000) continue;
      // Stamp only AFTER a successful enqueue: if queue.add throws (a Redis
      // hiccup), the stamp must stay stale so the next tick retries rather
      // than skipping this machine for a full interval over nothing.
      await queue.add(`sync/${m.name}`, { sync: m.name } as unknown as ScanJobData, {
        jobId: `sync--${m.name}`,
        removeOnComplete: true,
        removeOnFail: true,
      });
      await catalog.setSetting(key, String(now)).catch(() => {});
    }
  }

  // 2. Discovery: self roots (untagged — legacy behaviour) + every synced
  // mirror root (machine-tagged by mirrorRootsFor). The same slug can appear
  // twice here — once untagged, once per mirror machine — and that is by
  // design: it is the same project, discovered on two machines.
  const mirrorRoots = opts.mirrorRoots ?? (mf ? mirrorRootsFor(mf, self) : []);
  const projects = discoverProjects([...cfg.codeRoots, ...mirrorRoots]);

  // 3. Claude attribution, per machine. Each round matches ONLY against that
  // machine's own projects (see attributeClaudeDirs's docstring for why: two
  // machines with the same code-root layout produce identical encoded
  // hostPaths for a same-slug project, and matching against the combined list
  // let self silently steal every mirror's Claude transcripts).
  const codeRootEnc = cfg.codeRoots.map((r) => encodeClaudePath(r.host ?? r.container));
  const selfProjects = projects.filter((p) => p.machine === undefined);
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
  mergeAttribution(attributeClaudeDirs(selfClaudePaths, selfProjects, codeRootEnc, undefined));

  const mirrorClaude = opts.mirrorClaude ?? (mf ? mirrorClaudeDirsFor(mf, self) : []);
  for (const mc of mirrorClaude) {
    let names: string[] = [];
    try {
      names = readdirSync(mc.dir).filter((n) => !n.startsWith('.'));
    } catch {
      names = [];
    }
    const paths = names.map((n) => join(mc.dir, n));
    const mcProjects = projects.filter((p) => p.machine === mc.machine);
    mergeAttribution(attributeClaudeDirs(paths, mcProjects, mc.encodedRoots, mc.machine));
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
  //
  // Logged only on CHANGE: index_errors has no pruning, and a standing
  // divergence would otherwise write a fresh row every tick forever, pinning
  // the health figure non-zero and burying real scan failures under it. The
  // last-logged warning text is kept in settings per project; a resolved
  // divergence clears it rather than leaving a stale flag behind.
  for (const [projectId, locs] of locationsByProjectId) {
    if (locs.length < 2) continue;
    const withOrigins = await originsForLocations(locs, execGit);
    const warning = checkLocationDivergence(withOrigins);
    const settingKey = divergenceKey(projectId);
    const stored = await catalog.getSetting(settingKey).catch(() => null);
    if (warning && warning !== stored) {
      await catalog.logError(projectId, locs[0]!.rootPath, 'divergence', warning);
      await catalog.setSetting(settingKey, warning).catch(() => {});
    } else if (!warning && stored) {
      await catalog.setSetting(settingKey, '').catch(() => {});
    }
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
