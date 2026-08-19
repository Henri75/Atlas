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
