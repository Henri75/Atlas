import { serve } from '@hono/node-server';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  AskService,
  Catalog,
  SearchService,
  VectorStore,
  collectionNameFor,
  createEmbedder,
  getConfig,
  mappingsFromConfig,
} from '@kdbscope/core';
import type { EmbeddingProvider } from '@kdbscope/core';
import { buildApp } from './app.js';

/**
 * API entrypoint. Reads the active collection published by the indexer so
 * both services query the same embedding space; falls back to resolving the
 * provider locally when the indexer hasn't booted yet.
 */
async function main() {
  const cfg = getConfig();
  const catalog = new Catalog(cfg.databaseUrl);
  await catalog.migrate();

  let embedder: EmbeddingProvider | null = null;
  try {
    embedder = await createEmbedder(cfg.embeddings);
  } catch (e) {
    console.warn('[api] embedder unavailable, sparse/FTS only:', (e as Error).message);
  }

  // Prefer the collection the indexer registered (survives provider races).
  let collection = await catalog.getSetting('active_collection');
  if (!collection && embedder) {
    collection = collectionNameFor(embedder.name, embedder.model, embedder.dim);
  }
  const vectors = new VectorStore(cfg.qdrantUrl, collection ?? 'kdbscope_unset');

  const search = new SearchService(catalog, vectors, embedder);
  const ask = new AskService(search, catalog, cfg.llm);

  const connection = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue('kdbscope-scan', { connection });

  const app = buildApp({
    catalog,
    search,
    ask,
    vectorCount: () => vectors.count(),
    // Read live: the indexer may switch collections when the model changes.
    meta: () => ({
      embedder: embedder ? `${embedder.name}/${embedder.model}` : 'none',
      collection: vectors.collection,
    }),
    queueCounts: async () => {
      try {
        return await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      } catch {
        return null; // Redis down: stats still render, just without queue depth.
      }
    },
    pathMappings: mappingsFromConfig(cfg),
    enqueueScan: async ({ project, full }) => {
      // The indexer's scheduler tick owns discovery; we piggyback by writing
      // a trigger job it treats identically (same queue, discovery job).
      // BullMQ rejects ':' in custom ids; the timestamp keeps repeat triggers
      // distinct rather than collapsing onto one pending job.
      const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-');
      await queue.add(
        'manual-reindex',
        { trigger: 'manual', project, full },
        { jobId: `manual--${safe(project ?? 'all')}--${full ? 'full' : 'inc'}--${Date.now()}` },
      );
      return 1;
    },
  });

  serve({ fetch: app.fetch, port: cfg.apiPort, hostname: '0.0.0.0' }, (info) => {
    console.log(`[api] listening on :${info.port}`);
  });
}

main().catch((e) => {
  console.error('[api] fatal:', e);
  process.exit(1);
});
