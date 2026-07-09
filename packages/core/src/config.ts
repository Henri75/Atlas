import { z } from 'zod';

/**
 * Central configuration (§3.1: single source of truth, env-driven).
 * Every service reads ONLY from here — no inline constants elsewhere.
 */

const EmbeddingsProvider = z.enum(['auto', 'ollama', 'bundled', 'openai', 'g2p']);
const LlmProvider = z.enum(['openai', 'g2p']);

const schema = z.object({
  /**
   * Every project tree to index. `container` is where it is mounted (slot 1 is
   * `/data/code`, extras are `/data/code2` … `/data/code5`); `host` is the
   * same tree as the user sees it, used to build editor deep links. Paired at
   * parse time so the two can never fall out of alignment.
   */
  codeRoots: z
    .array(z.object({ container: z.string(), host: z.string().optional() }))
    .min(1)
    .default([{ container: '/data/code' }]),
  claudeProjectsDir: z.string().default('/data/claude/projects'),
  claudeProjectsHost: z.string().optional(),
  databaseUrl: z.string().default('postgres://kdbscope:kdbscope@postgres:5432/kdbscope'),
  redisUrl: z.string().default('redis://redis:6379'),
  qdrantUrl: z.string().default('http://qdrant:6333'),
  scanIntervalMin: z.coerce.number().int().min(1).default(5),
  /**
   * Parallel scan jobs. Every job embeds, and a local Ollama serialises
   * requests, so a high value just queues work and provokes dropped
   * connections. Raise it only for a remote/batched embedding endpoint.
   */
  workerConcurrency: z.coerce.number().int().min(1).max(16).default(2),
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

/** How many extra project trees compose can mount (`/data/code2` … `code5`). */
export const MAX_EXTRA_CODE_ROOTS = 4;

/**
 * Collect the project trees to index. Slot 1 is always present. An extra slot
 * counts only when its *host* path is configured, because that is what decides
 * whether compose actually mounted anything there.
 */
function readCodeRoots(env: NodeJS.ProcessEnv): {
  codeRoots: { container: string; host?: string }[];
} {
  const val = (v: string | undefined) => (v === undefined || v === '' ? undefined : v);

  const codeRoots = [
    { container: val(env.CODE_ROOT) ?? '/data/code', host: val(env.CODE_ROOT_HOST) },
  ];
  for (let i = 2; i <= MAX_EXTRA_CODE_ROOTS + 1; i++) {
    const host = val(env[`CODE_ROOT_HOST_${i}`]);
    if (!host) continue; // no host path means compose mounted nothing there
    codeRoots.push({ container: val(env[`CODE_ROOT_${i}`]) ?? `/data/code${i}`, host });
  }
  return { codeRoots };
}

function fromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const opt = (v: string | undefined) => (v === undefined || v === '' ? undefined : v);
  return schema.parse({
    ...readCodeRoots(env),
    claudeProjectsDir: opt(env.CLAUDE_PROJECTS_DIR),
    claudeProjectsHost: opt(env.CLAUDE_PROJECTS_HOST),
    databaseUrl: opt(env.DATABASE_URL),
    redisUrl: opt(env.REDIS_URL),
    qdrantUrl: opt(env.QDRANT_URL),
    scanIntervalMin: opt(env.SCAN_INTERVAL_MIN),
    workerConcurrency: opt(env.WORKER_CONCURRENCY),
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
