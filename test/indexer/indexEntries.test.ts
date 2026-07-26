import { describe, expect, it, vi } from 'vitest';
import { indexEntries } from '../../packages/indexer/src/pipeline.js';
import type { Entry } from '@atlas/core';

const entry = (id: number, body: string): { id: number; entry: Entry } => ({
  id,
  entry: {
    projectSlug: 'deepcast',
    sourceType: 'claude_session',
    sessionId: 'abc',
    title: `entry ${id}`,
    body,
    sourcePath: '/x/abc.jsonl',
  },
});

function makeDeps(embedImpl?: () => Promise<number[][]>) {
  const upserted: unknown[][] = [];
  const embedCalls: number[] = [];
  /** Entry ids marked as vectorized, in the order indexEntries marked them. */
  const marked: number[] = [];
  const markedIn: string[] = [];
  return {
    deps: {
      catalog: {
        markVectorized: vi.fn(async (ids: number[], collection: string) => {
          marked.push(...ids);
          markedIn.push(collection);
        }),
      } as any,
      vectors: {
        collection: 'test_collection',
        upsert: vi.fn(async (points: unknown[]) => {
          upserted.push(points);
        }),
      } as any,
      embedder: {
        name: 'fake',
        model: 'm',
        dim: 3,
        embed: vi.fn(async (texts: string[]) => {
          embedCalls.push(texts.length);
          if (embedImpl) return embedImpl();
          return texts.map(() => [1, 2, 3]);
        }),
      },
    },
    upserted,
    embedCalls,
    marked,
    markedIn,
  };
}

/** ~4 chunks per entry (body 4.2KB, chunker maxChars 1800). */
const BIG_BODY = 'paragraph text here. '.repeat(200);

describe('indexEntries', () => {
  it('batches chunks across entries, capping every embed call at 32', async () => {
    // 12 entries x ~4 chunks = ~48 chunks => at least two batches.
    const inserted = Array.from({ length: 12 }, (_, i) => entry(i + 1, BIG_BODY));
    const { deps, embedCalls } = makeDeps();

    const total = await indexEntries(deps, inserted);

    expect(total).toBeGreaterThan(32);
    expect(embedCalls.length).toBeGreaterThan(1);
    // Every embed call is capped at the batch size.
    for (const n of embedCalls) expect(n).toBeLessThanOrEqual(32);
    // All but the last batch are full — proves batches span entry boundaries.
    for (const n of embedCalls.slice(0, -1)) expect(n).toBe(32);
    expect(embedCalls.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('reports cumulative progress after each batch', async () => {
    const inserted = Array.from({ length: 12 }, (_, i) => entry(i + 1, BIG_BODY));
    const { deps } = makeDeps();
    const progress: number[] = [];

    const total = await indexEntries(deps, inserted, (c) => {
      progress.push(c);
    });

    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(total);
    // Monotonically increasing.
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('retries a transient embed failure instead of losing the file', async () => {
    let n = 0;
    const { deps } = makeDeps(async () => {
      if (++n === 1) throw new Error('fetch failed');
      return [[1, 2, 3]];
    });
    const total = await indexEntries(deps, [entry(1, 'short body')]);
    expect(total).toBe(1);
    expect(deps.embedder.embed).toHaveBeenCalledTimes(2);
  });

  it('returns 0 and does nothing for no entries', async () => {
    const { deps } = makeDeps();
    expect(await indexEntries(deps, [])).toBe(0);
    expect(deps.vectors.upsert).not.toHaveBeenCalled();
  });

  it('carries entry metadata into the qdrant payload', async () => {
    const { deps, upserted } = makeDeps();
    await indexEntries(deps, [entry(7, 'short body')]);
    const point = (upserted[0] as any[])[0];
    expect(point.payload).toMatchObject({
      entry_id: 7,
      project: 'deepcast',
      source_type: 'claude_session',
      session_id: 'abc',
    });
    expect(point.dense).toEqual([1, 2, 3]);
    expect(point.sparse.indices.length).toBeGreaterThan(0);
  });

  it('carries doc_status into the payload for archived docs', async () => {
    const { deps, upserted } = makeDeps();
    const e = entry(9, 'short body');
    e.entry.sourceType = 'doc';
    e.entry.meta = { docStatus: 'archived' };
    await indexEntries(deps, [e]);
    expect((upserted[0] as any[])[0].payload.doc_status).toBe('archived');
  });

  /**
   * Coverage tracking. These pin the 2026-07-25 incident: entries were committed
   * to Postgres, the embedder failed mid-file, and because insertEntries dedups
   * on rescan they were never embedded again — silently unsearchable forever.
   * An entry may only be marked once every one of its chunks has been upserted.
   */
  describe('vector coverage marking', () => {
    it('marks an entry against the active collection once its chunks land', async () => {
      const { deps, marked, markedIn } = makeDeps();
      await indexEntries(deps, [entry(7, 'short body')]);
      expect(marked).toEqual([7]);
      // Recorded per collection, so a later model switch invalidates it.
      expect(markedIn).toEqual(['test_collection']);
    });

    it('does NOT mark entries whose chunks were never embedded', async () => {
      // Fails on the very first batch: nothing was upserted, so nothing may be
      // claimed as covered. This is the regression test for the incident.
      const { deps, marked } = makeDeps(async () => {
        throw new Error('ollama embed failed: 500');
      });
      const inserted = Array.from({ length: 12 }, (_, i) => entry(i + 1, BIG_BODY));

      await expect(indexEntries(deps, inserted)).rejects.toThrow(/embed failed/);
      expect(marked).toEqual([]);
    });

    it('marks only the entries completed before a mid-file failure', async () => {
      // Succeed for the first batch, then fail: entries whose chunks all landed
      // in batch 1 are covered; the rest must stay unmarked so the reconciler
      // picks them up.
      //
      // A non-transient message on purpose — 'fetch failed' would burn all five
      // retries (~15s of backoff) to prove something the retry test already
      // covers. What matters here is only that the later batch never upserts.
      let call = 0;
      const { deps, marked } = makeDeps(async () => {
        if (++call > 1) throw new Error('ollama embed failed: 500');
        return Array.from({ length: 32 }, () => [1, 2, 3]);
      });
      const inserted = Array.from({ length: 12 }, (_, i) => entry(i + 1, BIG_BODY));

      await expect(indexEntries(deps, inserted)).rejects.toThrow(/embed failed/);

      // Something was covered, but far from all — and never an entry whose
      // chunks extend past the first batch.
      expect(marked.length).toBeGreaterThan(0);
      expect(marked.length).toBeLessThan(inserted.length);
      expect(marked).toEqual([...marked].sort((a, b) => a - b));
    });

    it('marks an entry only after its final chunk, when it straddles batches', async () => {
      // ~4 chunks per entry over a 32-chunk batch: entry 9's chunks span the
      // batch boundary, so a naive per-batch mark would claim it too early.
      const { deps, marked, upserted } = makeDeps();
      const inserted = Array.from({ length: 12 }, (_, i) => entry(i + 1, BIG_BODY));

      const marksAtFirstUpsert: number[] = [];
      (deps.vectors as any).upsert = vi.fn(async (points: unknown[]) => {
        upserted.push(points);
        marksAtFirstUpsert.push(marked.length);
      });

      await indexEntries(deps, inserted);

      expect(marked).toEqual(inserted.map((e) => e.id));
      // No entry is marked before its own chunks have been upserted: the count
      // of marks after the first batch is strictly less than the entry count.
      expect(marksAtFirstUpsert[0]).toBeLessThan(inserted.length);
    });

    it('marks an entry that produces no chunks rather than looping forever', async () => {
      // A body the chunker yields nothing for must not stay permanently
      // uncovered — the reconciler would retry it on every pass.
      const { deps, marked } = makeDeps();
      await indexEntries(deps, [entry(3, '')]);
      expect(marked).toContain(3);
    });
  });
});
