import { describe, expect, it } from 'vitest';
import { resolveProjectAlias } from '@atlas/core';

/**
 * When a repo moves, its old Claude transcripts stop matching any known code
 * root, so they are filed under a slug derived from the whole old path
 * ("users-nasta-documents-coding-new-deepcast"). Those are not duplicates —
 * they are the only copy of that era's history, 27,300 entries of it, and a
 * search scoped to "deepcast" silently missed every one.
 *
 * Matching is on slugs alone: a ghost slug ends with the canonical slug because
 * both are derived from the same trailing path segments.
 */

const canonical = [
  { slug: 'deepcast', rootPath: '/Users/nasta/__CODING NEW/DeepCast' },
  { slug: 'deepcast-lycos', rootPath: '/Users/nasta/__CODING NEW/DeepCast/Lycos' },
  { slug: 'google-gemini-pool', rootPath: '/Users/nasta/__CODING NEW/google-gemini-pool' },
  { slug: 'askall', rootPath: '/Users/nasta/__CODING NEW/AskAll' },
  { slug: 'masterclass-web', rootPath: '/Users/nasta/__CODING NEW/masterclass-web' },
];

describe('resolveProjectAlias', () => {
  it('maps a moved checkout to its canonical project', () => {
    expect(resolveProjectAlias('users-nasta-documents-coding-new-deepcast', canonical)).toBe(
      'deepcast',
    );
    expect(resolveProjectAlias('volumes-cloudbox-coding-deepcast', canonical)).toBe('deepcast');
    expect(resolveProjectAlias('volumes-cloudbox-coding-askall', canonical)).toBe('askall');
  });

  it('prefers the deepest project when one slug is a suffix of another', () => {
    // Must not collapse Lycos into its parent: "…-deepcast-lycos" ends with
    // "-lycos", not "-deepcast", but a naive contains() check would pick either.
    expect(resolveProjectAlias('users-nasta-documents-coding-new-deepcast-lycos', canonical)).toBe(
      'deepcast-lycos',
    );
  });

  it('leaves genuinely standalone directories alone', () => {
    // A code root, not a project.
    expect(resolveProjectAlias('users-nasta-coding-new', canonical)).toBeNull();
    // Real projects that simply are not indexed from a known root.
    expect(resolveProjectAlias('myllm', canonical)).toBeNull();
    expect(resolveProjectAlias('freerouting', canonical)).toBeNull();
    expect(resolveProjectAlias('private-tmp', canonical)).toBeNull();
    expect(
      resolveProjectAlias('users-nasta-paperclip-instances-default-workspaces-1673e977', canonical),
    ).toBeNull();
  });

  it('does not alias a project to itself', () => {
    expect(resolveProjectAlias('deepcast', canonical)).toBeNull();
  });

  /**
   * Only a discovered project (one with a real rootPath) may be an alias target.
   * Pointing one ghost at another would chain aliases and resolve nothing.
   */
  it('refuses to alias onto another ghost', () => {
    const withGhost = [...canonical, { slug: 'masterclass-app', rootPath: '' }];
    expect(
      resolveProjectAlias('volumes-cloudbox-coding-masterclass-dl-masterclass-app', withGhost),
    ).toBeNull();
  });

  it('requires a segment boundary, not a bare substring', () => {
    // "…-notdeepcast" must not match "deepcast".
    expect(resolveProjectAlias('volumes-x-notdeepcast', canonical)).toBeNull();
  });

  it('takes the longest matching suffix when several could match', () => {
    const overlapping = [
      { slug: 'shared', rootPath: '/a/shared' },
      { slug: 'x-shared', rootPath: '/b/x/shared' },
    ];
    // Ends with both "-shared" and "-x-shared"; the deeper project wins.
    // No tie is possible beyond this: projects.slug is UNIQUE, so at most one
    // project can carry the longest matching suffix.
    expect(resolveProjectAlias('volumes-cloudbox-x-shared', overlapping)).toBe('x-shared');
  });
});
