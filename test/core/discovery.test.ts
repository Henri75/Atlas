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
  it('slugify normalizes arbitrary names', () => {
    expect(slugify('Fun/populous!!')).toBe('fun-populous');
  });
});
