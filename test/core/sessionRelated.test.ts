import { describe, expect, it } from 'vitest';
import {
  SessionRelatedService,
  describeDelta,
  directionOf,
  relatedWhy,
  temporalScore,
  type SessionRowFull,
} from '@atlas/core';

const DAY = 24 * 3600_000;

function row(over: Partial<SessionRowFull> = {}): SessionRowFull {
  return {
    sessionId: 'anchor',
    projectId: 1,
    projectSlug: 'deepcast',
    title: 'Qdrant collection copy',
    startedAt: '2026-08-10T10:00:00.000Z',
    endedAt: '2026-08-10T12:00:00.000Z',
    promptCount: 4,
    actionCount: 20,
    entryCount: 100,
    filesTouched: ['/repo/a.ts'],
    sourcePath: '/t.jsonl',
    ...over,
  };
}

/**
 * A stand-in catalog. `sharingArgs` captures what candidate generation actually
 * asked for, which is where the stop-file rule has to be enforced.
 */
function makeService(opts: {
  rows: SessionRowFull[];
  files?: Record<string, string[]>;
  df?: Record<string, number>;
  dfTotal?: number;
  sharing?: { sessionId: string; shared: number }[];
  window?: string[];
  hits?: { sessionId: string; score: number; kind?: string }[];
  entriesInWindow?: any[];
}) {
  const captured: { sharingPaths?: string[]; probe?: string } = {};
  const catalog = {
    sessionRows: async (ids: string[]) => opts.rows.filter((r) => ids.includes(r.sessionId)),
    sessionFilesFor: async (ids: string[]) =>
      new Map<string, string[]>(
        ids
          .map((id): [string, string[]] => [id, opts.files?.[id] ?? []])
          .filter(([, v]) => v.length),
      ),
    fileDocumentFrequency: async (paths: string[]) => ({
      df: new Map(paths.map((p) => [p, opts.df?.[p] ?? 1])),
      total: opts.dfTotal ?? 2322,
    }),
    fileDocumentFrequencyForSessions: async (ids: string[], extra: string[]) => {
      const paths = new Set<string>(extra);
      for (const id of ids) for (const p of opts.files?.[id] ?? []) paths.add(p);
      return {
        df: new Map([...paths].map((p) => [p, opts.df?.[p] ?? 1])),
        total: opts.dfTotal ?? 2322,
      };
    },
    sessionsSharingFiles: async (paths: string[]) => {
      captured.sharingPaths = paths;
      return opts.sharing ?? [];
    },
    sessionsInWindow: async () => opts.window ?? [],
    sessionEntriesByKind: async () => [],
    entriesInWindow: async () => opts.entriesInWindow ?? [],
    normalizeFiles: async (p: string[]) => p,
  } as any;
  const search = {
    search: async (probe: string) => {
      captured.probe = probe;
      return {
        hits: (opts.hits ?? []).map((h, i) => ({
          entryId: i + 1,
          score: h.score,
          projectSlug: 'deepcast',
          sourceType: 'claude_session',
          sessionId: h.sessionId,
          kind: h.kind,
          title: 't',
          snippet: 's',
          sourcePath: '/x',
        })),
        mode: 'hybrid',
        degraded: false,
        tookMs: 1,
      };
    },
  } as any;
  return { svc: new SessionRelatedService(catalog, search), captured };
}

describe('temporalScore', () => {
  it('decays linearly to zero at the window edge', () => {
    const t0 = Date.parse('2026-08-10T00:00:00Z');
    expect(temporalScore(t0, '2026-08-10T00:00:00Z', 14)).toBeCloseTo(1);
    expect(temporalScore(t0, '2026-08-17T00:00:00Z', 14)).toBeCloseTo(0.5);
    expect(temporalScore(t0, '2026-08-24T00:00:00Z', 14)).toBeCloseTo(0);
  });

  it('is symmetric before and after, and 0 for unusable input', () => {
    const t0 = Date.parse('2026-08-10T00:00:00Z');
    expect(temporalScore(t0, '2026-08-03T00:00:00Z', 14)).toBeCloseTo(
      temporalScore(t0, '2026-08-17T00:00:00Z', 14),
    );
    expect(temporalScore(NaN, '2026-08-10T00:00:00Z', 14)).toBe(0);
    expect(temporalScore(t0, undefined, 14)).toBe(0);
    expect(temporalScore(t0, 'nonsense', 14)).toBe(0);
  });
});

describe('directionOf', () => {
  const anchor = row();
  it('classifies before, after and overlapping by the whole window', () => {
    expect(directionOf(anchor, row({ startedAt: '2026-08-09T10:00:00Z', endedAt: '2026-08-09T11:00:00Z' }))).toBe('before');
    expect(directionOf(anchor, row({ startedAt: '2026-08-11T10:00:00Z', endedAt: '2026-08-11T11:00:00Z' }))).toBe('after');
    // Starts inside the anchor's window: concurrent work, not a successor.
    expect(directionOf(anchor, row({ startedAt: '2026-08-10T11:00:00Z', endedAt: '2026-08-10T13:00:00Z' }))).toBe('overlapping');
  });

  it('falls back to overlapping rather than guessing when a timestamp is missing', () => {
    expect(directionOf(anchor, row({ startedAt: undefined, endedAt: undefined }))).toBe('overlapping');
  });
});

describe('relatedWhy', () => {
  it('names the shared files instead of counting them', () => {
    const why = relatedWhy({ file: 0.8, semantic: 0.2, temporal: 0.1 }, ['a.ts', 'b.ts', 'c.ts'], DAY);
    expect(why[0]!.kind).toBe('file');
    expect(why[0]!.detail).toContain('a.ts');
    expect(why[0]!.detail).toContain('1 more');
  });

  it('omits a leg that contributed nothing', () => {
    const why = relatedWhy({ file: 0, semantic: 0.5, temporal: 0 }, [], 0);
    expect(why.map((w) => w.kind)).toEqual(['semantic']);
  });
});

describe('describeDelta', () => {
  it('reads naturally in both directions and at every scale', () => {
    expect(describeDelta(0)).toBe('at the same time');
    expect(describeDelta(20 * 60_000)).toBe('20 min later');
    expect(describeDelta(-3 * 3600_000)).toBe('3 h earlier');
    expect(describeDelta(5 * DAY)).toBe('5 d later');
  });
});

describe('SessionRelatedService', () => {
  it('returns null for a session that does not exist', async () => {
    const { svc } = makeService({ rows: [] });
    expect(await svc.related('nope')).toBeNull();
  });

  it('excludes stop-files from candidate generation but still scores them', async () => {
    const { svc, captured } = makeService({
      rows: [row({ filesTouched: ['/repo/makefile', '/repo/rare.ts'] }), row({ sessionId: 'other' })],
      files: { anchor: ['makefile', 'rare.ts'], other: ['makefile', 'rare.ts'] },
      // 183 of 2,322 file-bearing sessions — the corpus's real stop-file rate.
      df: { makefile: 183, 'rare.ts': 2 },
      sharing: [{ sessionId: 'other', shared: 1 }],
    });
    const r = await svc.related('anchor');
    expect(captured.sharingPaths).toEqual(['rare.ts']);
    expect(r!.related[0]!.sharedFiles).toContain('makefile');
    // and the identifying file is listed first
    expect(r!.related[0]!.sharedFiles[0]).toBe('rare.ts');
  });

  it('does not bury a fileless session — the 72% case', async () => {
    // Neither side records a file, so only the subject leg can speak. It must
    // still return a usable score rather than being scaled down for a reason
    // that is about missing data, not about relatedness.
    const fileless = makeService({
      rows: [row({ filesTouched: [] }), row({ sessionId: 'sem', filesTouched: [] })],
      files: {},
      hits: [{ sessionId: 'sem', score: 0.9, kind: 'insight' }],
    });
    const r = await fileless.svc.related('anchor');
    expect(r!.related).toHaveLength(1);
    expect(r!.basis).toContain('semantic');

    // The decisive property: an identical subject match scores the SAME whether
    // or not files happen to exist elsewhere. A leg with nothing to say
    // contributes nothing — it never scales the legs that do.
    const withFiles = makeService({
      rows: [row({ filesTouched: ['/repo/a.ts'] }), row({ sessionId: 'sem', filesTouched: [] })],
      files: { anchor: ['a.ts'] },
      hits: [{ sessionId: 'sem', score: 0.9, kind: 'insight' }],
    });
    const r2 = await withFiles.svc.related('anchor');
    expect(r2!.related[0]!.score).toBeCloseTo(r!.related[0]!.score, 5);
  });

  /**
   * Measured regression, seen on the first real query: a 3-message session with
   * no files ranked ABOVE a 502-message session sharing two files, because a
   * weighted mean averaged the heavy session's weak-but-real file score in
   * while the trivial one had no file term to dilute it. Having evidence made
   * it score worse than having none.
   */
  it('does not rank a fileless session above one that shares files', async () => {
    const anchor = row({ filesTouched: ['/repo/x.ts'] });
    const heavy = row({
      sessionId: 'heavy',
      entryCount: 502,
      actionCount: 277,
      startedAt: '2026-08-09T10:00:00Z',
      endedAt: '2026-08-09T18:00:00Z',
    });
    const trivial = row({
      sessionId: 'trivial',
      entryCount: 3,
      actionCount: 0,
      filesTouched: [],
      startedAt: '2026-08-10T12:00:00Z',
      endedAt: '2026-08-10T12:02:00Z',
    });
    const { svc } = makeService({
      rows: [anchor, heavy, trivial],
      // The heavy session shares a file but only one of many; the trivial one
      // has none at all and a slightly better subject score.
      files: { anchor: ['x.ts'], heavy: ['x.ts', ...Array.from({ length: 20 }, (_, i) => `o${i}.ts`)] },
      sharing: [{ sessionId: 'heavy', shared: 1 }],
      hits: [
        { sessionId: 'trivial', score: 1.0, kind: 'insight' },
        { sessionId: 'heavy', score: 0.8, kind: 'insight' },
      ],
    });
    const r = await svc.related('anchor');
    expect(r!.related[0]!.sessionId).toBe('heavy');
  });

  it('says so when only timestamps were usable', async () => {
    const { svc } = makeService({
      rows: [row({ filesTouched: [], title: undefined }), row({ sessionId: 'neighbour', filesTouched: [] })],
      files: {},
      hits: [],
      window: ['neighbour'],
    });
    const r = await svc.related('anchor');
    expect(r!.basis).toEqual(['temporal']);
    expect(r!.note).toMatch(/Only timestamps/);
  });

  it('reports an empty result honestly rather than as a scored zero', async () => {
    const { svc } = makeService({ rows: [row()], files: {}, hits: [] });
    const r = await svc.related('anchor');
    expect(r!.related).toEqual([]);
    expect(r!.note).toBeTruthy();
  });

  it('splits before and after, and can filter to one side', async () => {
    const before = row({ sessionId: 'b', startedAt: '2026-08-05T10:00:00Z', endedAt: '2026-08-05T11:00:00Z' });
    const after = row({ sessionId: 'a', startedAt: '2026-08-15T10:00:00Z', endedAt: '2026-08-15T11:00:00Z' });
    const base = {
      rows: [row(), before, after],
      files: { anchor: ['x.ts'], b: ['x.ts'], a: ['x.ts'] },
      sharing: [{ sessionId: 'b', shared: 1 }, { sessionId: 'a', shared: 1 }],
    };
    const all = await makeService(base).svc.related('anchor');
    expect(new Set(all!.related.map((r) => r.direction))).toEqual(new Set(['before', 'after']));

    const onlyAfter = await makeService(base).svc.related('anchor', { direction: 'after' });
    expect(onlyAfter!.related.every((r) => r.direction !== 'before')).toBe(true);
  });

  it('keeps other projects out when asked to', async () => {
    const foreign = row({ sessionId: 'f', projectSlug: 'kdb' });
    const { svc } = makeService({
      rows: [row(), foreign],
      files: { anchor: ['x.ts'], f: ['x.ts'] },
      sharing: [{ sessionId: 'f', shared: 1 }],
    });
    const r = await svc.related('anchor', { crossProject: false });
    expect(r!.related).toEqual([]);
  });

  it('builds the semantic probe from the anchor rather than the query', async () => {
    const { svc, captured } = makeService({
      rows: [row({ title: 'Qdrant collection copy' })],
      files: {},
    });
    await svc.related('anchor');
    expect(captured.probe).toContain('Qdrant collection copy');
  });

  it('surfaces commits touching the same files as context, not as sessions', async () => {
    const { svc } = makeService({
      rows: [row()],
      files: { anchor: ['x.ts'] },
      entriesInWindow: [
        { id: 9, sourceType: 'git_commit', title: 'fix the thing', occurredAt: '2026-08-11T00:00:00Z', sourceRef: 'abc123', meta: { files: ['x.ts'] } },
        { id: 10, sourceType: 'git_commit', title: 'unrelated', occurredAt: '2026-08-11T00:00:00Z', meta: { files: ['zzz.ts'] } },
      ],
    });
    const r = await svc.related('anchor', { context: true });
    expect(r!.contextEvents).toHaveLength(1);
    expect(r!.contextEvents![0]!.sourceRef).toBe('abc123');
    expect(r!.related.some((x) => x.sessionId === '9')).toBe(false);
  });

  it('omits context entirely unless asked', async () => {
    const { svc } = makeService({ rows: [row()], files: { anchor: ['x.ts'] } });
    expect((await svc.related('anchor'))!.contextEvents).toBeUndefined();
  });
});
