import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatComplete, chatCompleteWithUsage } from '../../packages/core/src/llm.js';

afterEach(() => vi.unstubAllGlobals());

const cfg = { provider: 'g2p', model: 'configured-model', baseUrl: 'http://llm/v1' } as any;
const msgs = [{ role: 'user' as const, content: 'hi' }];

function stub(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => body, text: async () => '' })),
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
