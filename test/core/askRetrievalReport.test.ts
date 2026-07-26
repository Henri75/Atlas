import { describe, expect, it } from 'vitest';
import { AskService } from '@atlas/core';
import type { AskEvent } from '@atlas/core';

/**
 * The `retrieval` report is what lets a consuming agent judge an answer without
 * parsing hedges out of prose. Two failures made that impossible before:
 *
 *  - Ask discarded search's `mode`/`degraded`, so an answer built without dense
 *    vectors reported itself healthy.
 *  - Nothing measured what the index held, so the model inferred coverage from
 *    its retrieved sample and stated it as fact (the 2026-07-15 incident).
 *
 * These assert against the `sources` event, which is emitted before any LLM call
 * — so they pin the measurement, not the model's prose.
 */

const hit = {
  entryId: 1,
  score: 1,
  projectSlug: 'deepcast',
  sourceType: 'kdb_component' as const,
  title: 'analyzer-worker: videoinsight_low had no consumer',
  snippet: 'snippet',
  occurredAt: '2026-07-15T00:00:00.000Z',
  sourcePath: '/x.log',
};

function makeService(opts: {
  hits?: unknown[];
  mode?: string;
  degraded?: boolean;
  coverage?: unknown[];
  windowCounts?: number[];
} = {}) {
  const windowCalls: [string[], string, string][] = [];
  const search = {
    search: async () => ({
      hits: opts.hits ?? [hit],
      mode: opts.mode ?? 'hybrid',
      degraded: opts.degraded ?? false,
      tookMs: 1,
    }),
  };
  let call = 0;
  const catalog = {
    getEntries: async (ids: number[]) => new Map(ids.map((i) => [i, { body: 'full body' }])),
    coverage: async () =>
      opts.coverage ?? [
        {
          projectSlug: 'deepcast',
          entries: 151368,
          oldest: '2025-11-17T19:33:13.000Z',
          newest: '2026-07-25T22:49:16.000Z',
        },
      ],
    countInWindow: async (projects: string[], since: string, until: string) => {
      windowCalls.push([projects, since, until]);
      return opts.windowCounts?.[call++] ?? 0;
    },
  };
  const svc = new AskService(search as any, catalog as any, {
    model: 'test-model',
    baseUrl: 'http://x',
    apiKey: 'k',
  } as any);
  return { svc, windowCalls };
}

async function sourcesEvent(gen: AsyncGenerator<AskEvent>) {
  for await (const e of gen) if (e.type === 'sources') return e as any;
  throw new Error('no sources event');
}

describe('AskService retrieval report', () => {
  it('reports measured coverage for the scope, not the retrieved sample', async () => {
    const { svc } = makeService();
    const e = await sourcesEvent(svc.askStream('what happened on 2026-07-21?'));

    expect(e.retrieval.coverage).toEqual([
      expect.objectContaining({ projectSlug: 'deepcast', entries: 151368 }),
    ]);
    // The retrieved block is dated 07-15; coverage says the index runs to 07-25.
    // That contradiction is the whole point — it is what the model previously
    // had no way to see.
    expect(e.retrieval.coverage[0].newest).toBe('2026-07-25T22:49:16.000Z');
  });

  it('counts the asked window and its neighbourhood when a date is named', async () => {
    const { svc, windowCalls } = makeService({ windowCounts: [0, 412] });
    const e = await sourcesEvent(svc.askStream('what caused the spike on 2026-07-21?'));

    expect(e.retrieval.window).toMatchObject({ exact: 0, padded: 412 });
    // Exact day first, then the padded range — an incident on the 21st is
    // usually written up later, so 0-on-the-day must not stand alone.
    expect(windowCalls[0]![1]).toBe('2026-07-21T00:00:00.000Z');
    expect(windowCalls[1]![1]).toBe('2026-07-18T00:00:00.000Z');
  });

  it('omits the window when the question names no date', async () => {
    const { svc, windowCalls } = makeService();
    const e = await sourcesEvent(svc.askStream('why is videoinsight_low starved?'));
    expect(e.retrieval.window).toBeUndefined();
    expect(windowCalls).toHaveLength(0);
  });

  /**
   * B3: search silently degrades (hybrid → sparse-only when the embedder is
   * down → fts when Qdrant is down) and Ask used to hardcode `degraded: false`.
   */
  it('propagates sparse-only degradation instead of reporting healthy', async () => {
    const { svc } = makeService({ mode: 'sparse-only', degraded: true });
    const e = await sourcesEvent(svc.askStream('anything'));
    expect(e.retrieval).toMatchObject({ mode: 'sparse-only', degraded: true });
  });

  it('propagates the Postgres FTS fallback', async () => {
    const { svc } = makeService({ mode: 'fts', degraded: true });
    const e = await sourcesEvent(svc.askStream('anything'));
    expect(e.retrieval).toMatchObject({ mode: 'fts', degraded: true });
  });

  it('still answers when the coverage measurement fails', async () => {
    const search = {
      search: async () => ({ hits: [hit], mode: 'hybrid', degraded: false, tookMs: 1 }),
    };
    const catalog = {
      getEntries: async (ids: number[]) => new Map(ids.map((i) => [i, { body: 'b' }])),
      coverage: async () => {
        throw new Error('catalog down');
      },
      countInWindow: async () => 0,
    };
    const svc = new AskService(search as any, catalog as any, { model: 'm' } as any);

    const e = await sourcesEvent(svc.askStream('what happened on 2026-07-21?'));
    // Degraded gracefully: the preamble is lost, the answer and its sources are
    // not. A measurement failure must not cost the user their answer.
    expect(e.sources).toHaveLength(1);
    expect(e.retrieval.coverage).toEqual([]);
    expect(e.retrieval.mode).toBe('hybrid');
  });
});
