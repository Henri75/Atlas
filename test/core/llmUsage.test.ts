import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatComplete, chatCompleteWithUsage } from '../../packages/core/src/llm.js';

afterEach(() => vi.unstubAllGlobals());

const cfg = { provider: 'g2p', model: 'configured-model', baseUrl: 'http://llm/v1' } as any;
const msgs = [{ role: 'user' as const, content: 'hi' }];

function stub(body: unknown, headers: Record<string, string> = {}) {
  // Case-insensitive, like the real Headers object: the gateway sends
  // `X-G2p-Reply-Model` and the code must not depend on that casing.
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => h.get(name.toLowerCase()) ?? null },
      json: async () => body,
      text: async () => '',
    })),
  );
}

/**
 * The token counts were always on the wire — an OpenAI-compatible response
 * carries `usage` and a resolved `model` — but the response type declared only
 * `{ choices }`, so they were parsed and discarded. That left every ask made
 * through MCP (which uses the buffered route) with no cost data at all.
 */
describe('chatCompleteWithUsage', () => {
  it('returns the token counts the provider reported', async () => {
    stub({
      choices: [{ message: { content: 'answer' } }],
      usage: { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540 },
    });
    const { content, usage } = await chatCompleteWithUsage(cfg, msgs);
    expect(content).toBe('answer');
    expect(usage).toMatchObject({ promptTokens: 1200, completionTokens: 340, totalTokens: 1540 });
  });

  /**
   * Gateways substitute models by routing policy. Reporting the *requested*
   * model would make that substitution invisible in the usage record, which is
   * precisely the thing worth noticing.
   */
  it('reports the model that actually answered, not the one requested', async () => {
    stub({ choices: [{ message: { content: 'a' } }], model: 'served-model-b' });
    const { usage } = await chatCompleteWithUsage(cfg, msgs);
    expect(usage?.model).toBe('served-model-b');
  });

  /**
   * THE regression. The gateway's `x-g2p-reply-model` header names what actually
   * ran; the body's `model` field is frequently the requested name echoed back.
   * The first version of this read only the body, so on the buffered path — the
   * one MCP uses, and therefore most real asks — every substitution was recorded
   * as the model we asked for.
   *
   * Observed in production data: the streaming path recorded the provider-
   * qualified `google/gemini-2.5-flash-lite` while the buffered path recorded a
   * bare `gemini-3-flash-preview` for the same gateway.
   */
  it('prefers the gateway header over the body when they disagree', async () => {
    stub(
      { choices: [{ message: { content: 'a' } }], model: 'gemini-2.5-flash' },
      { 'X-G2p-Reply-Model': 'google/gemini-2.5-flash-lite' },
    );
    const { usage } = await chatCompleteWithUsage(cfg, msgs);
    expect(usage?.model).toBe('google/gemini-2.5-flash-lite');
  });

  it('falls back to the body model when the gateway sends no header', async () => {
    stub({ choices: [{ message: { content: 'a' } }], model: 'gemini-2.5-flash' });
    const { usage } = await chatCompleteWithUsage(cfg, msgs);
    expect(usage?.model).toBe('gemini-2.5-flash');
  });

  it('captures the gateway retry count and request id', async () => {
    stub(
      { choices: [{ message: { content: 'a' } }] },
      {
        'x-g2p-reply-model': 'm',
        'x-g2p-reply-attempts': '3',
        'x-request-id': 'req_abc123',
      },
    );
    const { usage } = await chatCompleteWithUsage(cfg, msgs);
    // > 1 means the gateway failed over internally before it succeeded — an
    // answer that arrived, but not on the first try.
    expect(usage?.attempts).toBe(3);
    expect(usage?.requestId).toBe('req_abc123');
  });

  it('ignores a nonsense attempts header rather than storing NaN', async () => {
    stub({ choices: [{ message: { content: 'a' } }] }, { 'x-g2p-reply-attempts': 'not-a-number' });
    const { usage } = await chatCompleteWithUsage(cfg, msgs);
    expect(usage?.attempts).toBeUndefined();
  });

  /** A stub or provider with no headers at all must cost metrics, not the answer. */
  it('still answers when the response has no headers object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'answer' } }] }),
        text: async () => '',
      })),
    );
    await expect(chatCompleteWithUsage(cfg, msgs)).resolves.toMatchObject({ content: 'answer' });
  });

  /**
   * Usage is advisory. A provider that omits it must still produce an answer —
   * failing the call over missing telemetry would trade a working feature for a
   * monitoring nicety.
   */
  it('still answers when the provider reports no usage at all', async () => {
    stub({ choices: [{ message: { content: 'answer' } }] });
    const { content, usage } = await chatCompleteWithUsage(cfg, msgs);
    expect(content).toBe('answer');
    expect(usage).toBeUndefined();
  });

  it('keeps the existing empty-completion guard', async () => {
    stub({ choices: [{ message: { content: '   ' }, finish_reason: 'length' }] });
    await expect(chatCompleteWithUsage(cfg, msgs, { retry: { sleep: async () => {} } })).rejects.toThrow(
      /empty completion/i,
    );
  });
});

/** The four existing call sites must be untouched by the split. */
describe('chatComplete still returns a bare string', () => {
  it('unwraps the content', async () => {
    stub({ choices: [{ message: { content: 'answer' } }], usage: { total_tokens: 9 } });
    await expect(chatComplete(cfg, msgs)).resolves.toBe('answer');
  });
});
