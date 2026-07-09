import { describe, expect, it } from 'vitest';
import { Catalog } from '@kdbscope/core';
import type { Entry } from '@kdbscope/core';

const base: Entry = {
  projectSlug: 'deepcast',
  sourceType: 'kdb_changelog',
  title: 'fix bug',
  body: 'body text',
  sourcePath: '/data/code/DeepCast/kdb/changelog.log',
  sourceRef: 'line:1',
};

/**
 * dedup_key is what makes re-scanning idempotent: a colliding key means the
 * second entry is silently never inserted, never embedded, never searchable.
 */
describe('Catalog.dedupKey', () => {
  it('is stable for the same entry', () => {
    expect(Catalog.dedupKey(base)).toBe(Catalog.dedupKey({ ...base }));
  });

  it('changes when the body changes, so edits are re-indexed', () => {
    expect(Catalog.dedupKey(base)).not.toBe(Catalog.dedupKey({ ...base, body: 'different' }));
  });

  it('separates entries that differ only by title, ref, path or project', () => {
    const keys = new Set([
      Catalog.dedupKey(base),
      Catalog.dedupKey({ ...base, title: 'other' }),
      Catalog.dedupKey({ ...base, sourceRef: 'line:2' }),
      Catalog.dedupKey({ ...base, sourcePath: '/other.log' }),
      Catalog.dedupKey({ ...base, projectSlug: 'swan' }),
    ]);
    expect(keys.size).toBe(5);
  });

  /** Regression: a space-joined key let a boundary migrate between fields. */
  it('does not collide when a space shifts between ref and title', () => {
    const a = Catalog.dedupKey({ ...base, sourceRef: 'line:1', title: 'fix bug' });
    const b = Catalog.dedupKey({ ...base, sourceRef: 'line:1 fix', title: 'bug' });
    expect(a).not.toBe(b);
  });

  it('treats a missing sourceRef as distinct from an empty-looking title', () => {
    const a = Catalog.dedupKey({ ...base, sourceRef: undefined, title: 'x' });
    const b = Catalog.dedupKey({ ...base, sourceRef: 'x', title: '' });
    expect(a).not.toBe(b);
  });
});
