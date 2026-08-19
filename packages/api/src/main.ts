import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
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
  mirrorMappings,
  ollamaAvailable,
  parseRedisMemory,
  qdrantCollectionSizes,
  selfMachine,
} from '@atlas/core';
import type { StorageUsage } from '@atlas/core';
import type { EmbeddingProvider } from '@atlas/core';
import { buildApp } from './app.js';
import { guardTick } from './guard.js';
import { bootId, setConflicted } from './instance.js';

/**
 * API entrypoint. Reads the active collection published by the indexer so
 * both services query the same embedding space; falls back to resolving the
 * provider locally when the indexer hasn't booted yet.
 */
async function main() {
  const cfg = getConfig();

  // Fail closed (spec §7): a non-loopback bind with no token would serve the
  // LAN with no auth at all. Refuse to boot rather than do that silently.
  if (cfg.atlasBind !== '127.0.0.1' && !cfg.atlasToken) {
    console.error(
      `[api] REFUSING TO START — ATLAS_BIND=${cfg.atlasBind} with no ATLAS_TOKEN set. ` +
        'Set ATLAS_TOKEN or leave ATLAS_BIND at 127.0.0.1.',
    );
    process.exit(1);
  }

  const catalog = new Catalog(cfg.databaseUrl);
  await catalog.migrate();

  // Same self-name rule as the indexer's scheduler (resolveSelfName): a
  // present config/machines.yaml names this machine via ATLAS_SELF, an absent
  // one means legacy single-machine mode. Resolved once at boot — the file is
  // a committed SSoT that needs a restart to change anyway.
  const machinesFleet = loadMachinesFileIfPresent(cfg.machinesFile);
  const selfMachineName = machinesFleet ? selfMachine(machinesFleet, cfg.atlasSelf).name : 'local';

  // Continuous single-active guard (spec §8/§10, Task 23). Peers = every
  // OTHER machines.yaml entry, INCLUDING `enabled: false` — a disabled
  // machine can still have its stack accidentally left running. Peers run
  // the api on the same API_PORT convention we do; machines.yaml has no
  // per-machine port field. Legacy mode (no machines file, or a file naming
  // only this machine) yields zero peers, and the guard never runs at all —
  // matching the resolver's own legacy fallback above.
  const guardPeers = machinesFleet
    ? machinesFleet.machines
        .filter((m) => m.name !== selfMachineName)
        .map((m) => ({ name: m.name, url: `http://${m.address}:${cfg.apiPort}/api/instance` }))
    : [];
  const guardWarn = (s: string) => console.warn(`[api] ${s}`);

  if (guardPeers.length > 0) {
    // One pass BEFORE the listener binds (spec §8: "at boot, probe peers — a
    // live peer ⇒ refuse to start"). Deliberately run before the heavier
    // boot work below (embedder resolution, Redis, BullMQ) so a doomed boot
    // exits fast instead of standing all of that up first just to tear it
    // down. `ATLAS_FORCE_ACTIVE=1` is the documented escape hatch — an
    // emergency override, never something the committed defaults set.
    let liveAtBoot: string[] = [];
    await guardTick({
      self: selfMachineName,
      bootId,
      peers: guardPeers,
      token: cfg.atlasToken,
      onConflict: (names) => {
        liveAtBoot = names;
      },
      warn: guardWarn,
    });

    if (liveAtBoot.length > 0 && !cfg.atlasForceActive) {
      console.error(
        `[api] REFUSING TO START — live Atlas instance already running on: ${liveAtBoot.join(', ')}. ` +
          'Run `make down` on one of them before starting this one ' +
          '(or set ATLAS_FORCE_ACTIVE=1 to override — emergency use only).',
      );
      process.exit(1);
    }
    if (liveAtBoot.length > 0) {
      console.warn(
        `[api] ATLAS_FORCE_ACTIVE=1 — starting anyway despite live peer(s): ${liveAtBoot.join(', ')}`,
      );
    }
  }

  // `installId` (spec §8): a settings-row identity, minted once and reused
  // across restarts — unlike `bootId` (instance.ts), which is per-process and
  // never persisted. The restore runbook deliberately re-mints this on a
  // volume copy, which is why `bootId` (not this) is the load-bearing
  // self-recognition check for the single-active guard.
  //
  // `ensureSetting` (not getSetting+setSetting): a check-then-act pair races
  // two concurrent boots into minting two different ids, with the later
  // `setSetting` silently winning and the other boot reporting its own
  // unpersisted id until restart — undermining installId's stable-identity
  // role in the cloned-volume story. `ensureSetting` mints atomically and
  // both boots converge on whichever value actually won.
  const installId = await catalog.ensureSetting('install_id', randomUUID());

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
    // Self mappings plus every other enabled machine's mirror (spec §9);
    // mappingsFromConfig already sorts longest-first on its own, but merging
    // in the mirror mappings means the COMBINED array needs its own explicit
    // re-sort — two independently-sorted lists concatenated are not one
    // sorted list.
    pathMappings: [
      ...mappingsFromConfig(cfg),
      ...(machinesFleet ? mirrorMappings(machinesFleet, selfMachineName) : []),
    ].sort((a, b) => b.containerRoot.length - a.containerRoot.length),
    // What was *asked for*. The dashboard compares it against what the indexer
    // recorded as actually serving, which is the only way to tell a deliberate
    // provider from `auto` having settled for one.
    embeddingsProvider: cfg.embeddings.provider,
    // Read live, not captured: the self-heal loop can install one later.
    servingEmbedder: () =>
      embedder ? { name: embedder.name, model: embedder.model, dim: embedder.dim } : null,
    backlogReview,
    backlogMatchThreshold: cfg.backlogMatchThreshold,
    atlasToken: cfg.atlasToken,
    machines: () => ({ fleet: machinesFleet, self: selfMachineName }),
    listMachineSync: () => catalog.listMachineSync(),
    listProjectLocations: () => catalog.listProjectLocations(),
    // `entries` reuses the same `catalog.stats()` call `/api/dashboard`
    // already makes — no dedicated COUNT query for `/api/instance`.
    instance: async () => ({
      machine: selfMachineName,
      installId,
      entries: (await catalog.stats()).entries,
    }),

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
    // Same queue, same job shape the scheduler's own cadence enqueues
    // (scheduler.ts:213) — a fixed jobId per machine means this collapses
    // onto a pending scheduled sync instead of racing it.
    triggerSync: async (machine: string) => {
      await queue.add(
        `sync/${machine}`,
        { sync: machine },
        { jobId: `sync--${machine}`, removeOnComplete: true, removeOnFail: true },
      );
    },
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

  // Continuous re-probe (spec §8): "closes the asleep-peer hole — a peer
  // invisible at boot is caught within one tick of either side waking."
  // `onConflict: setConflicted` flips this instance to `state: conflicted`
  // (dashboard banner, resolver refusal) rather than exiting — no auto-kill,
  // because an automated winner could stop the instance with the fresher
  // index mid-write. A guard failure must never take a serving API down: any
  // rejection from this tick is caught and logged, and the next tick retries.
  if (guardPeers.length > 0) {
    const timer = setInterval(() => {
      guardTick({
        self: selfMachineName,
        bootId,
        peers: guardPeers,
        token: cfg.atlasToken,
        onConflict: setConflicted,
        warn: guardWarn,
      }).catch((e) => {
        console.error('[api] guard tick failed (will retry next interval):', e);
      });
    }, cfg.scanIntervalMin * 60_000);
    timer.unref();
  }
}

main().catch((e) => {
  console.error('[api] fatal:', e);
  process.exit(1);
});
