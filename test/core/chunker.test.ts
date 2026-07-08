import { describe, expect, it } from 'vitest';
import { chunk } from '@kdbscope/core';

describe('chunk', () => {
  it('returns single chunk for short text', () => {
    expect(chunk('hello world')).toEqual(['hello world']);
  });

  it('returns empty for blank text', () => {
    expect(chunk('   \n  ')).toEqual([]);
  });

  it('splits long text on paragraph boundaries within the limit', () => {
    const para = 'word '.repeat(100).trim(); // ~500 chars
    const text = Array.from({ length: 10 }, () => para).join('\n\n'); // ~5000 chars
    const chunks = chunk(text, { maxChars: 1800, overlap: 200 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1800 + 200 + 2);
  });

  it('hard-splits a single oversized paragraph', () => {
    const chunks = chunk('x'.repeat(5000), { maxChars: 1000, overlap: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
  });

  it('overlaps consecutive chunks for context continuity', () => {
    const para = 'alpha beta gamma delta '.repeat(30).trim();
    const text = [para, para, para].join('\n\n');
    const chunks = chunk(text, { maxChars: 800, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    const tail = chunks[0]!.slice(-50);
    expect(chunks[1]!.includes(tail.slice(0, 20))).toBe(true);
  });
});
