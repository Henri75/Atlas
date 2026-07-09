import { describe, expect, it } from 'vitest';
import { buildQdrantFilter } from '@kdbscope/core';

/**
 * An over-broad filter silently returns the wrong rows; an over-narrow one
 * silently returns none. Neither raises an error, so this is worth pinning.
 */
describe('buildQdrantFilter', () => {
  it('returns undefined when nothing is filtered, so Qdrant scans everything', () => {
    expect(buildQdrantFilter({})).toBeUndefined();
  });

  it('filters by project, source type and component as exact keyword matches', () => {
    expect(
      buildQdrantFilter({ project: 'deepcast', sourceType: 'git_commit', component: 'worker' }),
    ).toEqual({
      must: [
        { key: 'project', match: { value: 'deepcast' } },
        { key: 'source_type', match: { value: 'git_commit' } },
        { key: 'component', match: { value: 'worker' } },
      ],
    });
  });

  it('collapses since/until into one range clause', () => {
    expect(buildQdrantFilter({ since: '2026-01-01', until: '2026-02-01' })).toEqual({
      must: [{ key: 'occurred_at', range: { gte: '2026-01-01', lte: '2026-02-01' } }],
    });
  });

  it('supports an open-ended range in either direction', () => {
    expect(buildQdrantFilter({ since: '2026-01-01' })).toEqual({
      must: [{ key: 'occurred_at', range: { gte: '2026-01-01' } }],
    });
    expect(buildQdrantFilter({ until: '2026-01-01' })).toEqual({
      must: [{ key: 'occurred_at', range: { lte: '2026-01-01' } }],
    });
  });

  it('ignores empty strings rather than filtering on ""', () => {
    // An empty project would otherwise match nothing at all.
    expect(buildQdrantFilter({ project: '', component: '' })).toBeUndefined();
  });
});
