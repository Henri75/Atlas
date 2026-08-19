import { describe, expect, it } from 'vitest';
import {
  editorUrl,
  lineFromSourceRef,
  mappingsFromConfig,
  mirrorMappings,
  remoteEditorUrl,
  resolveLocation,
  toHostPath,
} from '@atlas/core';
import { parseConfig } from '@atlas/core';
import type { MachinesFile } from '@atlas/core';

const MAPPINGS = [
  { containerRoot: '/data/claude/projects', hostRoot: '/Users/nasta/.claude/projects' },
  { containerRoot: '/data/code', hostRoot: '/Users/nasta/__CODING NEW' },
];

describe('toHostPath', () => {
  it('rewrites a code path to its host equivalent', () => {
    expect(toHostPath('/data/code/DeepCast/kdb/changelog.log', MAPPINGS)).toBe(
      '/Users/nasta/__CODING NEW/DeepCast/kdb/changelog.log',
    );
  });

  it('rewrites a claude transcript path', () => {
    expect(toHostPath('/data/claude/projects/x/abc.jsonl', MAPPINGS)).toBe(
      '/Users/nasta/.claude/projects/x/abc.jsonl',
    );
  });

  it('maps the mount root itself', () => {
    expect(toHostPath('/data/code', MAPPINGS)).toBe('/Users/nasta/__CODING NEW');
  });

  it('leaves an unmapped path untouched rather than guessing', () => {
    expect(toHostPath('/etc/passwd', MAPPINGS)).toBe('/etc/passwd');
    // A prefix that only *looks* like the mount must not match.
    expect(toHostPath('/data/codex/thing', MAPPINGS)).toBe('/data/codex/thing');
  });

  it('is a no-op when no mappings are configured', () => {
    expect(toHostPath('/data/code/x', [])).toBe('/data/code/x');
  });
});

describe('mappingsFromConfig', () => {
  it('builds mappings only for configured host roots, most specific first', () => {
    const cfg = parseConfig({
      CODE_ROOT_HOST: '/Users/nasta/__CODING NEW',
      CLAUDE_PROJECTS_HOST: '/Users/nasta/.claude/projects',
    });
    const m = mappingsFromConfig(cfg);
    expect(m[0]!.containerRoot.length).toBeGreaterThanOrEqual(m[1]!.containerRoot.length);
    expect(toHostPath('/data/code/a', m)).toBe('/Users/nasta/__CODING NEW/a');
  });

  it('yields nothing when host roots are unset', () => {
    expect(mappingsFromConfig(parseConfig({}))).toEqual([]);
  });
});

describe('editorUrl', () => {
  it('encodes spaces in the path', () => {
    expect(editorUrl('/Users/nasta/__CODING NEW/DeepCast/a.ts')).toBe(
      'vscode://file/Users/nasta/__CODING%20NEW/DeepCast/a.ts',
    );
  });

  it('appends a line number when known', () => {
    expect(editorUrl('/x/a.log', 42)).toBe('vscode://file/x/a.log:42');
  });
});

/** Two enabled non-self machines plus one disabled — the filtering matrix. */
const FLEET: MachinesFile = {
  machines: [
    {
      name: 'nasta-mbp',
      address: '192.168.1.20',
      user: 'nasta',
      codeRoots: ['/Users/nasta/__CODING NEW'],
      claudeProjects: '/Users/nasta/.claude/projects',
      enabled: true,
      remoteRsyncPath: '/opt/homebrew/bin/rsync',
      slugOverrides: {},
    },
    {
      name: 'm4max',
      address: '192.168.1.30',
      user: 'serge',
      codeRoots: ['/Users/serge/CODING', '/Users/serge/other'],
      claudeProjects: '/Users/serge/.claude/projects',
      enabled: true,
      remoteRsyncPath: '/opt/homebrew/bin/rsync',
      slugOverrides: {},
    },
    {
      name: 'mac-mini',
      address: '192.168.1.40',
      user: 'nasta',
      codeRoots: ['/Users/nasta/mini'],
      claudeProjects: '/Users/nasta/mini/.claude/projects',
      enabled: false,
      remoteRsyncPath: '/opt/homebrew/bin/rsync',
      slugOverrides: {},
    },
  ],
  sync: { intervalMin: 10, excludes: [] },
};

describe('mirrorMappings', () => {
  it('builds container→host mappings for every enabled non-self machine, 1-based code roots', () => {
    const m = mirrorMappings(FLEET, 'nasta-mbp');
    // self (nasta-mbp) and disabled (mac-mini) contribute nothing.
    expect(m.every((x) => x.machine === 'm4max')).toBe(true);
    expect(m).toHaveLength(3); // 2 code roots + 1 claude dir, for m4max only

    expect(m).toContainEqual({
      containerRoot: '/data/remote/m4max/code1',
      hostRoot: '/Users/serge/CODING',
      machine: 'm4max',
      sshUser: 'serge',
      sshAddress: '192.168.1.30',
    });
    expect(m).toContainEqual({
      containerRoot: '/data/remote/m4max/code2',
      hostRoot: '/Users/serge/other',
      machine: 'm4max',
      sshUser: 'serge',
      sshAddress: '192.168.1.30',
    });
    expect(m).toContainEqual({
      containerRoot: '/data/remote/m4max/claude',
      hostRoot: '/Users/serge/.claude/projects',
      machine: 'm4max',
      sshUser: 'serge',
      sshAddress: '192.168.1.30',
    });
  });

  it('yields nothing when every other machine is disabled or self', () => {
    expect(mirrorMappings(FLEET, 'm4max').some((x) => x.machine === 'mac-mini')).toBe(false);
    expect(mirrorMappings(FLEET, 'm4max').every((x) => x.machine !== 'm4max')).toBe(true);
  });
});

describe('resolveLocation', () => {
  it('resolves a mirrored path to the remote host path plus machine/ssh fields', () => {
    const mappings = mirrorMappings(FLEET, 'nasta-mbp');
    expect(resolveLocation('/data/remote/m4max/code1/x/kdb/changelog.log', mappings)).toEqual({
      hostPath: '/Users/serge/CODING/x/kdb/changelog.log',
      machine: 'm4max',
      sshUser: 'serge',
      sshAddress: '192.168.1.30',
    });
  });

  it('same longest-prefix specificity as toHostPath — a config mapping stays machine-less', () => {
    expect(resolveLocation('/data/code/DeepCast/a.ts', MAPPINGS)).toEqual({
      hostPath: '/Users/nasta/__CODING NEW/DeepCast/a.ts',
    });
  });

  it('unmatched path passes through with no machine/ssh fields at all', () => {
    const mappings = mirrorMappings(FLEET, 'nasta-mbp');
    expect(resolveLocation('/etc/passwd', mappings)).toEqual({ hostPath: '/etc/passwd' });
  });
});

describe('remoteEditorUrl', () => {
  it('builds a vscode-remote deep link from sshUser/sshAddress/hostPath', () => {
    expect(
      remoteEditorUrl({
        hostPath: '/Users/serge/CODING/x/kdb/changelog.log',
        sshUser: 'serge',
        sshAddress: '192.168.1.30',
      }),
    ).toBe('vscode://vscode-remote/ssh-remote+serge@192.168.1.30/Users/serge/CODING/x/kdb/changelog.log');
  });

  it('encodes spaces in the path', () => {
    expect(
      remoteEditorUrl({
        hostPath: '/Users/serge/__CODING NEW/DeepCast/a.ts',
        sshUser: 'serge',
        sshAddress: '192.168.1.30',
      }),
    ).toBe(
      'vscode://vscode-remote/ssh-remote+serge@192.168.1.30/Users/serge/__CODING%20NEW/DeepCast/a.ts',
    );
  });

  it('never appends a :line suffix — the remote URI scheme ignores it', () => {
    const url = remoteEditorUrl(
      { hostPath: '/x/a.log', sshUser: 'serge', sshAddress: '192.168.1.30' },
      42,
    );
    expect(url).toBe('vscode://vscode-remote/ssh-remote+serge@192.168.1.30/x/a.log');
    expect(url).not.toContain(':42');
  });
});

describe('lineFromSourceRef', () => {
  it('extracts a line from kdb log refs', () => {
    expect(lineFromSourceRef('line:128')).toBe(128);
  });

  it('returns undefined for commit shas and missing refs', () => {
    expect(lineFromSourceRef('aaa111bbb')).toBeUndefined();
    expect(lineFromSourceRef(undefined)).toBeUndefined();
  });
});
