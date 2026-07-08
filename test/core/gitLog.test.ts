import { describe, expect, it } from 'vitest';
import { parseGitLog } from '@kdbscope/core';

const ctx = { projectSlug: 'deepcast', repoPath: '/data/code/DeepCast' };

const RAW =
  '\x01aaa111\x1f2026-07-08T22:00:00+02:00\x1fnasta\x1ffix: pgbouncer stale pidfile crash-loop\n' +
  'M\tbackend/docker/pgbouncer.ini\n' +
  'A\tmigrations/044_retired_at.sql\n' +
  '\x01bbb222\x1f2026-07-07T10:00:00+02:00\x1fnasta\x1ffeat: VideoCard system\n' +
  'R100\told/Card.tsx\tsrc/VideoCard.tsx\n';

describe('parseGitLog', () => {
  it('parses commits with name-status file lists', () => {
    const entries = parseGitLog(RAW, ctx);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      sourceType: 'git_commit',
      title: 'fix: pgbouncer stale pidfile crash-loop',
      sourceRef: 'aaa111',
      occurredAt: '2026-07-08T22:00:00+02:00',
    });
    expect((entries[0]!.meta as any).files).toEqual([
      'backend/docker/pgbouncer.ini',
      'migrations/044_retired_at.sql',
    ]);
    // Renames keep the NEW path (last tab field).
    expect((entries[1]!.meta as any).files).toEqual(['src/VideoCard.tsx']);
  });

  it('returns empty for empty output', () => {
    expect(parseGitLog('', ctx)).toEqual([]);
  });
});
