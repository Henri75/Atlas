import { describe, expect, it } from 'vitest';
import {
  claudeDirFallbackSlug,
  encodeClaudePath,
  matchClaudeDirToProject,
  slugify,
} from '@kdbscope/core';

describe('encodeClaudePath', () => {
  it('matches Claude Code dir-name encoding (verified against real dirs)', () => {
    expect(encodeClaudePath('/Users/nasta/__CODING NEW/DeepCast')).toBe(
      '-Users-nasta---CODING-NEW-DeepCast',
    );
    expect(encodeClaudePath('/Users/nasta/__CODING NEW/fwdr.it')).toBe(
      '-Users-nasta---CODING-NEW-fwdr-it',
    );
  });
});

/**
 * Regression: projects are discovered at their *container* path
 * (`/data/code/DeepCast`) but Claude Code names its transcript directory after
 * the *host* cwd (`-Users-nasta---CODING-NEW-DeepCast`). Matching on the
 * container path matched nothing, so every project was silently split in two —
 * `deepcast` (7,871 entries from its files) and `users-nasta-coding-new-deepcast`
 * (24,098 entries from its transcripts).
 */
describe('matchClaudeDirToProject with container mounts', () => {
  const mounted = [
    {
      slug: 'deepcast',
      rootPath: '/data/code/DeepCast',
      hostPath: '/Users/nasta/__CODING NEW/DeepCast',
    },
    {
      slug: 'lycos',
      rootPath: '/data/code/DeepCast/Lycos',
      hostPath: '/Users/nasta/__CODING NEW/DeepCast/Lycos',
    },
  ];

  it('matches a Claude dir to the project mounted from that host path', () => {
    expect(
      matchClaudeDirToProject('-Users-nasta---CODING-NEW-DeepCast', mounted)?.slug,
    ).toBe('deepcast');
  });

  it('still prefers the deepest project', () => {
    expect(
      matchClaudeDirToProject('-Users-nasta---CODING-NEW-DeepCast-Lycos', mounted)?.slug,
    ).toBe('lycos');
  });

  it('never matches the container path, which the dir name never encodes', () => {
    expect(matchClaudeDirToProject('-data-code-DeepCast', mounted)).toBeNull();
  });

  it('falls back to rootPath when a project has no host mapping', () => {
    const local = [{ slug: 'x', rootPath: '/Users/nasta/x' }];
    expect(matchClaudeDirToProject('-Users-nasta-x', local)?.slug).toBe('x');
  });
});

describe('matchClaudeDirToProject', () => {
  const projects = [
    { rootPath: '/Users/nasta/__CODING NEW/DeepCast', slug: 'deepcast' },
    { rootPath: '/Users/nasta/__CODING NEW/DeepCast/Lycos', slug: 'lycos' },
    { rootPath: '/Users/nasta/__CODING NEW/Swan', slug: 'swan' },
  ];

  it('matches exact dirs', () => {
    expect(
      matchClaudeDirToProject('-Users-nasta---CODING-NEW-Swan', projects)?.slug,
    ).toBe('swan');
  });

  it('prefers the deepest matching project', () => {
    expect(
      matchClaudeDirToProject('-Users-nasta---CODING-NEW-DeepCast-Lycos', projects)?.slug,
    ).toBe('lycos');
  });

  it('maps sub-dirs of a project to that project', () => {
    expect(
      matchClaudeDirToProject('-Users-nasta---CODING-NEW-DeepCast-backend', projects)?.slug,
    ).toBe('deepcast');
  });

  it('returns null when nothing matches', () => {
    expect(matchClaudeDirToProject('-Users-nasta-elsewhere', projects)).toBeNull();
  });
});

describe('fallback slugs', () => {
  it('slugifies the tail after the code root', () => {
    const root = encodeClaudePath('/Users/nasta/__CODING NEW');
    expect(claudeDirFallbackSlug('-Users-nasta---CODING-NEW-openclaw-app', root)).toBe(
      'openclaw-app',
    );
  });

  it('strips whichever of several roots matches, longest first', () => {
    const roots = [
      encodeClaudePath('/Users/nasta/__CODING NEW'),
      encodeClaudePath('/Users/nasta/__CODING NEW/Archive'),
    ];
    expect(claudeDirFallbackSlug('-Users-nasta---CODING-NEW-Archive-old-thing', roots)).toBe(
      'old-thing',
    );
    expect(claudeDirFallbackSlug('-Users-nasta---CODING-NEW-fresh', roots)).toBe('fresh');
  });

  it('leaves a dir under no known root as a full-path slug', () => {
    const roots = [encodeClaudePath('/Users/nasta/__CODING NEW')];
    expect(claudeDirFallbackSlug('-Volumes-Other-thing', roots)).toBe('volumes-other-thing');
  });
  it('slugify normalizes arbitrary names', () => {
    expect(slugify('Fun/populous!!')).toBe('fun-populous');
  });
});
