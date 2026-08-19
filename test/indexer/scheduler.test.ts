import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parseConfig, encodeClaudePath } from '@atlas/core';
import { scanJobId, scheduleScans } from '../../packages/indexer/src/scheduler.js';
import type { CodeRoot } from '../../packages/indexer/src/scanners.js';

/**
 * BullMQ rejects ':' in custom job ids ("Custom Id cannot contain :"), which
 * crash-looped the indexer once. Project slugs and Claude dir names can hold
 * dots, slashes and colons, so ids must always be normalised.
 */
describe('scanJobId', () => {
  it('never contains a colon, even when inputs do', () => {
    const id = scanJobId('deepcast', 'claude_session__-Users-nasta-x:y', false);
    expect(id).not.toContain(':');
  });

  it('normalises every character outside [A-Za-z0-9_-]', () => {
    expect(scanJobId('fwdr.it', 'doc')).toBe('fwdr-it--doc--inc');
    expect(scanJobId('a/b', 'kdb')).toBe('a-b--kdb--inc');
  });

  it('distinguishes full from incremental runs', () => {
    expect(scanJobId('p', 'kdb', true)).toBe('p--kdb--full');
    expect(scanJobId('p', 'kdb', false)).toBe('p--kdb--inc');
  });

  it('is stable so an identical pending job is not queued twice', () => {
    expect(scanJobId('p', 'doc')).toBe(scanJobId('p', 'doc'));
  });

  it('separates distinct claude dirs of the same project', () => {
    const a = scanJobId('deepcast', 'claude_session__-Users-nasta-DeepCast');
    const b = scanJobId('deepcast', 'claude_session__-Volumes-CloudBox-DeepCast');
    expect(a).not.toBe(b);
  });
});

const root = mkdtempSync(join(tmpdir(), 'kdbscope-sched-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'DeepCast/kdb'), { recursive: true });
writeFileSync(join(root, 'DeepCast/kdb/changelog.log'), 'x');

// A Claude project dir that matches no known project (no CODE_ROOT prefix in
// its name), so it becomes a standalone/ghost project with rootPath ''.
const claudeRoot = mkdtempSync(join(tmpdir(), 'kdbscope-sched-claude-'));
afterAll(() => rmSync(claudeRoot, { recursive: true, force: true }));
mkdirSync(join(claudeRoot, '-Users-ghost-Somewhere-Else'), { recursive: true });

function makeCatalog() {
  return {
    refreshProjectAliases: async () => 0,
    upsertProject: vi.fn(async () => 1),
    upsertProjectLocation: vi.fn(async () => {}),
  } as any;
}

describe('scheduleScans job options', () => {
  const run = async () => {
    const add = vi.fn(async () => {});
    const catalog = makeCatalog();
    const cfg = parseConfig({ CODE_ROOT: root, CLAUDE_PROJECTS_DIR: join(root, 'nope') });
    await scheduleScans(cfg, catalog, { add } as any);
    return { add, catalog };
  };

  /**
   * Regression: jobs used `removeOnComplete: 1000`. BullMQ treats add() for a
   * *retained completed* id as a silent no-op, so once a source had been
   * scanned once its deterministic id stayed reserved and every later scan of
   * it was dropped — the index quietly stopped updating.
   */
  it('releases the deterministic job id as soon as the job completes', async () => {
    const { add } = await run();
    expect(add).toHaveBeenCalled();
    for (const call of add.mock.calls) {
      const opts = (call as any)[2];
      expect(opts.removeOnComplete).toBe(true);
      expect(opts.jobId).toBeTruthy();
    }
  });

  it('still retries failures with backoff', async () => {
    const { add } = await run();
    const opts = (add.mock.calls[0] as any)[2];
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toMatchObject({ type: 'exponential' });
  });

  /**
   * The same trap, on the other exit. `removeOnComplete: true` was fixed above;
   * `removeOnFail: 500` sat on the next line and reserved the identical id for
   * the identical reason — BullMQ no-ops add() for a retained id whatever state
   * it is retained in.
   *
   * Found live on 2026-07-29: a Postgres restart on 07-26 failed one scan per
   * source ("the database system is in recovery mode"), and the 48 retained
   * failures then blocked every one of those sources from rescanning for three
   * days. Every project except deepcast — whose jobs happened not to be in
   * flight — silently stopped indexing. Nothing reported it; the scheduler kept
   * logging "140 scan jobs enqueued" a tick, and all but a handful were dropped
   * on the floor.
   *
   * A failed scan does not need retaining to be retried: the next tick is five
   * minutes away, and BullMQ has already spent its three attempts.
   */
  it('releases the job id when the job fails, not just when it completes', async () => {
    const { add } = await run();
    expect(add).toHaveBeenCalled();
    for (const call of add.mock.calls) {
      const opts = (call as any)[2];
      // Any retention count reserves the id; only true frees it.
      expect(opts.removeOnFail).toBe(true);
    }
  });

  /**
   * Legacy mode: no config/machines.yaml at the configured path, so
   * resolveSelfName falls back to 'local'. Every discovered project's
   * location and every enqueued job must carry that name.
   */
  it('writes a project_locations row and tags every job with the self machine (legacy: no machines.yaml)', async () => {
    const { add, catalog } = await run();
    expect(catalog.upsertProjectLocation).toHaveBeenCalledTimes(1);
    const loc = catalog.upsertProjectLocation.mock.calls[0]![0];
    expect(loc).toMatchObject({
      projectId: 1,
      machine: 'local',
      rootPath: join(root, 'DeepCast'),
      hasKdb: true,
    });

    expect(add).toHaveBeenCalled();
    for (const call of add.mock.calls) {
      const data = (call as any)[1];
      expect(data.machine).toBe('local');
      expect(data.isSelf).toBe(true);
    }
  });

  it('standalone/ghost projects (rootPath \'\') get no project_locations row', async () => {
    const add = vi.fn(async () => {});
    const catalog = makeCatalog();
    const cfg = parseConfig({ CODE_ROOT: root, CLAUDE_PROJECTS_DIR: claudeRoot });
    await scheduleScans(cfg, catalog, { add } as any);

    // DeepCast (discovered) + the unmatched claude dir (standalone/ghost).
    expect(catalog.upsertProject).toHaveBeenCalledTimes(2);
    // Only the discovered project (non-empty rootPath) gets a location row.
    expect(catalog.upsertProjectLocation).toHaveBeenCalledTimes(1);
    expect(catalog.upsertProjectLocation.mock.calls[0]![0]).toMatchObject({
      rootPath: join(root, 'DeepCast'),
    });
  });
});

/**
 * Multi-machine tick: sync jobs, mirror scanning, per-machine Claude
 * attribution, and the divergence check.
 *
 * `opts.mirrorRoots` / `opts.mirrorClaude` are a test seam — they default to
 * the real `mirrorRootsFor`/`mirrorClaudeDirsFor` calls, which look under
 * `/data/remote/...` (real on the indexer container, unreachable on a dev
 * Mac). Tests inject fake mirror entries that point at real temp dirs
 * instead, so discovery and Claude matching run for real against them.
 * `opts.execGit` is the same idea for the divergence check's git plumbing.
 */
describe('scheduleScans — multi-machine', () => {
  const mmRoot = mkdtempSync(join(tmpdir(), 'kdbscope-sched-mm-'));
  afterAll(() => rmSync(mmRoot, { recursive: true, force: true }));
  mkdirSync(join(mmRoot, 'DeepCast/kdb'), { recursive: true });
  writeFileSync(join(mmRoot, 'DeepCast/kdb/changelog.log'), 'x');

  const mmClaudeRoot = mkdtempSync(join(tmpdir(), 'kdbscope-sched-mm-claude-'));
  afterAll(() => rmSync(mmClaudeRoot, { recursive: true, force: true }));

  // Mirror code tree: DeepCast (same slug as self — two-location case) + a
  // mirror-only project (notes).
  const mirrorCodeRoot = mkdtempSync(join(tmpdir(), 'kdbscope-sched-mm-mirror-'));
  afterAll(() => rmSync(mirrorCodeRoot, { recursive: true, force: true }));
  mkdirSync(join(mirrorCodeRoot, 'DeepCast/kdb'), { recursive: true });
  mkdirSync(join(mirrorCodeRoot, 'notes/kdb'), { recursive: true });

  // Mirror Claude tree: one dir that matches the mirror `notes` project via
  // its remote hostPath, one that matches nothing (fallback ghost).
  const mirrorClaudeRoot = mkdtempSync(join(tmpdir(), 'kdbscope-sched-mm-mirror-claude-'));
  afterAll(() => rmSync(mirrorClaudeRoot, { recursive: true, force: true }));
  const NOTES_HOST_PATH = '/Users/serge/CODING/notes';
  mkdirSync(join(mirrorClaudeRoot, encodeClaudePath(NOTES_HOST_PATH)), { recursive: true });
  mkdirSync(join(mirrorClaudeRoot, '-Users-serge-CODING-ghostproj'), { recursive: true });

  const machinesYamlDir = mkdtempSync(join(tmpdir(), 'kdbscope-sched-mm-cfg-'));
  afterAll(() => rmSync(machinesYamlDir, { recursive: true, force: true }));
  const machinesYamlPath = join(machinesYamlDir, 'machines.yaml');
  writeFileSync(
    machinesYamlPath,
    `
machines:
  - name: selfhost
    address: 10.0.0.1
    user: serge
    codeRoots: ["${mmRoot}"]
    claudeProjects: "${mmClaudeRoot}"
    enabled: true
  - name: m4max
    address: 192.168.1.30
    user: serge
    codeRoots: ["/Users/serge/CODING"]
    claudeProjects: /Users/serge/.claude/projects
    enabled: true
  - name: macmini
    address: 192.168.1.31
    user: serge
    codeRoots: ["/Users/serge/CODING"]
    claudeProjects: /Users/serge/.claude/projects
    enabled: false
sync:
  intervalMin: 10
  excludes: []
`,
  );

  const mirrorRoots: CodeRoot[] = [
    { container: mirrorCodeRoot, host: '/Users/serge/CODING', machine: 'm4max', slugOverrides: {} },
  ];
  const mirrorClaude = [
    { machine: 'm4max', dir: mirrorClaudeRoot, encodedRoots: [encodeClaudePath('/Users/serge/CODING')] },
  ];

  /** Assigns each distinct slug its own numeric id, like a real upsert. */
  function makeCatalog() {
    const settings = new Map<string, string>();
    const slugIds = new Map<string, number>();
    let nextId = 1;
    return {
      refreshProjectAliases: async () => 0,
      upsertProject: vi.fn(async (p: { slug: string }) => {
        if (!slugIds.has(p.slug)) slugIds.set(p.slug, nextId++);
        return slugIds.get(p.slug)!;
      }),
      upsertProjectLocation: vi.fn(async () => {}),
      getSetting: vi.fn(async (k: string) => settings.get(k) ?? null),
      setSetting: vi.fn(async (k: string, v: string) => {
        settings.set(k, v);
      }),
      logError: vi.fn(async () => {}),
      slugIds,
    } as any;
  }

  function setup() {
    const add = vi.fn(async () => {});
    const catalog = makeCatalog();
    const cfg = parseConfig({
      CODE_ROOT: mmRoot,
      CLAUDE_PROJECTS_DIR: mmClaudeRoot,
      ATLAS_MACHINES_FILE: machinesYamlPath,
      ATLAS_SELF: 'selfhost',
    });
    return { add, catalog, cfg };
  }

  it('enqueues one sync job per enabled remote machine, none for a disabled one', async () => {
    const { add, catalog, cfg } = setup();
    await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots: [], mirrorClaude: [] });

    const syncCalls = add.mock.calls.filter((c: any) => c[2]?.jobId?.startsWith('sync--'));
    expect(syncCalls).toHaveLength(1);
    const [, data, opts] = syncCalls[0] as any;
    expect(opts.jobId).toBe('sync--m4max');
    expect(opts.removeOnComplete).toBe(true);
    expect(opts.removeOnFail).toBe(true);
    expect(data).toMatchObject({ sync: 'm4max' });
    expect(add.mock.calls.some((c: any) => c[2]?.jobId === 'sync--macmini')).toBe(false);
  });

  it('does not re-enqueue a sync job within the cadence interval', async () => {
    const { add, catalog, cfg } = setup();
    await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots: [], mirrorClaude: [] });
    add.mockClear();
    await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots: [], mirrorClaude: [] });
    expect(add.mock.calls.some((c: any) => c[2]?.jobId === 'sync--m4max')).toBe(false);
  });

  it('mirror project jobs carry the mirror machine, isSelf:false, and a machine-suffixed key', async () => {
    const { add, catalog, cfg } = setup();
    await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots, mirrorClaude: [] });

    const notesJobs = add.mock.calls.filter((c: any) => c[1]?.projectSlug === 'notes');
    expect(notesJobs.length).toBeGreaterThan(0);
    for (const call of notesJobs) {
      const data = (call as any)[1];
      const opts = (call as any)[2];
      expect(data.machine).toBe('m4max');
      expect(data.isSelf).toBe(false);
      expect(opts.jobId).toContain('m4max');
    }
  });

  it('writes both locations for a slug present on self and on a mirror, under one project id', async () => {
    const { add, catalog, cfg } = setup();
    await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots, mirrorClaude: [] });

    const deepcastId = catalog.slugIds.get('deepcast');
    const locs = catalog.upsertProjectLocation.mock.calls
      .map((c: any) => c[0])
      .filter((l: any) => l.projectId === deepcastId);
    expect(locs).toHaveLength(2);
    expect(locs.some((l: any) => l.machine === 'selfhost' && l.rootPath === join(mmRoot, 'DeepCast'))).toBe(true);
    expect(locs.some((l: any) => l.machine === 'm4max' && l.rootPath === join(mirrorCodeRoot, 'DeepCast'))).toBe(true);
  });

  it('a mirror claude dir matching a mirror project attributes to it, not a ghost', async () => {
    const { add, catalog, cfg } = setup();
    await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots, mirrorClaude });

    const claudeJobs = add.mock.calls.filter(
      (c: any) => c[1]?.sourceType === 'claude_session' && c[1]?.projectSlug === 'notes',
    );
    expect(claudeJobs).toHaveLength(1);
    const data = (claudeJobs[0] as any)[1];
    expect(data.machine).toBe('m4max');
    expect(data.isSelf).toBe(false);
    expect(data.claudeDirs?.[0]).toBe(join(mirrorClaudeRoot, encodeClaudePath(NOTES_HOST_PATH)));
  });

  it('an unmatched mirror claude dir falls back to a slug stripped of the mirror roots, no location row', async () => {
    const { add, catalog, cfg } = setup();
    await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots, mirrorClaude });

    expect(catalog.slugIds.has('ghostproj')).toBe(true);
    const ghostId = catalog.slugIds.get('ghostproj');
    const locs = catalog.upsertProjectLocation.mock.calls
      .map((c: any) => c[0])
      .filter((l: any) => l.projectId === ghostId);
    expect(locs).toHaveLength(0);

    const ghostJobs = add.mock.calls.filter((c: any) => c[1]?.projectSlug === 'ghostproj');
    expect(ghostJobs.length).toBeGreaterThan(0);
    expect((ghostJobs[0] as any)[1].machine).toBe('m4max');
    expect((ghostJobs[0] as any)[1].isSelf).toBe(false);
  });

  it('detects a divergent origin URL between self and mirror locations, logging once', async () => {
    const { add, catalog, cfg } = setup();
    const execGit = vi.fn(async (_args: string[], cwd: string) => {
      if (cwd === join(mmRoot, 'DeepCast')) return 'git@x:self-deepcast.git';
      if (cwd === join(mirrorCodeRoot, 'DeepCast')) return 'git@x:mirror-deepcast.git';
      return null;
    });
    await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots, mirrorClaude: [], execGit });

    expect(catalog.logError).toHaveBeenCalledTimes(1);
    const [projectId, , stage, message] = catalog.logError.mock.calls[0]!;
    expect(projectId).toBe(catalog.slugIds.get('deepcast'));
    expect(stage).toBe('divergence');
    expect(message).toContain('selfhost');
    expect(message).toContain('m4max');
  });

  it('agreeing origin URLs across locations do not log a divergence', async () => {
    const { add, catalog, cfg } = setup();
    const execGit = vi.fn(async () => 'git@x:same.git');
    await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots, mirrorClaude: [], execGit });
    expect(catalog.logError).not.toHaveBeenCalled();
  });
});
