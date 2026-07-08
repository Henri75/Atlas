import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readTailLines } from '../../packages/indexer/src/pipeline.js';

const dir = mkdtempSync(join(tmpdir(), 'kdbscope-tail-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readTailLines', () => {
  it('reads whole file from offset 0, excludes torn trailing line', () => {
    const p = join(dir, 'a.jsonl');
    writeFileSync(p, '{"a":1}\n{"a":2}\n{"torn');
    const { lines, newOffset } = readTailLines(p, 0);
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
    expect(newOffset).toBe('{"a":1}\n{"a":2}\n'.length);
  });

  it('continues from a stored offset after appends', () => {
    const p = join(dir, 'b.jsonl');
    writeFileSync(p, '{"a":1}\n');
    const first = readTailLines(p, 0);
    appendFileSync(p, '{"a":2}\n{"a":3}\n');
    const second = readTailLines(p, first.newOffset);
    expect(second.lines).toEqual(['{"a":2}', '{"a":3}']);
  });

  it('returns nothing when no new complete lines', () => {
    const p = join(dir, 'c.jsonl');
    writeFileSync(p, '{"a":1}\n');
    const { newOffset } = readTailLines(p, 0);
    const again = readTailLines(p, newOffset);
    expect(again.lines).toEqual([]);
    expect(again.newOffset).toBe(newOffset);
  });

  it('handles multibyte content with correct byte offsets', () => {
    const p = join(dir, 'd.jsonl');
    writeFileSync(p, '{"t":"éclair ✓"}\n');
    const r1 = readTailLines(p, 0);
    expect(r1.lines).toEqual(['{"t":"éclair ✓"}']);
    appendFileSync(p, '{"t":"次"}\n');
    const r2 = readTailLines(p, r1.newOffset);
    expect(r2.lines).toEqual(['{"t":"次"}']);
  });
});
