import { describe, expect, it, vi } from 'vitest';
import { mirrorCodeRoot, mirrorClaudeDir } from '@atlas/core';
import type { MachineConfig } from '@atlas/core';
import { syncMachine } from '../../packages/indexer/src/sync.js';

const M: MachineConfig = {
  name: 'm4max', address: '192.168.1.30', user: 'serge', codeRoots: ['/Users/serge/CODING'],
  claudeProjects: '/Users/serge/.claude/projects', enabled: true,
  remoteRsyncPath: '/opt/homebrew/bin/rsync', slugOverrides: {},
};

function makeCatalog() {
  return {
    recordSyncStart: vi.fn(async (_machine: string) => {}),
    recordSyncResult: vi.fn(async (
      _machine: string,
      _r: { status: 'ok' | 'unreachable' | 'error'; bytes?: number; durationMs?: number; error?: string },
    ) => {}),
  };
}

describe('syncMachine', () => {
  it('asleep machine → unreachable status, zero rsync invocations, no throw', async () => {
    const calls: string[][] = [];
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'ssh') throw new Error('Connection refused');
      return { stdout: '' };
    });
    const catalog = makeCatalog();
    const out = await syncMachine({ catalog, exec, mkdirp: () => {} }, M, { excludes: [] });
    expect(out).toBe('unreachable');
    expect(calls.filter((c) => c[0] === 'rsync')).toHaveLength(0);
    expect(catalog.recordSyncStart).toHaveBeenCalledWith('m4max');
    expect(catalog.recordSyncResult).toHaveBeenCalledWith('m4max', expect.objectContaining({ status: 'unreachable' }));
    // no error rows — an asleep Mac is expected (spec §10)
    const [, arg] = catalog.recordSyncResult.mock.calls[0]!;
    expect((arg as any).error).toBeUndefined();
  });

  it('happy path: one rsync per code root + one for claude, ok recorded with stats', async () => {
    const calls: string[][] = [];
    const mkdirCalls: string[] = [];
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'ssh') return { stdout: '' };
      return { stdout: 'Number of files: 12\nTotal transferred file size: 1,234 bytes\n' };
    });
    const catalog = makeCatalog();
    const out = await syncMachine({ catalog, exec, mkdirp: (p: string) => mkdirCalls.push(p) }, M, { excludes: [] });

    expect(out).toBe('ok');
    const rsyncCalls = calls.filter((c) => c[0] === 'rsync');
    expect(rsyncCalls).toHaveLength(2); // 1 code root + 1 claude

    // dest paths passed to rsync are exactly the mirror helpers' outputs
    expect(rsyncCalls[0]!.at(-1)).toBe(`${mirrorCodeRoot(M.name, 1)}/`);
    expect(rsyncCalls[1]!.at(-1)).toBe(`${mirrorClaudeDir(M.name)}/`);
    expect(mkdirCalls).toContain(mirrorCodeRoot(M.name, 1));
    expect(mkdirCalls).toContain(mirrorClaudeDir(M.name));

    expect(catalog.recordSyncResult).toHaveBeenCalledWith(
      'm4max',
      expect.objectContaining({ status: 'ok', bytes: 2468 }), // 1,234 * 2 jobs
    );
    const [, arg] = catalog.recordSyncResult.mock.calls[0]!;
    expect(typeof (arg as any).durationMs).toBe('number');
  });

  it('rsync failure records error and stops', async () => {
    let rsyncCallCount = 0;
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === 'ssh') return { stdout: '' };
      rsyncCallCount++;
      if (rsyncCallCount === 1) throw new Error('rsync: connection unexpectedly closed');
      return { stdout: 'Total transferred file size: 1,234 bytes\n' };
    });
    const catalog = makeCatalog();
    const out = await syncMachine({ catalog, exec, mkdirp: () => {} }, M, { excludes: [] });

    expect(out).toBe('error');
    expect(rsyncCallCount).toBe(1); // stopped at first failure — next tick retries
    expect(catalog.recordSyncResult).toHaveBeenCalledWith(
      'm4max',
      expect.objectContaining({ status: 'error', error: expect.stringContaining('unexpectedly closed') }),
    );
  });

  it('bytes parsing handles comma-grouped numbers', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === 'ssh') return { stdout: '' };
      return { stdout: 'Total transferred file size: 12,345,678 bytes\n' };
    });
    const catalog = makeCatalog();
    await syncMachine({ catalog, exec, mkdirp: () => {} }, M, { excludes: [] });

    const [, arg] = catalog.recordSyncResult.mock.calls[0]!;
    expect((arg as any).bytes).toBe(24_691_356); // 12,345,678 * 2 jobs
  });
});
