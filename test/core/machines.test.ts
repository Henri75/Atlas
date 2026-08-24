import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  /**
   * The COMMITTED fleet file, not a fixture — this is the class of failure
   * the fixtures above cannot catch. `config/machines.yaml` travels with the
   * checkout, `ATLAS_SELF` does not (gitignored .env), so the instant this
   * file landed on the branch every machine that had not set ATLAS_SELF got
   * an api that throws before `serve()` and a crash-looping indexer. The
   * remedy is enforced by `scripts/preflight.sh` (a hard fail before compose
   * runs) and documented as step 0 of the rollout ritual; this test pins the
   * other half: that the real file still parses, still contains the name the
   * docs and preflight tell operators to use, and still fails ACTIONABLY —
   * naming ATLAS_SELF and the known machines — when it is missing.
   */
  it('the committed config/machines.yaml parses, and self-resolution fails actionably without ATLAS_SELF', () => {
    // test/core/machines.test.ts -> test/core -> test -> repo root.
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const committed = join(repoRoot, 'config', 'machines.yaml');
    expect(existsSync(committed)).toBe(true);

    const mf = loadMachinesFileIfPresent(committed);
    expect(mf).not.toBeNull();

    expect(() => selfMachine(mf!, undefined)).toThrow(/ATLAS_SELF is not set/);
    // The message must name the machines an operator can choose from —
    // "ATLAS_SELF is not set" alone leaves them guessing at the spelling.
    expect(() => selfMachine(mf!, undefined)).toThrow(/nasta-mbp/);
    expect(selfMachine(mf!, 'nasta-mbp').name).toBe('nasta-mbp');
  });

  it('mirror path helpers are fixed-shape', () => {
    expect(mirrorCodeRoot('m4max', 1)).toBe('/data/remote/m4max/code1');
    expect(mirrorClaudeDir('m4max')).toBe('/data/remote/m4max/claude');
  });
});
