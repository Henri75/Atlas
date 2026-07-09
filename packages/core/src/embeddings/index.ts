import type { AppConfig } from '../config.js';
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
export async function createEmbedder(cfg: AppConfig['embeddings']): Promise<EmbeddingProvider> {
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
      });
    case 'g2p':
      return createOpenAICompatProvider({
        name: 'g2p',
        baseUrl: cfg.baseUrl ?? 'http://host.docker.internal:8181/v1',
        model: cfg.model,
        apiKey: cfg.apiKey,
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
      console.warn(
        `[embeddings] could not pull ${cfg.model} (${(e as Error).message}) — ` +
          'falling back to the bundled CPU model.',
      );
      return createBundledProvider();
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
