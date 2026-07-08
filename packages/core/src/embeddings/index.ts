import type { AppConfig } from '../config.js';
import type { EmbeddingProvider } from './types.js';
import { createBundledProvider } from './bundled.js';
import { createOllamaProvider, ollamaAvailable } from './ollama.js';
import { createOpenAICompatProvider } from './openaiCompat.js';

export type { EmbeddingProvider } from './types.js';
export { ollamaAvailable } from './ollama.js';

/**
 * Provider selection (design §5.5): explicit provider wins; 'auto' probes
 * Ollama and falls back to the bundled CPU model.
 */
export async function createEmbedder(cfg: AppConfig['embeddings']): Promise<EmbeddingProvider> {
  switch (cfg.provider) {
    case 'ollama':
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
    default: {
      if (await ollamaAvailable(cfg.ollamaUrl)) {
        try {
          return await createOllamaProvider(cfg.ollamaUrl, cfg.model);
        } catch {
          // model missing etc. — fall through to bundled
        }
      }
      return createBundledProvider();
    }
  }
}
