import { describe, expect, it } from 'vitest';
import { buildRsyncArgs, buildSyncExcludes, assertMirrorDest } from '../../packages/indexer/src/sync.js';

const M = { name: 'm4max', address: '192.168.1.30', user: 'serge', codeRoots: ['/Users/serge/CODING'],
  claudeProjects: '/Users/serge/.claude/projects', enabled: true,
  remoteRsyncPath: '/opt/homebrew/bin/rsync', slugOverrides: {} };

describe('rsync args', () => {
  it('code sync: partial-dir not bare --partial; delete; excludes derived from scanners', () => {
    const args = buildRsyncArgs(M, { remotePath: '/Users/serge/CODING', dest: '/data/remote/m4max/code1', kind: 'code' }, buildSyncExcludes([]));
    expect(args).toContain('--partial-dir=.rsync-partial');
    expect(args).not.toContain('--partial');
    expect(args).toContain('--delete');
    expect(args).toContain('--rsync-path=/opt/homebrew/bin/rsync');
    expect(args.some((a) => a === '--exclude=node_modules')).toBe(true);
    expect(args.some((a) => a === '--exclude=.env*')).toBe(true);
    expect(args.some((a) => a === '--exclude=data')).toBe(true);       // scanner parity
    expect(args.at(-2)).toBe('serge@192.168.1.30:/Users/serge/CODING/');
    expect(args.at(-1)).toBe('/data/remote/m4max/code1/');
  });
  it('claude sync: jsonl include-filter, no code excludes needed', () => {
    const args = buildRsyncArgs(M, { remotePath: M.claudeProjects, dest: '/data/remote/m4max/claude', kind: 'claude' }, []);
    const i = args.indexOf('--include=*/');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('--include=*.jsonl');
    expect(args[i + 2]).toBe('--exclude=*');
  });
  it('destination guard refuses escapes', () => {
    expect(() => assertMirrorDest('/data/remote/m4max/code1', 'm4max')).not.toThrow();
    expect(() => assertMirrorDest('/data/code', 'm4max')).toThrow();
    expect(() => assertMirrorDest('/data/remote/other/code1', 'm4max')).toThrow();
    expect(() => assertMirrorDest('/data/remote/../code', 'm4max')).toThrow();
    expect(() => assertMirrorDest('/data/remote/M4 Max/code1', 'M4 Max')).toThrow();
  });
});
