import { describe, expect, it } from 'vitest';
import { AskService } from '@atlas/core';
import type { SearchFilters, SearchHit } from '@atlas/core';

/**
 * `retrieveForContext` is Ask's retrieval path, made public so the evaluation
 * harness measures *it* rather than a reimplementation.
 *
 * The duplication it avoids is not hypothetical: the pool size is
 * `min(max(k*3,24),60)`, the scope silently widens on a total miss, and
 * `mode`/`degraded` are threaded out for the trust contract. A harness that
 * rebuilt that sequence would agree with the product on the day it was written
 * and drift the first time any of it was tuned — while still reporting numbers
 * that looked like the product's.
 *
 * Retrieval and context selection are also two different surfaces: the session
 * cap cannot change the pool at all, only which of its members survive into the
 * k blocks. So both are returned, and both are asserted here.
 */

const hit = (id: number, score: number, sourceType: SearchHit['sourceType']): SearchHit => ({
  entryId: id,
  score,
  projectSlug: 'deepcast',
  sourceType,
  title: `t${id}`,
  snippet: 's',
  sourcePath: `/x${id}`,
});

function makeService(opts: { hits?: SearchHit[]; scoped?: SearchHit[]; mode?: string } = {}) {
  const calls: { q: string; filters: SearchFilters; limit: number }[] = [];
  const search = {
    search: async (q: string, filters: SearchFilters, limit: number) => {
      calls.push({ q, filters, limit });
      // First call is the scoped one; a second call means the scope widened.
      const hits = calls.length === 1 ? (opts.scoped ?? opts.hits ?? []) : (opts.hits ?? []);
      return { hits, mode: opts.mode ?? 'hybrid', degraded: (opts.mode ?? 'hybrid') !== 'hybrid', tookMs: 1 };
    },
  };
  const catalog = {
    getEntries: async (ids: number[]) => new Map(ids.map((i) => [i, { body: 'b' }])),
    expandProjectScope: async (s: string[]) => s,
    coverage: async () => [],
    countInWindow: async () => 0,
  };
  const svc = new AskService(search as any, catalog as any, {
    model: 'test-model',
    baseUrl: 'http://x',
  } as any);
  return { svc, calls };
}

describe('AskService.retrieveForContext', () => {
  it('over-fetches a pool and returns both it and the selected context', async () => {
    const pool = Array.from({ length: 30 }, (_, i) => hit(i + 1, 1 - i / 100, 'claude_session'));
    const { svc, calls } = makeService({ hits: pool });

    const r = await svc.retrieveForContext('q', {}, 4);

    // The pool formula is the product's, not the caller's: max(4*3,24) = 24.
    expect(calls[0]!.limit).toBe(24);
    expect(r.pool).toHaveLength(30);
    // ...and the context is the reranked k, which is a strict subset of it.
    expect(r.hits).toHaveLength(4);
    expect(r.pool.map((h) => h.entryId)).toEqual(expect.arrayContaining(r.hits.map((h) => h.entryId)));
  });

  it('applies a rerank override without touching the pool', async () => {
    // Sessions out-weight the authoritative hits on raw score, so the cap is
    // what decides how many of them reach the window.
    const pool = [
      hit(1, 0.99, 'claude_session'),
      hit(2, 0.98, 'claude_session'),
      hit(3, 0.97, 'claude_session'),
      hit(4, 0.96, 'claude_session'),
      hit(5, 0.5, 'doc'),
      hit(6, 0.48, 'kdb_component'),
    ];
    const { svc } = makeService({ hits: pool });

    const shipped = await svc.retrieveForContext('q', {}, 4);
    const lifted = await svc.retrieveForContext('q', {}, 4, { maxSessionFraction: 1 });

    const sessions = (hits: SearchHit[]) =>
      hits.filter((h) => h.sourceType === 'claude_session').length;
    expect(sessions(shipped.hits)).toBe(2);
    expect(sessions(lifted.hits)).toBe(4);
    // The variant changed only selection. Retrieval is upstream of every knob in
    // RerankOptions, which is exactly why the two stages are measured apart.
    expect(shipped.pool.map((h) => h.entryId)).toEqual(lifted.pool.map((h) => h.entryId));
  });

  it('carries mode and degraded out of search', async () => {
    const { svc } = makeService({ hits: [hit(1, 1, 'doc')], mode: 'sparse-only' });
    const r = await svc.retrieveForContext('q', {}, 4);
    expect(r.mode).toBe('sparse-only');
    expect(r.degraded).toBe(true);
  });

  it('widens a scope that matched nothing, and reports the pool it actually used', async () => {
    const wide = [hit(7, 0.9, 'kdb_component')];
    const { svc, calls } = makeService({ scoped: [], hits: wide });

    const r = await svc.retrieveForContext('q', { project: 'deepcast' }, 4);

    expect(r.scopeFallback).toEqual({ requested: ['deepcast'], usedAllProjects: true });
    // Both scope keys must be cleared or the "widened" search is still scoped.
    expect(calls[1]!.filters.project).toBeUndefined();
    expect(calls[1]!.filters.projects).toBeUndefined();
    // The pool describes what was searched, not what was asked for — otherwise a
    // metric would be computed against a candidate set the run never saw.
    expect(r.pool.map((h) => h.entryId)).toEqual([7]);
  });

  it('returns an empty pool alongside an empty context on a genuine miss', async () => {
    const { svc } = makeService({ hits: [] });
    const r = await svc.retrieveForContext('q', {}, 4);
    expect(r.hits).toEqual([]);
    expect(r.pool).toEqual([]);
    expect(r.scopeFallback).toBeUndefined();
  });
});

/**
 * The explanatory floor: retrieval must hand `rerankForContext` something to
 * promote.
 *
 * The rerank already weights docs and kdb logs above transcripts and caps
 * sessions at half the window — but it can only reorder what it was given.
 * Measured on the live index (2026-07-29), the top 100 for a real question were
 * 94 `claude_session`, so the cap freed slots nothing could fill and the answer
 * was synthesized from chatter while the one-line kdb entry that stated the
 * finding sat unretrieved.
 */
describe('AskService.retrieveForContext explanatory floor', () => {
  /** Answers the source-restricted top-up differently from the primary search. */
  function makeTieredService(primary: SearchHit[], explanatory: SearchHit[]) {
    const calls: { filters: SearchFilters; limit: number }[] = [];
    const search = {
      search: async (_q: string, filters: SearchFilters, limit: number) => {
        calls.push({ filters, limit });
        const hits = filters.sourceTypes?.length ? explanatory : primary;
        return { hits, mode: 'hybrid', degraded: false, tookMs: 1 };
      },
    };
    const catalog = {
      getEntries: async (ids: number[]) => new Map(ids.map((i) => [i, { body: 'b' }])),
      expandProjectScope: async (s: string[]) => s,
      coverage: async () => [],
      countInWindow: async () => 0,
    };
    const svc = new AskService(search as any, catalog as any, {
      model: 'test-model',
      baseUrl: 'http://x',
    } as any);
    return { svc, calls };
  }

  const sessions = (n: number) =>
    Array.from({ length: n }, (_, i) => hit(i + 1, 0.9 - i / 100, 'claude_session'));

  it('tops an all-session pool up with explanatory sources', async () => {
    const { svc, calls } = makeTieredService(sessions(20), [hit(99, 0.4, 'kdb_backlog')]);

    const r = await svc.retrieveForContext('q', {}, 4);

    // A second retrieval fired, restricted to the explanatory types...
    expect(calls).toHaveLength(2);
    expect(calls[1]!.filters.sourceTypes).toContain('kdb_backlog');
    expect(calls[1]!.filters.sourceTypes).not.toContain('claude_session');
    // ...and its hit reached the pool, and then the window the cap freed for it.
    expect(r.pool.map((h) => h.entryId)).toContain(99);
    expect(r.hits.map((h) => h.entryId)).toContain(99);
  });

  it('does not top up a pool that already has enough non-session hits', async () => {
    const primary = [hit(1, 0.9, 'doc'), hit(2, 0.8, 'kdb_component'), hit(3, 0.7, 'claude_session')];
    const { svc, calls } = makeTieredService(primary, [hit(99, 0.4, 'kdb_backlog')]);

    const r = await svc.retrieveForContext('q', {}, 4);

    expect(calls).toHaveLength(1);
    expect(r.pool.map((h) => h.entryId)).not.toContain(99);
  });

  it('treats an explicit source filter as an instruction, not a default', async () => {
    const { svc, calls } = makeTieredService(sessions(20), [hit(99, 0.4, 'kdb_backlog')]);

    await svc.retrieveForContext('q', { sourceTypes: ['claude_session'] }, 4);

    // Asking for sessions and getting kdb logs back would be the tool overruling
    // the caller about what they wanted to read.
    expect(calls).toHaveLength(1);
  });

  it('never lets the top-up disguise a scope that matched nothing', async () => {
    const calls: { filters: SearchFilters }[] = [];
    const search = {
      search: async (_q: string, filters: SearchFilters) => {
        calls.push({ filters });
        // The scoped search is empty; anything unscoped or restricted has hits.
        const scoped = filters.project || filters.projects?.length;
        return {
          hits: scoped ? [] : [hit(7, 0.9, 'kdb_component')],
          mode: 'hybrid',
          degraded: false,
          tookMs: 1,
        };
      },
    };
    const catalog = {
      getEntries: async (ids: number[]) => new Map(ids.map((i) => [i, { body: 'b' }])),
      expandProjectScope: async (s: string[]) => s,
      coverage: async () => [],
      countInWindow: async () => 0,
    };
    const svc = new AskService(search as any, catalog as any, {
      model: 'test-model',
      baseUrl: 'http://x',
    } as any);

    const r = await svc.retrieveForContext('q', { project: 'deepcast' }, 4);

    // Had the top-up run before the emptiness test, it would have returned
    // scoped-but-restricted hits, the widening would never have fired, and the
    // caller would have been told the answer came from `deepcast`.
    expect(r.scopeFallback).toEqual({ requested: ['deepcast'], usedAllProjects: true });
  });
});
