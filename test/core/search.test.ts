import { describe, expect, it } from 'vitest';
import { SearchService } from '@kdbscope/core';

/** Minimal fakes — we test the orchestration/degradation logic, not the stores. */

function fakeCatalog(rows: Record<number, any>, ftsHits: any[] = []) {
  return {
    getEntries: async (ids: number[]) =>
      new Map(ids.filter((id) => rows[id]).map((id) => [id, rows[id]])),
    ftsSearch: async () => ftsHits,
  } as any;
}

const row = (id: number) => ({
  id,
  slug: 'deepcast',
  source_type: 'kdb_changelog',
  component: null,
  session_id: null,
  title: `entry ${id}`,
  body: 'body '.repeat(100),
  occurred_at: new Date('2026-07-08T10:00:00Z'),
  source_path: '/x/changelog.log',
  source_ref: null,
});

describe('SearchService degradation chain', () => {
  it('hybrid mode when embedder works', async () => {
    const vectors = {
      query: async (o: any) => {
        expect(o.dense).toBeDefined();
        return [{ entryId: 1, score: 0.9 }];
      },
    } as any;
    const embedder = { name: 'x', model: 'm', dim: 3, embed: async () => [[1, 2, 3]] };
    const s = new SearchService(fakeCatalog({ 1: row(1) }), vectors, embedder);
    const r = await s.search('video import bug');
    expect(r.mode).toBe('hybrid');
    expect(r.degraded).toBe(false);
    expect(r.hits[0]).toMatchObject({ entryId: 1, projectSlug: 'deepcast' });
  });

  it('sparse-only when embedder throws', async () => {
    const vectors = {
      query: async (o: any) => {
        expect(o.dense).toBeUndefined();
        return [{ entryId: 1, score: 0.4 }];
      },
    } as any;
    const embedder = {
      name: 'x',
      model: 'm',
      dim: 3,
      embed: async () => {
        throw new Error('provider down');
      },
    };
    const s = new SearchService(fakeCatalog({ 1: row(1) }), vectors, embedder);
    const r = await s.search('video import bug');
    expect(r.mode).toBe('sparse-only');
    expect(r.degraded).toBe(true);
    expect(r.hits).toHaveLength(1);
  });

  it('falls back to Postgres FTS when Qdrant throws', async () => {
    const vectors = {
      query: async () => {
        throw new Error('qdrant down');
      },
    } as any;
    const ftsHit = { entryId: 7, score: 0.1, projectSlug: 'deepcast', title: 'x' };
    const s = new SearchService(fakeCatalog({}, [ftsHit]), vectors, null);
    const r = await s.search('anything');
    expect(r.mode).toBe('fts');
    expect(r.degraded).toBe(true);
    expect(r.hits).toEqual([ftsHit]);
  });

  it('drops stale qdrant ids missing from the catalog', async () => {
    const vectors = {
      query: async () => [
        { entryId: 1, score: 0.9 },
        { entryId: 99, score: 0.8 },
      ],
    } as any;
    const s = new SearchService(fakeCatalog({ 1: row(1) }), vectors, null);
    const r = await s.search('q');
    expect(r.hits.map((h) => h.entryId)).toEqual([1]);
  });
});
