import { HttpError } from '../retry.js';
import type { EmbeddingProvider } from './types.js';

/**
 * Any OpenAI-compatible /embeddings endpoint: OpenAI itself, G2P (if the
 * proxy exposes embeddings), LM Studio, vLLM, etc.
 */
export async function createOpenAICompatProvider(opts: {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}): Promise<EmbeddingProvider> {
  const embed = async (texts: string[]): Promise<number[][]> => {
    const r = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: opts.model, input: texts }),
      // Remote endpoints are slower than a local model but still answer in
      // seconds; a long ceiling only hides a dead provider.
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new HttpError(`${opts.name} embeddings failed: ${await r.text()}`, r.status);
    const data = (await r.json()) as { data: { index: number; embedding: number[] }[] };
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  };
  const probe = await embed(['dimension probe']);
  return { name: opts.name, model: opts.model, dim: probe[0]!.length, embed };
}
