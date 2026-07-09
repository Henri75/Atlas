import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import cron from 'node-cron';
import {
  Catalog,
  VectorStore,
  collectionNameFor,
  createEmbedder,
  getConfig,
} from '@kdbscope/core';
import {
  backfillVectors,
  needsBackfill,
  processScanJob,
  type PipelineDeps,
  type ScanJobData,
} from './pipeline.js';
import { SCAN_QUEUE, scheduleScans, withSchedulerLock } from './scheduler.js';

/**
 * Indexer entrypoint: migrate catalog, resolve the embedding provider,
 * ensure the Qdrant collection, then run scheduler + BullMQ workers.
 */
async function main() {
  const cfg = getConfig();
  const catalog = new Catalog(cfg.databaseUrl);
  await catalog.migrate();
  console.log('[indexer] catalog migrated');

  const embedder = await createEmbedder(cfg.embeddings);
  console.log(`[indexer] embedder: ${embedder.name}/${embedder.model} dim=${embedder.dim}`);

  const vectors = new VectorStore(
    cfg.qdrantUrl,
    collectionNameFor(embedder.name, embedder.model, embedder.dim),
  );
  await vectors.ensure(embedder.dim);
  await catalog.setSetting('active_embedder', `${embedder.name}/${embedder.model}/${embedder.dim}`);
  console.log(`[indexer] qdrant collection ready: ${vectors.collection}`);

  const deps: PipelineDeps = { catalog, vectors, embedder };
  const connection = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<ScanJobData>(SCAN_QUEUE, { connection });

  /**
   * A collection holding fewer vectors than the catalog has entries means the
   * embedding model changed (the dimension is part of the collection name) or
   * a previous backfill died partway. Entries are never re-inserted
   * (dedup_key), so a normal scan never re-emits them — the vectors must be
   * rebuilt from Postgres.
   *
   * This runs to completion *before* the scan worker starts. Both paths embed,
   * and a local Ollama serves one request at a time, so letting them compete
   * starves the backfill (measured: ~70s per batch against 0.7s standalone).
   *
   * `active_collection` is only published once the rebuild finishes, so the
   * API keeps querying the previous, fully-populated collection throughout.
   */
  const [vectorPoints, entryCount] = await Promise.all([vectors.count(), catalog.countEntries()]);
  const rebuilding = needsBackfill(vectorPoints, entryCount);
  if (rebuilding) {
    const previous = await catalog.getSetting('active_collection');
    console.log(
      `[indexer] ${vectors.collection} holds ${vectorPoints} vectors for ${entryCount} entries — ` +
        `re-embedding from the catalog${previous ? ` (search stays on ${previous})` : ''}`,
    );
    const t0 = Date.now();
    const n = await backfillVectors(deps, {
      // Throughput comes from `embedded` (this run); the bar uses `done`
      // (absolute), or a resumed run would report an absurd rate.
      onPage: async (done, total, embedded) => {
        const rate = embedded / Math.max(1, (Date.now() - t0) / 1000);
        const etaSec = Math.round((total - done) / Math.max(rate, 0.01));
        // Surfaced by /api/stats so a stalled rebuild is visible in the UI
        // rather than only in `docker logs`.
        await catalog
          .setSetting('backfill', JSON.stringify({ done, total, etaSec }))
          .catch(() => {});
        if (done % 2000 < 200) {
          console.log(`[indexer] re-embed ${done}/${total} entries (~${Math.round(etaSec / 60)}m left)`);
        }
      },
    });
    await catalog.setSetting('backfill', '').catch(() => {});
    console.log(`[indexer] re-embed complete: ${n} entries in ${Math.round((Date.now() - t0) / 1000)}s`);
  }

  // Publish only now: readers switch to the new collection once it can serve.
  await catalog.setSetting('active_collection', vectors.collection);

  const worker = new Worker<ScanJobData>(
    SCAN_QUEUE,
    async (job) => {
      // Manual trigger from the API: expand into per-project scan jobs.
      const data = job.data as ScanJobData & { trigger?: string; project?: string };
      if (data.trigger === 'manual') {
        const runId = await catalog.startRun('manual');
        const enqueued = await scheduleScans(cfg, catalog, queue, {
          project: data.project,
          full: data.full,
        });
        await catalog.finishRun(runId, { enqueued });
        return { enqueued };
      }
      const t0 = Date.now();
      // updateProgress renews the job lock; without it, files that take longer
      // than lockDuration trip BullMQ's stall watchdog and get re-queued.
      const { chunksIndexed } = await processScanJob(deps, job.data, async ({ file, chunks }) => {
        await job.updateProgress({ file, chunks }).catch(() => {});
      });
      if (chunksIndexed > 0) {
        console.log(
          `[indexer] ${job.data.projectSlug}/${job.data.sourceType}: +${chunksIndexed} chunks in ${Date.now() - t0}ms`,
        );
      }
      return { chunksIndexed };
    },
    {
      connection: new Redis(cfg.redisUrl, { maxRetriesPerRequest: null }),
      concurrency: cfg.workerConcurrency,
      // Embedding a batch on CPU can take a while; give the lock room and let
      // updateProgress() renew it. Defaults (30s/1) are tuned for fast jobs.
      lockDuration: 120_000,
      stalledInterval: 120_000,
      maxStalledCount: 3,
    },
  );
  worker.on('failed', (job, err) => {
    console.error(`[indexer] job ${job?.id} failed: ${err.message}`);
  });

  const tick = async (kind: 'boot' | 'scheduled') => {
    await withSchedulerLock(connection, async () => {
      const runId = await catalog.startRun(kind);
      const enqueued = await scheduleScans(cfg, catalog, queue);
      await catalog.finishRun(runId, { enqueued });
      console.log(`[indexer] ${kind} tick: ${enqueued} scan jobs enqueued`);
    });
  };

  await tick('boot');
  cron.schedule(`*/${cfg.scanIntervalMin} * * * *`, () => {
    tick('scheduled').catch((e) => console.error('[indexer] tick failed:', e));
  });

  const shutdown = async () => {
    console.log('[indexer] shutting down…');
    await worker.close();
    await queue.close();
    connection.disconnect();
    await catalog.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error('[indexer] fatal:', e);
  process.exit(1);
});
