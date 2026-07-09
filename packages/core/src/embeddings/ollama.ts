import { HttpError } from '../retry.js';
import type { EmbeddingProvider } from './types.js';

export async function ollamaAvailable(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Ollama reports installed models as "name:tag"; a bare name means ":latest". */
export async function ollamaHasModel(baseUrl: string, model: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const data = (await r.json()) as { models?: { name: string }[] };
    const want = model.includes(':') ? model : `${model}:latest`;
    return (data.models ?? []).some((m) => m.name === want || m.name === model);
  } catch {
    return false;
  }
}

/**
 * Pull a model into Ollama. The pull endpoint streams NDJSON progress; we only
 * need completion, so the body is drained rather than parsed. Large first-time
 * pulls (~270MB for nomic-embed-text) justify the long timeout.
 */
export async function ollamaPull(baseUrl: string, model: string): Promise<void> {
  const r = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false }),
    signal: AbortSignal.timeout(900_000),
  });
  if (!r.ok) throw new Error(`ollama pull ${model} failed: ${r.status} ${await r.text()}`);
}

/**
 * A healthy 32-item batch answers in well under a second. A minutes-long
 * ceiling does not buy resilience: it turns a fast, retryable failure into a
 * silent stall — observed when an old Ollama runner crashed mid-request and
 * simply stopped responding.
 */
const EMBED_TIMEOUT_MS = 30_000;

export async function createOllamaProvider(
  baseUrl: string,
  model: string,
): Promise<EmbeddingProvider> {
  const embed = async (texts: string[]): Promise<number[][]> => {
    const r = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    // Carry the status so withRetry can classify 5xx/429 as transient.
    if (!r.ok) throw new HttpError(`ollama embed failed: ${await r.text()}`, r.status);
    const data = (await r.json()) as { embeddings: number[][] };
    return data.embeddings;
  };
  const probe = await embed(['dimension probe']);
  return { name: 'ollama', model, dim: probe[0]!.length, embed };
}
