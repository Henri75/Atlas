import { describe, expect, it } from 'vitest';
import { extractLiteral, literalShape, spellingIn } from '../../packages/eval/src/literals.js';

/**
 * Pool L needs a literal to build a question around: the size, version, sha or
 * column name a person would actually quote when asking about something months
 * later ("the 6.8MB json", "the whale's tags_with_counts row").
 *
 * Deliberately **not** built on `isLiteralToken` from `@atlas/core`, even though
 * that predicate answers a similar question. That one is part of the retrieval
 * code this pool exists to test; sharing it would let a change to the ranking
 * silently reshape the fixture that is supposed to hold it to account. This is
 * an independent definition of "looks like a literal", by shape alone.
 */
describe('literalShape', () => {
  it('recognises measurements, versions, shas and identifiers', () => {
    expect(literalShape('6.8MB')).toBe('measurement');
    expect(literalShape('462ms')).toBe('measurement');
    expect(literalShape('v1.18.2')).toBe('version');
    expect(literalShape('1.18.2')).toBe('version');
    expect(literalShape('4277bf0b')).toBe('sha');
    expect(literalShape('tags_with_counts')).toBe('identifier');
    expect(literalShape('deepcast.io')).toBe('dotted');
  });

  it('rejects ordinary prose and bare numbers', () => {
    for (const t of ['quite', 'frontend', 'the', '2026', '17']) expect(literalShape(t)).toBeNull();
  });

  /**
   * A year or a plain count is not discriminative — the corpus is full of them,
   * and a question built around "2026" would measure nothing.
   */
  it('does not treat a bare integer as a measurement', () => {
    expect(literalShape('621')).toBeNull();
  });
});

describe('extractLiteral', () => {
  it('finds the measurement in a real backlog line', () => {
    const text =
      "Dashboard facets: the whale user's mv_user_metadata_aggregations.tags_with_counts " +
      'is 6.8MB JSONB (621k videos) — every dashboard facet read detoasts it (>1s)';
    expect(extractLiteral(text)).toBe('6.8mb');
  });

  it('prefers a measurement over an identifier in the same text', () => {
    // Measurements are the shape that broke: they were shredded into a colliding
    // fragment, while identifiers survived tokenisation intact.
    expect(extractLiteral('the tags_with_counts column reached 6.8MB')).toBe('6.8mb');
  });

  it('falls back to an identifier when there is no measurement', () => {
    expect(extractLiteral('the mv_user_metadata_aggregations view was rebuilt')).toBe(
      'mv_user_metadata_aggregations',
    );
  });

  it('returns null for text with nothing quotable', () => {
    expect(extractLiteral('we fixed the thing that was slow and shipped it')).toBeNull();
  });

  it('ignores a literal too long to be quoted naturally', () => {
    const huge = `a${'b'.repeat(60)}_c`;
    expect(extractLiteral(`the ${huge} thing`)).toBeNull();
  });

  it('is deterministic for the same text', () => {
    const text = 'bumped to v1.18.2 after the 6.8MB regression in tags_with_counts';
    expect(extractLiteral(text)).toBe(extractLiteral(text));
  });
});

/**
 * `6.8` on its own is a decimal, not a version. It only looked like one because
 * the version pattern accepted two components — and a question built around
 * "6.8" would match half the corpus, measuring nothing. A version needs either a
 * `v` prefix or three components.
 */
describe('literalShape version disambiguation', () => {
  it('does not call a bare two-part decimal a version', () => {
    expect(literalShape('6.8')).toBeNull();
    expect(literalShape('1.5')).toBeNull();
  });

  it('still recognises real versions', () => {
    expect(literalShape('v1.18')).toBe('version');
    expect(literalShape('1.18.2')).toBe('version');
    expect(literalShape('v4.12.28')).toBe('version');
  });

  it('does not pick a decimal out of a spaced measurement', () => {
    // "6.8 MB" tokenises to "6.8" and "mb", neither of which is quotable alone.
    expect(extractLiteral('the row was 6.8 MB in total')).toBeNull();
  });
});

/**
 * The question must quote the literal as the entry spells it. Asking about
 * "6.8MB" when the entry says "6.8 MB" is a different and much harder test, and
 * conflating them would hide which spelling regressed.
 */
describe('spellingIn', () => {
  it('returns the literal with the casing the source used', () => {
    expect(spellingIn('the row is 6.8MB of JSONB', '6.8mb')).toBe('6.8MB');
    expect(spellingIn('bumped to V1.18.2 today', 'v1.18.2')).toBe('V1.18.2');
  });

  it('returns null when the literal is not present', () => {
    expect(spellingIn('nothing quotable here', '6.8mb')).toBeNull();
  });

  it('is not confused by regex metacharacters in the literal', () => {
    // A dotted identifier contains `.`, which as a pattern would match anything.
    expect(spellingIn('see DeepCast.io for details', 'deepcast.io')).toBe('DeepCast.io');
    expect(spellingIn('see deepcastxio for details', 'deepcast.io')).toBeNull();
  });
});
