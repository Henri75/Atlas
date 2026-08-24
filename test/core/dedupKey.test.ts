import { describe, expect, it } from 'vitest';
import { Catalog } from '@atlas/core';
import type { Entry } from '@atlas/core';

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

/**
 * A transcript's directory name encodes the host path it was recorded under
 * (`-Users-nasta---CODING-NEW-DeepCast`). Migrating to another machine renames
 * every one of them; the key must not notice, or the whole corpus re-indexes as
 * new (2026-08-24: 347k rows, each re-embedded).
 */
describe('Catalog.dedupKey for Claude transcripts', () => {
  const dir = '/data/claude/projects';
  const transcript: Entry = {
    projectSlug: 'deepcast',
    sourceType: 'claude_session',
    sessionId: '74701c4c-3684-4878-bffc-d3499fe76f4d',
    title: 'Insight: something',
    body: 'the body',
    sourcePath: `${dir}/-Users-nasta---CODING-NEW-DeepCast/74701c4c-3684-4878-bffc-d3499fe76f4d.jsonl`,
  };
  const moved: Entry = {
    ...transcript,
    projectSlug: 'users-nasta-coding-new-deepcast', // attribution differs per machine too
    sourcePath: `${dir}/-Users-serge--CODING-DeepCast/74701c4c-3684-4878-bffc-d3499fe76f4d.jsonl`,
  };

  it('is identical for the same transcript under a renamed directory and a different attribution', () => {
    expect(Catalog.dedupKey(moved, dir)).toBe(Catalog.dedupKey(transcript, dir));
  });

  it('keeps nested paths (subagent transcripts) distinct from the top-level file', () => {
    const nested = {
      ...transcript,
      sourcePath: `${dir}/-Users-serge--CODING-DeepCast/sub/74701c4c-3684-4878-bffc-d3499fe76f4d.jsonl`,
    };
    expect(Catalog.dedupKey(nested, dir)).not.toBe(Catalog.dedupKey(transcript, dir));
  });

  it('still separates different sessions, titles and bodies', () => {
    const keys = new Set([
      Catalog.dedupKey(transcript, dir),
      Catalog.dedupKey({ ...transcript, sourcePath: `${dir}/-Users-serge--CODING-DeepCast/other.jsonl` }, dir),
      Catalog.dedupKey({ ...transcript, title: 'other' }, dir),
      Catalog.dedupKey({ ...transcript, body: 'other' }, dir),
    ]);
    expect(keys.size).toBe(4);
  });

  it('falls back to the full path when the file is not under the transcripts root', () => {
    const a = Catalog.dedupKey({ ...transcript, sourcePath: '/elsewhere/a.jsonl' }, dir);
    const b = Catalog.dedupKey({ ...transcript, sourcePath: '/elsewhere/b.jsonl' }, dir);
    expect(a).not.toBe(b);
  });

  it('leaves project-file sources path- and project-scoped', () => {
    expect(Catalog.dedupKey(base, dir)).not.toBe(Catalog.dedupKey({ ...base, projectSlug: 'swan' }, dir));
  });
});
