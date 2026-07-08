import type { AppConfig } from './config.js';

/**
 * Minimal OpenAI-compatible chat client. G2P is just a preset base URL —
 * same wire protocol, no inbound key required.
 *
 * Retry policy (§3.8): transient failures only — 429 and 5xx, max 2 retries
 * with exponential backoff. Other 4xx fail immediately.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export async function chatComplete(
  cfg: AppConfig['llm'],
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          max_tokens: opts.maxTokens ?? 2048,
          temperature: opts.temperature ?? 0.2,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) {
        const text = await r.text();
        const err = new Error(`LLM ${r.status}: ${text.slice(0, 500)}`);
        if (!RETRYABLE.has(r.status)) throw err;
        lastError = err;
        continue;
      }
      const data = (await r.json()) as {
        choices: { message: { content: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('LLM returned no content');
      return content;
    } catch (e) {
      const err = e as Error;
      // AbortError / network errors are transient; API 4xx errors are not.
      if (err.message.startsWith('LLM 4')) throw err;
      lastError = err;
    }
  }
  throw lastError ?? new Error('LLM call failed');
}
