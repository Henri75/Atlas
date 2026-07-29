import { HttpError, withRetry } from '../retry.js';
import type { EmbeddingProvider } from './types.js';

export interface ProbeOptions {
  attempts?: number;
  timeoutMs?: number;
  /** Injected in tests so a probe never actually sleeps. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Is Ollama there? Asked more than once, because the answer decides the index.
 *
 * This used to be a single fetch with a 2s timeout. That looks harmless until
 * you follow what a `false` sets in motion: `autoSelect` falls back to the
 * bundled 384-dim model, the collection name encodes the dimension so a *new*
 * empty collection is created, the backfill re-embeds every entry into it on a
 * CPU model, `active_collection` is then republished, and `reclaimOrphans`
 * deletes the good collection as an orphan. A two-second network blip is enough
 * to start that, and on 2026-07-29 it did: the host was at load 26, the probe
 * timed out while Ollama was running and reachable throughout, and the indexer
 * booted on the bundled model and began rebuilding 326k entries.
 *
 * Retrying is the cheapest possible guard — a genuinely absent Ollama still
 * answers in about seven seconds, once per boot, while a loaded host gets the
 * benefit of the doubt it always deserved. A non-ok response counts as a failed
 * attempt rather than a verdict, because a 503 from an Ollama still loading its
 * runner is exactly the case worth waiting for.
 */
export async function ollamaAvailable(baseUrl: string, opts: ProbeOptions = {}): Promise<boolean> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return true;
    } catch {
      // Unreachable *this time*. Whether that is the truth is what the next
      // attempt is for.
    }
    if (attempt < attempts) await sleep(250 * 2 ** (attempt - 1));
  }
  return false;
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

/**
 * The first embed after a boot pays the model's cold-load cost, so it is the
 * slowest call in the whole startup sequence — and the one whose failure is
 * most expensive, because `autoSelect` reads a throw here as "no Ollama" and
 * hands the entire index to the bundled CPU model.
 *
 * Steady-state embeds keep the tight ceiling for the reason `EMBED_TIMEOUT_MS`
 * gives: a long one turns a fast retryable failure into a silent stall. That
 * argument does not transfer to the probe. Its alternative to waiting is not a
 * quick retry — it is a full re-embed of the catalog on a worse model — so the
 * probe is allowed to be patient exactly once per boot.
 *
 * Measured on the host that hit this on 2026-07-29: 13.4s cold at load 18.8,
 * 0.23s warm, with indexing batches logged at 45.2s under the same load.
 */
const PROBE_TIMEOUT_MS = 90_000;
const PROBE_ATTEMPTS = 3;

export async function createOllamaProvider(
  baseUrl: string,
  model: string,
  probeOpts: ProbeOptions = {},
): Promise<EmbeddingProvider> {
  const embed = async (texts: string[], timeoutMs = EMBED_TIMEOUT_MS): Promise<number[][]> => {
    const r = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Carry the status so withRetry can classify 5xx/429 as transient.
    if (!r.ok) throw new HttpError(`ollama embed failed: ${await r.text()}`, r.status);
    const data = (await r.json()) as { embeddings: number[][] };
    return data.embeddings;
  };

  // Retried for the same reason `ollamaAvailable` is: the answer decides the
  // collection, and therefore the index. Hardening the reachability probe alone
  // left this one able to start the identical chain one step later. A 4xx is
  // still fatal on the first attempt — a missing model does not arrive by
  // waiting, and retrying it only delays the pull that would fix it.
  const probe = await withRetry(
    () => embed(['dimension probe'], probeOpts.timeoutMs ?? PROBE_TIMEOUT_MS),
    {
      attempts: probeOpts.attempts ?? PROBE_ATTEMPTS,
      baseDelayMs: 1000,
      sleep: probeOpts.sleep,
      onRetry: (attempt, err) =>
        console.warn(
          `[embeddings] dimension probe against ${model} failed (attempt ${attempt}): ` +
            `${(err as Error).message.slice(0, 200)} — retrying rather than conceding to the CPU model`,
        ),
    },
  );
  return {
    name: 'ollama',
    model,
    dim: probe[0]!.length,
    embed: (texts: string[]) => embed(texts),
  };
}
