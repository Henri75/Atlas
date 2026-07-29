import type { AppConfig } from '../config.js';
import { collectionNameFor } from '../qdrant.js';
import type { EmbeddingProvider } from './types.js';
import { createBundledProvider } from './bundled.js';
import {
  createOllamaProvider,
  ollamaAvailable,
  ollamaHasModel,
  ollamaPull,
  warnIfOllamaTooOld,
} from './ollama.js';
import { createOpenAICompatProvider } from './openaiCompat.js';

export type { EmbeddingProvider } from './types.js';
export {
  MIN_OLLAMA_VERSION,
  compareVersions,
  ollamaAvailable,
  ollamaHasModel,
  ollamaPull,
  warnIfOllamaTooOld,
} from './ollama.js';

/**
 * Provider selection. `auto` prefers Ollama — it is several times faster than
 * the bundled CPU model and produces better vectors — and will pull the model
 * on first boot. Every fallback is logged: a silent downgrade to the CPU
 * embedder costs hours on a large index and used to be invisible.
 */
export async function createEmbedder(
  cfg: AppConfig['embeddings'],
  /** Deployment identity for G2P stats; omit to use the shared default. */
  g2pClientId?: string,
): Promise<EmbeddingProvider> {
  switch (cfg.provider) {
    case 'ollama':
      await warnIfOllamaTooOld(cfg.ollamaUrl);
      return createOllamaProvider(cfg.ollamaUrl, cfg.model);
    case 'bundled':
      return createBundledProvider();
    case 'openai':
      if (!cfg.baseUrl) throw new Error('EMBEDDINGS_BASE_URL is required for provider=openai');
      return createOpenAICompatProvider({
        name: 'openai',
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKey: cfg.apiKey,
        clientId: g2pClientId,
      });
    case 'g2p':
      return createOpenAICompatProvider({
        name: 'g2p',
        baseUrl: cfg.baseUrl ?? 'http://host.docker.internal:8181/v1',
        model: cfg.model,
        apiKey: cfg.apiKey,
        clientId: g2pClientId,
      });
    case 'auto':
    default:
      return autoSelect(cfg);
  }
}

async function autoSelect(cfg: AppConfig['embeddings']): Promise<EmbeddingProvider> {
  if (!(await ollamaAvailable(cfg.ollamaUrl))) {
    console.warn(
      `[embeddings] Ollama unreachable at ${cfg.ollamaUrl} — falling back to the bundled ` +
        'CPU model (slower). Start Ollama for a large speedup.',
    );
    return createBundledProvider();
  }

  // Loud, non-fatal: an old Ollama stalls indexing with no visible error.
  await warnIfOllamaTooOld(cfg.ollamaUrl);

  if (!(await ollamaHasModel(cfg.ollamaUrl, cfg.model))) {
    console.log(`[embeddings] pulling ${cfg.model} into Ollama (first run, may take a while)…`);
    try {
      await ollamaPull(cfg.ollamaUrl, cfg.model);
      console.log(`[embeddings] pulled ${cfg.model}`);
    } catch (e) {
      // Not fatal by itself. `ollamaHasModel` is a single unretried 5s call, and
      // a loaded host makes it answer "absent" about a model that is installed
      // — so a failed pull of a model that was there all along must not decide
      // the index. The dimension probe below is the honest test; let it run.
      console.warn(
        `[embeddings] could not pull ${cfg.model} (${(e as Error).message}) — ` +
          'trying the model anyway, in case it was there all along.',
      );
    }
  }

  try {
    return await createOllamaProvider(cfg.ollamaUrl, cfg.model);
  } catch (e) {
    console.warn(
      `[embeddings] Ollama present but unusable (${(e as Error).message}) — ` +
        'falling back to the bundled CPU model.',
    );
    return createBundledProvider();
  }
}

/** The provider `auto` prefers; anything else means it fell back. */
export const AUTO_PREFERRED_PROVIDER = 'ollama';

export interface EmbedderStatus {
  /** Provider actually serving, or null before the indexer has ever run. */
  name: string | null;
  model: string | null;
  dim: number | null;
  /** What the operator configured, verbatim. */
  configured: string;
  /** `auto` settled for something other than its preferred provider. */
  fallback: boolean;
}

/**
 * Read the `active_embedder` setting into something a health surface can show.
 *
 * "Running on a fallback embedder" used to exist only in `docker logs`, which is
 * where it stayed on 2026-07-29 while the indexer began rebuilding the index on
 * a CPU model. Every dashboard dependency showed healthy, correctly: it measured
 * reachability, and everything was reachable. A degraded embedder is not an
 * outage — it is worse, because nothing looks wrong while the vectors quietly
 * get worse and the rebuild burns hours.
 *
 * Only `auto` can produce a fallback. Asking for `bundled` and getting `bundled`
 * is the system working, and reporting that as degraded would train everyone to
 * ignore the flag.
 */
export function embedderStatus(configured: string, activeEmbedder: string | null): EmbedderStatus {
  const unknown = { name: null, model: null, dim: null, configured, fallback: false };
  if (!activeEmbedder) return unknown;

  // `${name}/${model}/${dim}`, where the *model* may itself contain slashes
  // ("bundled/Xenova/all-MiniLM-L6-v2/384"). Only the first and last fields are
  // positional; everything between them is the model.
  const parts = activeEmbedder.split('/');
  if (parts.length < 3) return unknown;
  const name = parts[0]!;
  const dim = Number(parts[parts.length - 1]);
  if (!name || !Number.isFinite(dim)) return unknown;

  return {
    name,
    model: parts.slice(1, -1).join('/'),
    dim,
    configured,
    fallback: configured === 'auto' && name !== AUTO_PREFERRED_PROVIDER,
  };
}

export interface ServingVerdict {
  serves: boolean;
  reason?: string;
}

/**
 * Can this embedder query the collection the indexer published?
 *
 * The indexer's `embedderDowngrade` guard protects the index from a fallback
 * embedder. This protects *search*, in the other process. The API resolves its
 * own embedder from the same `auto` config, at the same moment, against the
 * same loaded host — and nothing checked the result against the collection it
 * was about to query.
 *
 * The failure is entirely silent. A 384-dim query vector against the 768-dim
 * collection is rejected by Qdrant, `SearchService` catches that alongside
 * "Qdrant is down" and answers from Postgres FTS instead: every search
 * degraded, at roughly twelve seconds each, while `/api/dashboard` keeps
 * reporting `ollama/768` — because `embedderHealth` reads the `active_embedder`
 * setting, which the *indexer* writes about *itself*.
 *
 * Identity, not dimension, is the test. Two models can share a dimension and
 * embed into unrelated spaces; Qdrant would accept those queries and return
 * confident nonsense, which is worse than an error, and exactly the class of
 * degradation this system keeps having to learn to see.
 */
export function embedderServesCollection(
  embedder: Pick<EmbeddingProvider, 'name' | 'model' | 'dim'> | null,
  activeCollection: string | null,
): ServingVerdict {
  if (!embedder) return { serves: false, reason: 'no embedder resolved' };
  // Nothing published yet (first boot): whatever resolved is what will be used.
  if (!activeCollection) return { serves: true };

  const own = collectionNameFor(embedder.name, embedder.model, embedder.dim);
  if (own === activeCollection) return { serves: true };

  return {
    serves: false,
    reason:
      `resolved ${embedder.name}/${embedder.model}/${embedder.dim}, which embeds into ${own}, ` +
      `but the indexer publishes ${activeCollection}. Dense queries would be answered from the ` +
      'wrong vector space or rejected outright, and either way search would quietly fall back ' +
      'to the Postgres scan.',
  };
}
