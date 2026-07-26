import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_G2P_CLIENT_ID,
  chatStream,
  createSseParser,
} from '../../packages/core/src/llm.js';

const frame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe('createSseParser', () => {
  it('extracts content deltas from complete frames', () => {
    const parse = createSseParser();
    expect(parse(frame('Hello') + frame(' world'))).toEqual(['Hello', ' world']);
  });

  it('buffers frames split across network reads', () => {
    const parse = createSseParser();
    const full = frame('streamed');
    const cut = Math.floor(full.length / 2);
    expect(parse(full.slice(0, cut))).toEqual([]);
    expect(parse(full.slice(cut))).toEqual(['streamed']);
  });

  it('ignores the [DONE] sentinel and empty data lines', () => {
    const parse = createSseParser();
    expect(parse(frame('x') + 'data: [DONE]\n\n')).toEqual(['x']);
    expect(parse('data: \n\n')).toEqual([]);
  });

  it('survives a malformed frame without dropping the stream', () => {
    const parse = createSseParser();
    expect(parse('data: {not json}\n\n' + frame('after'))).toEqual(['after']);
  });

  it('ignores frames with no content delta (role-only openers)', () => {
    const parse = createSseParser();
    const roleOnly = `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`;
    expect(parse(roleOnly + frame('hi'))).toEqual(['hi']);
  });

  it('handles multiple data lines inside one record', () => {
    const parse = createSseParser();
    const rec =
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'b' } }] })}\n\n`;
    expect(parse(rec)).toEqual(['a', 'b']);
  });

  /**
   * The usage frame is the odd one out: it carries `choices: []`, so it yields
   * no content and would be dropped entirely by a content-only read. It only
   * arrives when the request opts in via stream_options.include_usage.
   */
  describe('usage capture', () => {
    const usageFrame =
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 19, total_tokens: 30 },
      })}\n\n`;

    it('captures the usage frame without emitting it as a delta', () => {
      const seen: unknown[] = [];
      const parse = createSseParser((u) => seen.push(u));

      expect(parse(frame('hi') + usageFrame)).toEqual(['hi']);
      expect(seen).toEqual([{ promptTokens: 11, completionTokens: 19, totalTokens: 30 }]);
    });

    it('does not invoke the sink when no usage frame arrives', () => {
      const seen: unknown[] = [];
      const parse = createSseParser((u) => seen.push(u));

      parse(frame('hi') + 'data: [DONE]\n\n');
      expect(seen).toEqual([]);
    });

    it('parses content deltas the same whether or not a sink is passed', () => {
      // The sink is additive: it must not change what the parser returns.
      expect(createSseParser()(frame('x'))).toEqual(['x']);
      expect(createSseParser(() => {})(frame('x'))).toEqual(['x']);
    });
  });

  /**
   * The finish reason is what separates "the model had nothing to say" from "the
   * model was cut off mid-thought". Ask reports one of those to the user, and
   * without this it could only say the answer was empty — which is precisely what
   * made the same failure hard to diagnose on the non-streaming path.
   */
  describe('finish reason capture', () => {
    it('reports the reason from the final content frame', () => {
      const seen: string[] = [];
      const parse = createSseParser(undefined, (r) => seen.push(r));
      const last = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;

      expect(parse(frame('hi') + last)).toEqual(['hi']);
      expect(seen).toEqual(['stop']);
    });

    it('reports a truncation even though that frame carries no content', () => {
      // The case that matters: zero deltas, and the only evidence of why.
      const seen: string[] = [];
      const parse = createSseParser(undefined, (r) => seen.push(r));
      const truncated = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`;

      expect(parse(truncated + 'data: [DONE]\n\n')).toEqual([]);
      expect(seen).toEqual(['length']);
    });

    it('stays silent when no frame carries a reason', () => {
      const seen: string[] = [];
      const parse = createSseParser(undefined, (r) => seen.push(r));
      parse(frame('hi') + 'data: [DONE]\n\n');
      expect(seen).toEqual([]);
    });

    it('ignores a null reason, which providers send on every non-final frame', () => {
      const seen: string[] = [];
      const parse = createSseParser(undefined, (r) => seen.push(r));
      parse(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' }, finish_reason: null }] })}\n\n`);
      expect(seen).toEqual([]);
    });
  });
});

/**
 * The streaming path builds its headers independently of chatComplete, so an
 * attribution header added to one and not the other would leave every
 * interactive answer — the bulk of real traffic — unattributed in G2P stats.
 */
describe('chatStream request headers', () => {
  afterEach(() => vi.unstubAllGlobals());

  const cfg = { provider: 'g2p', model: 'm', baseUrl: 'http://llm/v1' } as any;
  const msgs = [{ role: 'user' as const, content: 'hi' }];

  /** A single-frame SSE body; enough to drive the generator to completion. */
  function stubStream() {
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => undefined },
      body: {
        getReader() {
          let sent = false;
          return {
            read: async () =>
              sent
                ? { done: true, value: undefined }
                : ((sent = true),
                  {
                    done: false,
                    value: new TextEncoder().encode(
                      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
                    ),
                  }),
            releaseLock() {},
          };
        },
      },
    }));
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  /** Drains the generator so the request is actually issued. */
  const drain = async (gen: AsyncGenerator<string>) => {
    for await (const _ of gen) void _;
  };

  const headersOf = (fn: ReturnType<typeof stubStream>) => (fn.mock.calls[0] as any)[1].headers;

  it('sends the configured client id', async () => {
    const fn = stubStream();
    await drain(chatStream(cfg, msgs, { clientId: 'Atlas' }));
    expect(headersOf(fn)['X-G2P-Client-Id']).toBe('Atlas');
  });

  it('falls back to the default client id', async () => {
    const fn = stubStream();
    await drain(chatStream(cfg, msgs));
    expect(headersOf(fn)['X-G2P-Client-Id']).toBe(DEFAULT_G2P_CLIENT_ID);
  });

  it('omits the header when explicitly opted out', async () => {
    const fn = stubStream();
    await drain(chatStream(cfg, msgs, { clientId: '' }));
    expect(headersOf(fn)['X-G2P-Client-Id']).toBeUndefined();
  });
});
