import { describe, expect, it } from 'vitest';
import { contentHash, deterministicUuid } from '@kdbscope/core';

describe('deterministicUuid', () => {
  it('is stable across calls, so re-indexing upserts instead of duplicating', () => {
    expect(deterministicUuid('deepcast', '/x.log', '1', '0')).toBe(
      deterministicUuid('deepcast', '/x.log', '1', '0'),
    );
  });

  it('has a valid UUID shape with version 5 and the RFC variant bits', () => {
    const id = deterministicUuid('a', 'b');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('distinguishes different parts', () => {
    expect(deterministicUuid('a', 'b')).not.toBe(deterministicUuid('a', 'c'));
    expect(deterministicUuid('deepcast', '/x', '1', '0')).not.toBe(
      deterministicUuid('deepcast', '/x', '1', '1'),
    );
  });

  /**
   * Regression: v1 joined parts with a space, so a boundary could migrate
   * between fields. Two different entries then shared a dedup_key and the
   * second was silently never indexed. Titles are free text, so it was real.
   */
  it('does not let a space move the boundary between parts', () => {
    expect(deterministicUuid('line:1', 'fix bug')).not.toBe(
      deterministicUuid('line:1 fix', 'bug'),
    );
    expect(deterministicUuid('a b', 'c')).not.toBe(deterministicUuid('a', 'b c'));
  });

  it('distinguishes an empty part from a missing one', () => {
    expect(deterministicUuid('a', '', 'b')).not.toBe(deterministicUuid('a', 'b'));
  });

  it('handles paths with spaces (the real code root has one)', () => {
    const a = deterministicUuid('p', '/Users/nasta/__CODING NEW/a.ts', '1', '0');
    const b = deterministicUuid('p', '/Users/nasta/__CODING NEW/a.ts', '1', '1');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-/);
  });
});

describe('contentHash', () => {
  it('is stable and short', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).toHaveLength(16);
  });

  it('separates different bodies', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});
