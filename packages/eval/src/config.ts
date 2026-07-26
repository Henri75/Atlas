import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Harness configuration (§3.1: one place, env-driven, no inline constants).
 *
 * The defaults are *host* addresses, unlike `@atlas/core`'s, which are the
 * container-internal ones. That is the whole reason this module exists: the
 * harness runs on the host so a variant can be a config object instead of an
 * image rebuild, and every service it needs is already published on 127.0.0.1.
 * `make eval` passes the ports from .env so there is still a single source of
 * truth for them.
 */

export interface EvalConfig {
  databaseUrl: string;
  qdrantUrl: string;
  embeddings: { provider: 'ollama'; model: string; ollamaUrl: string };
  /** Judge transport. Model is overridden per call, so only the endpoint matters. */
  llm: { provider: 'g2p'; model: string; baseUrl: string; apiKey?: string };
  judge: {
    /** Grades every pooled candidate. */
    primary: string;
    /** Re-grades the subsample the agreement statistic is computed over. */
    second: string;
    /** Fraction of labels double-judged, stratified by grade and class. */
    subsampleFraction: number;
    /** Candidates per judging call. Keeps completions well inside token limits. */
    batchSize: number;
  };
  /** Where Claude Code transcripts live on this host. */
  claudeProjectsDir: string;
  fixtures: {
    queries: string;
    judgements: string;
    baseline: string;
    arbitrate: string;
    signals: string;
  };
  /**
   * Seed for every stochastic step — candidate shuffling, bootstrap resampling,
   * subsample selection. Committed with each artifact so a number can be
   * re-derived rather than merely trusted.
   */
  seed: number;
  /** Context window size Ask uses by default; the k in nDCG@10's neighbourhood. */
  k: number;
  /** Retrieval-stage cutoff for recall. */
  poolCutoff: number;
  /**
   * Queries in flight. Ollama serialises embedding requests (see core's
   * workerConcurrency note), so a larger number only lengthens the queue.
   */
  concurrency: number;
}

const num = (v: string | undefined, dflt: number) => (v ? Number(v) : dflt);
const str = (v: string | undefined, dflt: string) => (v && v !== '' ? v : dflt);

export function evalConfig(env: NodeJS.ProcessEnv = process.env): EvalConfig {
  const fixtureDir = resolve(str(env.ATLAS_EVAL_FIXTURES, 'test/fixtures/eval'));
  return {
    databaseUrl: str(
      env.DATABASE_URL,
      `postgres://kdbscope:kdbscope@127.0.0.1:${num(env.POSTGRES_PORT, 5460)}/kdbscope`,
    ),
    qdrantUrl: str(env.QDRANT_URL, `http://127.0.0.1:${num(env.QDRANT_PORT, 6363)}`),
    embeddings: {
      // Pinned to ollama rather than 'auto': the bundled CPU fallback produces
      // different vectors, so a run that silently downgraded would be comparing
      // rankings from two different embedding spaces and never say so.
      provider: 'ollama',
      model: str(env.EMBEDDINGS_MODEL, 'nomic-embed-text'),
      ollamaUrl: str(env.OLLAMA_URL, 'http://127.0.0.1:11434'),
    },
    llm: {
      provider: 'g2p',
      model: str(env.ATLAS_EVAL_JUDGE, 'cline-pass/kimi-k3'),
      baseUrl: str(env.LLM_BASE_URL, 'http://127.0.0.1:8181/v1'),
      ...(env.LLM_API_KEY ? { apiKey: env.LLM_API_KEY } : {}),
    },
    judge: {
      primary: str(env.ATLAS_EVAL_JUDGE, 'cline-pass/kimi-k3'),
      second: str(env.ATLAS_EVAL_JUDGE2, 'cline-pass/glm-5.2'),
      subsampleFraction: num(env.ATLAS_EVAL_SUBSAMPLE, 0.25),
      batchSize: num(env.ATLAS_EVAL_BATCH, 20),
    },
    claudeProjectsDir: str(env.CLAUDE_PROJECTS_HOST, `${homedir()}/.claude/projects`),
    fixtures: {
      queries: `${fixtureDir}/queries.json`,
      judgements: `${fixtureDir}/judgements.json`,
      baseline: `${fixtureDir}/baseline.json`,
      arbitrate: `${fixtureDir}/arbitrate.md`,
      signals: `${fixtureDir}/signals.json`,
    },
    seed: num(env.ATLAS_EVAL_SEED, 20260726),
    k: num(env.ATLAS_EVAL_K, 12),
    poolCutoff: num(env.ATLAS_EVAL_POOL_CUTOFF, 30),
    concurrency: num(env.ATLAS_EVAL_CONCURRENCY, 4),
  };
}
