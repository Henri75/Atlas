import { describe, expect, it, vi, type Mock } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownHostsPath } from '@atlas/core';
import { checkRemoteRsync, judgeRsyncVersion, type Exec } from '../../packages/cli/src/rsyncPreflight.js';

/** test/cli/rsyncPreflight.test.ts -> test/cli -> test -> repo root. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('judgeRsyncVersion', () => {
  it('recognizes GNU rsync', () => {
    expect(judgeRsyncVersion('rsync  version 3.5.0  protocol version 32')).toBe('ok');
  });

  it('recognizes a plain rsync version line without a protocol suffix', () => {
    expect(judgeRsyncVersion('rsync  version 3.2.7')).toBe('ok');
  });

  it('flags openrsync', () => {
    expect(judgeRsyncVersion('openrsync: protocol version 29')).toBe('openrsync');
  });

  it('is case-insensitive for openrsync', () => {
    expect(judgeRsyncVersion('OpenRsync: protocol version 29')).toBe('openrsync');
  });

  it('treats garbage as unparseable', () => {
    expect(judgeRsyncVersion('garbage')).toBe('unparseable');
  });

  it('treats an empty line as unparseable', () => {
    expect(judgeRsyncVersion('')).toBe('unparseable');
  });

  it('treats whitespace-only as unparseable', () => {
    expect(judgeRsyncVersion('   ')).toBe('unparseable');
  });
});

describe('checkRemoteRsync', () => {
  const OPTS = {
    user: 'serge',
    address: '192.168.1.30',
    remoteRsyncPath: '/opt/homebrew/bin/rsync',
    keyPath: '/keys-dir/atlas_sync',
    knownHosts: '/repo/config/known_hosts',
  };

  it('runs ssh via execFile argv — never a shell string — with the SYNC\'s key and pinned host keys', async () => {
    const exec: Exec = vi.fn().mockResolvedValue({ stdout: 'rsync  version 3.5.0  protocol version 32\n' });
    const result = await checkRemoteRsync(exec, OPTS);
    expect(result).toEqual({ ok: true });
    // -i and UserKnownHostsFile are the point: probing with the operator's
    // ambient ssh config proves the OPERATOR can reach the machine, which
    // says nothing about the indexer, whose only credentials are
    // /keys/atlas_sync + /config/known_hosts (packages/indexer/src/sync.ts).
    expect(exec).toHaveBeenCalledWith(
      'ssh',
      [
        '-i', '/keys-dir/atlas_sync',
        '-o', 'UserKnownHostsFile=/repo/config/known_hosts',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=5',
        'serge@192.168.1.30',
        '/opt/homebrew/bin/rsync', '--version',
      ],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  /**
   * The defaults are what production actually runs (`atlas machines add`
   * passes neither path), so they get their own case: the key comes from
   * the same `ATLAS_KEYS_DIR` compose mounts at `/keys`, and known_hosts
   * from this checkout's `config/` — never `~/.ssh/known_hosts`.
   */
  it('defaults the key to $ATLAS_KEYS_DIR/atlas_sync and known_hosts to the checkout\'s config/', async () => {
    const saved = process.env.ATLAS_KEYS_DIR;
    process.env.ATLAS_KEYS_DIR = '/custom/keys';
    try {
      const exec: Exec = vi.fn().mockResolvedValue({ stdout: 'rsync  version 3.5.0\n' });
      await checkRemoteRsync(exec, {
        user: 'serge', address: '192.168.1.30', remoteRsyncPath: '/opt/homebrew/bin/rsync',
      });
      const args = (exec as unknown as Mock).mock.calls[0]![1] as string[];
      expect(args[0]).toBe('-i');
      expect(args[1]).toBe('/custom/keys/atlas_sync');
      expect(args[3]).toBe(`UserKnownHostsFile=${knownHostsPath()}`);
      expect(knownHostsPath()).toBe(join(REPO_ROOT, 'config', 'known_hosts'));
    } finally {
      if (saved === undefined) delete process.env.ATLAS_KEYS_DIR;
      else process.env.ATLAS_KEYS_DIR = saved;
    }
  });

  it('refuses openrsync', async () => {
    const exec: Exec = vi.fn().mockResolvedValue({ stdout: 'openrsync: protocol version 29\n' });
    expect(await checkRemoteRsync(exec, OPTS)).toEqual({
      ok: false,
      reason: 'openrsync',
      detail: 'openrsync: protocol version 29',
    });
  });

  it('refuses unreachable/ssh failure', async () => {
    const exec: Exec = vi.fn().mockRejectedValue(new Error('ssh: connect to host 192.168.1.30 port 22: Operation timed out'));
    const result = await checkRemoteRsync(exec, OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unreachable');
      expect(result.detail).toMatch(/timed out/);
    }
  });

  it('refuses unparseable output rather than assuming it is safe', async () => {
    const exec: Exec = vi.fn().mockResolvedValue({ stdout: 'garbage\n' });
    expect(await checkRemoteRsync(exec, OPTS)).toEqual({
      ok: false,
      reason: 'unparseable',
      detail: 'garbage',
    });
  });
});
