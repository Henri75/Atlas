import { describe, expect, it } from 'vitest';
import { ftsQuery, tokenize } from '@atlas/core';

/**
 * The bug these pin, measured against the live index on 2026-07-26:
 *
 *   websearch_to_tsquery('english', 'worker pool resize procedure supervisorctl stopwaitsecs')
 *     → 'worker' & 'pool' & 'resiz' & 'procedur' & 'supervisorctl' & 'stopwaitsec'  → 0 rows
 *   ...while 'worker pool resize' matched 31 rows and 'supervisorctl' alone matched 182.
 *
 * Because `ftsSearch` is the fallback taken when Qdrant is unreachable, and an
 * empty result comes back as `{ hits: [], mode: 'fts' }`, a caller could not tell
 * a broken fallback from an index that genuinely holds nothing on the subject.
 */
describe('ftsQuery', () => {
  it('ORs the terms so matching some of them is a match', () => {
    expect(ftsQuery('worker pool resize')).toBe('worker | pool | resize');
  });

  it('turns the query that matched nothing into one that can match', () => {
    const q = ftsQuery('worker pool resize procedure supervisorctl stopwaitsecs');
    expect(q).toBe('worker | pool | resize | procedure | supervisorctl | stopwaitsecs');
    // The failure was the conjunction; nothing here may reintroduce it.
    expect(q).not.toContain('&');
  });

  it('drops stopwords, which carry no retrieval signal', () => {
    // Otherwise "why did the pool resize?" would OR in 'the' and 'did' and rank
    // every entry in the corpus above nothing.
    expect(ftsQuery('why did the pool resize?')).toBe('why | pool | resize');
  });

  /**
   * `to_tsquery` has a real operator grammar (`&`, `|`, `!`, `<->`, parentheses),
   * so unsanitised input is a syntax-error and injection surface. Reusing the
   * sparse tokeniser removes the whole class: tokens are `[a-z0-9_]` only.
   */
  it('strips anything to_tsquery could read as an operator', () => {
    for (const nasty of ["a & b", 'a | b', '!a', 'a <-> b', "a:*'", '((()))', "'; DROP TABLE"]) {
      const out = ftsQuery(nasty);
      expect(out).not.toMatch(/[&!:'()<>;]/);
    }
  });

  it('keeps identifiers with underscores and digits intact', () => {
    // These are the highest-signal terms in this corpus — queue names, flags.
    expect(ftsQuery('videoinsight_low int8 quantization')).toBe(
      'videoinsight_low | int8 | quantization',
    );
  });

  it('returns an empty query for input with no usable terms', () => {
    // Matches nothing, which is correct — and must not be a syntax error.
    expect(ftsQuery('the and of')).toBe('');
    expect(ftsQuery('???')).toBe('');
    expect(ftsQuery('')).toBe('');
  });

  it('agrees with the sparse branch about what a term is', () => {
    // The vector and FTS paths degrade into one another, so a disagreement about
    // tokenisation would make the same query mean two different things.
    const q = 'Why does the G2P hstats gauge fill lazily, one sample per poll?';
    expect(ftsQuery(q).split(' | ')).toEqual(tokenize(q));
  });
});
