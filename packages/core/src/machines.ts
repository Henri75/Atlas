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

/**
 * Minutes between sync ticks when config/machines.yaml omits `sync.intervalMin`
 * — the schema default below, and also what the API falls back to in legacy
 * mode (no fleet file at all, so there is no MachinesFile to read a value
 * from). Exported so both call `10` by name instead of by two independently
 * maintained literals.
 */
export const DEFAULT_SYNC_INTERVAL_MIN = 10;

/**
 * Default `remoteRsyncPath` — Homebrew's rsync on Apple Silicon. Stock macOS
 * `/usr/bin/rsync` is openrsync and must never be used (spec §4). Exported so
 * the CLI's add-machine openrsync preflight (`packages/cli/src/rsyncPreflight.ts`)
 * checks the exact path a new entry will actually get, instead of a second,
 * independently-drifting literal.
 */
export const DEFAULT_REMOTE_RSYNC_PATH = '/opt/homebrew/bin/rsync';

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
  remoteRsyncPath: z.string().default(DEFAULT_REMOTE_RSYNC_PATH),
  /** dir-basename → slug, for unrelated same-named projects (spec §5). */
  slugOverrides: z.record(z.string(), z.string()).default({}),
});

export const machinesFileSchema = z.object({
  machines: z.array(machineSchema).min(1).refine(
    (ms) => new Set(ms.map((m) => m.name)).size === ms.length,
    { message: 'duplicate machine name' },
  ),
  sync: z.object({
    intervalMin: z.number().int().min(1).default(DEFAULT_SYNC_INTERVAL_MIN),
    /** ADDITIONS to the built-in list derived from the scanners' IGNORED_DIRS. */
    excludes: z.array(z.string()).default([]),
  }).default({ intervalMin: DEFAULT_SYNC_INTERVAL_MIN, excludes: [] }),
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
