import { describe, expect, it } from 'vitest';
import { deriveDocAge, isArchivedDocPath } from '@kdbscope/core';

describe('isArchivedDocPath', () => {
  it.each([
    'docs/archive/old-design.md',
    'docs/archives/2024/notes.md',
    'docs/archived/x.md',
    'docs/_archive/x.md',
    'docs/_legacy/auth.md',
    'docs/legacy/auth.md',
    'docs/old/readme.md',
    'docs/deprecated/api.md',
    'docs/Previous/INNERTUBE.md',
    'docs/Previous/archive/deep.md',
    'docs/obsolete/x.md',
    'docs/superseded/x.md',
    'docs/outdated/x.md',
    'docs/backup/x.md',
    'docs/backups/x.md',
    'docs/bak/x.md',
    'docs/OLD/x.md',
  ])('flags %s', (p) => {
    expect(isArchivedDocPath(p)).toBe(true);
  });

  it('flags archived filename stems', () => {
    expect(isArchivedDocPath('docs/auth.deprecated.md')).toBe(true);
    expect(isArchivedDocPath('docs/design-old.md')).toBe(true);
    expect(isArchivedDocPath('README_legacy.md')).toBe(true);
  });

  it.each([
    'docs/architecture/overview.md',
    'docs/golden/fixtures.md',
    'README.md',
    'docs/getting-started.md',
    // "old" must match a whole token, not a substring.
    'docs/goldilocks/x.md',
    'docs/scaffold.md',
  ])('does not flag %s', (p) => {
    expect(isArchivedDocPath(p)).toBe(false);
  });
});

describe('deriveDocAge', () => {
  const now = Date.parse('2026-07-11T00:00:00Z');

  it('marks docs older than the threshold as aging, with their age', () => {
    const r = deriveDocAge('2025-05-01T00:00:00Z', 12, now);
    expect(r.status).toBe('aging');
    expect(r.ageMonths).toBe(14);
  });

  it('leaves younger docs active but still reports age', () => {
    const r = deriveDocAge('2025-09-01T00:00:00Z', 12, now);
    expect(r.status).toBe('active');
    expect(r.ageMonths).toBe(10);
  });

  it('boundary: exactly at the threshold is aging', () => {
    const r = deriveDocAge('2025-07-05T00:00:00Z', 12, now);
    expect(r.status).toBe('aging');
    expect(r.ageMonths).toBe(12);
  });

  it('no or invalid date → active with no age (never a false label)', () => {
    expect(deriveDocAge(undefined, 12, now)).toEqual({ status: 'active' });
    expect(deriveDocAge('not-a-date', 12, now)).toEqual({ status: 'active' });
  });
});
