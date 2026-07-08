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
import { processScanJob, type PipelineDeps, type ScanJobData } from './pipeline.js';
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
  console.log(`[indexer] qdrant collection ready: ${vectors.collection}`);

  const deps: PipelineDeps = { catalog, vectors, embedder };
  const connection = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<ScanJobData>(SCAN_QUEUE, { connection });

  const worker = new Worker<ScanJobData>(
    SCAN_QUEUE,
    async (job) => {
      const t0 = Date.now();
      const { chunksIndexed } = await processScanJob(deps, job.data);
      if (chunksIndexed > 0) {
        console.log(
          `[indexer] ${job.data.projectSlug}/${job.data.sourceType}: +${chunksIndexed} chunks in ${Date.now() - t0}ms`,
        );
      }
      return { chunksIndexed };
    },
    { connection: new Redis(cfg.redisUrl, { maxRetriesPerRequest: null }), concurrency: cfg.workerConcurrency },
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
