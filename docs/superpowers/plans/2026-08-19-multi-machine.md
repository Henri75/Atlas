# Atlas Multi-Machine Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One active Atlas instance indexes N Macs (self via bind mounts, remotes via SSH-pull rsync mirrors), with machine-independent entry identity, LAN serving behind a bearer token, and verified active-instance resolution.

**Architecture:** The indexer gains a `sync:<machine>` job that rsync-pulls each remote's code roots + `~/.claude/projects` into a `remote_mirror` volume; the existing scanners index the mirror unchanged. Entry identity moves to dedup-key v3 (project-relative paths, content-derived refs) via an in-place boot migration — no truncate, no re-embed. A resolver (CLI + stdio MCP shim) probes the closed machine set from `config/machines.yaml` and demands exactly one HMAC-proven active instance.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), Node 22, Hono, BullMQ, Postgres 18, Qdrant, zod v4, vitest (hermetic: temp dirs + stub catalog), Docker Compose. New dep: `yaml` (pin exact latest stable: `npm view yaml version`).

**Spec:** `docs/superpowers/specs/2026-08-19-multi-machine-design.md` — read it first; every task argues from it.

## Global Constraints

- `ID_SCHEME = 'v2'` and `NAMESPACE = 'kdbscope:v2'` (`packages/core/src/ids.ts:12-20`) are **FROZEN**. Never bump, never reuse the `id_scheme` settings marker — a mismatch triggers `resetDerivedData()` (TRUNCATE + collection drop, `packages/indexer/src/main.ts:77-98`). The v3 migration uses its own marker key `dedup_scheme`.
- `PROJECT_GROUPING = 'v2'` stays (spec §5 records why: remote dirs were never attributed before; self attribution unchanged).
- Advisory lock **732016** serializes the dedup migration; **732015** stays DDL-only (the API also takes it at boot, `packages/api/src/main.ts:32`).
- Machine names match `^[a-z0-9][a-z0-9-]*$` and are frozen once data exists. Mirror destinations are always under `/data/remote/<machine>/`.
- Config four-place rule: any new env var lands in `packages/core/src/config.ts` (schema + `fromEnv`), `config/atlas.defaults.env`, `test/core/configDefaults.test.ts` (or its `INTENTIONALLY_ABSENT`/`CONSUMED_BY_COMPOSE` lists), and `docker-compose.yml` when compose consumes it.
- Tests live under `test/` mirroring packages; no live services (temp dirs + stub catalog, template `test/indexer/scheduler.test.ts`). New guard tests are mutation-verified: watch them fail before trusting them.
- Every new Make target carries a `## description` (generated help; `make help-audit` must pass).
- Git: §5.1 ritual only — `git branch --show-current` first; stage **explicit paths**; `git add <paths> && git commit -m "…" -- <paths> && git rev-parse HEAD`; verify `git show --stat <hash>`; push promptly. Subject ≤ 72 chars, `tag(area): what`, 0–2 body lines, never mention Claude/Anthropic, no co-author trailer.
- Lint gate for every task: `make lint` (tsc across packages) in addition to the named tests.

## File Structure (what exists where when this plan is done)

```
config/machines.yaml                      NEW  machine SSoT (committed)
config/known_hosts                        NEW  pinned SSH host keys (committed)
packages/core/src/machines.ts             NEW  schema + loader + selfMachine
packages/core/src/identity.ts             NEW  v3 identity normalization + ordinals + DEDUP_SCHEME
packages/core/src/dedupMigration.ts       NEW  in-place key migration
packages/core/src/resolve.ts              NEW  active-instance resolver (host-side)
packages/core/src/{config,catalog,types,paths,qdrant,search,index}.ts   MOD
packages/indexer/src/sync.ts              NEW  rsync builder + sync job executor
packages/indexer/src/{scanners,scheduler,pipeline,main}.ts              MOD
packages/api/src/instance.ts              NEW  bootId/installId/state + guard
packages/api/src/auth.ts                  NEW  bearer middleware
packages/api/src/{app,main}.ts            MOD
packages/mcp/src/{main,tools}.ts          MOD  auth + machine params + instructions
packages/cli/src/{main,api}.ts            MOD  machines/connect/which/open + resolver
packages/atlas-connect/                   NEW  stdio MCP shim package
packages/ui/src/…                         MOD  badge, filter, Machines view, token prompt
docker-compose.yml, docker/node.Dockerfile, Makefile, scripts/           MOD
docs/multi-machine.md                     NEW  runbooks
docs/adr/20260819-multi-machine-one-active-instance.md                   NEW
```

---

# Phase 1 — Machine model (self-only; no behaviour change)

### Task 1: machines.yaml schema + loader

**Files:**
- Create: `packages/core/src/machines.ts`
- Create: `config/machines.yaml`
- Modify: `packages/core/src/index.ts` (export the new module)
- Modify: `packages/core/package.json` + root lockfile (add `yaml`, exact pin)
- Test: `test/core/machines.test.ts`

**Interfaces:**
- Produces: `MachineConfig`, `MachinesFile`, `machinesFileSchema`, `loadMachinesFile(path: string): MachinesFile`, `loadMachinesFileIfPresent(path: string): MachinesFile | null`, `selfMachine(mf: MachinesFile, selfName: string | undefined): MachineConfig` (throws with a named, actionable message on unset/unknown), `MIRROR_BASE = '/data/remote'`, `mirrorCodeRoot(name: string, i: number): string` (`/data/remote/<name>/code<i>`, i is 1-based), `mirrorClaudeDir(name: string): string`.

- [ ] **Step 1: Add the dependency (exact pin per version policy)**

Run: `npm view yaml version` then `npm install --save-exact yaml@<that version> -w @atlas/core`

- [ ] **Step 2: Write the failing test**

```ts
// test/core/machines.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadMachinesFile, loadMachinesFileIfPresent, selfMachine,
  mirrorCodeRoot, mirrorClaudeDir,
} from '@atlas/core';

const VALID = `
machines:
  - name: nasta-mbp
    address: 192.168.1.20
    user: nasta
    codeRoots: ["/Users/nasta/__CODING NEW"]
    claudeProjects: /Users/nasta/.claude/projects
  - name: m4max
    address: 192.168.1.30
    user: serge
    codeRoots: ["/Users/serge/CODING"]
    claudeProjects: /Users/serge/.claude/projects
    enabled: false
sync:
  intervalMin: 15
`;

function write(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'machines-'));
  const p = join(dir, 'machines.yaml');
  writeFileSync(p, content);
  return p;
}

describe('machines.yaml', () => {
  it('parses a valid file with defaults applied', () => {
    const mf = loadMachinesFile(write(VALID));
    expect(mf.machines).toHaveLength(2);
    expect(mf.machines[0]!.enabled).toBe(true);          // default
    expect(mf.machines[0]!.remoteRsyncPath).toBe('/opt/homebrew/bin/rsync');
    expect(mf.machines[0]!.slugOverrides).toEqual({});
    expect(mf.machines[1]!.enabled).toBe(false);
    expect(mf.sync.intervalMin).toBe(15);
    expect(mf.sync.excludes).toEqual([]);
  });

  it('rejects bad names, .local addresses, duplicate names', () => {
    expect(() => loadMachinesFile(write(VALID.replace('m4max', 'M4 Max')))).toThrow(/name/);
    expect(() => loadMachinesFile(write(VALID.replace('192.168.1.30', 'm4max.local')))).toThrow(/\.local/);
    expect(() => loadMachinesFile(write(VALID.replace('name: m4max', 'name: nasta-mbp')))).toThrow(/duplicate/i);
  });

  it('selfMachine resolves by name and fails loudly otherwise', () => {
    const mf = loadMachinesFile(write(VALID));
    expect(selfMachine(mf, 'm4max').user).toBe('serge');
    expect(() => selfMachine(mf, undefined)).toThrow(/ATLAS_SELF/);
    expect(() => selfMachine(mf, 'macmini')).toThrow(/macmini/);
  });

  it('absent file is legacy single-machine mode, not an error', () => {
    expect(loadMachinesFileIfPresent('/nonexistent/machines.yaml')).toBeNull();
  });

  it('mirror path helpers are fixed-shape', () => {
    expect(mirrorCodeRoot('m4max', 1)).toBe('/data/remote/m4max/code1');
    expect(mirrorClaudeDir('m4max')).toBe('/data/remote/m4max/claude');
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run test/core/machines.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement `packages/core/src/machines.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * config/machines.yaml — the committed SSoT for the machine fleet (spec §3).
 * Names are FROZEN once data exists: they appear in entries.machine, sessions,
 * and mirror paths. The file travels with the repo, so every machine sees the
 * same picture; ATLAS_SELF (per-machine .env) picks out "me".
 */

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const machineSchema = z.object({
  name: z.string().regex(NAME_RE, 'name must match [a-z0-9][a-z0-9-]*'),
  address: z.string().min(1).refine((a) => !a.endsWith('.local'), {
    message: '*.local (mDNS) does not resolve inside containers; use an IP or LAN DNS name',
  }),
  user: z.string().min(1),
  codeRoots: z.array(z.string().min(1)).min(1),
  claudeProjects: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Stock macOS /usr/bin/rsync is openrsync — never use it (spec §4). */
  remoteRsyncPath: z.string().default('/opt/homebrew/bin/rsync'),
  /** dir-basename → slug, for unrelated same-named projects (spec §5). */
  slugOverrides: z.record(z.string(), z.string()).default({}),
});

export const machinesFileSchema = z.object({
  machines: z.array(machineSchema).min(1).refine(
    (ms) => new Set(ms.map((m) => m.name)).size === ms.length,
    { message: 'duplicate machine name' },
  ),
  sync: z.object({
    intervalMin: z.number().int().min(1).default(10),
    /** ADDITIONS to the built-in list derived from the scanners' IGNORED_DIRS. */
    excludes: z.array(z.string()).default([]),
  }).default({ intervalMin: 10, excludes: [] }),
});

export type MachineConfig = z.infer<typeof machineSchema>;
export type MachinesFile = z.infer<typeof machinesFileSchema>;

export function loadMachinesFile(path: string): MachinesFile {
  return machinesFileSchema.parse(parseYaml(readFileSync(path, 'utf8')));
}

/** Absent file = legacy single-machine mode. A present-but-invalid file throws. */
export function loadMachinesFileIfPresent(path: string): MachinesFile | null {
  if (!existsSync(path)) return null;
  return loadMachinesFile(path);
}

export function selfMachine(mf: MachinesFile, selfName: string | undefined): MachineConfig {
  if (!selfName) {
    throw new Error(
      `ATLAS_SELF is not set but config/machines.yaml exists — add ATLAS_SELF=<name> ` +
      `to this machine's .env (one of: ${mf.machines.map((m) => m.name).join(', ')})`,
    );
  }
  const m = mf.machines.find((x) => x.name === selfName);
  if (!m) {
    throw new Error(
      `ATLAS_SELF=${selfName} names no machine in config/machines.yaml ` +
      `(known: ${mf.machines.map((x) => x.name).join(', ')})`,
    );
  }
  return m;
}

export const MIRROR_BASE = '/data/remote';
export function mirrorCodeRoot(name: string, i: number): string {
  return `${MIRROR_BASE}/${name}/code${i}`;
}
export function mirrorClaudeDir(name: string): string {
  return `${MIRROR_BASE}/${name}/claude`;
}
```

Export from `packages/core/src/index.ts` alongside the existing exports.

- [ ] **Step 5: Create `config/machines.yaml`** with the real current machine only (m4max is added by the runbook when its details are confirmed — DO NOT invent its paths):

```yaml
# Atlas machine fleet — committed SSoT (spec: docs/superpowers/specs/2026-08-19-multi-machine-design.md).
# Names are FROZEN once indexed. Addresses must resolve from inside containers (no *.local).
# Each running machine sets ATLAS_SELF=<name> in its gitignored .env.
machines:
  - name: nasta-mbp
    address: 127.0.0.1        # replace with this Mac's LAN IP when a second machine joins
    user: nasta
    codeRoots:
      - "/Users/nasta/__CODING NEW"
    claudeProjects: /Users/nasta/.claude/projects
sync:
  intervalMin: 10
  excludes: []
```

- [ ] **Step 6: Run tests** — `npx vitest run test/core/machines.test.ts` → PASS; `make lint` → clean.

- [ ] **Step 7: Commit (§5.1 ritual)**

```bash
git branch --show-current
git add packages/core/src/machines.ts packages/core/src/index.ts config/machines.yaml test/core/machines.test.ts packages/core/package.json package-lock.json \
  && git commit -m "feature(atlas): machines.yaml schema + loader for multi-machine fleet" -- packages/core/src/machines.ts packages/core/src/index.ts config/machines.yaml test/core/machines.test.ts packages/core/package.json package-lock.json \
  && git rev-parse HEAD
git show --stat <captured-hash>   # exactly these files
git push
```

### Task 2: Config wiring — ATLAS_SELF, machines file path, compose mount

**Files:**
- Modify: `packages/core/src/config.ts` (schema + `fromEnv`)
- Modify: `config/atlas.defaults.env`
- Modify: `docker-compose.yml` (config mount + env passthrough)
- Test: `test/core/config.test.ts` (extend), `test/core/configDefaults.test.ts` (guard lists)

**Interfaces:**
- Produces: `cfg.machinesFile: string` (default `/config/machines.yaml`), `cfg.atlasSelf?: string`. Consumers call `loadMachinesFileIfPresent(cfg.machinesFile)` + `selfMachine(mf, cfg.atlasSelf)`.

- [ ] **Step 1: Write failing tests** — in `test/core/config.test.ts` add:

```ts
it('exposes machinesFile and atlasSelf', () => {
  const cfg = parseConfig({ ATLAS_SELF: 'nasta-mbp', ATLAS_MACHINES_FILE: '/tmp/m.yaml' });
  expect(cfg.machinesFile).toBe('/tmp/m.yaml');
  expect(cfg.atlasSelf).toBe('nasta-mbp');
  expect(parseConfig({}).machinesFile).toBe('/config/machines.yaml');
  expect(parseConfig({}).atlasSelf).toBeUndefined();
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/core/config.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `config.ts` schema add:

```ts
  /** Committed machine-fleet SSoT; absent file = legacy single-machine mode. */
  machinesFile: z.string().default('/config/machines.yaml'),
  /** Which machines.yaml entry is THIS host. Required once the file exists. */
  atlasSelf: z.string().optional(),
```

and in `fromEnv`: `machinesFile: opt(env.ATLAS_MACHINES_FILE), atlasSelf: opt(env.ATLAS_SELF),`.

- [ ] **Step 4: defaults env + guard test** — in `config/atlas.defaults.env` add under a new `# Multi-machine` header:

```
# Multi-machine (spec: docs/superpowers/specs/2026-08-19-multi-machine-design.md).
# The fleet lives in config/machines.yaml (committed). ATLAS_SELF names this
# machine's entry and belongs in the per-machine .env, NOT here.
ATLAS_MACHINES_FILE=/config/machines.yaml
```

In `test/core/configDefaults.test.ts` add `ATLAS_SELF` to `INTENTIONALLY_ABSENT` (it is per-machine `.env` material, like the spec says). Run the guard test, watch it pass; then mutation-verify by temporarily removing `ATLAS_MACHINES_FILE` from the defaults file → the guard must FAIL → restore.

- [ ] **Step 5: Compose** — in `docker-compose.yml`: add to `x-node-common` `environment:` block `ATLAS_SELF: ${ATLAS_SELF:-}` and to **indexer** and **api** `volumes:` `- ./config:/config:ro`. (mcp does not read machines.yaml.)

- [ ] **Step 6: Run** `npx vitest run test/core/config.test.ts test/core/configDefaults.test.ts` → PASS; `make lint`.

- [ ] **Step 7: Commit + push (§5.1 ritual, explicit paths):** `improvement(config): ATLAS_SELF + machines file wiring, config/ mounted ro`

### Task 3: Catalog schema — machine columns, project_locations, machine_sync

**Files:**
- Modify: `packages/core/src/catalog.ts` (SCHEMA additions + accessors)
- Test: `test/core/catalogMachine.test.ts`

**Interfaces:**
- Produces (on `Catalog`): `upsertProjectLocation(loc: { projectId: number; machine: string; rootPath: string; hostPath: string; hasKdb: boolean }): Promise<void>`; `listProjectLocations(): Promise<Map<number, { machine: string; rootPath: string; hostPath: string; hasKdb: boolean }[]>>`; `backfillMachine(selfName: string): Promise<number>` (rows updated); `recordSyncStart(machine: string): Promise<void>`; `recordSyncResult(machine: string, r: { status: 'ok' | 'unreachable' | 'error'; bytes?: number; durationMs?: number; error?: string }): Promise<void>`; `listMachineSync(): Promise<{ machine: string; lastAttemptAt: string | null; lastSuccessAt: string | null; status: string; bytes: number | null; durationMs: number | null; error: string | null }[]>`.

- [ ] **Step 1: Append to `SCHEMA`** (idempotent; note the ALTER comment convention at `catalog.ts:177-178`):

```sql
-- Which machine a row was FIRST ingested from (spec §6: ingestion provenance,
-- not presence). '' means "predates the machine model"; backfillMachine()
-- rewrites it to the self machine name on the first multi-machine boot.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS machine TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS machine TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS entries_machine ON entries (machine);

-- One row per (project, machine) location. projects.root_path stays the SELF
-- machine's path (spec §5); remote locations live only here.
CREATE TABLE IF NOT EXISTS project_locations (
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  machine TEXT NOT NULL,
  root_path TEXT NOT NULL,
  host_path TEXT NOT NULL DEFAULT '',
  has_kdb BOOLEAN NOT NULL DEFAULT false,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, machine)
);

-- Per-machine sync health. status: never | ok | unreachable | error | running.
CREATE TABLE IF NOT EXISTS machine_sync (
  machine TEXT PRIMARY KEY,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'never',
  bytes BIGINT,
  duration_ms INT,
  error TEXT
);
```

- [ ] **Step 2: Write the failing test** — `test/core/catalogMachine.test.ts` follows the stub pattern of the existing catalog tests **if** they use a live pool; they do not — catalog accessors are exercised via `test/api/routes.test.ts` stubs. So test the SQL accessors the cheap house way: assert the SQL text + params through a stubbed `pool.query` (see `test/core/usageLog.test.ts` for the idiom if present; otherwise):

```ts
import { describe, expect, it, vi } from 'vitest';
import { Catalog } from '@atlas/core';

function stubbed(): { cat: Catalog; q: ReturnType<typeof vi.fn> } {
  const cat = Object.create(Catalog.prototype) as Catalog;
  const q = vi.fn().mockResolvedValue({ rows: [] });
  Object.defineProperty(cat, 'pool', { value: { query: q } });
  return { cat, q };
}

describe('machine accessors', () => {
  it('upsertProjectLocation upserts on (project_id, machine)', async () => {
    const { cat, q } = stubbed();
    await cat.upsertProjectLocation({ projectId: 3, machine: 'm4max', rootPath: '/data/remote/m4max/code1/x', hostPath: '/Users/serge/CODING/x', hasKdb: true });
    expect(q.mock.calls[0]![0]).toMatch(/ON CONFLICT \(project_id, machine\)/);
    expect(q.mock.calls[0]![1]).toEqual([3, 'm4max', '/data/remote/m4max/code1/x', '/Users/serge/CODING/x', true]);
  });
  it('backfillMachine touches only empty-machine rows', async () => {
    const { cat, q } = stubbed();
    await cat.backfillMachine('nasta-mbp');
    for (const call of q.mock.calls) expect(call[0]).toMatch(/machine = ''/);
  });
  it('recordSyncResult stamps last_success_at only on ok', async () => {
    const { cat, q } = stubbed();
    await cat.recordSyncResult('m4max', { status: 'unreachable' });
    expect(q.mock.calls[0]![0]).not.toMatch(/last_success_at = now\(\)/);
    await cat.recordSyncResult('m4max', { status: 'ok', bytes: 10, durationMs: 5 });
    expect(q.mock.calls[1]![0]).toMatch(/last_success_at = now\(\)/);
  });
});
```

- [ ] **Step 3: Verify fail, then implement the accessors** on `Catalog` (near `upsertProject`):

```ts
async upsertProjectLocation(loc: { projectId: number; machine: string; rootPath: string; hostPath: string; hasKdb: boolean }): Promise<void> {
  await this.pool.query(
    `INSERT INTO project_locations (project_id, machine, root_path, host_path, has_kdb)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (project_id, machine) DO UPDATE
       SET root_path = EXCLUDED.root_path, host_path = EXCLUDED.host_path,
           has_kdb = EXCLUDED.has_kdb, seen_at = now()`,
    [loc.projectId, loc.machine, loc.rootPath, loc.hostPath, loc.hasKdb],
  );
}

async listProjectLocations(): Promise<Map<number, { machine: string; rootPath: string; hostPath: string; hasKdb: boolean }[]>> {
  const r = await this.pool.query(
    `SELECT project_id, machine, root_path, host_path, has_kdb FROM project_locations ORDER BY machine`,
  );
  const map = new Map<number, { machine: string; rootPath: string; hostPath: string; hasKdb: boolean }[]>();
  for (const row of r.rows) {
    const list = map.get(row.project_id) ?? [];
    list.push({ machine: row.machine, rootPath: row.root_path, hostPath: row.host_path, hasKdb: row.has_kdb });
    map.set(row.project_id, list);
  }
  return map;
}

/** First multi-machine boot: stamp pre-machine rows with the self machine. */
async backfillMachine(selfName: string): Promise<number> {
  const a = await this.pool.query(`UPDATE entries SET machine = $1 WHERE machine = ''`, [selfName]);
  const b = await this.pool.query(`UPDATE sessions SET machine = $1 WHERE machine = ''`, [selfName]);
  return (a.rowCount ?? 0) + (b.rowCount ?? 0);
}

async recordSyncStart(machine: string): Promise<void> {
  await this.pool.query(
    `INSERT INTO machine_sync (machine, last_attempt_at, status) VALUES ($1, now(), 'running')
     ON CONFLICT (machine) DO UPDATE SET last_attempt_at = now(), status = 'running', error = NULL`,
    [machine],
  );
}

async recordSyncResult(machine: string, r: { status: 'ok' | 'unreachable' | 'error'; bytes?: number; durationMs?: number; error?: string }): Promise<void> {
  await this.pool.query(
    r.status === 'ok'
      ? `INSERT INTO machine_sync (machine, last_attempt_at, last_success_at, status, bytes, duration_ms)
         VALUES ($1, now(), now(), 'ok', $2, $3)
         ON CONFLICT (machine) DO UPDATE SET last_success_at = now(), status = 'ok',
           bytes = EXCLUDED.bytes, duration_ms = EXCLUDED.duration_ms, error = NULL`
      : `INSERT INTO machine_sync (machine, last_attempt_at, status, error)
         VALUES ($1, now(), $4, $5)
         ON CONFLICT (machine) DO UPDATE SET status = $4, error = $5`,
    r.status === 'ok' ? [machine, r.bytes ?? null, r.durationMs ?? null] : [machine, null, null, r.status, r.error ?? null],
  );
}
```

(Adjust the non-ok param list so `$4/$5` line up — write it as two separate query strings with their own param arrays, exactly as above.)

`listMachineSync()` is a straight `SELECT … FROM machine_sync ORDER BY machine` mapping snake_case→camelCase.

- [ ] **Step 4: Run** the new test + `make test` (nothing else may break) + `make lint`.

- [ ] **Step 5: Commit + push:** `feature(catalog): machine provenance columns, project_locations, machine_sync`

### Task 4: Machine-aware upsertProject + scheduler writes self locations

**Files:**
- Modify: `packages/core/src/catalog.ts:326-339` (`upsertProject`)
- Modify: `packages/indexer/src/scheduler.ts` (self machine + location writes)
- Modify: `packages/indexer/src/pipeline.ts:804` (the per-job upsert call site)
- Modify: `packages/indexer/src/main.ts` (resolve self name once; `backfillMachine` on boot)
- Modify: `packages/core/src/catalog.ts:1238` (`upsertSession` gains `machine`, set-on-insert-only)
- Test: `test/indexer/scheduler.test.ts` (extend), `test/core/catalogMachine.test.ts` (extend)

**Interfaces:**
- Changes: `upsertProject(p: { slug; name; rootPath; hasKdb }, opts?: { isSelf?: boolean })` — when `opts.isSelf === false` the ON CONFLICT update must NOT touch `root_path`/`has_kdb`. Default `isSelf: true` keeps every existing call site behaving exactly as today.
- Changes: `upsertSession(projectId, meta, sourcePath, machine: string)` — insert sets `machine`; conflict update keeps the existing non-empty value: `machine = CASE WHEN sessions.machine = '' THEN EXCLUDED.machine ELSE sessions.machine END`.
- Produces: `ScanJobData` gains `machine: string` (set by the scheduler; the self machine name or the remote's). `resolveSelfName(cfg): string` helper in `packages/indexer/src/scheduler.ts`: machines file present → `selfMachine(...).name`; absent → `'local'` (legacy mode label, also what `backfillMachine` receives).

- [ ] **Step 1: Failing tests.** In `test/core/catalogMachine.test.ts`:

```ts
it('upsertProject with isSelf:false leaves root_path alone', async () => {
  const { cat, q } = stubbed();
  await cat.upsertProject({ slug: 'x', name: 'x', rootPath: '/data/remote/m4max/code1/x', hasKdb: true }, { isSelf: false });
  expect(q.mock.calls[0]![0]).toMatch(/DO UPDATE SET name = EXCLUDED.name\s+RETURNING/);
});
```

In `test/indexer/scheduler.test.ts` extend the real-`scheduleScans` block: the stub catalog records `upsertProjectLocation` calls; assert every discovered project got a location row `{ machine: 'local', … }` and every enqueued job carries `machine: 'local'` (legacy mode: no machines.yaml in the temp config).

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement.** `upsertProject`:

```ts
async upsertProject(
  p: { slug: string; name: string; rootPath: string; hasKdb: boolean },
  opts: { isSelf?: boolean } = {},
): Promise<number> {
  const isSelf = opts.isSelf !== false;
  const r = await this.pool.query(
    isSelf
      ? `INSERT INTO projects (slug, name, root_path, has_kdb) VALUES ($1,$2,$3,$4)
         ON CONFLICT (slug) DO UPDATE SET root_path = EXCLUDED.root_path, has_kdb = EXCLUDED.has_kdb
         RETURNING id`
      // Remote discovery must never clobber the self machine's paths (spec §5).
      : `INSERT INTO projects (slug, name, root_path, has_kdb) VALUES ($1,$2,$3,$4)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
    [p.slug, p.name, isSelf ? p.rootPath : '', p.hasKdb],
  );
  return r.rows[0].id;
}
```

Note the INSERT half: a remote-first discovery must not plant a mirror path into `root_path` either, which is why the `isSelf:false` branch inserts `''` (exactly as written above). Scheduler: compute `const self = resolveSelfName(cfg)` once per tick; after each `catalog.upsertProject(...)` (which returns the id) call `catalog.upsertProjectLocation({ projectId: id, machine: self, rootPath: p.rootPath, hostPath: p.hostPath ?? '', hasKdb: p.hasKdb })` for discovered (non-standalone) projects; add `machine: self` to the `base` job object. In `pipeline.ts:804`, the per-job `upsertProject` call passes `{ isSelf: job.machine === selfNameFromJob }` — simplest: add `isSelf: boolean` to `ScanJobData` alongside `machine`, set by the scheduler, and pass it through. Indexer `main.ts`: after the marker block, `await catalog.backfillMachine(resolveSelfName(cfg))` (idempotent, logs the count once). `upsertSession` callers (in `pipeline.ts` scanClaude) pass `job.machine`.

- [ ] **Step 4: Run** `npx vitest run test/indexer/scheduler.test.ts test/core/catalogMachine.test.ts` then `make test`, `make lint`.

- [ ] **Step 5: Commit + push:** `feature(indexer): machine-tagged jobs, self project locations, provenance backfill`

### Task 5: API surface — /api/machines + project locations

**Files:**
- Modify: `packages/api/src/app.ts` (ApiDeps at :39-88; `/api/projects` at :529; new route)
- Modify: `packages/api/src/main.ts` (wire deps)
- Test: `test/api/routes.test.ts` (extend `makeDeps`)

**Interfaces:**
- `ApiDeps` gains: `machines: () => { fleet: MachinesFile | null; self: string }`, `listMachineSync: Catalog['listMachineSync']`, `listProjectLocations: Catalog['listProjectLocations']`.
- Produces: `GET /api/machines` → `{ self, machines: [{ name, address, user, codeRoots, claudeProjects, enabled, sync: { lastAttemptAt, lastSuccessAt, status, bytes, durationMs, error } | null }] }` (404-free; legacy mode returns `{ self: 'local', machines: [] }`). `GET /api/projects` rows gain `locations: [{ machine, hostPath, hasKdb }]` (host paths translated exactly like `rootPath` is at `app.ts:529-538`).

- [ ] **Step 1: Failing route tests** (house idiom — `buildApp(makeDeps(overrides))`):

```ts
it('GET /api/machines merges config and sync state', async () => {
  const app = buildApp(makeDeps({
    machines: () => ({ fleet: { machines: [{ name: 'nasta-mbp', address: '127.0.0.1', user: 'nasta', codeRoots: ['/x'], claudeProjects: '/y', enabled: true, remoteRsyncPath: '/opt/homebrew/bin/rsync', slugOverrides: {} }], sync: { intervalMin: 10, excludes: [] } }, self: 'nasta-mbp' }),
    listMachineSync: async () => [{ machine: 'nasta-mbp', lastAttemptAt: null, lastSuccessAt: null, status: 'never', bytes: null, durationMs: null, error: null }],
  }));
  const r = await app.request('/api/machines');
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.self).toBe('nasta-mbp');
  expect(body.machines[0].sync.status).toBe('never');
});
it('GET /api/projects carries locations', async () => { /* stub listProjectLocations, assert shape */ });
```

- [ ] **Step 2–4: Implement route + wiring, run tests, lint.** The route joins `machines()` and `listMachineSync()` by name.

- [ ] **Step 5: Commit + push:** `feature(api): /api/machines and per-project locations`

---

# Phase 2 — Identity v3 + migration (riskiest; land while nothing else is new)

### Task 6: identity.ts — normalization + occurrence ordinals + dedupKey v3

**Files:**
- Create: `packages/core/src/identity.ts`
- Modify: `packages/core/src/types.ts` (Entry gains `identity?`)
- Modify: `packages/core/src/catalog.ts:994-1002` (`dedupKey`)
- Modify: `packages/core/src/index.ts` (exports)
- Test: `test/core/identity.test.ts`, `test/core/dedupKey.test.ts` (extend, keep old cases passing via the fallback)

**Interfaces:**
- `Entry` gains `identity?: { scope: string; path: string; ref: string }`.
- Produces: `DEDUP_SCHEME = 'v3'`; `applyIdentity(entries: Entry[], ctx: { rootPath?: string; claudeDirName?: string }): void` (sets `identity` per spec §6 table); `assignOccurrenceOrdinals(entries: Entry[]): void` (for entries whose `sourceRef` matches `/^line:\d+$/`, sets `identity.ref = 'occ:<k>'`, k = 1-based occurrence of `(title, contentHash(body))` in array order — call AFTER `applyIdentity`); `identityFromStored(row: { source_type: string; source_path: string; source_ref: string | null; title: string; body: string }, projectSlug: string, roots: string[], claudeDirs: string[]): { scope: string; path: string; ref: string }` (the migration-side twin — MUST agree with `applyIdentity`; the agreement test is the crux).
- Changes: `Catalog.dedupKey(e)` becomes:

```ts
static dedupKey(e: Entry): string {
  // v3 (spec §6): machine-independent identity when the pipeline provided one;
  // the legacy-shaped fallback IS the spec's conservative no-known-root rule.
  const id = e.identity ?? { scope: e.projectSlug, path: e.sourcePath, ref: e.sourceRef ?? '' };
  return deterministicUuid(id.scope, id.path, id.ref, e.title, contentHash(e.body));
}
```

- [ ] **Step 1: Failing tests** — `test/core/identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Catalog, applyIdentity, assignOccurrenceOrdinals, identityFromStored } from '@atlas/core';
import { parseChangelog } from '@atlas/core';   // exported via parsers barrel; check index.ts

const CTX = { projectSlug: 'kdb', sourcePath: '/data/code/kdb/kdb/changelog.log' };

describe('v3 identity', () => {
  it('kdb lines: same content at different paths/lines → same key (cross-machine dedup)', () => {
    const line = '- [DONE] - [2026-08-01 10:00 UTC] - [Fix] - [core] - [thing happened]';
    const a = parseChangelog(`${line}\n`, CTX);
    const b = parseChangelog(`- [DONE] - [2026-07-01] - [Other] - [x] - [padding]\n${line}\n`,
      { ...CTX, sourcePath: '/data/remote/m4max/code1/kdb/kdb/changelog.log' });
    applyIdentity(a, { rootPath: '/data/code/kdb' });
    applyIdentity(b, { rootPath: '/data/remote/m4max/code1/kdb' });
    assignOccurrenceOrdinals(a); assignOccurrenceOrdinals(b);
    expect(Catalog.dedupKey(a[0]!)).toBe(Catalog.dedupKey(b[1]!));   // same line, shifted position
    expect(Catalog.dedupKey(b[0]!)).not.toBe(Catalog.dedupKey(b[1]!));
  });

  it('identical lines get distinct ordinals, stable under reordering', () => {
    const dup = '- [INFO] - [2026-08-01] - [Note] - [x] - [same text]';
    const es = parseChangelog(`${dup}\n${dup}\n`, CTX);
    applyIdentity(es, { rootPath: '/data/code/kdb' });
    assignOccurrenceOrdinals(es);
    expect(es[0]!.identity!.ref).toBe('occ:1');
    expect(es[1]!.identity!.ref).toBe('occ:2');
  });

  it('claude entries: scope is "claude", slug-independent', () => {
    const e = { projectSlug: 'ghost-users-nasta-kdb', sourceType: 'claude_session' as const, title: 't', body: 'b',
      sourcePath: '/data/remote/m4max/claude/-Users-nasta---CODING-NEW-kdb/abc.jsonl' };
    const f = { ...e, projectSlug: 'kdb', sourcePath: '/data/claude/projects/-Users-nasta---CODING-NEW-kdb/abc.jsonl' };
    applyIdentity([e], { claudeDirName: '-Users-nasta---CODING-NEW-kdb' });
    applyIdentity([f], { claudeDirName: '-Users-nasta---CODING-NEW-kdb' });
    expect(Catalog.dedupKey(e)).toBe(Catalog.dedupKey(f));   // Migration-Assistant copy dedups
  });

  it('git: scope keeps the slug — same sha in two projects stays distinct', () => {
    const mk = (slug: string) => ({ projectSlug: slug, sourceType: 'git_commit' as const, title: 'init', body: 'init',
      sourcePath: `/data/code/${slug}`, sourceRef: 'abc123' });
    const [a, b] = [mk('fork-a'), mk('fork-b')];
    applyIdentity([a], { rootPath: '/data/code/fork-a' });
    applyIdentity([b], { rootPath: '/data/code/fork-b' });
    expect(Catalog.dedupKey(a)).not.toBe(Catalog.dedupKey(b));
  });

  it('no known root → stored-path fallback, never a throw', () => {
    const e = { projectSlug: 'x', sourceType: 'doc' as const, title: 't', body: 'b', sourcePath: '/weird/path.md' };
    applyIdentity([e], { rootPath: '/data/code/other' });
    expect(e.identity!.path).toBe('/weird/path.md');
  });

  it('identityFromStored agrees with applyIdentity on every source type', () => {
    // Build one entry per source type via the live path, then feed the same
    // fields through identityFromStored and assert identical identity triples.
  });
});
```

(Fill the last test with the four concrete cases — kdb line, doc with `sourceRef: '#anchor'`, git commit, claude entry — asserting `identityFromStored(...)` deep-equals `entry.identity`.)

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement `identity.ts`:**

```ts
import { basename } from 'node:path';
import type { Entry } from './types.js';
import { contentHash } from './ids.js';

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
    const k = `${e.identity.path}${e.title}${contentHash(e.body)}`;
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    e.identity.ref = `occ:${n}`;
  }
}
```

`identityFromStored(row, projectSlug, roots, claudeDirs)` mirrors the two branches from stored columns: `source_type === 'claude_session'` → strip any of `claudeDirs` prefixes to recover `<dir>/<file>` (fallback: last two path segments); else try each root in `roots` (longest first) for `relativeTo`; line refs are handled by the migration's grouping pass (Task 9), so here return the raw ref. Export `contentHash` from `ids.ts` if not already exported (check `index.ts`).

- [ ] **Step 4: Run** identity + dedupKey tests, then `make test` (the existing `dedupKey.test.ts` cases still pass — entries without `identity` use the legacy-shaped fallback, so nothing else in the suite moves), `make lint`.

- [ ] **Step 5: Commit + push:** `feature(core): dedup v3 identity — path-normalized, ordinal line refs`

### Task 7: Pipeline applies identity at scan time

**Files:**
- Modify: `packages/indexer/src/pipeline.ts` (`scanKdb`, `scanClaude`, `scanGit`, `scanDocs` — right after each parser call, before `insertEntries`)
- Test: `test/indexer/pipelineIdentity.test.ts`

**Interfaces:**
- Consumes: `applyIdentity`, `assignOccurrenceOrdinals` from `@atlas/core`; `job.rootPath`; scanClaude's per-dir loop knows the dir name.
- Invariant: every entry inserted by the pipeline carries `identity`. Add a dev assertion in `insertEntries`? No — `dedupKey`'s fallback is the spec's escape hatch; instead the test asserts the four scan paths set it.

- [ ] **Step 1: Failing test** — build a temp project (changelog + docs + a real `git init` repo + a fake claude dir with one JSONL line), run `processScanJob` per source with a stub catalog capturing `insertEntries` args (idiom: `test/indexer/pipeline.test.ts`), assert `entries.every((e) => e.identity)` and that a kdb line entry has `identity.ref` matching `/^occ:\d+$/` while its `sourceRef` still matches `/^line:\d+$/` (deep links keep lines — spec §6). Add the **rsync-shrink** case here too (spec §11): scan the claude JSONL once, truncate the file to a shorter valid prefix, scan again — the stored offset resets and the scan neither throws nor duplicates (the guard already lives at `scanClaude`, `pipeline.ts:278`; this test pins it against the mirror-rewrite scenario).

- [ ] **Step 2: Verify fail. Step 3: Implement** — in `scanKdb` after `parse*`: `applyIdentity(entries, { rootPath: job.rootPath }); assignOccurrenceOrdinals(entries);` (ordinals are per-file: call per parsed file, which is how scanKdb iterates anyway). In `scanDocs` and `scanGit`: `applyIdentity(entries, { rootPath: job.rootPath })`. In `scanClaude`: `applyIdentity(entries, { claudeDirName: basename(dir) })`.

- [ ] **Step 4: Run + `make test` + lint. Step 5: Commit + push:** `feature(indexer): scan-time v3 identity on all four sources`

### Task 8: scanGit watermark-wedge fix

**Files:**
- Modify: `packages/indexer/src/pipeline.ts:332-345`
- Test: `test/indexer/gitWatermark.test.ts`

**Interfaces:** none new — behaviour: an invalid stored ref logs to `index_errors` and falls back to `git log HEAD -n 5000`, and the watermark then advances normally.

- [ ] **Step 1: Failing test** — temp dir, real git repo (`git init`, config user, one commit), stub catalog whose `getScanState` returns `{ ref: 'deadbeef'.repeat(5), … }`; run `processScanJob` for `git_commit`; assert: `logError` called once with a message matching `/watermark/i`, `insertEntries` received the commit, `setScanState` called with the real HEAD sha. Mutation-verify: comment out the fallback → test fails.

- [ ] **Step 2: Verify fail. Step 3: Implement** — replace the catch in `scanGit`:

```ts
} catch (e) {
  const msg = (e as Error).message;
  const benign = /does not have any commits|unknown revision|bad revision/i.test(msg);
  if (!benign) {
    await deps.catalog.logError(projectId, job.rootPath, 'git-log', msg);
    return 0;
  }
  if (!state?.ref) return 0; // genuinely empty repo — unchanged behaviour
  // Stored watermark no longer resolves (remote force-push/rebase + gc — spec §4).
  // Silent-swallow here wedged the repo FOREVER: never logged, never reset.
  await deps.catalog.logError(projectId, job.rootPath, 'git-log',
    `watermark ${state.ref} invalid (force-push/gc?); falling back to bounded full log: ${msg}`);
  try {
    const r = await execFileAsync(
      'git',
      ['-c', 'safe.directory=*', 'log', 'HEAD', '--name-status', `--pretty=format:${GIT_LOG_FORMAT}`, '-n', '5000'],
      { cwd: job.rootPath, maxBuffer: 64 * 1024 * 1024 },
    );
    stdout = r.stdout; // dedup keys absorb the overlap with already-indexed commits
  } catch (e2) {
    await deps.catalog.logError(projectId, job.rootPath, 'git-log', (e2 as Error).message);
    return 0;
  }
}
```

- [ ] **Step 4: Run + mutation-verify + `make test` + lint. Step 5: Commit + push:** `bugfix(indexer): invalid git watermark now logs and self-heals — silent forever-wedge after remote force-push+gc`

### Task 9: The migration — dedupMigration.ts + boot wiring

**Files:**
- Create: `packages/core/src/dedupMigration.ts`
- Modify: `packages/core/src/qdrant.ts` (add `deleteByEntryIds`)
- Modify: `packages/indexer/src/main.ts` (run after the marker block, before worker/cron)
- Modify: `packages/core/src/index.ts`
- Test: `test/core/dedupMigration.test.ts`

**Interfaces:**
- Produces: `runDedupMigration(catalog: Catalog, vectors: { deleteByEntryIds(ids: number[]): Promise<void> } | null, opts?: { batchSize?: number; log?: (s: string) => void }): Promise<{ scanned: number; rekeyed: number; collisions: number; ordinalGroups: number }>` — idempotent and resumable (cursor in settings key `dedup_cursor`); takes `pg_advisory_lock(732016)` for its whole run; returns without work when `settings.dedup_scheme === 'v3'`; stamps the marker itself on success.
- Produces (VectorStore): `deleteByEntryIds(entryIds: number[]): Promise<void>` — points delete by filter `{ must: [{ key: 'entry_id', match: { any: entryIds } }] }`.

- [ ] **Step 1: Failing tests** — stubbed-pool Catalog is too coarse here; instead test the pure planner. Split the module: `planRekey(rows, projectsById, claudeDirs)` (pure) and the executor. Test the planner:

```ts
// rows: as SELECTed. projectsById: Map<number, { slug, rootPath }>.
it('groups line-ref rows per file and assigns ordinals by line order', () => {
  const rows = [
    row(1, 'kdb_changelog', '/data/code/kdb/kdb/changelog.log', 'line:12', 'T', 'same'),
    row(2, 'kdb_changelog', '/data/code/kdb/kdb/changelog.log', 'line:5',  'T', 'same'),
  ];
  const plan = planRekey(rows, projects, []);
  // line:5 is occurrence 1, line:12 occurrence 2 — ordered by parsed line, id tiebreak
  expect(plan.get(2)!.ref).toBe('occ:1');
  expect(plan.get(1)!.ref).toBe('occ:2');
});
it('non-line rows rekey row-wise; unmatched paths keep stored path', () => { /* git sha kept; /weird/x.md stays absolute */ });
it('identical normalized identity + same content → collision marked, lowest id survives', () => { /* two rows, same everything → plan lists loser id 2 for deletion */ });
```

- [ ] **Step 2: Verify fail. Step 3: Implement.** Executor skeleton (batch loop):

```ts
export async function runDedupMigration(catalog, vectors, opts = {}) {
  const batch = opts.batchSize ?? 2000;
  const log = opts.log ?? console.log;
  if ((await catalog.getSetting('dedup_scheme')) === DEDUP_SCHEME) return ZERO;
  const client = await catalog.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(732016)');
    const projectsById = await loadProjects(client);            // id → { slug, rootPath }
    const claudeDirs = ['/data/claude/projects'];               // + mirror claude dirs later; harmless now
    const stats = { scanned: 0, rekeyed: 0, collisions: 0, ordinalGroups: 0 };
    // cursorPair: '' → [0, '']; else JSON.parse. Written next to the loop.
    // Cursor = the last processed (project_id, source_path) pair, JSON in the
    // 'dedup_cursor' setting. Whole FILES at a time, so ordinal groups are
    // never split across batches.
    let [curProject, curPath] = cursorPair(await catalog.getSetting('dedup_cursor'));
    for (;;) {
      const files = await client.query(
        `SELECT DISTINCT project_id, source_path FROM entries
         WHERE (project_id, source_path) > ($1, $2)
         ORDER BY project_id, source_path LIMIT $3`,
        [curProject, curPath, batch],
      );
      if (!files.rows.length) break;
      for (const f of files.rows) {
        const rows = await client.query(
          `SELECT id, project_id, source_type, source_path, source_ref, title, body, dedup_key
           FROM entries WHERE project_id = $1 AND source_path = $2 ORDER BY id`, [f.project_id, f.source_path]);
        const plan = planRekey(rows.rows, projectsById, claudeDirs);
        await applyPlan(client, vectors, plan, stats);           // per-file transaction
        stats.scanned += rows.rows.length;
      }
      const last = files.rows.at(-1)!;
      [curProject, curPath] = [last.project_id, last.source_path];
      await catalog.setSetting('dedup_cursor', JSON.stringify([curProject, curPath]));
      log(`[dedup-v3] ${stats.scanned} scanned, ${stats.rekeyed} rekeyed, ${stats.collisions} collisions`);
    }
    await catalog.setSetting('dedup_scheme', DEDUP_SCHEME);
    await catalog.setSetting('dedup_cursor', '');
    return stats;
  } finally {
    await client.query('SELECT pg_advisory_unlock(732016)').catch(() => {});
    client.release();
  }
}
```

`applyPlan` per row: `UPDATE entries SET dedup_key = $1 WHERE id = $2`; on `unique_violation` (code 23505): the key's holder is `SELECT id FROM entries WHERE dedup_key = $1`; keep the **lower** id — delete the loser's Qdrant points FIRST (`vectors?.deleteByEntryIds([loserId])`, spec §6.4: PG-first crash re-converges, the reverse orphans points), then `DELETE FROM entries WHERE id = $loser`; if the loser was the holder, retry the UPDATE. Count `stats.collisions`. Ordinal groups > 1 increment `stats.ordinalGroups`. `planRekey` computes per-row `{ scope, path, ref, newKey }` using `identityFromStored` + per-file ordinal grouping for `line:` refs (rank ordered by parsed line number, id tiebreak — spec §6.3).

Boot wiring in `packages/indexer/src/main.ts`, immediately after the `MARKERS` block and `backfillMachine`, before `createEmbedder`:

```ts
// v3 key migration (spec §6): own marker, own lock, runs to completion before
// any scanning. An empty catalog just gets stamped.
if ((await catalog.getSetting('dedup_scheme')) !== DEDUP_SCHEME) {
  if (!hadEntries) {
    await catalog.setSetting('dedup_scheme', DEDUP_SCHEME);
  } else {
    console.log('[indexer] dedup key migration v3 starting (in place; no re-embed)');
    const s = await runDedupMigration(catalog, vectorsForMigration /* VectorStore for the ACTIVE collection, from settings.active_collection — null when unset */);
    console.log(`[indexer] dedup v3 done: ${JSON.stringify(s)}`);
  }
}
```

- [ ] **Step 4: Run tests + `make test` + lint. Step 5: Commit + push:** `feature(core): in-place dedup v3 migration — own marker, lock 732016, Qdrant-first collision deletes`

### Task 10: db-dump target + rehearsal script

**Files:**
- Modify: `Makefile`
- Create: `scripts/dedup_rehearsal.sh`
- Test: `make help-audit` (existing guard) + a dry run

**Interfaces:** `make db-dump` → `backups/kdbscope-<UTC stamp>.dump` via `docker compose exec postgres pg_dump -U kdbscope -Fc kdbscope`. `make dedup-rehearsal` → runs the script.

- [ ] **Step 1: Add targets** (descriptions are load-bearing — generated help):

```make
db-dump: ## Dump the catalog to backups/ (custom format). Run BEFORE the dedup-v3 migration.
	@mkdir -p backups
	$(COMPOSE) exec -T postgres pg_dump -U kdbscope -Fc kdbscope > backups/kdbscope-$$(date -u +%Y%m%d-%H%M%S).dump
	@ls -lh backups/ | tail -1

dedup-rehearsal: ## Rehearse the dedup-v3 migration against a COPY of the live DB. Read-only w.r.t. the real catalog; prints the verification report.
	bash scripts/dedup_rehearsal.sh
```

- [ ] **Step 2: Write `scripts/dedup_rehearsal.sh`** — spins a throwaway `postgres:18.4` container on a free port, restores the newest `backups/*.dump`, runs `node` with a small driver that calls `runDedupMigration` against it (`DATABASE_URL` pointed at the scratch container, `vectors: null` — vector deletes are only counted, not executed, in rehearsal: pass a counting stub and PRINT what would be deleted), prints `{ scanned, rekeyed, collisions, ordinalGroups }` plus the collision row ids, then destroys the container. ~40 lines; `set -euo pipefail`; the driver script lives inline via `node --input-type=module -e`.

- [ ] **Step 3: Run** `make help-audit` (must pass — mutation-verify once by deleting a `##` description, watch it fail, restore) and `make db-dump && make dedup-rehearsal` against the live stack. **The rehearsal report gates Phase 2 rollout** — eyeball collisions and ordinal groups before restarting the indexer with the new code.

- [ ] **Step 4: Commit + push:** `feature(ops): db-dump + dedup-v3 rehearsal harness`

---

# Phase 3 — Sync engine + mirror indexing

### Task 11: rsync command builder + destination guard

**Files:**
- Modify: `packages/indexer/src/scanners.ts` (export `IGNORED_DIRS` as `SCANNER_IGNORED_DIRS: readonly string[]`)
- Create: `packages/indexer/src/sync.ts` (builder half)
- Test: `test/indexer/syncArgs.test.ts`

**Interfaces:**
- Produces: `buildSyncExcludes(extra: string[]): string[]` — `SCANNER_IGNORED_DIRS` + `['.git/*.lock', '.git/index.lock', '.git/objects/tmp_*', '.git/gc.pid', '.rsync-partial', '.env*']` + `extra`; `assertMirrorDest(dest: string, machine: string): void` (throws unless `dest` starts with `/data/remote/<machine>/` and machine matches `^[a-z0-9][a-z0-9-]*$`); `buildRsyncArgs(m: MachineConfig, job: { remotePath: string; dest: string; kind: 'code' | 'claude' }, excludes: string[]): string[]`.

- [ ] **Step 1: Failing tests:**

```ts
import { describe, expect, it } from 'vitest';
import { buildRsyncArgs, buildSyncExcludes, assertMirrorDest } from '../../packages/indexer/src/sync.js';

const M = { name: 'm4max', address: '192.168.1.30', user: 'serge', codeRoots: ['/Users/serge/CODING'],
  claudeProjects: '/Users/serge/.claude/projects', enabled: true,
  remoteRsyncPath: '/opt/homebrew/bin/rsync', slugOverrides: {} };

describe('rsync args', () => {
  it('code sync: partial-dir not bare --partial; delete; excludes derived from scanners', () => {
    const args = buildRsyncArgs(M, { remotePath: '/Users/serge/CODING', dest: '/data/remote/m4max/code1', kind: 'code' }, buildSyncExcludes([]));
    expect(args).toContain('--partial-dir=.rsync-partial');
    expect(args).not.toContain('--partial');
    expect(args).toContain('--delete');
    expect(args).toContain('--rsync-path=/opt/homebrew/bin/rsync');
    expect(args.some((a) => a === '--exclude=node_modules')).toBe(true);
    expect(args.some((a) => a === '--exclude=.env*')).toBe(true);
    expect(args.some((a) => a === '--exclude=data')).toBe(true);       // scanner parity
    expect(args.at(-2)).toBe('serge@192.168.1.30:/Users/serge/CODING/');
    expect(args.at(-1)).toBe('/data/remote/m4max/code1/');
  });
  it('claude sync: jsonl include-filter, no code excludes needed', () => {
    const args = buildRsyncArgs(M, { remotePath: M.claudeProjects, dest: '/data/remote/m4max/claude', kind: 'claude' }, []);
    const i = args.indexOf('--include=*/');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('--include=*.jsonl');
    expect(args[i + 2]).toBe('--exclude=*');
  });
  it('destination guard refuses escapes', () => {
    expect(() => assertMirrorDest('/data/remote/m4max/code1', 'm4max')).not.toThrow();
    expect(() => assertMirrorDest('/data/code', 'm4max')).toThrow();
    expect(() => assertMirrorDest('/data/remote/other/code1', 'm4max')).toThrow();
    expect(() => assertMirrorDest('/data/remote/../code', 'm4max')).toThrow();
    expect(() => assertMirrorDest('/data/remote/M4 Max/code1', 'M4 Max')).toThrow();
  });
});
```

- [ ] **Step 2: Verify fail. Step 3: Implement** (`sync.ts`, builder half):

```ts
import type { MachineConfig } from '@atlas/core';
import { SCANNER_IGNORED_DIRS } from './scanners.js';

/** rsync must never write outside its machine's mirror (spec §4 safety rails). */
export function assertMirrorDest(dest: string, machine: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(machine)) throw new Error(`invalid machine name: ${machine}`);
  const prefix = `/data/remote/${machine}/`;
  if (!dest.startsWith(prefix) || dest.includes('..')) {
    throw new Error(`sync destination ${dest} escapes ${prefix}`);
  }
}

/** Kept in lockstep with the scanners: what they ignore, we never transfer. */
export function buildSyncExcludes(extra: string[]): string[] {
  return [
    ...SCANNER_IGNORED_DIRS,
    // git transient state — a remote git op mid-sync must not plant locks/tmp
    // objects in the mirror (spec §4); mirror git also runs GIT_OPTIONAL_LOCKS=0.
    '.git/*.lock', '.git/index.lock', '.git/objects/tmp_*', '.git/gc.pid',
    '.rsync-partial',
    '.env*', // secrets never enter the mirror; no scanner reads them
    ...extra,
  ];
}

export function buildRsyncArgs(
  m: MachineConfig,
  job: { remotePath: string; dest: string; kind: 'code' | 'claude' },
  excludes: string[],
): string[] {
  assertMirrorDest(job.dest, m.name);
  const ssh = `ssh -i /keys/atlas_sync -o UserKnownHostsFile=/config/known_hosts -o BatchMode=yes -o ConnectTimeout=10`;
  const args = [
    '-a', '--delete', '--partial-dir=.rsync-partial', '--timeout=120',
    `--rsync-path=${m.remoteRsyncPath}`,
    '-e', ssh,
  ];
  if (job.kind === 'claude') {
    // Only what listSessionFiles reads (spec §4) — keep in lockstep with scanners.listSessionFiles.
    args.push('--include=*/', '--include=*.jsonl', '--exclude=*');
  } else {
    for (const x of excludes) args.push(`--exclude=${x}`);
  }
  args.push(`${m.user}@${m.address}:${job.remotePath.replace(/\/$/, '')}/`, `${job.dest.replace(/\/$/, '')}/`);
  return args;
}
```

In `scanners.ts`: `export const SCANNER_IGNORED_DIRS = [...IGNORED_DIRS] as readonly string[];` (keep the Set private for lookups).

- [ ] **Step 4: Run + lint. Step 5: Commit + push:** `feature(indexer): rsync builder — scanner-derived excludes, guarded destinations`

### Task 12: Sync job executor

**Files:**
- Modify: `packages/indexer/src/sync.ts` (executor half)
- Test: `test/indexer/syncMachine.test.ts`

**Interfaces:**
- Produces: `type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: string }>`; `syncMachine(deps: { catalog: Pick<Catalog, 'recordSyncStart' | 'recordSyncResult'>; exec?: Exec; mkdirp?: (p: string) => void }, m: MachineConfig, sync: { excludes: string[] }): Promise<'ok' | 'unreachable' | 'error'>`.
- Behaviour: `recordSyncStart` → preflight `ssh … <user>@<address> true` (BatchMode, ConnectTimeout 5) → on failure `recordSyncResult('unreachable')`, return (no error rows — an asleep Mac is expected, spec §10) → else mkdir each dest, run rsync per codeRoot (`code1..codeN`) then claude; sum transferred bytes (parse rsync `--stats` output's "Total transferred file size"); any rsync failure → `recordSyncResult('error', { error })` and return `'error'` (the next tick retries; per-file atomicity means a half sync is safe).

- [ ] **Step 1: Failing tests** — stub `exec`:

```ts
it('asleep machine → unreachable status, zero rsync invocations, no throw', async () => {
  const calls: string[][] = [];
  const exec = vi.fn(async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === 'ssh') throw new Error('Connection refused');
    return { stdout: '' };
  });
  const catalog = { recordSyncStart: vi.fn(), recordSyncResult: vi.fn() };
  const out = await syncMachine({ catalog, exec, mkdirp: () => {} }, M, { excludes: [] });
  expect(out).toBe('unreachable');
  expect(calls.filter((c) => c[0] === 'rsync')).toHaveLength(0);
  expect(catalog.recordSyncResult).toHaveBeenCalledWith('m4max', expect.objectContaining({ status: 'unreachable' }));
});
it('happy path: one rsync per code root + one for claude, ok recorded with stats', async () => { /* exec ok, stdout carries "Total transferred file size: 1,234 bytes" */ });
it('rsync failure records error and stops', async () => { /* second rsync throws */ });
```

- [ ] **Step 2–3: Verify fail; implement.** Add `--stats` to `buildRsyncArgs` output (harmless in tests). `mkdirp` defaults to `mkdirSync(p, { recursive: true })`. `exec` defaults to a `execFile` promisify with `GIT_OPTIONAL_LOCKS: '0'` irrelevant here (that's scan-side); timeout via the exec opts.

- [ ] **Step 4: Run + lint. Step 5: Commit + push:** `feature(indexer): syncMachine — preflight, per-root rsync, machine_sync recording`

### Task 13: Mirror discovery + machine-aware Claude matching (pure parts)

**Files:**
- Modify: `packages/indexer/src/scanners.ts` (`CodeRoot` gains `machine?`, `slugOverrides?`; `discoverProjects` applies overrides + tags machine)
- Create: `packages/indexer/src/mirror.ts`
- Test: `test/indexer/mirrorDiscovery.test.ts`

**Interfaces:**
- `CodeRoot` gains `machine?: string; slugOverrides?: Record<string, string>`. `DiscoveredProject` gains `machine?: string` (`@atlas/core` type; optional so nothing else breaks; absent = self).
- `discoverProjects` change: slug = `slugOverrides[name] ?? slugify(name)` (top-level dirs only); `seen` dedup becomes **per (slug, machine)** — same slug on two machines is the same project discovered twice (both kept, each with its own machine tag; the scheduler upserts one `projects` row + two locations); same slug twice on ONE machine keeps first-wins but now logs a warning line naming both paths (spec §5).
- Produces (`mirror.ts`): `mirrorRootsFor(mf: MachinesFile, selfName: string): CodeRoot[]` — for each enabled non-self machine `m` and each `m.codeRoots[i]` that **exists on disk** (`existsSync(mirrorCodeRoot(m.name, i+1))` — a mirror that has never synced is silently skipped, which is the spec §5 ordering constraint enforced structurally): `{ container: mirrorCodeRoot(m.name, i+1), host: m.codeRoots[i], machine: m.name, slugOverrides: m.slugOverrides }`; `mirrorClaudeDirsFor(mf, selfName): { machine: string; dir: string; encodedRoots: string[] }[]` (dir existence-checked the same way; `encodedRoots` = that machine's `codeRoots.map(encodeClaudePath)`).

- [ ] **Step 1: Failing tests** — temp tree building `/tmp/…/data/remote/m4max/code1/ProjX/{kdb,.git}` etc.; assert: mirror project discovered with `machine: 'm4max'`, `hostPath: '/Users/serge/CODING/ProjX'`; slug override applied; non-existent mirror root yields `[]`; same-slug-two-machines yields two DiscoveredProjects with different machines; same-slug-one-machine warns once (spy on `console.warn`).

- [ ] **Step 2–3: Verify fail; implement.** (`mirrorRootsFor` takes an `exists` injection defaulting to `existsSync`, same test-injection idiom as Task 12.)

- [ ] **Step 4: Run + `make test` (scanners tests must stay green) + lint. Step 5: Commit + push:** `feature(indexer): mirror roots + machine-tagged discovery with slug overrides`

### Task 14: Scheduler tick — sync jobs + mirror scanning + per-machine Claude attribution

**Files:**
- Modify: `packages/indexer/src/scheduler.ts` (the tick), `packages/indexer/src/pipeline.ts` (`ScanJobData.machine/isSelf` already exist from Task 4), `packages/indexer/src/main.ts` (worker dispatch for the new job kind)
- Test: `test/indexer/scheduler.test.ts` (extend)

**Interfaces:**
- `ScanJobData` gains nothing new. New queue job kind `{ sync: string }` (machine name) with job id `sync--<machine>`, `removeOnComplete/removeOnFail: true` (the Task-force of `scheduler.ts:98-110` applies verbatim).
- `scheduleScans` signature unchanged; internally: (1) enqueue one `sync` job per enabled non-self machine **every `sync.intervalMin`** (track last-enqueue in settings key `sync_enqueued:<machine>` — same pattern as `ADOPTION_TICK_KEY`); (2) `discoverProjects([...cfg.codeRoots.map(self-tagged), ...mirrorRootsFor(mf, self)])`; (3) upsert: self projects as today (`isSelf: true` + location), mirror projects `{ isSelf: false }` + location with the remote hostPath; (4) Claude attribution runs **per machine**: self dirs against self+all projects exactly as today (`scheduler.ts:37-63` unchanged), then for each `mirrorClaudeDirsFor` entry match that machine's dirs against projects **using that machine's hostPaths** (the mirror-discovered projects carry them) with fallback slugs from that machine's `encodedRoots`; claude scan jobs carry `machine` accordingly; (5) mirror-root kdb/git/doc jobs carry the mirror `rootPath` and `machine`.
- Worker dispatch in `main.ts:384-484`: a job whose data has `sync` calls `syncMachine(...)` with the real catalog + default exec.

Additionally this task lands the **divergence check** (spec §5): a pure helper `checkLocationDivergence(locations: { machine: string; originUrl: string | null }[]): string | null` in `mirror.ts` (returns a warning string when two locations report different non-null origin URLs), fed by a per-location `git -c safe.directory=* remote get-url origin` (falling back to `git rev-list --max-parents=0 HEAD -n 1`) run in the tick for projects with 2+ locations; a mismatch logs to `index_errors` (stage `divergence`) once per tick and the warning text reaches `/api/machines`. It warns loudly and changes nothing — `slugOverrides` is the operator's fix.

- [ ] **Step 1: Failing tests** — extend the `scheduleScans` integration block: temp config with a machines file (write one into the temp dir, point `ATLAS_MACHINES_FILE` at it via `parseConfig`), a fake mirror tree; assert: sync job enqueued once per enabled remote (and not for `enabled: false`); mirror project's jobs carry `machine: 'm4max'`, `isSelf: false`; a claude dir under the mirror matching a mirror project's encoded hostPath attributes to that project (not a ghost); an unmatched mirror claude dir falls back to a slug stripped of **m4max's** roots. Plus pure tests for `checkLocationDivergence` (same URL → null; different URLs → names both machines; a null origin never triggers).

- [ ] **Step 2–3: Verify fail; implement.** Keep the tick's shape; hoist the per-machine matching into a helper `attributeClaudeDirs(dirs, projects, encodedRoots)` shared by the self and mirror paths so the logic exists once.

- [ ] **Step 4: Run + `make test` + lint. Step 5: Commit + push:** `feature(indexer): sync jobs + mirror scanning + per-machine claude attribution`

### Task 15: Infra — volume, keys, image, admin trigger, smoke

**Files:**
- Modify: `docker-compose.yml` (remote_mirror volume on indexer; `~/.atlas/keys` mount)
- Modify: `docker/node.Dockerfile` (`openssh-client`, `rsync`)
- Modify: `packages/api/src/app.ts` (+`POST /api/admin/sync`), `packages/api/src/main.ts` (deps: enqueue via the existing reindex-trigger pattern — read how `/api/admin/reindex` enqueues at `app.ts:828` and mirror it), `packages/cli/src/main.ts` (nothing yet — Phase 4)
- Modify: `Makefile` (`sync-now`), `scripts/smoke.sh` (assert `/api/machines` answers)
- Test: `test/api/routes.test.ts` (admin sync route), `make help-audit`

**Interfaces:** `POST /api/admin/sync {machine}` → 202 `{ enqueued: true }`, 404 unknown machine, 400 disabled machine. `make sync-now MACHINE=m4max`.

- [ ] **Step 1: compose:**

```yaml
  indexer:
    volumes:
      # …existing…
      - remote_mirror:/data/remote
      - '${ATLAS_KEYS_DIR:-~/.atlas/keys}:/keys:ro'
volumes:
  remote_mirror:
```

`ATLAS_KEYS_DIR` joins the defaults env + `CONSUMED_BY_COMPOSE` list in the guard test. Directory (not file) mount — Docker turns a missing file bind into a directory, which would hand ssh a directory as an identity file; the runbook + a `make up` preflight (`scripts/preflight.sh`, called from the `up` target: `mkdir -p ~/.atlas/keys`) guarantee the dir exists.

- [ ] **Step 2: Dockerfile** — in `docker/node.Dockerfile`'s runtime stage: `RUN apt-get update && apt-get install -y --no-install-recommends openssh-client rsync git && rm -rf /var/lib/apt/lists/*` (git is already there — confirm; keep the line minimal if so).

- [ ] **Step 3: admin route + Make target** (`sync-now: ## Trigger an immediate sync of MACHINE=<name> (404s on unknown; the scheduler tick also syncs on its own cadence)`), smoke line, route test, `make help-audit` green.

- [ ] **Step 4: `make restart-build` on the real stack; verify `/api/machines` and an indexer log line showing the sync scheduler idle (no remotes enabled yet).** This is the phase-3 live gate: nothing regresses for single-machine.

- [ ] **Step 5: Commit + push:** `feature(stack): remote_mirror volume, ssh keys mount, sync admin trigger`

---

# Phase 4 — Provenance UX

### Task 16: `machine` search filter — Qdrant + FTS in lockstep

**Files:**
- Modify: `packages/core/src/types.ts` (`SearchFilters.machine?: string`)
- Modify: `packages/core/src/qdrant.ts` (`buildQdrantFilter` + `VectorPoint.payload.machine?`)
- Modify: `packages/core/src/catalog.ts` (`ftsSearch` — the mirrored condition)
- Modify: `packages/api/src/app.ts:302` (`/api/search` param)
- Modify: `packages/indexer/src/pipeline.ts:126-139` (payload gains `machine: b.entry.machine…` — thread `job.machine` onto entries at insert time: set `e.machine`? No — payload reads the job: pass `machine` through `indexEntries` alongside the existing per-entry data)
- Test: `test/core/qdrantFilter.test.ts` (extend — including the guard), `test/api/routes.test.ts`

**Interfaces:** `SearchFilters.machine?: string` — filter semantics documented at every surface as **"first ingested from"** (spec §6). Payload field `machine` is **not** added to `PAYLOAD_INDEXES` (spec §6: two-valued low-selectivity field; the `indexed ⊆ filtered` guard direction already permits filter-without-index — extend the guard test to assert `machine` is filtered and NOT indexed, with a comment citing the 2026-08-14 payload-index cost work).

- [ ] **Step 1: Failing tests:** filter builder emits `{ key: 'machine', match: { value } }` when set; `ftsSearch` SQL includes `e.machine = $n` under the same condition (assert via the stubbed-pool SQL-text idiom); the guard test's parsed filter-key set now contains `machine` while `PAYLOAD_INDEXES` does not.

- [ ] **Step 2–4: Implement, run, lint.** In `pipeline.ts`, `indexEntries`'s upsert loop adds `machine: job.machine` to the payload (thread the job through the existing call — `indexEntries(deps, inserted, progress)` already closes over the job in each scanner; add a `machine` param). Old points lack the field: a `machine` filter therefore misses pre-backfill points until Task 17 runs — Task 17 lands in the same phase before the filter is surfaced in any UI/CLI (Tasks 19–20 depend on 17; note the ordering in both commits).

- [ ] **Step 5: Commit + push:** `feature(search): machine filter — hybrid and FTS in lockstep, payload unindexed by design`

### Task 17: Payload backfill walk

**Files:**
- Create: `packages/indexer/src/backfillMachinePayload.ts`
- Modify: `packages/indexer/src/main.ts` (run once at boot when settings key `machine_payload_backfilled` ≠ active collection)
- Test: `test/indexer/backfillMachinePayload.test.ts`

**Interfaces:** `backfillMachinePayload(deps: { catalog: Catalog; vectors: VectorStore }, log?: (s: string) => void): Promise<number>` — batches over entries (`SELECT id, machine FROM entries WHERE vectorized_in = $activeCollection ORDER BY id` cursor loop), `vectors.setPayloadByEntryIds(ids, { machine })` grouped by machine value (the `setPayload`-by-`entry_id`-filter pattern from the docStatus resync — find it near `qdrant.ts`'s `setPayload` usage and reuse the exact mechanism); stamps `machine_payload_backfilled = <collection>` when done.

- [ ] **Steps: failing test with stubbed VectorStore (records calls) → implement → run → lint → commit + push:** `feature(indexer): one-time machine payload backfill`

### Task 18: Path mapping + remote editor links

**Files:**
- Modify: `packages/core/src/paths.ts`
- Modify: `packages/api/src/main.ts:154` (build mappings incl. mirrors), `packages/api/src/app.ts:218-219` (decoration)
- Test: `test/core/paths.test.ts` (extend)

**Interfaces:**
- `PathMapping` gains `machine?: string; sshUser?: string; sshAddress?: string`.
- Produces: `mirrorMappings(mf: MachinesFile, selfName: string): PathMapping[]` — for each non-self machine and root: `{ containerRoot: mirrorCodeRoot(...), hostRoot: <remote real root>, machine, sshUser: m.user, sshAddress: m.address }` + the claude dir equivalent.
- `toHostPath` unchanged. New `resolveLocation(containerPath, mappings): { hostPath: string; machine?: string; sshUser?: string; sshAddress?: string }`.
- `editorUrl(hostPath, line?)` unchanged for self. New `remoteEditorUrl(loc, line?)`: `vscode://vscode-remote/ssh-remote+<user>@<address><encoded hostPath>` (no `:line` — the remote URI scheme ignores it; omit rather than emit a lie). API decoration: when `resolveLocation` returns a machine, use `remoteEditorUrl` and attach `machine` to the hit.

- [ ] **Steps: failing tests** (mapping resolution order — mirror roots are longer, so specificity sorting already wins; a `/data/remote/m4max/code1/x/kdb/changelog.log` resolves to `/Users/serge/CODING/x/kdb/changelog.log` + machine `m4max`; url shape `vscode://vscode-remote/ssh-remote+serge@192.168.1.30/Users/serge/...`) → **implement → run → lint → commit + push:** `feature(api): remote-aware host paths and vscode-remote deep links`

### Task 19: CLI + MCP surface

**Files:**
- Modify: `packages/cli/src/main.ts` (`search -m/--machine`; new `machines` command), `packages/cli/src/format.ts` (badge)
- Modify: `packages/mcp/src/tools.ts` (`atlas_search`/`atlas_ask` gain `machine` param with the provenance caveat in the description; `atlas_status` gains per-machine sync block; SERVER_INSTRUCTIONS sentence: *"machine filters mean 'first ingested from' — shared git-synced content belongs to whichever machine synced first; for 'exists on machine X' read a project's `locations`"*)
- Test: `test/mcp/tools.test.ts` (extend), CLI smoke by hand

**Interfaces:** `atlas machines` renders `/api/machines` as a table (name, address, enabled, status, last success, bytes, divergence warnings); `atlas machines add --name … --address … --user … --code-root … [--code-root …] --claude-projects …` and `atlas machines remove <name>` edit `config/machines.yaml` **via the `yaml` package's Document API** (round-trips comments — a plain parse/stringify would destroy the file's commentary), validate through `machinesFileSchema` before writing, and refuse `remove` when the API reports indexed data for that machine (frozen-name rule, spec §3); the CLI owns the checkout so file edits are in-bounds (spec §3). `atlas search -m <name>` passes `machine=` through.

- [ ] **Steps: failing MCP tool test (param plumbed to the API call; description contains "first ingested") → implement → run + lint → commit + push:** `feature(surface): machine filter + machines status in CLI and MCP`

### Task 20: UI — badge, filter, Machines view

**Files:**
- Modify: `packages/ui/src/nav.ts` (seventh view `machines`, hotkey `7` — the comment at `nav.ts:3-9` explains this is the SSoT; `App.tsx` hotkeys at :95-100 and the view checks get the seventh entry)
- Create: `packages/ui/src/views/MachinesView.tsx`
- Modify: `packages/ui/src/views/SearchView.tsx` (machine dropdown, populated from `/api/machines`, label "First ingested from"), `packages/ui/src/components/EntryDrawer.tsx` (+machine line), hit rows (badge), `packages/ui/src/views/DashboardView.tsx` (per-machine cards: status, last success, staleness color), `packages/ui/src/types.ts`, `packages/ui/src/api.ts`
- Test: `test/ui/machinesView.test.tsx`, extend `test/ui/nav.test.tsx` if present

**MachinesView content:** read-only fleet table (from `/api/machines`): name (self marked), address, user, code roots, enabled, sync status + last success + bytes + duration + error; a header note pointing at `config/machines.yaml` + the runbook for edits (spec: UI is view-only in v1).

- [ ] **Steps: failing render test (fleet table shows self marker + unreachable status pill) → implement → `make test` + lint → commit + push:** `feature(ui): machines view, machine badges and filter, dashboard sync cards`

---

# Phase 5 — LAN bind + token auth

### Task 21: Bearer middleware, fail-closed bind, UI token prompt

**Files:**
- Create: `packages/api/src/auth.ts`
- Modify: `packages/api/src/app.ts` (mount first), `packages/api/src/main.ts` (fail-closed check), `packages/mcp/src/main.ts` (same middleware + `/health` exempt), `docker-compose.yml` (bind parameterization), `config/atlas.defaults.env` (+`ATLAS_BIND=127.0.0.1`, `ATLAS_TOKEN=` empty-on-purpose like `EMBEDDINGS_API_KEY`), `test/core/configDefaults.test.ts`
- Modify: `packages/ui/src/api.ts` (Authorization header from localStorage; 401 → token prompt), `packages/ui/src/components/TokenGate.tsx` (new, minimal modal)
- Test: `test/api/auth.test.ts`

**Interfaces:**
- `authMiddleware(opts: { token?: string; exempt: string[] })` — Hono middleware. Rules (spec §7): no token configured → no-op (legacy localhost mode); request path in `exempt` (`/api/health`, `/api/instance`, mcp `/health`) → pass; socket peer address is loopback (`getConnInfo(c).remote.address` in `127.0.0.0/8` or `::1` — **socket only, never headers**; nginx sets no XFF and a header check would be spoofable) → pass; else require `Authorization: Bearer <token>` (timing-safe compare) → 401 JSON `{ error: 'unauthorized' }` otherwise.
- Fail-closed boot (api + mcp main): `ATLAS_BIND` set to non-`127.0.0.1` **and** no `ATLAS_TOKEN` → `console.error` + `process.exit(1)`.
- Compose: every host-port line becomes `'${ATLAS_BIND:-127.0.0.1}:${API_PORT:-8710}:8710'` (api, mcp, ui only — qdrant/redis/postgres KEEP the literal `127.0.0.1`, spec §7); `ATLAS_BIND`/`ATLAS_TOKEN` pass through `x-node-common.environment` (`ATLAS_TOKEN: ${ATLAS_TOKEN:-}` — the Doppler pattern at `docker-compose.yml:43-48`).
- Config module: `atlasBind: z.string().default('127.0.0.1')`, `atlasToken: z.string().optional()` + `fromEnv` + defaults env + guard lists.

- [ ] **Step 1: Failing tests** (Hono app with the middleware; hono's test client can set `env` conn info — if `getConnInfo` proves untestable through `app.request`, factor the decision into a pure `authorize(input: { path: string; peer: string; header?: string }, opts): 'pass' | 401` and test THAT, wiring the thin middleware around it):

```ts
const opts = { token: 'sekret', exempt: ['/api/health', '/api/instance'] };
it('no token configured → everything passes', () => expect(authorize({ path: '/api/search', peer: '192.168.1.9' }, { token: undefined, exempt: [] })).toBe('pass'));
it('exempt paths pass without header', () => expect(authorize({ path: '/api/health', peer: '192.168.1.9' }, opts)).toBe('pass'));
it('loopback peer passes (socket address only)', () => expect(authorize({ path: '/api/search', peer: '127.0.0.1' }, opts)).toBe('pass'));
it('LAN peer without/with wrong header → 401; right header → pass', () => { /* three asserts */ });
```

- [ ] **Step 2–3: Verify fail; implement.** UI: `api.ts` fetch wrapper adds the header when `localStorage.atlasToken` exists; on a 401 response dispatch a `atlas:unauthorized` event; `App.tsx` renders `TokenGate` (input + save → localStorage → reload) when it fires. Keep `TokenGate` under 60 lines — one input, one button, one line of copy.

Also extend the usage-telemetry test (the suite covering `recordCall` / the request-logging middleware): assert the recorded row for an authorized request contains no `Authorization` material in `path`/`query` — the spec's "tokens are never logged" claim gets a pin (spec §7).

- [ ] **Step 4: Run + `make test` + lint; then live check: `ATLAS_BIND=0.0.0.0` with no token → api container exits with the message; with a token → `curl -H "Authorization: Bearer …"` from another device works, without it 401s.** Mutation-verify the loopback rule: flip the peer check to trust an `X-Forwarded-For` header in a scratch branch of the test → must fail.

- [ ] **Step 5: Commit + push:** `feature(auth): bearer token + fail-closed LAN bind across api/mcp/ui`

---

# Phase 6 — Resolution & single-active guard

### Task 22: /api/instance — identity + HMAC proof

**Files:**
- Create: `packages/api/src/instance.ts`
- Modify: `packages/api/src/app.ts` (route + `X-Atlas-Machine`/`X-Atlas-State` response headers on every request), `packages/api/src/main.ts`
- Test: `test/api/instance.test.ts`

**Interfaces:**
- `packages/api/src/instance.ts` exports: `bootId: string` (module-level `randomUUID()` — per-process, the self-recognition key, spec §8); `getState(): 'active' | 'conflicted'`, `setConflicted(peers: string[]): void`, `conflictPeers(): string[]`; `instancePayload(deps: { machine: string; installId: string; entries: number }): object`; `proofFor(token: string, nonce: string, payload: object): string` = HMAC-SHA256 over `nonce + '\n' + canonicalJson(payload)` (sorted keys — write the 6-line canonicalizer next to it).
- Route `GET /api/instance?nonce=<8-64 hex>` — **no bearer auth** (spec §8: the client must never send the token first): responds `{ machine, installId, bootId, state, entries, proof }`; `proof` present only when a token is configured; 400 on missing/malformed nonce. `installId`: settings row `install_id`, minted `randomUUID()` at api boot when absent.
- `ApiDeps` gains `instance: () => { machine: string; installId: string; entries: number }` (entries from the existing stats/count the dashboard already reads — reuse, don't recount).

- [ ] **Step 1: Failing tests:** proof verifies against an independent HMAC computation; nonce validation (reject `''`, reject 100-char, reject non-hex); no-token mode omits proof; every response carries `X-Atlas-State: active`; `setConflicted` flips the header and payload.
- [ ] **Step 2–4: Implement, run, lint.**
- [ ] **Step 5: Commit + push:** `feature(api): /api/instance — nonce-challenged identity with HMAC proof`

### Task 23: Continuous single-active guard

**Files:**
- Create: `packages/api/src/guard.ts`
- Modify: `packages/api/src/main.ts` (boot check + interval)
- Test: `test/api/guard.test.ts`

**Interfaces:**
- `probePeer(url: string, token: string | undefined, fetchImpl?: typeof fetch): Promise<{ ok: true; machine: string; bootId: string; state: string } | { ok: false; reason: 'unreachable' | 'bad-proof' | 'no-proof' }>` — generates a nonce, validates the proof when it has a token.
- `guardTick(deps: { self: string; bootId: string; peers: { name: string; url: string }[]; token?: string; onConflict: (names: string[]) => void; probe?: typeof probePeer }): Promise<void>` — probes all peers; a responder with valid proof whose `bootId !== deps.bootId` is a live peer → `onConflict([names])`. **`bootId === mine` is a hairpin — ignored** (spec §8/§10). Bad proof from a configured peer is logged once as *token mismatch — check Doppler/.env on <name>* (spec §8 taxonomy), NOT a conflict.
- Boot (api main): run one guard pass **before** binding the listener; any live peer → `console.error` naming it + the exact remedy + `process.exit(1)` unless `ATLAS_FORCE_ACTIVE=1` (new env var, guard-test listed as `INTENTIONALLY_ABSENT` in the defaults file). Then `setInterval(guardTick, cfg.scanIntervalMin * 60_000)`, `onConflict` = `setConflicted`.
- Peers = every machines.yaml entry except self (including `enabled: false` — a disabled machine can still accidentally run a stack), URL `http://<address>:8710/api/instance`.

- [ ] **Step 1: Failing tests:** stub probe — 1 live peer ⇒ onConflict; hairpin (peer answers with my bootId) ⇒ no conflict; bad proof ⇒ no conflict, warn logged; all unreachable ⇒ nothing. Mutation-verify the hairpin rule (remove the bootId comparison → test fails).
- [ ] **Step 2–4: Implement, run, lint. Live: start the stack, `atlas which` in Task 26 will show it; for now `curl '/api/instance?nonce=abcd1234'`.**
- [ ] **Step 5: Commit + push:** `feature(api): continuous single-active guard with hairpin-safe bootId identity`

### Task 24: Resolver (host-side, shared by CLI + shim)

**Files:**
- Create: `packages/core/src/resolve.ts`
- Modify: `packages/core/src/index.ts`
- Test: `test/core/resolve.test.ts`

**Interfaces:**
- `resolveActive(opts: { machinesFile: string; token?: string; cachePath?: string; timeoutMs?: number; mcpPort?: number; uiPort?: number; fetchImpl?: typeof fetch; now?: () => number }): Promise<{ baseUrl: string; mcpUrl: string; uiUrl: string; machine: string; fromCache: boolean }>` — `mcpUrl`/`uiUrl` built from the winning machine's address + the port conventions (8711 `/mcp`, 8712; overridable via opts). Throws `AtlasResolveError` with `kind: 'no-machines' | 'none-reachable' | 'multiple-active' | 'conflicted' | 'token-mismatch'` and a `detail` listing every probe result (host, outcome, bootEpoch/entries when available) plus the remedy line.
- `invalidateOnConflictHeader(headers: Headers, cachePath: string): boolean` — any Atlas response carrying `X-Atlas-State: conflicted` deletes the cache file so the next call re-probes immediately (spec §8 bounds the stale-conflicted window to one request); the CLI's fetch wrapper and the shim's response path both call it.
- Order: explicit `ATLAS_API_URL` env (or legacy `KDBSCOPE_API_URL` with a one-line deprecation warning to stderr) wins unprobed → cache file (default `~/.atlas/active.json`, shape `{ baseUrl, machine, at }`, TTL 5 min) → verify cached instance with one probe; on failure or expiry probe all → **exactly one** valid+active; cache the winner. A response with `state: 'conflicted'` anywhere ⇒ `conflicted` error. Valid-proof failures from configured machines ⇒ `token-mismatch` (spec §8).
- `probeInstance(baseUrl, token, fetchImpl, timeoutMs)` — same proof verification as `guard.ts`'s `probePeer`; factor ONE implementation here in core and have `guard.ts` import it (delete the Task-23 local copy in this task; update its test imports).

- [ ] **Step 1: Failing tests** (injected `fetchImpl` + `now`): 0 reachable → `none-reachable` naming both hosts; 1 valid → resolves + writes cache (and `mcpUrl`/`uiUrl` point at the winner's address with the port conventions); 2 valid → `multiple-active` naming both; conflicted state → `conflicted`; bad proof → `token-mismatch`; fresh cache short-circuits (fetch not called); stale cache + dead host → re-probe finds the moved instance; env override skips everything; `invalidateOnConflictHeader` deletes the cache only on the conflicted header value.
- [ ] **Step 2–4: Implement, run, lint.**
- [ ] **Step 5: Commit + push:** `feature(core): verified active-instance resolver with cache and error taxonomy`

### Task 25: atlas-connect — stdio MCP shim

**Files:**
- Create: `packages/atlas-connect/package.json` (`"name": "@atlas/connect"`, `"bin": { "atlas-connect": "dist/main.js" }`, deps: `@modelcontextprotocol/sdk` matching the mcp package's pinned version), `packages/atlas-connect/src/main.ts`, `packages/atlas-connect/tsconfig.json` (copy the cli package's)
- Modify: root `package.json` workspaces (workspaces glob already covers `packages/*` — verify), `Makefile` (`connect-link: ## Install the atlas-connect MCP shim on this machine's PATH (npm link)`)
- Test: `test/connect/bridge.test.ts`

**Interfaces (the whole shim is ~150 lines):**
- `main.ts`: an MCP `Server` on `StdioServerTransport`. Handlers: `tools/list` and `tools/call` both go through `withUpstream(fn)`:

```ts
let upstream: Client | null = null;
async function withUpstream<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!upstream) upstream = await connect();       // resolveActive() + StreamableHTTPClientTransport(baseUrl.replace(':8710', ':8711') + '/mcp', { requestInit: { headers: auth } })
      return await fn(upstream);
    } catch (e) {
      upstream = null;                                  // mid-session move → re-resolve once (spec §8)
      if (attempt === 1) throw e;
    }
  }
  throw new Error('unreachable');
}
```

  The upstream endpoint is `resolveActive(...)`'s `mcpUrl` (Task 24 returns it precomputed from the winning machine's address — never derive ports by arithmetic on `baseUrl`). Every upstream response passes through `invalidateOnConflictHeader` (Task 24).
- Failure mapping: `tools/list` failure → return the static tool list? No — return an MCP error is unhelpful in Claude Code at session start; instead return ONE tool `atlas_unavailable` whose description carries the resolver's error text, so the failure is visible in-band (spec §8). `tools/call` failure → `{ content: [{ type: 'text', text: 'Atlas unreachable: <resolver detail>' }], isError: true }`.
- Token: from `~/.atlas/credentials` (JSON `{ token }`) when present.
- Registration (runbook): `claude mcp remove atlas; claude mcp add atlas -- atlas-connect` once per machine.

- [ ] **Step 1: Failing test** — the bridge logic factored pure: `withUpstream` retry semantics (first failure reconnects, second surfaces; a moved upstream resolves fresh) with injected `connect`.
- [ ] **Step 2–4: Implement, `make install` (workspace), run, lint.**
- [ ] **Step 5: Commit + push:** `feature(connect): stdio MCP shim — lazy resolve, in-band errors, one retry`

### Task 26: CLI — connect/which/open + resolver integration

**Files:**
- Modify: `packages/cli/src/api.ts` (base-URL resolution), `packages/cli/src/main.ts` (three commands + `machines` from Task 19)
- Test: `test/cli/resolve.test.ts` (if a cli test dir exists — else fold into `test/core/resolve.test.ts` the pure parts; the commands themselves are thin)

**Interfaces:**
- `api.ts`: today `const BASE = process.env.KDBSCOPE_API_URL ?? 'http://127.0.0.1:8710'` (`packages/cli/src/api.ts:4`) — becomes an async `baseUrl()` memo: `ATLAS_API_URL` → legacy var (deprecation note once) → `http://127.0.0.1:8710` if it answers `/api/health` within 300ms (zero-config localhost fast path — keeps every existing single-machine invocation instant) → `resolveActive(...)`. Token from `~/.atlas/credentials` attached as a default header when present.
- `atlas connect --token <t>`: writes `~/.atlas/credentials` (mode 0600) + probes + prints the resolved instance. `atlas which`: runs `resolveActive` with `cachePath: null` (fresh probe) and prints the per-host probe table (name, address, outcome, machine, state, entries). `atlas open`: resolves, `execFile('open', [resolved.uiUrl])`. The fetch wrapper passes every response through `invalidateOnConflictHeader` (Task 24) so a conflicted instance is abandoned after one request, not one TTL.

- [ ] **Steps: implement with the same commander block shape as the existing commands (`packages/cli/src/main.ts:70+`), manual smoke (`atlas which` against the live stack), lint, commit + push:** `feature(cli): connect/which/open + resolver-backed base URL`

---

# Phase 7 — Ops, docs, KDB closure

### Task 27: Runbooks, ADR, KDB entries, final audit

**Files:**
- Create: `docs/multi-machine.md` (timestamped per §4: add-machine runbook — keygen `ssh-keygen -t ed25519 -f ~/.atlas/keys/atlas_sync -N ''`, `ssh-copy-id`-style authorized_keys line with `restrict` options, `ssh-keyscan <addr> >> config/known_hosts`, openrsync preflight `ssh <host> /opt/homebrew/bin/rsync --version`, machines.yaml entry, Migration-Assistant warning (`ATLAS_SELF` + stale `~/.claude/projects` copies are EXPECTED to dedup, spec §10), token copy `atlas connect --token`; moving-the-stack runbook — `make down` / `make up`, volume-copy path with **installId re-mint** (`DELETE FROM settings WHERE key = 'install_id'` on the copy) and re-pull expectations)
- Create: `docs/adr/20260819-multi-machine-one-active-instance.md` (from `~/.claude/references/adr-template.md`; Decision: one active instance + pull-mirror + v3 identity; links the spec; referenced from the component log)
- Modify: `docs/architecture.md` (+ revision line + a Machines section), `docs/configuration.md` (+ new env vars), `README.md` (one paragraph + the architecture diagram gains the mirror)
- KDB: changelog COMPLETED line, `kdb/components/atlas.log` entry, `kdb/session.log` block — all via `bin/kdb_append`; backlog lines for the deferred items (presence-based machine filter; ordinal-duplicate cleanup; UI machine editing; Tailscale/TLS)
- Audit: `make test && make lint && make help-audit && make config-check && make smoke`

- [ ] **Step 1: Write the docs** (every non-code doc gets the `YYYY-MM-DD HH:MM UTC` header; updates add revision-history lines).
- [ ] **Step 2: Run the full audit block above; every gate green.**
- [ ] **Step 3: KDB appends** (formats per `~/.claude/references/kdb-protocol.md`; use `bin/kdb_append <log> - <<'EOF'` heredoc form).
- [ ] **Step 4: Final commit + push (§5.1):** `feature(atlas): multi-machine ops runbooks, ADR, docs` — then verify `git show --stat` lists exactly these files.

---

## Post-plan notes for the executor

- **Phase order is load-bearing:** 1 → 2 strictly (migration before any mirror data exists); 3 → 4 (payload backfill before the filter surfaces in UI/CLI); 5 → 6 (the guard probes need the token machinery). 5–6 may run before 3–4 if LAN access is needed sooner (spec §13).
- **Phase 2 live rollout ritual:** `make db-dump` → `make dedup-rehearsal` → eyeball the report (collisions ≈ 0 expected; ordinal groups listed) → only then `make restart-build` so the boot migration runs against the real catalog.
- **The m4max enrollment itself is operations, not code** (runbook in Task 27): generate the key, install it, keyscan, add the machines.yaml entry with the REAL paths (never invented ones), set `enabled: true`, `make restart-build`, watch `atlas machines` go `ok`.
- When a task's stated line numbers have drifted, search for the quoted code instead — the quotes are the anchor, the numbers are hints.


