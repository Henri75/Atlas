import type { EmbeddingProvider } from './types.js';

export async function ollamaAvailable(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function createOllamaProvider(
  baseUrl: string,
  model: string,
): Promise<EmbeddingProvider> {
  const embed = async (texts: string[]): Promise<number[][]> => {
    const r = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`ollama embed failed: ${r.status} ${await r.text()}`);
    const data = (await r.json()) as { embeddings: number[][] };
    return data.embeddings;
  };
  const probe = await embed(['dimension probe']);
  return { name: 'ollama', model, dim: probe[0]!.length, embed };
}
