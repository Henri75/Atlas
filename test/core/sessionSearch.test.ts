import { describe, expect, it } from 'vitest';
import {
  SessionSearchService,
  cardFacts,
  collapseThreads,
  substanceOf,
  type SearchHit,
  type SessionCard,
  type SessionRowFull,
} from '@atlas/core';

const HOUR = 3600_000;

function row(over: Partial<SessionRowFull> = {}): SessionRowFull {
  return {
    sessionId: 's1',
    projectId: 1,
    projectSlug: 'deepcast',
    title: 'Qdrant collection copy',
    cwd: '/repo',
    startedAt: '2026-08-01T10:00:00.000Z',
    endedAt: '2026-08-01T12:00:00.000Z',
    promptCount: 4,
    actionCount: 30,
    entryCount: 120,
    filesTouched: ['/repo/a.ts', '/repo/b.ts'],
    sourcePath: '/t.jsonl',
    ...over,
  };
}

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    entryId: 1,
    score: 0.5,
    projectSlug: 'deepcast',
    sourceType: 'claude_session',
    sessionId: 's1',
    title: 'Assistant: something',
    snippet: 'body text',
    sourcePath: '/t.jsonl',
    ...over,
  };
}

/** Minimal stand-ins: these services orchestrate, so the seams are the test. */
function makeService(opts: {
  rows?: SessionRowFull[];
  meta?: any[];
  hits?: SearchHit[];
  searchThrows?: boolean;
}) {
  const calls: { maxFetch?: number; filters?: any } = {};
  const catalog = {
    searchSessionsMeta: async () => opts.meta ?? [],
    sessionRows: async (ids: string[]) =>
      (opts.rows ?? []).filter((r) => ids.includes(r.sessionId)),
  } as any;
  const search = {
    search: async (_q: string, filters: any, _limit: number, o: any) => {
      calls.maxFetch = o?.maxFetch;
      calls.filters = filters;
      if (opts.searchThrows) throw new Error('qdrant down');
      return { hits: opts.hits ?? [], mode: 'hybrid', degraded: false, tookMs: 1 };
    },
  } as any;
  return { svc: new SessionSearchService(catalog, search), calls };
}

describe('cardFacts', () => {
  it('derives duration and never leaves a session unlabelled', () => {
    const c = cardFacts(row(), 0.5);
    expect(c.durationMs).toBe(2 * HOUR);
    expect(cardFacts(row({ title: undefined, sessionId: 'abcdef1234' }), 0).title).toBe(
      '(untitled session abcdef12)',
    );
  });

  it('omits duration rather than inventing one when an end is missing', () => {
    expect(cardFacts(row({ endedAt: undefined }), 0).durationMs).toBeUndefined();
  });
});

describe('substanceOf', () => {
  it('ranks a real work session far above the corpus median', () => {
    const median = substanceOf(
      row({ entryCount: 3, actionCount: 1, filesTouched: [], startedAt: '2026-08-01T10:00:00.000Z', endedAt: '2026-08-01T10:01:36.000Z' }),
    );
    expect(substanceOf(row())).toBeGreaterThan(median * 3);
  });
});

describe('SessionSearchService', () => {
  it('surfaces a session the content leg never retrieved, on metadata alone', async () => {
    const { svc } = makeService({
      rows: [row({ sessionId: 'meta-only' })],
      meta: [{ sessionId: 'meta-only', byId: false, byTitle: true, byCwd: false, byProject: false, byFile: false }],
      hits: [],
    });
    const r = await svc.searchSessions('qdrant');
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.why.map((w) => w.kind)).toContain('title');
  });

  it('puts a pasted session id first, ahead of a better content match', async () => {
    const idMatch = row({ sessionId: 'deadbeefcafe', entryCount: 3, actionCount: 0, filesTouched: [] });
    const contentMatch = row({ sessionId: 'other', entryCount: 400, actionCount: 100 });
    const { svc } = makeService({
      rows: [idMatch, contentMatch],
      meta: [{ sessionId: 'deadbeefcafe', byId: true, byTitle: false, byCwd: false, byProject: false, byFile: false }],
      hits: [hit({ sessionId: 'other', score: 0.99, kind: 'insight' })],
    });
    const r = await svc.searchSessions('deadbeefcafe', {}, { thread: false });
    expect(r.sessions[0]!.sessionId).toBe('deadbeefcafe');
    expect(r.sessions[0]!.why[0]!.kind).toBe('id');
  });

  it('lets a substantial session beat a trivial one on equal evidence', async () => {
    const heavy = row({ sessionId: 'heavy', entryCount: 300, actionCount: 120, startedAt: '2026-08-01T10:00:00.000Z', endedAt: '2026-08-01T14:00:00.000Z' });
    const trivial = row({ sessionId: 'trivial', entryCount: 3, actionCount: 0, filesTouched: [], startedAt: '2026-08-01T10:00:00.000Z', endedAt: '2026-08-01T10:01:00.000Z' });
    const { svc } = makeService({
      rows: [heavy, trivial],
      hits: [hit({ sessionId: 'heavy', score: 0.5 }), hit({ entryId: 2, sessionId: 'trivial', score: 0.5 })],
    });
    const r = await svc.searchSessions('anything', {}, { thread: false });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['heavy', 'trivial']);
  });

  it('still ranks a trivial session that genuinely matched — it is suppressed, not censored', async () => {
    const trivial = row({ sessionId: 'trivial', entryCount: 2, actionCount: 0, filesTouched: [] });
    const { svc } = makeService({ rows: [trivial], hits: [hit({ sessionId: 'trivial', score: 0.9 })] });
    const r = await svc.searchSessions('the error I pasted');
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.score).toBeGreaterThan(0);
  });

  it('weights an insight above an action for the same raw score', async () => {
    const a = row({ sessionId: 'a' });
    const b = row({ sessionId: 'b' });
    const { svc } = makeService({
      rows: [a, b],
      hits: [
        hit({ sessionId: 'a', score: 0.5, kind: 'insight' }),
        hit({ entryId: 2, sessionId: 'b', score: 0.5, kind: 'action' }),
      ],
    });
    const r = await svc.searchSessions('x', {}, { thread: false });
    expect(r.sessions[0]!.sessionId).toBe('a');
  });

  it('prefers prose excerpts over the action trail', async () => {
    const { svc } = makeService({
      rows: [row()],
      hits: [
        hit({ entryId: 1, score: 0.9, kind: 'action', snippet: 'Edit: a.ts' }),
        hit({ entryId: 2, score: 0.4, kind: 'insight', snippet: 'the real reason was X' }),
      ],
    });
    const r = await svc.searchSessions('x');
    expect(r.sessions[0]!.excerpts[0]!.kind).toBe('insight');
  });

  it('asks for a pool wide enough that a few long sessions cannot fill the window', async () => {
    const { svc, calls } = makeService({ rows: [row()], hits: [] });
    await svc.searchSessions('x');
    expect(calls.maxFetch).toBeGreaterThanOrEqual(250);
    expect(calls.filters.sourceTypes).toEqual(['claude_session']);
  });

  it('lifts an explicit date out of the query and reports what it applied', async () => {
    const { svc, calls } = makeService({ rows: [row()], hits: [] });
    const r = await svc.searchSessions('the qdrant work on 2026-07-21');
    expect(calls.filters.since).toBeTruthy();
    expect(r.interpreted?.since).toBeTruthy();
  });

  it('does not override an explicit filter with a date read from the text', async () => {
    const { svc, calls } = makeService({ rows: [row()], hits: [] });
    await svc.searchSessions('2026-07-21 thing', { since: '2020-01-01T00:00:00.000Z' });
    expect(calls.filters.since).toBe('2020-01-01T00:00:00.000Z');
  });

  it('still answers from metadata when the content leg fails, and says it degraded', async () => {
    const { svc } = makeService({
      rows: [row()],
      meta: [{ sessionId: 's1', byId: false, byTitle: true, byCwd: false, byProject: false, byFile: false }],
      searchThrows: true,
    });
    const r = await svc.searchSessions('qdrant');
    expect(r.sessions).toHaveLength(1);
    expect(r.degraded).toBe(true);
    expect(r.mode).toBe('metadata-only');
  });

  it('drops a hit whose session row is missing rather than failing the query', async () => {
    const { svc } = makeService({ rows: [], hits: [hit({ sessionId: 'ghost' })] });
    const r = await svc.searchSessions('x');
    expect(r.sessions).toEqual([]);
  });

  it('returns nothing for an empty query without calling the content leg', async () => {
    const { svc, calls } = makeService({ rows: [row()], hits: [hit()] });
    const r = await svc.searchSessions('   ');
    expect(r.sessions).toEqual([]);
    expect(calls.maxFetch).toBeUndefined();
  });
});

describe('collapseThreads', () => {
  const card = (over: Partial<SessionCard>): SessionCard => ({
    sessionId: 'x',
    projectSlug: 'deepcast',
    title: 't',
    promptCount: 1,
    actionCount: 1,
    entryCount: 10,
    fileCount: 0,
    filesTouched: [],
    substance: 0.5,
    score: 1,
    why: [],
    excerpts: [],
    ...over,
  });

  it('folds a resumed run of one project into a single card', () => {
    const out = collapseThreads(
      [
        card({ sessionId: 'a', score: 3, startedAt: '2026-08-01T10:00:00Z', endedAt: '2026-08-01T11:00:00Z' }),
        card({ sessionId: 'b', score: 2, startedAt: '2026-08-01T11:30:00Z', endedAt: '2026-08-01T12:00:00Z' }),
        card({ sessionId: 'c', score: 1, startedAt: '2026-08-01T12:20:00Z', endedAt: '2026-08-01T13:00:00Z' }),
      ],
      10,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.thread).toEqual({ size: 3, memberIds: ['a', 'b', 'c'] });
  });

  it('never folds across projects', () => {
    const out = collapseThreads(
      [
        card({ sessionId: 'a', projectSlug: 'deepcast', startedAt: '2026-08-01T10:00:00Z', endedAt: '2026-08-01T11:00:00Z' }),
        card({ sessionId: 'b', projectSlug: 'kdb', startedAt: '2026-08-01T11:10:00Z', endedAt: '2026-08-01T11:20:00Z' }),
      ],
      10,
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.thread).toBeUndefined();
  });

  it('leaves a distant session alone', () => {
    const out = collapseThreads(
      [
        card({ sessionId: 'a', startedAt: '2026-08-01T10:00:00Z', endedAt: '2026-08-01T11:00:00Z' }),
        card({ sessionId: 'b', startedAt: '2026-08-05T10:00:00Z', endedAt: '2026-08-05T11:00:00Z' }),
      ],
      10,
    );
    expect(out).toHaveLength(2);
  });

  it('tolerates sessions with no timestamps', () => {
    const out = collapseThreads([card({ sessionId: 'a' }), card({ sessionId: 'b' })], 10);
    expect(out.map((c) => c.sessionId)).toEqual(['a', 'b']);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      card({ sessionId: `s${i}`, projectSlug: `p${i}`, startedAt: `2026-0${(i % 8) + 1}-01T10:00:00Z` }),
    );
    expect(collapseThreads(many, 5)).toHaveLength(5);
  });
});
