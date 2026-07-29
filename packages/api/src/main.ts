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
  dirSize,
  getConfig,
  mappingsFromConfig,
  ollamaAvailable,
  parseRedisMemory,
  qdrantCollectionSizes,
} from '@atlas/core';
import type { StorageUsage } from '@atlas/core';
import type { EmbeddingProvider } from '@atlas/core';
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
    embedder = await createEmbedder(cfg.embeddings, cfg.g2pClientId);
  } catch (e) {
    console.warn('[api] embedder unavailable, sparse/FTS only:', (e as Error).message);
  }

  // Prefer the collection the indexer registered (survives provider races).
  let collection = await catalog.getSetting('active_collection');
  if (!collection && embedder) {
    collection = collectionNameFor(embedder.name, embedder.model, embedder.dim);
  }
  const vectors = new VectorStore(cfg.qdrantUrl, collection ?? 'kdbscope_unset');

  const search = new SearchService(catalog, vectors, embedder, cfg.docs);
  const ask = new AskService(search, catalog, cfg.llm, cfg.g2pClientId);

  const connection = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue('kdbscope-scan', { connection });

  const STORAGE_TTL_MS = 30_000;
  let storageCache: { at: number; value: StorageUsage } | null = null;

  const cachedStorage = async (): Promise<StorageUsage> => {
    if (storageCache && Date.now() - storageCache.at < STORAGE_TTL_MS) return storageCache.value;

    // The indexer publishes the active collection; `vectors.collection` only
    // catches up when someone searches, so after a model switch it can still
    // name the old one — inverting the very warning we want to show.
    const active = await catalog.getSetting('active_collection').catch(() => null);

    const [postgresBytes, qdrantBytes, redisInfo, collections] = await Promise.all([
      catalog.databaseSize(),
      dirSize(cfg.qdrantStoragePath),
      connection.info('memory').catch(() => ''),
      qdrantCollectionSizes(cfg.qdrantStoragePath, active ?? vectors.collection),
    ]);

    const value: StorageUsage = {
      postgresBytes,
      qdrantBytes,
      redisMemoryBytes: parseRedisMemory(redisInfo),
      collections,
    };
    storageCache = { at: Date.now(), value };
    return value;
  };

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
    // What was *asked for*. The dashboard compares it against what the indexer
    // recorded as actually serving, which is the only way to tell a deliberate
    // provider from `auto` having settled for one.
    embeddingsProvider: cfg.embeddings.provider,

    // Walking Qdrant's storage tree is the slow part; sizes move slowly, so a
    // short TTL keeps the dashboard fresh without re-crawling on every poll.
    storage: () => cachedStorage(),

    health: async () => {
      const [postgres, qdrant, redis, ollama] = await Promise.all([
        catalog.reachable(),
        vectors.healthy(),
        connection.ping().then(() => true).catch(() => false),
        cfg.embeddings.provider === 'bundled'
          ? Promise.resolve(true)
          : ollamaAvailable(cfg.embeddings.ollamaUrl),
      ]);
      return { postgres, qdrant, redis, ollama };
    },

    vectorStats: () => vectors.info(),
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
