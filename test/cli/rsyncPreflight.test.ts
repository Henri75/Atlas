import { describe, expect, it, vi } from 'vitest';
import { checkRemoteRsync, judgeRsyncVersion, type Exec } from '../../packages/cli/src/rsyncPreflight.js';

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
  const OPTS = { user: 'serge', address: '192.168.1.30', remoteRsyncPath: '/opt/homebrew/bin/rsync' };

  it('runs ssh via execFile argv — never a shell string', async () => {
    const exec: Exec = vi.fn().mockResolvedValue({ stdout: 'rsync  version 3.5.0  protocol version 32\n' });
    const result = await checkRemoteRsync(exec, OPTS);
    expect(result).toEqual({ ok: true });
    expect(exec).toHaveBeenCalledWith(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=5',
        'serge@192.168.1.30',
        '/opt/homebrew/bin/rsync', '--version',
      ],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
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
