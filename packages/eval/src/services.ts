import {
  AskService,
  Catalog,
  SearchService,
  VectorStore,
  createEmbedder,
  type EmbeddingProvider,
} from '@atlas/core';
import type { EvalConfig } from './config.js';
import type { CorpusFingerprint } from './types.js';

/**
 * Wire up the real services against the live stack, from the host.
 *
 * Deliberately the product's own classes rather than a thin re-implementation:
 * the harness measures `AskService.retrieveForContext`, which owns the pool-size
 * formula, the scope-widening fallback and the degradation flags. A harness that
 * rebuilt that sequence would agree with the product on the day it was written
 * and drift the first time any of it was tuned, while still printing numbers that
 * looked like the product's.
 */
export interface Stack {
  catalog: Catalog;
  vectors: VectorStore;
  search: SearchService;
  ask: AskService;
  embedder: EmbeddingProvider;
  close: () => Promise<void>;
}

export async function connect(cfg: EvalConfig): Promise<Stack> {
  const catalog = new Catalog(cfg.databaseUrl);
  // Follow whatever collection the indexer is writing. Reading it rather than
  // deriving it from the embedding config means a model switch cannot leave the
  // harness querying an empty collection and calling the result a regression.
  const collection = await catalog.getSetting('active_collection');
  if (!collection) {
    throw new Error('no active_collection in settings — has the indexer ever run?');
  }
  const vectors = new VectorStore(cfg.qdrantUrl, collection);
  if (!(await vectors.healthy())) throw new Error(`qdrant unreachable at ${cfg.qdrantUrl}`);

  const embedder = await createEmbedder(cfg.embeddings as never);
  // `createEmbedder` falls back to the bundled CPU model when Ollama is down,
  // and that model produces vectors in a different space. Silently comparing
  // rankings across two embedding spaces is exactly the kind of invisible
  // degradation this harness exists to catch, so refuse instead.
  if (embedder.name !== 'ollama') {
    throw new Error(
      `embedder resolved to "${embedder.name}", not ollama — vectors would not match the ` +
        `index built with ${cfg.embeddings.model}. Start Ollama at ${cfg.embeddings.ollamaUrl}.`,
    );
  }

  const search = new SearchService(catalog, vectors, embedder);
  const ask = new AskService(search, catalog, cfg.llm as never);
  return { catalog, vectors, search, ask, embedder, close: () => catalog.close() };
}

/**
 * What the index looked like at this moment.
 *
 * Stamped on every run and stored with a baseline, because the corpus grows every
 * five minutes: without it, a diff against a recorded number silently measures
 * corpus growth and reports it as a ranking change.
 */
export async function fingerprint(
  stack: Stack,
  judgementsHash: string,
): Promise<CorpusFingerprint> {
  const r = await stack.catalog.pool.query(
    'SELECT count(*)::int AS entries, max(occurred_at) AS newest FROM entries',
  );
  return {
    entries: r.rows[0].entries,
    newestOccurredAt: r.rows[0].newest?.toISOString?.() ?? null,
    collection: stack.vectors.collection,
    embedder: stack.embedder.name,
    embedderDim: stack.embedder.dim,
    judgementsHash,
  };
}

/** Which fingerprint fields differ, for the drift banner. */
export function driftFields(a: CorpusFingerprint, b: CorpusFingerprint): string[] {
  const keys = Object.keys(a) as (keyof CorpusFingerprint)[];
  return keys.filter((k) => a[k] !== b[k]);
}

/**
 * Run `work` over `items` with a bounded number in flight.
 *
 * Ollama serialises embedding requests, so this exists to keep a batch moving
 * without queueing behind itself — not to go wide.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
