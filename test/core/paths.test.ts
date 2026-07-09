import { describe, expect, it } from 'vitest';
import { editorUrl, lineFromSourceRef, mappingsFromConfig, toHostPath } from '@kdbscope/core';
import { parseConfig } from '@kdbscope/core';

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

describe('lineFromSourceRef', () => {
  it('extracts a line from kdb log refs', () => {
    expect(lineFromSourceRef('line:128')).toBe(128);
  });

  it('returns undefined for commit shas and missing refs', () => {
    expect(lineFromSourceRef('aaa111bbb')).toBeUndefined();
    expect(lineFromSourceRef(undefined)).toBeUndefined();
  });
});
