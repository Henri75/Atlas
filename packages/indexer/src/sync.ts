import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { mirrorClaudeDir, mirrorCodeRoot, type Catalog, type MachineConfig } from '@atlas/core';
import { SCANNER_IGNORED_DIRS } from './scanners.js';

const execFileAsync = promisify(execFile);

// Shared between buildRsyncArgs's -e ssh string and syncMachine's preflight
// probe, so the two invocations of ssh can never drift apart on these.
const SSH_KEY = '/keys/atlas_sync';
const SSH_KNOWN_HOSTS = '/config/known_hosts';

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
  const ssh = `ssh -i ${SSH_KEY} -o UserKnownHostsFile=${SSH_KNOWN_HOSTS} -o BatchMode=yes -o ConnectTimeout=10`;
  const args = [
    // --stats makes "Total transferred file size" parseable by syncMachine.
    '-a', '--delete', '--stats', '--partial-dir=.rsync-partial', '--timeout=120',
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

/** Injected process runner — defaults to a promisified execFile. */
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: string }>;

const defaultExec: Exec = async (cmd, args, opts) => {
  const r = await execFileAsync(cmd, args, { timeout: opts?.timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout };
};

/**
 * rsync's --stats output includes lines like:
 *   Total transferred file size: 12,345,678 bytes
 * Commas are locale grouping, not thousands markers to reject.
 */
function parseTransferredBytes(stdout: string): number {
  const m = stdout.match(/Total transferred file size:\s*([\d,]+)\s*bytes/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
}

/**
 * Sync one machine's code roots and Claude transcripts into its mirror.
 *
 * A preflight ssh probe distinguishes "asleep Mac" (expected — spec §10; no
 * error row, no rsync attempted) from a genuine rsync failure. rsync jobs run
 * sequentially and stop at the first failure: per-file atomicity means a half
 * sync is safe, and the next scheduler tick retries from where rsync's own
 * delta logic leaves off.
 */
export async function syncMachine(
  deps: {
    catalog: Pick<Catalog, 'recordSyncStart' | 'recordSyncResult'>;
    exec?: Exec;
    mkdirp?: (p: string) => void;
  },
  m: MachineConfig,
  sync: { excludes: string[] },
): Promise<'ok' | 'unreachable' | 'error'> {
  const exec = deps.exec ?? defaultExec;
  const mkdirp = deps.mkdirp ?? ((p: string) => mkdirSync(p, { recursive: true }));

  await deps.catalog.recordSyncStart(m.name);

  try {
    await exec('ssh', [
      '-i', SSH_KEY,
      '-o', `UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      `${m.user}@${m.address}`, 'true',
    ]);
  } catch {
    // An asleep Mac is expected (spec §10) — not an error worth a row.
    await deps.catalog.recordSyncResult(m.name, { status: 'unreachable' });
    return 'unreachable';
  }

  const jobs: { remotePath: string; dest: string; kind: 'code' | 'claude' }[] = [
    ...m.codeRoots.map((remotePath, i) => ({
      remotePath, dest: mirrorCodeRoot(m.name, i + 1), kind: 'code' as const,
    })),
    { remotePath: m.claudeProjects, dest: mirrorClaudeDir(m.name), kind: 'claude' as const },
  ];

  for (const job of jobs) mkdirp(job.dest);

  const startedAt = Date.now();
  let bytes = 0;
  for (const job of jobs) {
    const args = buildRsyncArgs(m, job, sync.excludes);
    try {
      const { stdout } = await exec('rsync', args);
      bytes += parseTransferredBytes(stdout);
    } catch (e) {
      await deps.catalog.recordSyncResult(m.name, { status: 'error', error: (e as Error).message });
      return 'error';
    }
  }

  await deps.catalog.recordSyncResult(m.name, { status: 'ok', bytes, durationMs: Date.now() - startedAt });
  return 'ok';
}
