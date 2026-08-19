import { describe, expect, it } from 'vitest';
import type { MachineConfig, MachinesFile } from '@atlas/core';
import { mirrorCodeRoot, mirrorClaudeDir, encodeClaudePath } from '@atlas/core';
import {
  mirrorRootsFor,
  mirrorClaudeDirsFor,
  checkLocationDivergence,
} from '../../packages/indexer/src/mirror.js';

function machine(overrides: Partial<MachineConfig> = {}): MachineConfig {
  return {
    name: 'm4max',
    address: '192.168.1.30',
    user: 'serge',
    codeRoots: ['/Users/serge/CODING'],
    claudeProjects: '/Users/serge/.claude/projects',
    enabled: true,
    remoteRsyncPath: '/opt/homebrew/bin/rsync',
    slugOverrides: {},
    ...overrides,
  };
}

function mf(machines: MachineConfig[]): MachinesFile {
  return { machines, sync: { intervalMin: 10, excludes: [] } };
}

describe('mirrorRootsFor', () => {
  it('yields a CodeRoot for each code root whose mirror exists on disk', () => {
    const m = machine({ codeRoots: ['/Users/serge/CODING', '/Users/serge/Other'] });
    const existing = new Set([mirrorCodeRoot('m4max', 1), mirrorCodeRoot('m4max', 2)]);
    const roots = mirrorRootsFor(mf([m]), 'self', (p) => existing.has(p));
    expect(roots).toEqual([
      { container: mirrorCodeRoot('m4max', 1), host: '/Users/serge/CODING', machine: 'm4max', slugOverrides: {} },
      { container: mirrorCodeRoot('m4max', 2), host: '/Users/serge/Other', machine: 'm4max', slugOverrides: {} },
    ]);
  });

  it('skips a code root whose mirror has never synced (does not exist on disk)', () => {
    const m = machine();
    const roots = mirrorRootsFor(mf([m]), 'self', () => false);
    expect(roots).toEqual([]);
  });

  it('skips the self machine', () => {
    const m = machine({ name: 'self' });
    const roots = mirrorRootsFor(mf([m]), 'self', () => true);
    expect(roots).toEqual([]);
  });

  it('skips a disabled machine', () => {
    const m = machine({ enabled: false });
    const roots = mirrorRootsFor(mf([m]), 'other-self', () => true);
    expect(roots).toEqual([]);
  });

  it('carries a machine slugOverrides through to the CodeRoot', () => {
    const m = machine({ slugOverrides: { notes: 'm4max-notes' } });
    const roots = mirrorRootsFor(mf([m]), 'self', () => true);
    expect(roots[0]!.slugOverrides).toEqual({ notes: 'm4max-notes' });
  });
});

describe('mirrorClaudeDirsFor', () => {
  it('yields an entry with encoded roots for each existing mirror claude dir', () => {
    const m = machine({ codeRoots: ['/Users/serge/CODING', '/Users/serge/Other'] });
    const dirs = mirrorClaudeDirsFor(mf([m]), 'self', (p) => p === mirrorClaudeDir('m4max'));
    expect(dirs).toEqual([
      {
        machine: 'm4max',
        dir: mirrorClaudeDir('m4max'),
        encodedRoots: [
          encodeClaudePath('/Users/serge/CODING'),
          encodeClaudePath('/Users/serge/Other'),
        ],
      },
    ]);
  });

  it('skips a machine whose claude mirror dir does not exist', () => {
    const m = machine();
    expect(mirrorClaudeDirsFor(mf([m]), 'self', () => false)).toEqual([]);
  });

  it('skips the self machine and disabled machines', () => {
    const machines = [machine({ name: 'self' }), machine({ name: 'off', enabled: false })];
    expect(mirrorClaudeDirsFor(mf(machines), 'self', () => true)).toEqual([]);
  });
});

describe('checkLocationDivergence', () => {
  it('returns null when there are 0 or 1 non-null origin URLs', () => {
    expect(checkLocationDivergence([])).toBeNull();
    expect(checkLocationDivergence([{ machine: 'a', originUrl: null }])).toBeNull();
    expect(
      checkLocationDivergence([{ machine: 'a', originUrl: 'git@x:y.git' }]),
    ).toBeNull();
  });

  it('returns null when every non-null origin URL agrees', () => {
    const result = checkLocationDivergence([
      { machine: 'a', originUrl: 'git@x:y.git' },
      { machine: 'b', originUrl: 'git@x:y.git' },
      { machine: 'c', originUrl: null },
    ]);
    expect(result).toBeNull();
  });

  it('ignores null origin URLs when comparing', () => {
    const result = checkLocationDivergence([
      { machine: 'a', originUrl: null },
      { machine: 'b', originUrl: null },
    ]);
    expect(result).toBeNull();
  });

  it('warns naming each diverging machine and its URL when origin URLs disagree', () => {
    const result = checkLocationDivergence([
      { machine: 'm4max', originUrl: 'git@x:notes.git' },
      { machine: 'macmini', originUrl: 'git@x:other-notes.git' },
    ]);
    expect(result).not.toBeNull();
    expect(result).toContain('m4max');
    expect(result).toContain('git@x:notes.git');
    expect(result).toContain('macmini');
    expect(result).toContain('git@x:other-notes.git');
  });
});
