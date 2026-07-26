import { describe, expect, it, vi, afterEach } from 'vitest';
import { AskService } from '@atlas/core';
import type { AskEvent } from '@atlas/core';

afterEach(() => vi.unstubAllGlobals());

const hit = {
  entryId: 1,
  score: 1,
  projectSlug: 'deepcast',
  sourceType: 'kdb_component' as const,
  title: 'video-import: timeout fix',
  snippet: 'snippet',
  sourcePath: '/x.log',
};

/**
 * A stubbed streaming response. Headers default to what the real G2P gateway
 * sends (verified against a live probe): it answers with a *substituted* model,
 * so the fixtures exercise the served-model path rather than the fallback.
 * Pass `null` to simulate a provider that returns no telemetry headers at all.
 */
function makeService(
  hits: unknown[],
  streamBody?: string,
  headers: Record<string, string> | null = {
    'x-g2p-reply-model': 'google/gemma-4-31b-it',
    'x-g2p-reply-attempts': '1',
    'x-request-id': 'req-abc',
  },
) {
  const search = {
    // Stands in for the real filter: the fixture data lives in `deepcast`, so a
    // scope that does not include it matches nothing. Honours BOTH `project` and
    // `projects` — a mock that only knew the singular would report a partial
    // multi-project match as a full one and hide the very bug these tests exist
    // to catch.
    search: async (_q: string, filters: { project?: string; projects?: string[] } = {}) => {
      const scope = filters.projects?.length
        ? filters.projects
        : filters.project
          ? [filters.project]
          : [];
      const inScope = scope.length === 0 || scope.includes('deepcast');
      return { hits: inScope ? hits : [], mode: 'hybrid', degraded: false, tookMs: 1 };
    },
  };
  const catalog = {
    getEntries: async (ids: number[]) => new Map(ids.map((i) => [i, { body: 'full body' }])),
  };
  if (streamBody !== undefined) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        // `headers: null` stands in for a provider that sends none — telemetry
        // must degrade to nothing without taking the answer down with it.
        ...(headers ? { headers: new Headers(headers) } : {}),
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(streamBody));
            c.close();
          },
        }),
      })),
    );
  }
  return new AskService(search as any, catalog as any, {
    provider: 'g2p',
    model: 'test-model',
    baseUrl: 'http://llm/v1',
  } as any);
}

const collect = async (gen: AsyncGenerator<AskEvent>) => {
  const out: AskEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

const frame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe('AskService.askStream', () => {
  it('emits sources first, then deltas, then done', async () => {
    const svc = makeService([hit], frame('The ') + frame('fix [1]') + 'data: [DONE]\n\n');
    const events = await collect(svc.askStream('what changed?'));

    expect(events[0]).toMatchObject({ type: 'sources' });
    expect((events[0] as any).sources[0]).toMatchObject({ n: 1, entryId: 1 });

    const deltas = events.filter((e) => e.type === 'delta').map((e: any) => e.text);
    expect(deltas.join('')).toBe('The fix [1]');

    expect(events.at(-1)).toMatchObject({ type: 'done', model: 'test-model', degraded: false });
  });

  it('short-circuits with a no-match message when nothing is retrieved', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const svc = makeService([]);
    const events = await collect(svc.askStream('nothing'));

    expect(events[0]).toMatchObject({ type: 'sources', sources: [] });
    // Even a total miss reports how retrieval ran: "found nothing on hybrid" and
    // "found nothing because the embedder was down" are different answers, and a
    // consuming agent must be able to tell them apart.
    expect((events[0] as any).retrieval).toMatchObject({ mode: 'hybrid', degraded: false });
    expect((events[1] as any).text).toMatch(/No indexed content matched/);
    expect(events.at(-1)).toMatchObject({ type: 'done', degraded: false });
    // Retrieval found nothing, so the LLM must not be called at all.
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * A stream that ends without ever producing text is a failure, not an answer.
   *
   * The non-streaming path already refuses this: `chatComplete` throws
   * `EmptyCompletionError` when the completion is blank, which is what a
   * reasoning model returns once `max_tokens` is spent on reasoning
   * (`finish_reason: "length"`). The streaming path had no such guard — zero
   * content frames plus a normal `[DONE]` meant the `for await` body never ran,
   * so `done` reported `degraded: false` with metrics, and the UI rendered an
   * empty answer beside real sources. This is the path a human sees, so it was
   * the worse half of the two to leave unguarded.
   */
  it('reports a stream that produced no text as degraded, not as an answer', async () => {
    // Role-only opener and a usage frame, exactly what a truncated reasoning
    // model sends: telemetry arrives, content never does.
    const body =
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9000, completion_tokens: 2048, total_tokens: 11048 } })}\n\n` +
      'data: [DONE]\n\n';
    const svc = makeService([hit], body);
    const events = await collect(svc.askStream('what changed?'));

    // The sources are still worth having, so they are still emitted.
    expect(events[0]).toMatchObject({ type: 'sources' });
    const text = events
      .filter((e) => e.type === 'delta')
      .map((e: any) => e.text)
      .join('');
    expect(text).not.toBe('');
    expect(text).toMatch(/no answer text/i);
    // And the finish reason is named, because "empty" alone does not tell a
    // reader whether the model was cut off or genuinely had nothing to say.
    expect(text).toMatch(/length/);
    expect(events.at(-1)).toMatchObject({ type: 'done', degraded: true });
  });

  it('still reports a normal answer as healthy', async () => {
    // Guard against over-correcting: content present must stay degraded: false.
    const svc = makeService([hit], frame('a real answer [1]') + 'data: [DONE]\n\n');
    const events = await collect(svc.askStream('q'));
    expect(events.at(-1)).toMatchObject({ type: 'done', degraded: false });
  });

  it('treats a stream of only empty-string deltas as no answer', async () => {
    // The SSE parser drops falsy content, so this arrives as zero deltas too —
    // but assert it explicitly, since a future parser change could pass them on.
    const svc = makeService([hit], frame('') + frame('') + 'data: [DONE]\n\n');
    const events = await collect(svc.askStream('q'));
    expect(events.at(-1)).toMatchObject({ type: 'done', degraded: true });
  });

  it('degrades gracefully and fast when the LLM stream fails', async () => {
    const spy = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    vi.stubGlobal('fetch', spy);
    const svc = makeService([hit]);

    const t0 = Date.now();
    const events = await collect(svc.askStream('q'));

    expect(events[0]).toMatchObject({ type: 'sources' });
    const text = events.filter((e) => e.type === 'delta').map((e: any) => e.text).join('');
    expect(text).toMatch(/LLM unavailable/);
    expect(events.at(-1)).toMatchObject({ type: 'done', degraded: true });

    // Interactive streams must not sit in silent backoff: one attempt, no sleep.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  /**
   * A follow-up like "why?" carries no search signal and retrieves nothing,
   * but the conversation above it holds the answer. Only a *first* question
   * with no hits is a genuine dead end.
   */
  it('answers a follow-up even when retrieval finds nothing', async () => {
    const svc = makeService([], frame('Because of the pidfile.'));
    const events = await collect(
      svc.askStream('why?', {}, 12, [
        { role: 'user', content: 'what broke?' },
        { role: 'assistant', content: 'pgbouncer crash-looped [1]' },
      ]),
    );
    const text = events.filter((e) => e.type === 'delta').map((e: any) => e.text).join('');
    expect(text).toBe('Because of the pidfile.');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('still short-circuits a first question that retrieves nothing', async () => {
    const svc = makeService([]);
    const events = await collect(svc.askStream('nothing at all'));
    expect((events[1] as any).text).toMatch(/No indexed content matched/);
  });

  it('sends prior turns before the freshly retrieved context', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(frame('ok')));
          c.close();
        },
      }),
    }));
    vi.stubGlobal('fetch', spy);
    const svc = makeService([hit]);
    await collect(
      svc.askStream('and then?', {}, 12, [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ]),
    );

    const sent = JSON.parse((spy.mock.calls[0] as any)[1].body).messages;
    expect(sent.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[1].content).toBe('first question');
    // The newest question carries the context blocks, so [n] refers to them.
    expect(sent[3].content).toContain('Context blocks:');
    expect(sent[3].content).toContain('and then?');
  });

  it('never yields a delta before its sources', async () => {
    const svc = makeService([hit], frame('x'));
    const events = await collect(svc.askStream('q'));
    const firstDelta = events.findIndex((e) => e.type === 'delta');
    const sourcesAt = events.findIndex((e) => e.type === 'sources');
    expect(sourcesAt).toBeLessThan(firstDelta);
  });

  /**
   * The core regression: a feature indexed under one project (the drain feature
   * lives in google-gemini-pool) was invisible when asked about scoped to the
   * "wrong" sibling project. A hard scope must fall back to all projects rather
   * than confidently answer "no such thing exists".
   */
  it('widens to all projects when the scoped question matches nothing there', async () => {
    // hit belongs to `deepcast`; scope to a project the fixture never matches.
    const svc = makeService([hit], frame('It lives in deepcast [1]'));
    const events = await collect(svc.askStream('drain feature?', { project: 'google-gemini-pool' }));

    const sources = events.find((e) => e.type === 'sources') as any;
    expect(sources.sources).toHaveLength(1);
    expect(sources.scopeFallback).toEqual({
      // A list even for one project: a scope can hold several, and the banner
      // must be able to name every project that came up empty.
      requested: ['google-gemini-pool'],
      usedAllProjects: true,
    });
    const text = events.filter((e) => e.type === 'delta').map((e: any) => e.text).join('');
    expect(text).toContain('deepcast');
  });

  it('does NOT fall back when the scoped question has in-scope hits', async () => {
    const svc = makeService([hit], frame('answer [1]'));
    const events = await collect(svc.askStream('q', { project: 'deepcast' }));

    const sources = events.find((e) => e.type === 'sources') as any;
    expect(sources.sources).toHaveLength(1);
    expect(sources.scopeFallback).toBeUndefined();
  });

  /**
   * Multi-project scope. The rule generalises rather than merely accepting a
   * list: with several projects selected, *any* hit means the scope worked —
   * the projects that returned nothing simply had nothing to say. Widening on a
   * partial match would fire on nearly every multi-project ask.
   */
  it('answers from whatever matched, without widening, on a partial match', async () => {
    // `hit` lives in deepcast; the scope also names a project it never matches.
    const svc = makeService([hit], frame('found in deepcast [1]'));
    const events = await collect(
      svc.askStream('q', { projects: ['deepcast', 'never-matches'] }),
    );

    const sources = events.find((e) => e.type === 'sources') as any;
    expect(sources.sources).toHaveLength(1);
    // The scope worked. No fallback, no banner.
    expect(sources.scopeFallback).toBeUndefined();
  });

  it('widens only when NONE of the selected projects match', async () => {
    const svc = makeService([hit], frame('it lives elsewhere [1]'));
    const events = await collect(
      svc.askStream('q', { projects: ['nope-one', 'nope-two'] }),
    );

    const sources = events.find((e) => e.type === 'sources') as any;
    // Every requested project is named — the user needs to see the whole set
    // that came up empty, not just one of them.
    expect(sources.scopeFallback).toEqual({
      requested: ['nope-one', 'nope-two'],
      usedAllProjects: true,
    });
  });

  it('reports no match when nothing matches even after widening', async () => {
    const svc = makeService([]); // empty everywhere
    const events = await collect(svc.askStream('nothing', { project: 'whatever' }));
    const sources = events.find((e) => e.type === 'sources') as any;
    expect(sources.scopeFallback).toBeUndefined();
    expect((events[1] as any).text).toMatch(/No indexed content matched/);
  });
});

/**
 * Telemetry. The gateway routes by policy, so the configured model is a request
 * and the served model is the fact — reporting the former attributes an answer
 * to a model that never saw the question.
 */
describe('AskService.askStream — metrics', () => {
  const usageFrame = (completion: number) =>
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: completion, total_tokens: 11 + completion },
    })}\n\n`;

  it('reports the model the gateway served, not the one configured', async () => {
    const svc = makeService([hit], frame('hi [1]') + usageFrame(19) + 'data: [DONE]\n\n');
    const done = (await collect(svc.askStream('q'))).at(-1) as any;

    // Configured `test-model`; gateway answered with gemma. The served name wins.
    expect(done.metrics.model).toBe('google/gemma-4-31b-it');
    expect(done.metrics.substituted).toBe(true);
    expect(done.metrics.requestId).toBe('req-abc');
    expect(done.metrics.attempts).toBe(1);
  });

  it('carries the provider-reported token counts', async () => {
    const svc = makeService([hit], frame('hi [1]') + usageFrame(19) + 'data: [DONE]\n\n');
    const done = (await collect(svc.askStream('q'))).at(-1) as any;

    expect(done.metrics.promptTokens).toBe(11);
    expect(done.metrics.completionTokens).toBe(19);
    expect(done.metrics.totalTokens).toBe(30);
    expect(done.metrics.ttftMs).toBeGreaterThanOrEqual(0);
  });

  it('omits token counts when the provider sends no usage frame', async () => {
    const svc = makeService([hit], frame('hi [1]') + 'data: [DONE]\n\n');
    const done = (await collect(svc.askStream('q'))).at(-1) as any;

    // The model is still known (it came from a header); the counts are not.
    expect(done.metrics.model).toBe('google/gemma-4-31b-it');
    expect(done.metrics.totalTokens).toBeUndefined();
    // Never Infinity or NaN — with no completion count there is no rate to give.
    expect(done.metrics.tokensPerSec).toBeUndefined();
  });

  it('does not flag a vendor-prefixed name as a substitution', async () => {
    const svc = makeService([hit], frame('hi [1]'), {
      'x-g2p-reply-model': 'google/test-model', // same model, vendor-prefixed
    });
    const done = (await collect(svc.askStream('q'))).at(-1) as any;
    expect(done.metrics.substituted).toBe(false);
  });

  it('survives a provider that returns no telemetry headers', async () => {
    const svc = makeService([hit], frame('hi [1]'), null);
    const events = await collect(svc.askStream('q'));
    const done = events.at(-1) as any;

    // The answer must still arrive — telemetry is ancillary and must never be
    // able to fail the reply it describes.
    const text = events.filter((e) => e.type === 'delta').map((e: any) => e.text).join('');
    expect(text).toBe('hi [1]');
    expect(done.degraded).toBe(false);
    // Falls back to the configured model rather than inventing one.
    expect(done.metrics.model).toBe('test-model');
  });

  it('emits no metrics at all when the LLM is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => 'down' })));
    const svc = makeService([hit]);
    const done = (await collect(svc.askStream('q'))).at(-1) as any;

    expect(done.degraded).toBe(true);
    // No headers, no usage — fabricating zeroes would misreport a failed call.
    expect(done.metrics).toBeUndefined();
  });
});
