import { describe, expect, it } from 'vitest';
import { SPARSE_VERSION, fnv1a, isLiteralToken, sparseVector, tokenize } from '@atlas/core';

describe('tokenize', () => {
  it('lowercases, drops stopwords and short tokens', () => {
    expect(tokenize('The Video-Import IS a bug_fix x')).toEqual(['video', 'import', 'bug_fix']);
  });

  /**
   * The regression this whole tokeniser exists for (2026-07-29).
   *
   * `.` used to be a separator and single characters were dropped, so `6.8MB`
   * indexed as `["8mb"]`: the significant digit gone, and the remainder sharing
   * one bucket with every other `*.8MB` size in the corpus. Live consequence:
   * asking about a "6.8MB json" ranked the filler word "quite" above the only
   * discriminative term in the question, and the two entries that answered it
   * were nowhere in the top 100.
   */
  it('keeps a measurement whole instead of shredding it at the decimal point', () => {
    expect(tokenize('6.8MB')).toContain('6.8mb');
    expect(tokenize('6.8MB')).not.toContain('8mb');
  });

  it('tokenises the spaced and unspaced spellings of a measurement identically', () => {
    const spaced = [...tokenize('6.8 MB')].sort();
    const unspaced = [...tokenize('6.8MB')].sort();
    expect(spaced).toEqual(unspaced);
  });

  it('no longer collides distinct sizes into one token', () => {
    const shared = tokenize('6.8MB').filter((t) => tokenize('1.8MB').includes(t));
    // Only the bare unit may be shared; the magnitudes must be distinguishable.
    expect(shared).toEqual(['mb']);
  });

  it('keeps versions and addresses atomic', () => {
    expect(tokenize('v1.18.2')).toEqual(['v1.18.2']);
    expect(tokenize('127.0.0.1')).toEqual(['127.0.0.1']);
  });

  /**
   * The other half of the dotted-run rule. Splitting `6.8mb` is the bug;
   * splitting a compound identifier is what keeps a search for one of its parts
   * working, so both the whole and the parts are emitted.
   */
  it('emits a compound identifier both whole and in parts', () => {
    const t = tokenize('mv_user_metadata_aggregations.tags_with_counts');
    expect(t).toContain('mv_user_metadata_aggregations');
    expect(t).toContain('tags_with_counts');
  });

  it('does not fuse a sentence across its final full stop', () => {
    expect(tokenize('the answer is large. to fix it')).toEqual(['answer', 'large', 'fix']);
  });

  it('only joins a number to a real unit', () => {
    // `s3` is not a unit, so the number must not be absorbed into it.
    expect(tokenize('3 s3 buckets')).toEqual(['s3', 'buckets']);
    expect(tokenize('500ms')).toContain('500ms');
  });
});

describe('isLiteralToken', () => {
  it('recognises measurements, identifiers, versions and shas', () => {
    for (const t of ['6.8mb', '500ms', 'tags_with_counts', 'deepcast.io', '4277bf0b', '621'])
      expect(isLiteralToken(t)).toBe(true);
  });

  it('leaves ordinary prose alone', () => {
    for (const t of ['quite', 'large', 'frontend', 'json']) expect(isLiteralToken(t)).toBe(false);
  });
});

describe('SPARSE_VERSION', () => {
  /**
   * Stored and query sparse vectors must come from the same tokeniser or
   * keyword search silently stops matching — no error, no health-check signal.
   * The version is what triggers the re-tokenisation pass, so a tokeniser
   * change that forgets to bump it ships that silent failure.
   */
  it('is a positive integer the indexer can compare against', () => {
    expect(Number.isInteger(SPARSE_VERSION)).toBe(true);
    expect(SPARSE_VERSION).toBeGreaterThan(0);
  });

  /**
   * The guard that makes the version mean something.
   *
   * `SPARSE_VERSION` only protects the index if it is bumped whenever
   * tokenisation changes — and nothing about editing `tokenize()` reminds anyone
   * to do that. Forgetting is silent in every observable way: tests pass, the
   * indexer logs nothing, search returns results, and they are quietly wrong,
   * because the query encoder and 326k stored vectors have stopped agreeing on
   * what a term is.
   *
   * So the tokeniser's behaviour is pinned to a fingerprint over a corpus of the
   * shapes that matter. Any change to what `tokenize` emits fails here, and the
   * only way to make it pass is to look at the diff and decide deliberately
   * whether the stored index must be rebuilt.
   */
  it('is bumped whenever tokenisation changes', () => {
    const corpus = [
      'The Video-Import IS a bug_fix x',
      '6.8MB',
      '6.8 MB',
      '8MB',
      'v1.18.2',
      '127.0.0.1',
      'mv_user_metadata_aggregations.tags_with_counts',
      'deepcast.io/api/tags',
      '621k videos in 500ms',
      'commit 4277bf0b landed. next.',
      '3 s3 buckets',
      '$4.50 per 1.5 GB',
    ];
    const fingerprint = fnv1a(corpus.map((t) => tokenize(t).join(',')).join('|')).toString(16);

    // Changing the tokeniser changes this. If you are here because it failed:
    // bump SPARSE_VERSION in packages/core/src/sparse.ts, update this value, and
    // let the indexer re-tokenise the collection on its next boot.
    expect({ version: SPARSE_VERSION, fingerprint }).toEqual({
      version: 2,
      fingerprint: 'e8734deb',
    });
  });
});

describe('fnv1a', () => {
  it('is stable and positive', () => {
    expect(fnv1a('qdrant')).toBe(fnv1a('qdrant'));
    expect(fnv1a('qdrant')).toBeGreaterThan(0);
    expect(fnv1a('qdrant')).not.toBe(fnv1a('qdrants'));
  });
});

describe('sparseVector', () => {
  it('produces aligned, sorted indices with log-scaled tf', () => {
    const v = sparseVector('import import import video');
    expect(v.indices.length).toBe(v.values.length);
    expect(v.indices.length).toBe(2);
    expect([...v.indices].sort((a, b) => a - b)).toEqual(v.indices);
    const importVal = v.values[v.indices.indexOf(fnv1a('import'))]!;
    const videoVal = v.values[v.indices.indexOf(fnv1a('video'))]!;
    expect(importVal).toBeCloseTo(1 + Math.log(3));
    expect(videoVal).toBeCloseTo(1);
  });

  it('returns empty vector for stopword-only text', () => {
    expect(sparseVector('the and of')).toEqual({ indices: [], values: [] });
  });

  it('leaves documents at honest term frequency', () => {
    const doc = sparseVector('the 6.8mb payload');
    expect(doc.values[doc.indices.indexOf(fnv1a('6.8mb'))]).toBeCloseTo(1);
  });

  /**
   * In a conversational question the discriminative literal appears once,
   * exactly as often as the filler around it, so term frequency alone cannot
   * tell them apart. Measured failure: `8mb` (IDF 16.35) ranked below the word
   * `quite` (17.48) in the very question it was supposed to answer.
   */
  it('up-weights literals in a query but not the prose around them', () => {
    const q = sparseVector('the 6.8mb payload', { boostLiterals: true });
    const literal = q.values[q.indices.indexOf(fnv1a('6.8mb'))]!;
    const prose = q.values[q.indices.indexOf(fnv1a('payload'))]!;
    expect(literal).toBeGreaterThan(prose);
    expect(prose).toBeCloseTo(1);
  });

  it('boosts nothing unless asked', () => {
    const plain = sparseVector('6.8mb payload');
    const boosted = sparseVector('6.8mb payload', { boostLiterals: true });
    expect(boosted.indices).toEqual(plain.indices);
    expect(boosted.values).not.toEqual(plain.values);
  });
});
