/**
 * `atlas machines add`'s openrsync-refusal preflight (spec §4, review ruling
 * on Task 27: ships as code, not runbook-only). Stock macOS `/usr/bin/rsync`
 * is openrsync (protocol 29) and a non-interactive sshd PATH will not find
 * Homebrew's rsync unless `--rsync-path` names it explicitly — the sync
 * engine already does that (`packages/indexer/src/sync.ts`), but nothing
 * previously stopped an operator from enrolling a machine whose
 * `remoteRsyncPath` is actually openrsync, or unreachable, and only finding
 * out when the first sync job fails. This runs the same check the runbook
 * (`docs/multi-machine.md` step 4) documents as a manual command, before the
 * machines.yaml entry is ever written.
 *
 * Pure judgment (`judgeRsyncVersion`) is separated from the ssh call
 * (`checkRemoteRsync`) so the interesting logic is directly unit-testable,
 * and the exec boundary is injectable so tests never shell out to a real ssh
 * — the same shape as the indexer's `sync.ts` `Exec` type, redefined here
 * rather than imported: the CLI must not depend on the indexer package (a
 * service, not a library the host-side CLI links against).
 */

import { knownHostsPath, syncKeyPath } from '@atlas/core';

export type RsyncVersionJudgment = 'ok' | 'openrsync' | 'unparseable';

/**
 * Judges the first line of an `rsync --version` (or `openrsync --version`)
 * invocation. `'unparseable'` is refused as suspect rather than assumed
 * safe — a preflight that cannot positively identify GNU rsync must not
 * wave an unknown binary through.
 *
 * Examples:
 *   "rsync  version 3.5.0  protocol version 32"  -> 'ok'
 *   "openrsync: protocol version 29"             -> 'openrsync'
 *   "garbage"                                    -> 'unparseable'
 *   ""                                            -> 'unparseable'
 */
export function judgeRsyncVersion(firstLine: string): RsyncVersionJudgment {
  const line = firstLine.trim();
  if (/openrsync/i.test(line)) return 'openrsync';
  if (/^rsync\s+version\s+\d/i.test(line)) return 'ok';
  return 'unparseable';
}

/** Injected process runner. See file header for why this isn't imported from sync.ts. */
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: string }>;

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: 'unreachable' | 'openrsync' | 'unparseable'; detail: string };

const PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * `ssh -i <keys>/atlas_sync -o UserKnownHostsFile=<repo>/config/known_hosts
 * -o BatchMode=yes -o ConnectTimeout=5 <user>@<address> <remoteRsyncPath>
 * --version` via `execFile` (no shell — argv, never interpolated into a
 * shell string).
 *
 * The credentials are the SYNC's, not the operator's ambient ssh config,
 * and that is the whole point: a preflight that connects with the
 * operator's agent key and `~/.ssh/known_hosts` proves the operator can
 * reach the machine, which nobody doubted — it says nothing about whether
 * the indexer will, since the indexer only ever has `/keys/atlas_sync` and
 * `/config/known_hosts` (`packages/indexer/src/sync.ts`). Probing with the
 * same identity + pinned host keys means a pass here really does mean the
 * first sync job will connect: an unauthorized key (step 2 of the runbook
 * skipped) or an unpinned host key (step 3 skipped) now fails HERE, at
 * enroll time, instead of at the first sync tick.
 *
 * ssh failure of any kind (unreachable, auth refused, host key not pinned,
 * DNS failure) and a non-GNU-rsync/unparseable version line are both
 * refusals: an add-machine preflight's job is to stay silent about *why*
 * only as far as it has to — the caller decides what to tell the operator.
 */
export async function checkRemoteRsync(
  exec: Exec,
  opts: {
    user: string;
    address: string;
    remoteRsyncPath: string;
    /** Defaults to `$ATLAS_KEYS_DIR/atlas_sync` (else `~/.atlas/keys/atlas_sync`). */
    keyPath?: string;
    /** Defaults to this checkout's `config/known_hosts`. */
    knownHosts?: string;
  },
): Promise<PreflightResult> {
  const keyPath = opts.keyPath ?? syncKeyPath();
  const knownHosts = opts.knownHosts ?? knownHostsPath();
  let stdout: string;
  try {
    const r = await exec(
      'ssh',
      [
        '-i', keyPath,
        '-o', `UserKnownHostsFile=${knownHosts}`,
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=5',
        `${opts.user}@${opts.address}`,
        opts.remoteRsyncPath, '--version',
      ],
      { timeoutMs: PREFLIGHT_TIMEOUT_MS },
    );
    stdout = r.stdout;
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: (e as Error).message };
  }

  const firstLine = (stdout.split('\n')[0] ?? '').trim();
  const judgment = judgeRsyncVersion(firstLine);
  if (judgment === 'ok') return { ok: true };
  return { ok: false, reason: judgment, detail: firstLine };
}
