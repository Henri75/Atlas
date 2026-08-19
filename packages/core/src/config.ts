import { z } from 'zod';
import { DEFAULT_AGING_MONTHS, DEFAULT_ARCHIVED_PENALTY } from './docStatus.js';
import { DEFAULT_G2P_CLIENT_ID } from './g2pHeaders.js';

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
  /**
   * Qdrant's storage volume, mounted read-only into the API so the dashboard
   * can report real disk usage — Qdrant exposes no API for it.
   */
  qdrantStoragePath: z.string().default('/qdrant-storage'),
  scanIntervalMin: z.coerce.number().int().min(1).default(5),
  /**
   * Parallel scan jobs. Every job embeds, and a local Ollama serialises
   * requests, so a high value just queues work and provokes dropped
   * connections. Raise it only for a remote/batched embedding endpoint.
   */
  workerConcurrency: z.coerce.number().int().min(1).max(16).default(2),
  /**
   * Kill switch for the sparse re-tokenisation pass.
   *
   * Bumping `SPARSE_VERSION` makes every stored sparse vector disagree with the
   * query encoder, so the pass is normally mandatory — but it writes to every
   * point in the collection, and an operator watching a rebuild misbehave needs
   * a way to stop it that is not "edit the source and rebuild the image".
   * Skipping leaves keyword search on the old tokens (degraded, not broken:
   * dense retrieval is unaffected) and the pass reruns on the next boot.
   */
  sparseRebuild: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
    .default(true),
  /**
   * Permit `auto` to move the index to a different collection when it falls
   * back to a non-preferred embedder.
   *
   * Off by default because the fallback is a guess, not an instruction, and the
   * consequence is a full re-embed followed by the old collection being
   * reclaimed. Set it only to make a one-off downgrade go through; the
   * non-emergency way to switch models is an explicit `EMBEDDINGS_PROVIDER`.
   */
  allowEmbedderDowngrade: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
    .default(false),
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
  /**
   * Who we claim to be on outbound LLM/embedding calls (`X-G2P-Client-Id`), so
   * G2P attributes usage to us rather than the anonymous bucket. Shared by the
   * chat and embedding clients — it identifies the deployment, not one
   * endpoint, and embeddings against the `g2p` provider are billed traffic too.
   * Set it per instance to tell two deployments apart on the dashboard; set it
   * to an empty string to send nothing at all.
   */
  g2pClientId: z.string().default(DEFAULT_G2P_CLIENT_ID),
  /** Doc staleness knobs — tune ranking without ever reindexing. */
  docs: z
    .object({
      agingMonths: z.coerce.number().int().min(1).default(DEFAULT_AGING_MONTHS),
      archivedPenalty: z.coerce.number().min(0).max(1).default(DEFAULT_ARCHIVED_PENALTY),
    })
    .default({ agingMonths: DEFAULT_AGING_MONTHS, archivedPenalty: DEFAULT_ARCHIVED_PENALTY }),
  /** Minimum token containment for linking a legacy DONE:/RESOLVED: line to its item. */
  backlogMatchThreshold: z.coerce.number().min(0).max(1).default(0.5),
  /** Rows per page in the usage call log. */
  usagePageSize: z.coerce.number().int().min(10).max(500).default(100),
  /**
   * Minutes between adoption recomputes. Daily by default: the scan reads every
   * transcript on the machine, and whether agents honour a trigger changes over
   * days, not minutes.
   */
  adoptionRefreshMin: z.coerce.number().int().min(5).default(1440),
  /**
   * Days of usage telemetry to keep. 0 means keep everything, which is the
   * default — at observed volume the whole table is single-digit MB/year, and
   * silently discarding the record a monitor exists to hold is the worse failure.
   */
  usageRetentionDays: z.coerce.number().int().min(0).default(0),
  apiPort: z.coerce.number().int().default(8710),
  mcpPort: z.coerce.number().int().default(8711),
  apiUrl: z.string().default('http://api:8710'),
  /** Committed machine-fleet SSoT; absent file = legacy single-machine mode. */
  machinesFile: z.string().default('/config/machines.yaml'),
  /** Which machines.yaml entry is THIS host. Required once the file exists. */
  atlasSelf: z.string().optional(),
  /**
   * Host bind address api/mcp/ui publish their ports on (spec §7). Also read
   * at boot (api + mcp `main.ts`) to fail closed: a non-loopback bind with no
   * `atlasToken` refuses to start rather than serve the LAN unauthenticated.
   * qdrant/redis/postgres ignore this and stay on `127.0.0.1` regardless.
   */
  atlasBind: z.string().default('127.0.0.1'),
  /**
   * Bearer token required for non-loopback requests once set (spec §7).
   * Empty/absent = legacy localhost-only mode: `authMiddleware` is a no-op.
   */
  atlasToken: z.string().optional(),
  /**
   * Emergency escape hatch for the boot-time single-active guard (spec §8,
   * Task 23): a live peer normally refuses to let this instance start.
   * Deliberately absent from `config/atlas.defaults.env` — this overrides a
   * safety check meant to prevent two stacks writing the same index at
   * once, so it belongs in a one-off shell/Doppler override for the boot
   * that needs it, never in the committed fleet-wide defaults.
   */
  atlasForceActive: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
    .default(false),
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
    qdrantStoragePath: opt(env.QDRANT_STORAGE_PATH),
    scanIntervalMin: opt(env.SCAN_INTERVAL_MIN),
    workerConcurrency: opt(env.WORKER_CONCURRENCY),
    sparseRebuild: opt(env.KDB_SPARSE_REBUILD),
    allowEmbedderDowngrade: opt(env.KDB_ALLOW_EMBEDDER_DOWNGRADE),
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
    // NOT `opt()`: that maps '' to undefined, which zod would then replace with
    // the default — turning the documented "send no client id" opt-out into a
    // silent no-op. An unset var is undefined and does take the default.
    g2pClientId: env.KDB_G2P_CLIENT_ID,
    docs: {
      agingMonths: opt(env.KDB_DOCS_AGING_MONTHS),
      archivedPenalty: opt(env.KDB_ARCHIVED_PENALTY),
    },
    backlogMatchThreshold: opt(env.KDB_BACKLOG_MATCH_THRESHOLD),
    usagePageSize: opt(env.KDB_USAGE_PAGE_SIZE),
    adoptionRefreshMin: opt(env.KDB_ADOPTION_REFRESH_MIN),
    usageRetentionDays: opt(env.KDB_USAGE_RETENTION_DAYS),
    apiPort: opt(env.API_PORT),
    mcpPort: opt(env.MCP_PORT),
    apiUrl: opt(env.KDBSCOPE_API_URL),
    machinesFile: opt(env.ATLAS_MACHINES_FILE),
    atlasSelf: opt(env.ATLAS_SELF),
    atlasBind: opt(env.ATLAS_BIND),
    atlasToken: opt(env.ATLAS_TOKEN),
    atlasForceActive: opt(env.ATLAS_FORCE_ACTIVE),
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
