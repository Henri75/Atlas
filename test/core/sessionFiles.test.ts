import { describe, expect, it } from 'vitest';
import {
  fileIdf,
  fileSimilarity,
  isStopFile,
  normalizeSessionPath,
  normalizeSessionPaths,
  sharedFiles,
} from '@atlas/core';

/**
 * The three path eras that genuinely coexist in this index (verified against
 * the live catalog, 2026-08-28). If these do not collapse onto one key, file
 * overlap between a session from one era and a session from another is zero,
 * and the whole file signal is dead.
 */
const ERAS = [
  '/Users/serge/_CODING/DeepCast/backend/shared/config.py',
  '/Volumes/CloudBox/Projects/DeepCast/backend/shared/config.py',
  '/Users/nasta/__CODING NEW/DeepCast/backend/shared/config.py',
];

describe('normalizeSessionPath', () => {
  it('collapses every recorded path era for the same file onto one key', () => {
    const ctx = { roots: ['/Users/serge/_CODING/DeepCast'], repoNames: ['DeepCast'] };
    const keys = new Set(ERAS.map((p) => normalizeSessionPath(p, ctx)));
    expect([...keys]).toEqual(['backend/shared/config.py']);
  });

  it('prefers the longest matching root, so a nested checkout wins', () => {
    const ctx = {
      roots: ['/Users/serge/_CODING/DeepCast', '/Users/serge/_CODING/DeepCast/Lycos'],
      repoNames: ['DeepCast', 'Lycos'],
    };
    expect(normalizeSessionPath('/Users/serge/_CODING/DeepCast/Lycos/Makefile', ctx)).toBe(
      'makefile',
    );
  });

  it('matches a repo name from the right, so the innermost checkout wins', () => {
    // No roots at all: this is the cross-machine case, where only the
    // repository directory name survives.
    const ctx = { repoNames: ['DeepCast', 'Lycos'] };
    expect(normalizeSessionPath('/Users/nasta/__CODING NEW/DeepCast/Lycos/Makefile', ctx)).toBe(
      'makefile',
    );
  });

  it('keys .claude data files without their host-encoded directory', () => {
    const a = normalizeSessionPath(
      '/Users/nasta/.claude/projects/-Users-nasta---CODING-NEW-DeepCast/memory/MEMORY.md',
    );
    const b = normalizeSessionPath(
      '/Users/serge/.claude/projects/-Users-serge--CODING-DeepCast/memory/MEMORY.md',
    );
    expect(a).toBe('.claude/memory/memory.md');
    expect(a).toBe(b);
  });

  it('falls back to a home-relative key when no repo is recognised', () => {
    expect(normalizeSessionPath('/Users/someone/notes/todo.md')).toBe('~/notes/todo.md');
  });

  it('falls back to the last three segments for an unrecognisable absolute path', () => {
    expect(normalizeSessionPath('/opt/vendor/pkg/deep/nested/file.ts')).toBe(
      'deep/nested/file.ts',
    );
  });

  it('leaves an already-relative path alone', () => {
    expect(normalizeSessionPath('./packages/core/src/ask.ts')).toBe('packages/core/src/ask.ts');
  });

  it('returns empty for junk rather than throwing', () => {
    expect(normalizeSessionPath('')).toBe('');
    expect(normalizeSessionPath('   ')).toBe('');
    expect(normalizeSessionPath(undefined as unknown as string)).toBe('');
  });

  it('returns empty when the path IS the root (no file component)', () => {
    expect(normalizeSessionPath('/Users/serge/_CODING/DeepCast', { roots: ['/Users/serge/_CODING/DeepCast'] })).toBe('');
  });

  it('tolerates a trailing slash on a configured root', () => {
    expect(
      normalizeSessionPath('/Users/serge/_CODING/DeepCast/Makefile', {
        roots: ['/Users/serge/_CODING/DeepCast/'],
      }),
    ).toBe('makefile');
  });
});

describe('normalizeSessionPaths', () => {
  it('dedupes across eras and drops empties, preserving order', () => {
    expect(normalizeSessionPaths([...ERAS, '', '/Users/serge/_CODING/DeepCast/Makefile'], {
      repoNames: ['DeepCast'],
    })).toEqual(['backend/shared/config.py', 'makefile']);
  });
});

describe('fileIdf', () => {
  it('is strictly positive even for a file present in every session', () => {
    expect(fileIdf(100, 100)).toBeGreaterThan(0);
  });

  it('falls monotonically as document frequency rises', () => {
    const rare = fileIdf(1, 2322);
    const common = fileIdf(183, 2322); // MEMORY.md, the corpus's most-touched file
    expect(rare).toBeGreaterThan(common);
    expect(common).toBeGreaterThan(0);
  });

  it('never divides by zero on an empty corpus', () => {
    expect(Number.isFinite(fileIdf(0, 0))).toBe(true);
  });
});

describe('isStopFile', () => {
  // 2,322 sessions in this corpus carry any files at all.
  it('excludes the observed stop-files and keeps identifying ones', () => {
    expect(isStopFile(183, 2322)).toBe(true); // MEMORY.md
    expect(isStopFile(131, 2322)).toBe(true); // Makefile
    expect(isStopFile(66, 2322)).toBe(false); // frontend/src/lib/api.ts
    expect(isStopFile(1, 2322)).toBe(false);
  });

  it('is false on an empty corpus rather than excluding everything', () => {
    expect(isStopFile(0, 0)).toBe(false);
  });
});

describe('fileSimilarity', () => {
  const idfOf = (p: string) => (p === 'makefile' ? 0.2 : 4);

  it('scores total containment high despite very different set sizes', () => {
    const small = ['a.ts', 'b.ts', 'c.ts'];
    const large = [...small, ...Array.from({ length: 262 }, (_, i) => `x${i}.ts`)];
    // Jaccard would give 3/265 = 0.011 here, which reads as unrelated.
    expect(fileSimilarity(small, large, idfOf)).toBeGreaterThan(0.1);
  });

  it('is 1 for identical sets and 0 for disjoint ones', () => {
    expect(fileSimilarity(['a.ts', 'b.ts'], ['b.ts', 'a.ts'], idfOf)).toBeCloseTo(1);
    expect(fileSimilarity(['a.ts'], ['b.ts'], idfOf)).toBe(0);
  });

  it('barely moves when the only shared file is a stop-file', () => {
    const score = fileSimilarity(['makefile', 'a.ts'], ['makefile', 'z.ts'], idfOf);
    expect(score).toBeLessThan(0.02);
    expect(score).toBeGreaterThan(0);
  });

  it('is 0 when either side is empty', () => {
    expect(fileSimilarity([], ['a.ts'], idfOf)).toBe(0);
    expect(fileSimilarity(['a.ts'], [], idfOf)).toBe(0);
  });

  it('is not inflated by duplicates on either side', () => {
    expect(fileSimilarity(['a.ts', 'a.ts'], ['a.ts'], idfOf)).toBeCloseTo(1);
  });
});

describe('sharedFiles', () => {
  it('returns the overlap most-identifying first', () => {
    const idfOf = (p: string) => (p === 'makefile' ? 0.2 : p === 'rare.ts' ? 9 : 4);
    expect(sharedFiles(['makefile', 'mid.ts', 'rare.ts'], ['rare.ts', 'makefile', 'mid.ts'], idfOf)).toEqual([
      'rare.ts',
      'mid.ts',
      'makefile',
    ]);
  });
});
