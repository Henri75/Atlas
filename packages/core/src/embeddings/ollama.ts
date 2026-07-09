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

/**
 * Ollama below this segfaults inside `/api/embed` under sustained load
 * (a Go panic in `llamarunner.(*Server).embeddings`, then the runner hangs).
 * Diagnosed the hard way on 0.12.6; fixed by 0.13.
 */
export const MIN_OLLAMA_VERSION = '0.13.0';

/** Compare dotted numeric versions. Returns <0, 0, >0 like a comparator. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (v.match(/\d+/g) ?? []).map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Warn when the running Ollama is old enough to crash on embeddings. Never
 * throws: an unrecognised version string must not stop the indexer booting.
 */
export async function warnIfOllamaTooOld(baseUrl: string): Promise<string | null> {
  let version: string | undefined;
  try {
    const r = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    version = ((await r.json()) as { version?: string }).version;
  } catch {
    return null;
  }
  if (!version || !/\d/.test(version)) return null;
  if (compareVersions(version, MIN_OLLAMA_VERSION) >= 0) return null;

  const msg =
    `Ollama ${version} is below the known-good ${MIN_OLLAMA_VERSION}: its embeddings ` +
    'endpoint segfaults under sustained load, which stalls indexing with no error. ' +
    'Upgrade it (`brew upgrade ollama`).';
  console.warn(`[embeddings] ${msg}`);
  return msg;
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
