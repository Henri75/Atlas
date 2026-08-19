import { describe, expect, it } from 'vitest';
import { SearchService } from '@atlas/core';

/** Minimal fakes — we test the orchestration/degradation logic, not the stores. */

function fakeCatalog(rows: Record<number, any>, ftsHits: any[] = [], activeCollection?: string) {
  return {
    getEntries: async (ids: number[]) =>
      new Map(ids.filter((id) => rows[id]).map((id) => [id, rows[id]])),
    ftsSearch: async () => ftsHits,
    getSetting: async (k: string) =>
      k === 'active_collection' ? (activeCollection ?? null) : null,
  } as any;
}

const row = (id: number, machine = 'nasta-mbp') => ({
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
  machine,
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

  /**
   * Regression: switching the embedding model changes the vector dimension and
   * therefore the Qdrant collection. The API used to snapshot the collection at
   * boot, so after a model switch every dense query failed on a dimension
   * mismatch and search silently fell back to Postgres FTS.
   */
  it('follows the collection the indexer is actively writing', async () => {
    const vectors = {
      collection: 'kdbscope_bundled_minilm_384',
      useCollection(name: string) {
        this.collection = name;
      },
      query: async () => [{ entryId: 1, score: 0.9 }],
    } as any;
    const embedder = { name: 'ollama', model: 'nomic', dim: 768, embed: async () => [[1]] };
    const catalog = fakeCatalog({ 1: row(1) }, [], 'kdbscope_ollama_nomic_768');

    const s = new SearchService(catalog, vectors, embedder);
    await s.search('q');

    expect(vectors.collection).toBe('kdbscope_ollama_nomic_768');
  });

  it('keeps serving on the current collection when the catalog is unreachable', async () => {
    const vectors = {
      collection: 'current',
      useCollection(name: string) {
        this.collection = name;
      },
      query: async () => [{ entryId: 1, score: 0.5 }],
    } as any;
    const catalog = {
      getEntries: async () => new Map([[1, row(1)]]),
      ftsSearch: async () => [],
      getSetting: async () => {
        throw new Error('db down');
      },
    } as any;

    const s = new SearchService(catalog, vectors, null);
    const r = await s.search('q');

    expect(vectors.collection).toBe('current');
    expect(r.hits).toHaveLength(1);
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

  /**
   * Carried-forward prerequisite from Task 18's review: `hydrate` built the
   * SearchHit field-by-field and simply never read `row.machine`, so every
   * hit's `.machine` was undefined regardless of what the catalog held.
   */
  it('hydrate carries the entry\'s machine through to the hit', async () => {
    const vectors = { query: async () => [{ entryId: 1, score: 0.9 }] } as any;
    const s = new SearchService(fakeCatalog({ 1: row(1, 'm4max') }), vectors, null);
    const r = await s.search('q');
    expect(r.hits[0]!.machine).toBe('m4max');
  });

  it('hydrate normalizes the \'\' pre-machine-model sentinel to absent', async () => {
    const vectors = { query: async () => [{ entryId: 1, score: 0.9 }] } as any;
    const s = new SearchService(fakeCatalog({ 1: row(1, '') }), vectors, null);
    const r = await s.search('q');
    expect(r.hits[0]!.machine).toBeUndefined();
  });
});

describe('SearchService doc staleness', () => {
  const docRow = (id: number, opts: { archived?: boolean; occurredAt?: string } = {}) => ({
    ...row(id),
    source_type: 'doc',
    source_path: '/x/docs/a.md',
    occurred_at: opts.occurredAt ? new Date(opts.occurredAt) : new Date(),
    meta: opts.archived ? { docStatus: 'archived' } : {},
  });

  it('downranks an archived doc below an equal-scored active one and labels it', async () => {
    const rows = { 1: docRow(1, { archived: true }), 2: docRow(2) };
    const vectors = {
      // Archived arrives FIRST with a slightly better raw score.
      query: async () => [
        { entryId: 1, score: 0.9 },
        { entryId: 2, score: 0.85 },
      ],
    } as any;
    const s = new SearchService(fakeCatalog(rows), vectors, null);
    const r = await s.search('q');
    expect(r.hits.map((h) => h.entryId)).toEqual([2, 1]);
    expect(r.hits[1]!.docStatus).toBe('archived');
    expect(r.hits[1]!.score).toBeCloseTo(0.9 * 0.6);
    expect(r.hits[0]!.docStatus).toBeUndefined();
  });

  it('labels old-but-not-archived docs as aging WITHOUT a rank penalty', async () => {
    const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString();
    const rows = { 1: docRow(1, { occurredAt: twoYearsAgo }), 2: docRow(2) };
    const vectors = {
      query: async () => [
        { entryId: 1, score: 0.9 },
        { entryId: 2, score: 0.85 },
      ],
    } as any;
    const s = new SearchService(fakeCatalog(rows), vectors, null);
    const r = await s.search('q');
    // Aging keeps its rank.
    expect(r.hits.map((h) => h.entryId)).toEqual([1, 2]);
    expect(r.hits[0]!.docStatus).toBe('aging');
    expect(r.hits[0]!.ageMonths).toBeGreaterThanOrEqual(23);
    expect(r.hits[0]!.score).toBe(0.9);
  });

  it('never labels non-doc sources, however old', async () => {
    const oldCommit = { ...row(1), occurred_at: new Date('2020-01-01') };
    const vectors = { query: async () => [{ entryId: 1, score: 0.9 }] } as any;
    const s = new SearchService(fakeCatalog({ 1: oldCommit }), vectors, null);
    const r = await s.search('q');
    expect(r.hits[0]!.docStatus).toBeUndefined();
  });

  it('decorates and downranks on the FTS fallback path too', async () => {
    const vectors = {
      query: async () => {
        throw new Error('qdrant down');
      },
    } as any;
    const ftsHits = [
      { entryId: 1, score: 0.9, sourceType: 'doc', docStatus: 'archived', occurredAt: new Date().toISOString() },
      { entryId: 2, score: 0.85, sourceType: 'doc', occurredAt: new Date().toISOString() },
    ];
    const s = new SearchService(fakeCatalog({}, ftsHits as any), vectors, null);
    const r = await s.search('q');
    expect(r.mode).toBe('fts');
    expect(r.hits.map((h) => h.entryId)).toEqual([2, 1]);
    expect(r.hits[1]!.score).toBeCloseTo(0.9 * 0.6);
  });

  it('honors a custom penalty and aging threshold', async () => {
    const rows = { 1: docRow(1, { archived: true }) };
    const vectors = { query: async () => [{ entryId: 1, score: 1 }] } as any;
    const s = new SearchService(fakeCatalog(rows), vectors, null, {
      archivedPenalty: 0.1,
      agingMonths: 1,
    });
    const r = await s.search('q');
    expect(r.hits[0]!.score).toBeCloseTo(0.1);
  });
});

/**
 * Ask retrieves twice for one question (primary search, then the explanatory
 * top-up), and ~90% of the corpus is `claude_session`, so the top-up fires on
 * most asks. Embedding the same string twice would put a second Ollama
 * round-trip on the latency-critical path for a vector that cannot have changed.
 */
describe('SearchService query-embedding reuse', () => {
  const vectors = (collection = 'c1') =>
    ({
      collection,
      useCollection(name: string) {
        this.collection = name;
      },
      query: async () => [{ entryId: 1, score: 0.9 }],
    }) as any;

  function countingEmbedder() {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      provider: {
        name: 'x',
        model: 'm',
        dim: 3,
        embed: async () => {
          calls++;
          return [[1, 2, 3]];
        },
      },
    };
  }

  it('embeds the same question once across back-to-back searches', async () => {
    const e = countingEmbedder();
    const s = new SearchService(fakeCatalog({ 1: row(1) }), vectors(), e.provider);

    const a = await s.search('the same question');
    const b = await s.search('the same question', { sourceTypes: ['doc'] });

    expect(e.calls).toBe(1);
    // Reuse must not look like degradation — the dense branch still ran.
    expect(a.mode).toBe('hybrid');
    expect(b.mode).toBe('hybrid');
  });

  it('re-embeds a different question', async () => {
    const e = countingEmbedder();
    const s = new SearchService(fakeCatalog({ 1: row(1) }), vectors(), e.provider);
    await s.search('question one');
    await s.search('question two');
    expect(e.calls).toBe(2);
  });

  it('re-embeds when the collection changed under it', async () => {
    const e = countingEmbedder();
    const v = vectors('c1');
    const s = new SearchService(fakeCatalog({ 1: row(1) }), v, e.provider);

    await s.search('same text');
    // A model switch changes the vector space along with the collection, so a
    // reused vector would be a dimension mismatch, not a slightly stale answer.
    v.collection = 'c2';
    await s.search('same text');

    expect(e.calls).toBe(2);
  });
});

/**
 * Qdrant answers with *points*, and an entry is chunked into as many points as
 * it needs — so a query that matches two chunks of the same entry gets that
 * entry back twice. `hydrate` looked each point up and pushed a hit per point,
 * with nothing collapsing them.
 *
 * Seen live on 2026-07-29 while reviewing the backlog feature: an 8-hit
 * evidence bundle contained 6 distinct entries, two of them twice. The cost is
 * not cosmetic — the duplicates spend slots in a fixed result window, and
 * `buildBacklogJudgePrompt` renders one numbered block per hit, so the LLM
 * judge sees the same evidence twice and reads repetition as corroboration.
 *
 * Points arrive score-ordered, so keeping the first occurrence keeps the best.
 */
describe('SearchService entry de-duplication', () => {
  const dupVectors = (raw: { entryId: number; score: number }[]) =>
    ({ query: async () => raw }) as any;
  const embedder = { name: 'x', model: 'm', dim: 3, embed: async () => [[1, 2, 3]] };

  it('returns an entry once even when several of its chunks match', async () => {
    const s = new SearchService(
      fakeCatalog({ 1: row(1), 2: row(2) }),
      dupVectors([
        { entryId: 1, score: 0.9 },
        { entryId: 2, score: 0.8 },
        { entryId: 1, score: 0.7 },
        { entryId: 2, score: 0.6 },
      ]),
      embedder,
    );
    const r = await s.search('q');
    expect(r.hits.map((h) => h.entryId)).toEqual([1, 2]);
  });

  it('keeps the best-scoring occurrence', async () => {
    const s = new SearchService(
      fakeCatalog({ 1: row(1) }),
      dupVectors([
        { entryId: 1, score: 0.91 },
        { entryId: 1, score: 0.42 },
      ]),
      embedder,
    );
    const r = await s.search('q');
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.score).toBe(0.91);
  });

  it('does not let duplicates eat the result window', async () => {
    // Three distinct entries behind six points: a limit of 3 must return 3.
    const s = new SearchService(
      fakeCatalog({ 1: row(1), 2: row(2), 3: row(3) }),
      dupVectors([
        { entryId: 1, score: 0.9 },
        { entryId: 1, score: 0.89 },
        { entryId: 2, score: 0.8 },
        { entryId: 2, score: 0.79 },
        { entryId: 3, score: 0.7 },
        { entryId: 3, score: 0.69 },
      ]),
      embedder,
    );
    const r = await s.search('q', {}, 3);
    expect(r.hits.map((h) => h.entryId)).toEqual([1, 2, 3]);
  });
});
