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
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`${opts.name} embeddings failed: ${r.status} ${await r.text()}`);
    const data = (await r.json()) as { data: { index: number; embedding: number[] }[] };
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  };
  const probe = await embed(['dimension probe']);
  return { name: opts.name, model: opts.model, dim: probe[0]!.length, embed };
}
