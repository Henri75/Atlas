import { describe, expect, it } from 'vitest';
import {
  parseBacklog,
  parseChangelog,
  parseComponentLog,
  parseKdbStamp,
  parseSessionLog,
} from '@kdbscope/core';

const ctx = { projectSlug: 'deepcast', sourcePath: '/data/code/DeepCast/kdb/changelog.log' };

// Real-format samples (copied from DeepCast/kdb, 2026-07-09).
const CHANGELOG = `
- [IN-PROGRESS] - [2026-07-08 19:45 UTC] - [Bugfix] - [lycos-infrastructure] - [Investigate MS5/MS7 processing stall after key-pool change + rebuild/restart]
- [COMPLETED] - [2026-07-08 22:27 UTC] - [Feature] - [frontend-themes] - [Phase 2a: VideoCard system (3 anatomies), status-ramp migration, 3-layout dashboard redesign]
not a changelog line
`;

describe('parseKdbStamp', () => {
  it('parses full UTC stamps', () => {
    expect(parseKdbStamp('2026-07-08 22:37 UTC')).toBe('2026-07-08T22:37:00Z');
  });
  it('parses date-only stamps', () => {
    expect(parseKdbStamp('2026-07-03')).toBe('2026-07-03T00:00:00Z');
  });
  it('rejects garbage', () => {
    expect(parseKdbStamp('yesterday')).toBeUndefined();
  });
});

describe('parseChangelog', () => {
  it('parses status, type, component, description and skips non-matching lines', () => {
    const entries = parseChangelog(CHANGELOG, ctx);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      sourceType: 'kdb_changelog',
      component: 'lycos-infrastructure',
      occurredAt: '2026-07-08T19:45:00Z',
      meta: { status: 'IN-PROGRESS', taskType: 'Bugfix' },
    });
    expect(entries[1]!.body).toContain('VideoCard system');
    // Trailing "]" of the bracketed description must be stripped.
    expect(entries[1]!.body.endsWith(']')).toBe(false);
  });
});

describe('parseSessionLog', () => {
  const SESSION = `---
### [2026-07-08 22:07 UTC]

**User Prompt Summary:**
> Parallel G2P session reported client requests growing 5x in 4 days; check the DeepCast side.

**AI Response Summary:**
> Root-caused it: the continuous translation backfill loop ramped to its cap.
---
### [2026-07-08 22:27 UTC]

**User Prompt Summary:**
> Implement Task 12 (final) of DeepCast Phase 2a.

**AI Response Summary:**
> Fixed routeSkeletons.tsx; suite green.
`;
  it('parses blocks with prompt-summary titles and timestamps', () => {
    const entries = parseSessionLog(SESSION, ctx);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.title).toContain('G2P session reported');
    expect(entries[0]!.occurredAt).toBe('2026-07-08T22:07:00Z');
    expect(entries[1]!.body).toContain('routeSkeletons.tsx');
  });
});

describe('parseComponentLog', () => {
  const COMPONENT = `---
### [2026-07-03] - Legacy 3-query LLM path retired (dormant branch + flag)

**Objective:**
- Remove the unreachable legacy LLM path.

**Status:**
- Completed
`;
  it('parses component blocks with component name from ctx', () => {
    const entries = parseComponentLog(COMPONENT, { ...ctx, component: 'analyzer-worker' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sourceType: 'kdb_component',
      component: 'analyzer-worker',
      occurredAt: '2026-07-03T00:00:00Z',
      meta: { status: 'Completed' },
    });
    expect(entries[0]!.title).toContain('Legacy 3-query LLM path retired');
  });
});

describe('parseBacklog', () => {
  const BACKLOG = `
- [2026-07-09] [frontend-themes] VideoCard select-mode click path: one shared parameterized test
- [2026-07-09] Route DashboardSkeleton still mirrors old sidebar layout
`;
  it('parses dated backlog lines with optional component', () => {
    const entries = parseBacklog(BACKLOG, ctx);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.component).toBe('frontend-themes');
    expect(entries[1]!.component).toBeUndefined();
    expect(entries[1]!.occurredAt).toBe('2026-07-09T00:00:00Z');
  });
});
