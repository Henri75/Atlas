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
