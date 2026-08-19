import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parseConfig, encodeClaudePath } from '@atlas/core';
import type { DiscoveredProject } from '@atlas/core';
import { scanJobId, scheduleScans, attributeClaudeDirs, claudeAttribKey } from '../../packages/indexer/src/scheduler.js';
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

// Legacy mode means "no machines.yaml at the configured path" — these tests
// used to rely on the default `/config/machines.yaml` not existing on the
// test host, which is true today but not a guarantee. Pinning ATLAS_MACHINES_FILE
// to a path that provably never exists makes that hermetic.
const NO_MACHINES_FILE = join(mkdtempSync(join(tmpdir(), 'kdbscope-sched-no-mf-')), 'machines.yaml');

/**
 * A stub catalog with real bookkeeping (settings map, slug->id assignment
 * mirroring the real upsert-by-slug behaviour) rather than a bare vi.fn —
 * needed by every multi-machine test, since the sync-cadence and divergence
 * change-detection logic both round-trip through catalog.getSetting/setSetting.
 */
function makeMachineCatalog() {
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

describe('scheduleScans job options', () => {
  const run = async () => {
    const add = vi.fn(async () => {});
    const catalog = makeCatalog();
    const cfg = parseConfig({
      CODE_ROOT: root, CLAUDE_PROJECTS_DIR: join(root, 'nope'), ATLAS_MACHINES_FILE: NO_MACHINES_FILE,
    });
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
    const cfg = parseConfig({
      CODE_ROOT: root, CLAUDE_PROJECTS_DIR: claudeRoot, ATLAS_MACHINES_FILE: NO_MACHINES_FILE,
    });
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

  function setup() {
    const add = vi.fn(async () => {});
    const catalog = makeMachineCatalog();
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

  /**
   * A manual single-project rescan (opts.project) is a per-project trigger,
   * not a fleet-wide tick — it must not have the side effect of kicking off
   * syncs for every other machine, even though the cadence is due.
   */
  it('opts.project skips the sync block entirely, even when a sync is due', async () => {
    const { add, catalog, cfg } = setup();
    await scheduleScans(cfg, catalog, { add } as any, {
      mirrorRoots: [], mirrorClaude: [], project: 'deepcast',
    });
    expect(add.mock.calls.some((c: any) => c[2]?.jobId?.startsWith('sync--'))).toBe(false);
    expect(catalog.getSetting).not.toHaveBeenCalledWith('sync_enqueued:m4max');
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

  /**
   * index_errors has no pruning, and the divergence check runs every tick —
   * an unchanged divergence must be logged once, not every five minutes
   * forever, or it pins the health figure non-zero and buries real failures.
   */
  describe('divergence change-detection', () => {
    const divergent = vi.fn(async (_args: string[], cwd: string) => {
      if (cwd === join(mmRoot, 'DeepCast')) return 'git@x:self-deepcast.git';
      if (cwd === join(mirrorCodeRoot, 'DeepCast')) return 'git@x:mirror-deepcast.git';
      return null;
    });

    it('the same divergence across two ticks logs once, not twice', async () => {
      const { add, catalog, cfg } = setup();
      await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots, mirrorClaude: [], execGit: divergent });
      await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots, mirrorClaude: [], execGit: divergent });
      expect(catalog.logError).toHaveBeenCalledTimes(1);
    });

    it('a changed divergence warning logs again, with the new text', async () => {
      const { add, catalog, cfg } = setup();
      await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots, mirrorClaude: [], execGit: divergent });
      const changed = vi.fn(async (_args: string[], cwd: string) => {
        if (cwd === join(mmRoot, 'DeepCast')) return 'git@x:self-deepcast.git';
        if (cwd === join(mirrorCodeRoot, 'DeepCast')) return 'git@x:renamed-mirror-deepcast.git';
        return null;
      });
      await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots, mirrorClaude: [], execGit: changed });

      expect(catalog.logError).toHaveBeenCalledTimes(2);
      const [, , , firstMessage] = catalog.logError.mock.calls[0]!;
      const [, , , secondMessage] = catalog.logError.mock.calls[1]!;
      expect(secondMessage).not.toBe(firstMessage);
      expect(secondMessage).toContain('renamed-mirror-deepcast.git');
    });

    it('a resolved divergence logs nothing further and clears the stored flag', async () => {
      const { add, catalog, cfg } = setup();
      await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots, mirrorClaude: [], execGit: divergent });
      expect(catalog.logError).toHaveBeenCalledTimes(1);

      const agreeing = vi.fn(async () => 'git@x:same.git');
      await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots, mirrorClaude: [], execGit: agreeing });

      expect(catalog.logError).toHaveBeenCalledTimes(1); // still just the first
      const deepcastId = catalog.slugIds.get('deepcast');
      expect(catalog.setSetting).toHaveBeenCalledWith(`divergence:${deepcastId}`, '');
    });
  });
});

/**
 * Regression coverage for the bug found in review: two machines with the
 * SAME code-root layout (the common same-user case — a mirror config that
 * simply repeats the operator's own paths) produce IDENTICAL encoded
 * hostPaths for a same-slug project. Matching Claude dirs against the
 * combined self+mirror project list let the self entry (always listed first
 * in `discoverProjects`) win that tie every time, so a mirror machine's own
 * Claude dir landed in the SELF bucket — and because it shared the self
 * job's un-suffixed key, the mirror's job silently never ran: the remote
 * machine's transcripts were never indexed, with nothing in the logs to show it.
 */
describe('scheduleScans — per-machine claude attribution (identical layouts)', () => {
  const SHARED_HOST = '/Users/shared/CODING';
  const ENC_DEEPCAST = encodeClaudePath(`${SHARED_HOST}/DeepCast`);
  const ENC_LYCOS = encodeClaudePath(`${SHARED_HOST}/DeepCast/Lycos`);

  const selfRoot = mkdtempSync(join(tmpdir(), 'kdbscope-sched-idlayout-self-'));
  afterAll(() => rmSync(selfRoot, { recursive: true, force: true }));
  mkdirSync(join(selfRoot, 'DeepCast/kdb'), { recursive: true });
  mkdirSync(join(selfRoot, 'DeepCast/Lycos/kdb'), { recursive: true }); // nested/"deeper" self project

  const selfClaudeDir = mkdtempSync(join(tmpdir(), 'kdbscope-sched-idlayout-self-claude-'));
  afterAll(() => rmSync(selfClaudeDir, { recursive: true, force: true }));
  mkdirSync(join(selfClaudeDir, ENC_DEEPCAST), { recursive: true });
  mkdirSync(join(selfClaudeDir, ENC_LYCOS), { recursive: true });

  // Mirror machine, configured with the SAME host layout — its own DeepCast
  // project encodes to the exact same Claude path as self's.
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'kdbscope-sched-idlayout-mirror-'));
  afterAll(() => rmSync(mirrorRoot, { recursive: true, force: true }));
  mkdirSync(join(mirrorRoot, 'DeepCast/kdb'), { recursive: true });

  const mirrorClaudeDir = mkdtempSync(join(tmpdir(), 'kdbscope-sched-idlayout-mirror-claude-'));
  afterAll(() => rmSync(mirrorClaudeDir, { recursive: true, force: true }));
  mkdirSync(join(mirrorClaudeDir, ENC_DEEPCAST), { recursive: true }); // mirror's OWN transcript dir

  const mirrorRoots: CodeRoot[] = [
    { container: mirrorRoot, host: SHARED_HOST, machine: 'm4max', slugOverrides: {} },
  ];
  const mirrorClaude = [
    { machine: 'm4max', dir: mirrorClaudeDir, encodedRoots: [encodeClaudePath(SHARED_HOST)] },
  ];

  function setup() {
    const add = vi.fn(async () => {});
    const catalog = makeMachineCatalog();
    const cfg = parseConfig({
      CODE_ROOT: selfRoot,
      CODE_ROOT_HOST: SHARED_HOST,
      CLAUDE_PROJECTS_DIR: selfClaudeDir,
      ATLAS_MACHINES_FILE: NO_MACHINES_FILE, // resolveSelfName -> 'local'; mirrors come from opts, not a real fleet
    });
    return { add, catalog, cfg };
  }

  it('(a) a mirror Claude dir matching an identically-laid-out project attributes to the MIRROR bucket, with a distinct jobId from the self job', async () => {
    const { add, catalog, cfg } = setup();
    await scheduleScans(cfg, catalog, { add } as any, { mirrorRoots, mirrorClaude });

    const deepcastClaudeJobs = add.mock.calls.filter(
      (c: any) => c[1]?.sourceType === 'claude_session' && c[1]?.projectSlug === 'deepcast',
    );
    expect(deepcastClaudeJobs).toHaveLength(2);

    const selfJob = deepcastClaudeJobs.find((c: any) => c[1].isSelf === true)!;
    const mirrorJob = deepcastClaudeJobs.find((c: any) => c[1].isSelf === false)!;
    expect(selfJob).toBeDefined();
    expect(mirrorJob).toBeDefined();

    expect((selfJob as any)[1].machine).toBe('local');
    expect((selfJob as any)[1].claudeDirs).toEqual([join(selfClaudeDir, ENC_DEEPCAST)]);

    expect((mirrorJob as any)[1].machine).toBe('m4max');
    expect((mirrorJob as any)[1].claudeDirs).toEqual([join(mirrorClaudeDir, ENC_DEEPCAST)]);

    // The whole bug: before the fix these two shared one deterministic id.
    expect((selfJob as any)[2].jobId).not.toBe((mirrorJob as any)[2].jobId);
  });

  it('(b) self attribution is unaffected by the mirror\'s presence, including for a deeper/nested self project', async () => {
    const legacy = setup();
    await scheduleScans(legacy.cfg, legacy.catalog, { add: legacy.add } as any, {
      mirrorRoots: [], mirrorClaude: [],
    });

    const withMirror = setup();
    await scheduleScans(withMirror.cfg, withMirror.catalog, { add: withMirror.add } as any, {
      mirrorRoots, mirrorClaude,
    });

    const selfClaudeJobShape = (add: ReturnType<typeof vi.fn>) =>
      add.mock.calls
        .filter((c: any) => c[1]?.sourceType === 'claude_session' && c[1]?.isSelf === true)
        .map((c: any) => ({ projectSlug: c[1].projectSlug, claudeDirs: c[1].claudeDirs, machine: c[1].machine }))
        .sort((a: any, b: any) => a.projectSlug.localeCompare(b.projectSlug));

    const legacyShape = selfClaudeJobShape(legacy.add);
    const withMirrorShape = selfClaudeJobShape(withMirror.add);

    // Both self dirs (top-level DeepCast AND the nested/deeper DeepCast/Lycos)
    // must resolve identically whether or not a same-layout mirror is present.
    expect(legacyShape).toEqual(withMirrorShape);
    expect(legacyShape.map((j: any) => j.projectSlug)).toEqual(
      expect.arrayContaining(['deepcast', 'deepcast-lycos']),
    );
    // The mirror's own DeepCast job must never appear tagged as a self job.
    expect(withMirrorShape.every((j: any) => j.machine === 'local')).toBe(true);
  });
});

describe('attributeClaudeDirs', () => {
  function project(over: Partial<DiscoveredProject> = {}): DiscoveredProject {
    return { slug: 'deepcast', name: 'DeepCast', rootPath: '/self/DeepCast', hasKdb: true, ...over };
  }

  it('groups a matched dir under claudeAttribKey(matchedSlug, matchedMachine)', () => {
    const projects = [project({ hostPath: '/host/DeepCast' })];
    const dirPath = '/claude/-host-DeepCast';
    const { matchedByProjectSlug, standalone } = attributeClaudeDirs([dirPath], projects, []);
    expect(standalone).toEqual([]);
    expect(matchedByProjectSlug.get(claudeAttribKey('deepcast', undefined))).toEqual([dirPath]);
  });

  it('tags a self-machine match with machine:undefined and a mirror match with its machine', () => {
    const mirrorProjects = [project({ hostPath: '/host/DeepCast', machine: 'm4max' })];
    const dirPath = '/claude/-host-DeepCast';
    const { matchedByProjectSlug } = attributeClaudeDirs([dirPath], mirrorProjects, []);
    expect(matchedByProjectSlug.get(claudeAttribKey('deepcast', 'm4max'))).toEqual([dirPath]);
    expect(matchedByProjectSlug.has(claudeAttribKey('deepcast', undefined))).toBe(false);
  });

  it('an unmatched dir falls back to claudeDirFallbackSlug and tags the ghost with fallbackMachine', () => {
    const dirPath = '/claude/-Users-serge-CODING-mystery';
    const { matchedByProjectSlug, standalone } = attributeClaudeDirs(
      [dirPath], [], [encodeClaudePath('/Users/serge/CODING')], 'm4max',
    );
    expect(standalone).toEqual([{ slug: 'mystery', name: 'mystery', rootPath: '', hasKdb: false, machine: 'm4max' }]);
    expect(matchedByProjectSlug.get(claudeAttribKey('mystery', 'm4max'))).toEqual([dirPath]);
  });

  it('documents WHY callers must pre-filter: an unfiltered tie between a self and a mirror candidate resolves to whichever is listed first', () => {
    const selfP = project({ hostPath: '/shared/DeepCast' }); // machine: undefined
    const mirrorP = project({ hostPath: '/shared/DeepCast', machine: 'm4max' });
    const dirPath = '/claude/-shared-DeepCast';
    const { matchedByProjectSlug } = attributeClaudeDirs([dirPath], [selfP, mirrorP], []);
    // Self listed first -> wins the tie. This is exactly why scheduleScans
    // filters `projects` to one machine's own entries before calling here.
    expect(matchedByProjectSlug.get(claudeAttribKey('deepcast', undefined))).toEqual([dirPath]);
    expect(matchedByProjectSlug.has(claudeAttribKey('deepcast', 'm4max'))).toBe(false);
  });
});
