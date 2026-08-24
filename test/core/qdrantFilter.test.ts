import { describe, expect, it } from 'vitest';
import { buildQdrantFilter } from '@atlas/core';

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

  it('matches any of several source types with an OR clause', () => {
    expect(buildQdrantFilter({ sourceTypes: ['doc', 'kdb_component'] })).toEqual({
      must: [{ key: 'source_type', match: { any: ['doc', 'kdb_component'] } }],
    });
  });

  it('collapses a single-element sourceTypes to an equality match', () => {
    expect(buildQdrantFilter({ sourceTypes: ['doc'] })).toEqual({
      must: [{ key: 'source_type', match: { value: 'doc' } }],
    });
  });

  it('lets sourceTypes win over the legacy singular sourceType', () => {
    expect(buildQdrantFilter({ sourceType: 'git_commit', sourceTypes: ['doc', 'kdb_report'] })).toEqual({
      must: [{ key: 'source_type', match: { any: ['doc', 'kdb_report'] } }],
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

  /** Classification is decoration unless you can actually query it. */
  it('filters by message kind', () => {
    expect(buildQdrantFilter({ kind: 'insight' })).toEqual({
      must: [{ key: 'kind', match: { value: 'insight' } }],
    });
  });

  it('combines kind with the other filters', () => {
    const f = buildQdrantFilter({ project: 'deepcast', kind: 'summary' })!;
    expect(f.must).toHaveLength(2);
  });

  it('ignores empty strings rather than filtering on ""', () => {
    // An empty project would otherwise match nothing at all.
    expect(buildQdrantFilter({ project: '', component: '' })).toBeUndefined();
  });
});

describe('buildQdrantFilter docStatus', () => {
  it("'archived' targets archived docs directly", () => {
    expect(buildQdrantFilter({ docStatus: 'archived' })).toEqual({
      must: [{ key: 'doc_status', match: { value: 'archived' } }],
    });
  });

  it("'active' excludes archived without hiding untagged entries", () => {
    expect(buildQdrantFilter({ docStatus: 'active' })).toEqual({
      must: [],
      must_not: [{ key: 'doc_status', match: { value: 'archived' } }],
    });
  });
});

/**
 * spec §6: 'machine' means "first ingested from", not "currently present on".
 * Filters exactly like component — an exact keyword match, no index behind it
 * (see the `PAYLOAD_INDEXES` guard test in qdrantStorage.test.ts).
 */
describe('buildQdrantFilter machine', () => {
  it('filters by machine as an exact keyword match', () => {
    expect(buildQdrantFilter({ machine: 'nasta-mbp' })).toEqual({
      must: [{ key: 'machine', match: { value: 'nasta-mbp' } }],
    });
  });

  it('ignores an empty machine string rather than filtering on ""', () => {
    // '' is the legacy pre-machine-model sentinel (spec §6); no surface ever
    // sends it as a real filter value, and treating it as "no constraint" —
    // same as project/component above — keeps it that way.
    expect(buildQdrantFilter({ machine: '' })).toBeUndefined();
  });

  it('combines machine with the other filters', () => {
    expect(buildQdrantFilter({ project: 'deepcast', machine: 'nasta-mbp' })).toEqual({
      must: [
        { key: 'project', match: { value: 'deepcast' } },
        { key: 'machine', match: { value: 'nasta-mbp' } },
      ],
    });
  });
});

/**
 * Projects filter exactly like source types: one is an equality, several are an
 * OR, none is no constraint. The two must stay symmetric — they are the same
 * idiom, and a reader should be able to trust that.
 */
describe('buildQdrantFilter projects', () => {
  it('matches a single project by value', () => {
    expect(buildQdrantFilter({ project: 'deepcast' })).toEqual({
      must: [{ key: 'project', match: { value: 'deepcast' } }],
    });
  });

  it('matches several projects with `any` (an OR, not an AND)', () => {
    // An `all`/AND here would ask for entries belonging to both projects at
    // once — an empty set, since an entry has exactly one project.
    expect(buildQdrantFilter({ projects: ['deepcast', 'atlas'] })).toEqual({
      must: [{ key: 'project', match: { any: ['deepcast', 'atlas'] } }],
    });
  });

  it('collapses a one-item `projects` list to an equality match', () => {
    expect(buildQdrantFilter({ projects: ['atlas'] })).toEqual({
      must: [{ key: 'project', match: { value: 'atlas' } }],
    });
  });

  it('lets the plural win over the singular, like sourceTypes does', () => {
    expect(buildQdrantFilter({ project: 'ignored', projects: ['a', 'b'] })).toEqual({
      must: [{ key: 'project', match: { any: ['a', 'b'] } }],
    });
  });

  it('applies no project constraint when neither is given', () => {
    expect(buildQdrantFilter({})).toBeUndefined();
  });

  it('combines a project set with a source-type set', () => {
    expect(buildQdrantFilter({ projects: ['a', 'b'], sourceTypes: ['doc', 'git_commit'] })).toEqual({
      must: [
        { key: 'project', match: { any: ['a', 'b'] } },
        { key: 'source_type', match: { any: ['doc', 'git_commit'] } },
      ],
    });
  });
});
