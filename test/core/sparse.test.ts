import { describe, expect, it } from 'vitest';
import { fnv1a, sparseVector, tokenize } from '@kdbscope/core';

describe('tokenize', () => {
  it('lowercases, drops stopwords and short tokens', () => {
    expect(tokenize('The Video-Import IS a bug_fix x')).toEqual(['video', 'import', 'bug_fix']);
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
});
