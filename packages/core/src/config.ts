import { z } from 'zod';

/**
 * Central configuration (§3.1: single source of truth, env-driven).
 * Every service reads ONLY from here — no inline constants elsewhere.
 */

const EmbeddingsProvider = z.enum(['auto', 'ollama', 'bundled', 'openai', 'g2p']);
const LlmProvider = z.enum(['openai', 'g2p']);

const schema = z.object({
  codeRoot: z.string().default('/data/code'),
  claudeProjectsDir: z.string().default('/data/claude/projects'),
  databaseUrl: z.string().default('postgres://kdbscope:kdbscope@postgres:5432/kdbscope'),
  redisUrl: z.string().default('redis://redis:6379'),
  qdrantUrl: z.string().default('http://qdrant:6333'),
  scanIntervalMin: z.coerce.number().int().min(1).default(5),
  embeddings: z.object({
    provider: EmbeddingsProvider.default('auto'),
    model: z.string().default('nomic-embed-text'),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    /** Ollama endpoint probed by the 'auto'/'ollama' providers. */
    ollamaUrl: z.string().default('http://host.docker.internal:11434'),
  }),
  llm: z.object({
    provider: LlmProvider.default('g2p'),
    model: z.string().default('gemini-2.5-flash'),
    baseUrl: z.string().default('http://host.docker.internal:8181/v1'),
    apiKey: z.string().optional(),
  }),
  apiPort: z.coerce.number().int().default(8710),
  mcpPort: z.coerce.number().int().default(8711),
  apiUrl: z.string().default('http://api:8710'),
});

export type AppConfig = z.infer<typeof schema>;

function fromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const opt = (v: string | undefined) => (v === undefined || v === '' ? undefined : v);
  return schema.parse({
    codeRoot: opt(env.CODE_ROOT),
    claudeProjectsDir: opt(env.CLAUDE_PROJECTS_DIR),
    databaseUrl: opt(env.DATABASE_URL),
    redisUrl: opt(env.REDIS_URL),
    qdrantUrl: opt(env.QDRANT_URL),
    scanIntervalMin: opt(env.SCAN_INTERVAL_MIN),
    embeddings: {
      provider: opt(env.EMBEDDINGS_PROVIDER),
      model: opt(env.EMBEDDINGS_MODEL),
      baseUrl: opt(env.EMBEDDINGS_BASE_URL),
      apiKey: opt(env.EMBEDDINGS_API_KEY),
      ollamaUrl: opt(env.OLLAMA_URL),
    },
    llm: {
      provider: opt(env.LLM_PROVIDER),
      model: opt(env.LLM_MODEL),
      baseUrl: opt(env.LLM_BASE_URL),
      apiKey: opt(env.LLM_API_KEY),
    },
    apiPort: opt(env.API_PORT),
    mcpPort: opt(env.MCP_PORT),
    apiUrl: opt(env.KDBSCOPE_API_URL),
  });
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!cached) cached = fromEnv(process.env);
  return cached;
}

/** Test hook: parse an arbitrary env-like object without touching the cache. */
export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  return fromEnv(env);
}
