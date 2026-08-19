import { serve } from '@hono/node-server';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  AskService,
  BacklogReviewService,
  Catalog,
  SearchService,
  VectorStore,
  collectionNameFor,
  createEmbedder,
  dirSize,
  embedderServesCollection,
  getConfig,
  loadMachinesFileIfPresent,
  mappingsFromConfig,
  ollamaAvailable,
  parseRedisMemory,
  qdrantCollectionSizes,
  selfMachine,
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

  // Same self-name rule as the indexer's scheduler (resolveSelfName): a
  // present config/machines.yaml names this machine via ATLAS_SELF, an absent
  // one means legacy single-machine mode. Resolved once at boot — the file is
  // a committed SSoT that needs a restart to change anyway.
  const machinesFleet = loadMachinesFileIfPresent(cfg.machinesFile);
  const selfMachineName = machinesFleet ? selfMachine(machinesFleet, cfg.atlasSelf).name : 'local';

  // Prefer the collection the indexer registered (survives provider races).
  const published = await catalog.getSetting('active_collection');

  /**
   * Resolve an embedder that can actually query the published collection.
   *
   * The API runs its own `createEmbedder` in its own process, from the same
   * `auto` config, against the same host — so it can lose the Ollama race
   * independently of the indexer, and on `make restart-build` both are recreated
   * at once and race it together. The indexer's downgrade guard cannot help
   * here: it protects the index, and search is a different failure.
   *
   * A mismatched embedder is worse than none. Its dense vector is rejected by
   * Qdrant (or, at an equal dimension, silently answered from an unrelated
   * space), `SearchService` catches that and answers from the Postgres scan
   * instead, and every query becomes a slow, degraded one with nothing
   * reporting why. `null` costs the dense half and keeps the sparse half, which
   * still queries the real collection and is honestly labelled `sparse-only`.
   */
  const resolveEmbedder = async (): Promise<EmbeddingProvider | null> => {
    let candidate: EmbeddingProvider | null = null;
    try {
      candidate = await createEmbedder(cfg.embeddings, cfg.g2pClientId);
    } catch (e) {
      console.warn('[api] embedder unavailable, sparse/FTS only:', (e as Error).message);
      return null;
    }
    // Re-read: the indexer may have published a collection since we started.
    const active = (await catalog.getSetting('active_collection').catch(() => null)) ?? published;
    const verdict = embedderServesCollection(candidate, active);
    if (!verdict.serves) {
      console.error(`[api] REFUSING the resolved embedder — ${verdict.reason}`);
      return null;
    }
    console.log(`[api] embedder: ${candidate.name}/${candidate.model} dim=${candidate.dim}`);
    return candidate;
  };

  let embedder = await resolveEmbedder();

  let collection = published;
  if (!collection && embedder) {
    collection = collectionNameFor(embedder.name, embedder.model, embedder.dim);
  }
  const vectors = new VectorStore(cfg.qdrantUrl, collection ?? 'kdbscope_unset');

  const search = new SearchService(catalog, vectors, embedder, cfg.docs);

  /**
   * Self-heal. A refusal at boot is the right call but a bad resting state:
   * without this, a five-second blip during `make restart-build` leaves the API
   * on sparse-only until a human notices and restarts it. The indexer recovers
   * on its own (it exits and compose brings it back); the API has no equivalent,
   * so it re-resolves on a slow cadence until it has one that serves.
   */
  const EMBEDDER_RETRY_MS = 5 * 60_000;
  if (!embedder) {
    const timer = setInterval(() => {
      void (async () => {
        const next = await resolveEmbedder();
        if (!next) return;
        embedder = next;
        search.setEmbedder(next);
        clearInterval(timer);
        console.log('[api] embedder recovered — dense search is back');
      })();
    }, EMBEDDER_RETRY_MS);
    timer.unref?.();
  }
  const ask = new AskService(search, catalog, cfg.llm, cfg.g2pClientId);
  const backlogReview = new BacklogReviewService(search, cfg.llm, cfg.g2pClientId);

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
    // Read live, not captured: the self-heal loop can install one later.
    servingEmbedder: () =>
      embedder ? { name: embedder.name, model: embedder.model, dim: embedder.dim } : null,
    backlogReview,
    backlogMatchThreshold: cfg.backlogMatchThreshold,
    machines: () => ({ fleet: machinesFleet, self: selfMachineName }),
    listMachineSync: () => catalog.listMachineSync(),
    listProjectLocations: () => catalog.listProjectLocations(),

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
    /**
     * Same queue, different trigger — the worker already branches on it for
     * 'manual' and 'reconcile'. The work has to happen over there: adoption
     * reads ~/.claude/projects, which is mounted into the indexer only.
     */
    usagePageSize: cfg.usagePageSize,
    enqueueAdoption: async () => {
      await queue.add(
        'adoption',
        { trigger: 'adoption' },
        // A fixed id would collapse repeat refreshes onto one pending job and
        // make the button silently do nothing the second time it is pressed.
        { jobId: `adoption--${Date.now()}` },
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
