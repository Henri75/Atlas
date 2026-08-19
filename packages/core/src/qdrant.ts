import { QdrantClient } from '@qdrant/js-client-rest';
import { selectedProjects, type SearchFilters } from './types.js';
import type { SparseVector } from './sparse.js';
import { withRetry } from './retry.js';

/** Points per HTTP call. Keeps each request well inside Qdrant's 5s timeout. */
const UPSERT_BATCH = 64;

/**
 * Points per sparse-only update. Deliberately far larger than `UPSERT_BATCH`.
 *
 * 64 is sized for *dense* vectors — 768 floats a point, so a batch is ~200 kB.
 * A sparse vector is a few dozen term/value pairs, two orders of magnitude
 * smaller, and the batch size is not what bounds it. What bounds a re-tokenise
 * is the number of write *operations*: Qdrant applies them one at a time behind
 * the optimizer, so 326k points at 64 each is ~5,100 operations to work through.
 * Measured on the 2026-07-29 rebuild, that pass sent in 646s and was still
 * applying hours later on a loaded host. Same bytes, ~8x fewer operations.
 */
const SPARSE_UPDATE_BATCH = 512;

/**
 * Qdrant wrapper: one collection per embedding config, named vectors
 * 'dense' + 'sparse'. Sparse uses the server-side IDF modifier so clients
 * only ship term frequencies. Hybrid queries fuse both branches with RRF.
 */

export interface VectorPoint {
  id: string;
  dense?: number[];
  sparse: SparseVector;
  payload: {
    entry_id: number;
    project: string;
    source_type: string;
    component?: string;
    session_id?: string;
    /** Message classification (insight, summary, action…) for session entries. */
    kind?: string;
    /** 'archived' for docs under archive-style paths; absent means active. */
    doc_status?: string;
    occurred_at?: string;
    /**
     * Which machine this entry was first ingested from (spec §6). Absent on
     * points written before this field existed — a `machine` filter misses
     * those until the Task 17 backfill runs.
     */
    machine?: string;
  };
}

/**
 * The product is Atlas; the `kdbscope_` prefix is the former name and is FROZEN
 * PERMANENTLY. It is the storage key the live collection is stored under: every
 * one of the ~324k dense vectors lives in `kdbscope_<provider>_<model>_<dim>`.
 * Renaming the prefix to `atlas_` points the indexer at a collection that does
 * not exist — it creates an empty one and search returns nothing until a full
 * re-embed of every entry (hours). This is an internal namespace users never
 * see; do NOT attempt the rename unless a full re-embed is already happening
 * for another reason. The matching id namespace is frozen for the same reason
 * (see ids.ts). Cosmetic gain, hours of rebuild. Leave it.
 *
 * `COLLECTION_PREFIX` is the guard the orphan-reclaim path uses: we only ever
 * drop collections we ourselves created, never anything else in Qdrant.
 */
export const COLLECTION_PREFIX = 'kdbscope_';

export function collectionNameFor(provider: string, model: string, dim: number): string {
  const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `${COLLECTION_PREFIX}${safe(provider)}_${safe(model)}_${dim}`;
}

/**
 * Scalar int8 quantization: keeps a 1-byte-per-dimension approximation of each
 * dense vector in RAM (≈4× smaller than the fp32 original) and rescores the
 * top candidates against the full-precision vectors on disk. Recall loss for
 * Cosine is well under a percent, while the resident set of the 768-dim
 * collection drops from ~1GB of raw vectors to ~250MB. `quantile: 0.99` clips
 * outlier dimensions so the int8 range is not wasted on a few extreme values.
 *
 * `always_ram` pins the *quantized* copy in RAM. It says nothing about where
 * the fp32 originals live — that is `VECTORS.dense.on_disk`, and the two are
 * independent. Read both before changing either; assuming otherwise is exactly
 * how this collection ended up holding both copies in RAM (see VECTORS).
 */
const QUANTIZATION = {
  scalar: { type: 'int8' as const, quantile: 0.99, always_ram: true },
};

/**
 * Dense vectors live on disk; only the int8 approximation of them stays in RAM.
 *
 * This is the half of the 2026-07-15 quantization work that was missed, and the
 * miss was silent. That entry recorded the intent as "quantization keeps fp32
 * originals on disk for rescoring (always_ram quantizes the RAM-resident
 * copy)" — but `always_ram` only ever controlled the quantized copy. Where the
 * originals sit is this flag, it was never set, and its default is *in RAM*.
 * So the change added a ~290MB int8 copy alongside the ~1.1GB of fp32 vectors
 * instead of replacing it, and the collection carried both. Measured on the
 * live 376k-point collection (2026-07-30): every segment reported
 * `storage_type: InRamChunkedMmap`, and 707MB of Qdrant's 730MB RSS was
 * `Anonymous`/`Private_Dirty` — real RAM the kernel cannot reclaim, not page
 * cache. Boot peak was 2.12GiB.
 *
 * With `on_disk: true` the segments become `Mmap`/`ChunkedMmap`: the fp32 file
 * is memory-mapped, so the pages are file-backed and reclaimable under
 * pressure, and the resident set is the int8 copy plus the HNSW graph. Same
 * collection after the flip: ~360MB resident, no data rewritten beyond the
 * storage-format conversion Qdrant does in place.
 *
 * The HNSW graph deliberately stays in RAM (`hnsw_config.on_disk` left false).
 * It is the hot path — every query walks it — and it is the cheapest of the
 * three at ~31MB for this collection. Putting *it* on disk is the change that
 * actually hurts latency; putting the vectors there is nearly free because
 * only rescoring reads them.
 */
const VECTORS = {
  dense: { on_disk: true },
};

/**
 * The sparse inverted index is memory-mapped too.
 *
 * Sparse postings are far more disk-friendly than dense vectors — a query
 * touches only the posting lists for its own terms, not the whole structure —
 * which is why Qdrant's own memory guidance names sparse vectors as a first
 * candidate for disk. Measured 98MB of `ImmutableRam` index across the live
 * segments before the flip.
 *
 * `modifier: 'idf'` is repeated here because a PATCH of `sparse_vectors`
 * replaces the named vector's whole config; omitting it would drop server-side
 * IDF scoring and silently change every keyword ranking.
 */
const SPARSE_VECTORS = {
  sparse: { modifier: 'idf' as const, index: { on_disk: true } },
};

/**
 * Search-time quantization params. `rescore` MUST be stated explicitly.
 *
 * Qdrant's default for it flips with where the originals live: with vectors in
 * RAM, rescoring the top candidates against full precision is nearly free and
 * defaults ON; once `on_disk: true` it defaults OFF, because rescoring then
 * costs a disk read. That trade is made silently, and it is not the one we
 * want — moving vectors to disk would quietly hand back a chunk of the recall
 * the quantization was carefully tuned to preserve.
 *
 * Measured on the live collection against Qdrant's own exact full-precision
 * scan as ground truth (25 sampled query vectors, recall@10, dense branch
 * only, host idle, async_scorer on):
 *
 *   default                    0.9560    p50 21.0ms   — identical to rescore=false
 *   rescore: false             0.9560    p50 11.8ms
 *   rescore: true              0.9920    p50 14.6ms   <- shipped
 *   rescore: true, oversample 2  0.9960  p50 21.1ms
 *   rescore: true, hnsw_ef 256   0.9880  p50 21.0ms
 *
 * The default costing *more* than rescore=false is noise; the two send an
 * identical request. What is not noise is the 0.956/0.992 split, which
 * reproduced across two runs hours apart.
 *
 * Oversampling is left off: +0.004 recall is one result in 250 — inside the
 * noise floor of a 25-query sample — for ~45% more latency. Raising `hnsw_ef`
 * measured no better than the default and costs the same, so it is off too.
 */
const SEARCH_PARAMS = { quantization: { rescore: true } };

/**
 * Optimizer bounds chosen to cap the boot-time RAM spike. On start Qdrant
 * re-optimizes segments, pulling vectors into RAM to (re)build HNSW; a single
 * giant segment makes that spike the size of the whole collection. Capping the
 * segment size bounds how much is resident at once, trading a slightly larger
 * graph for a much lower peak — which is what a memory-constrained host feels.
 */
const OPTIMIZERS = {
  /**
   * ~64k vectors per segment. THE UNIT IS KILOBYTES, NOT VECTORS.
   *
   * This read `64_000` with the comment "~64k vectors per segment" until
   * 2026-08-14, and the two did not agree. Qdrant measures this in KB against a
   * 256-dimension reference vector — "1Kb = 1 vector of size 256" — so the
   * vector count is `max_segment_size / (dim / 256)`. At 768 dimensions each
   * vector bills 3 KB, so 64_000 bought ~21.3k vectors per segment, a third of
   * the intent.
   *
   * That is not a cosmetic drift, because several per-segment structures are a
   * FIXED SIZE regardless of how few points the segment holds. Each indexed
   * field's null-index allocates two 1 MiB `flags_a.dat` mmaps (`has_values`
   * and `is_null`) — 2 MiB per field per segment, whether the segment holds 24k
   * points or 200k. Measured on the live store, 2026-08-14:
   *
   *   560,694 points over 23 segments  (24,378 points/segment)
   *   payload_index total                600.2 MB
   *     of which null-index padding      385.9 MB   <- 64%, 8 fields x 23 x 2 MiB
   *     of which real index data         214.3 MB
   *
   * so roughly two thirds of the payload index is empty padding bought by
   * having three times as many segments as intended. Fixing the unit takes the
   * collection to ~8 segments and the padding to ~134 MB — about 250 MB off a
   * 642 MB resident footprint, for a one-line change and no data rewrite.
   *
   * 192_000 = 64_000 x (768 / 256), i.e. the number the old comment described.
   * ⚠️ IT IS DIMENSION-DEPENDENT: a model change that moves `denseDim` changes
   * how many vectors this buys. Re-derive it, do not carry it over.
   *
   * The boot-spike reasoning above still holds and still bounds this — at 64k
   * vectors a segment's fp32 is ~192 MB, so the two concurrent optimization
   * jobs below can hold ~384 MB, well under the 5.65 GiB peak that motivated
   * the cap.
   */
  max_segment_size: 192_000,
  /**
   * Cap concurrent segment optimizations. Left unset, Qdrant sizes this from
   * the CPU budget — 16 cores here — and every concurrent job holds its
   * segment's vectors while it rebuilds. That is the one part of the footprint
   * `on_disk` does not fix, because an optimization *is* the thing that
   * materialises data. Measured during the 2026-07-30 storage migration, when
   * every segment was converted at once: the cgroup peak reached 5.65GiB while
   * steady state was ~360MB.
   *
   * 2 rather than 1 on purpose. The extra job costs ~60MB (a 64k-vector
   * segment's int8 copy plus the graph being built) and the difference between
   * 1 and 2 is noise next to the 1.1GB the on-disk flip saves — while dropping
   * to a single thread would halve throughput on the passes that matter most,
   * the multi-hour re-embed and re-tokenise rebuilds. This repo has already
   * been bitten once by an optimizer that could not keep up (see
   * `setIndexingThreshold`), and that is the failure worth staying away from.
   */
  max_optimization_threads: 2,
};

/**
 * Qdrant's own default: build HNSW for a segment once it holds this many
 * vectors. Named here because `setIndexingThreshold(null)` has to restore
 * something, and "whatever it was before" is not knowable after a crash.
 */
const DEFAULT_INDEXING_THRESHOLD = 10_000;

/**
 * Every payload field that gets an index — the single source of truth for both
 * creating them and reaping ones we no longer want.
 *
 * AN INDEX IS ONLY WORTH ITS COST IF SOMETHING FILTERS ON IT. `session_id` was
 * indexed here from the start and never appeared in a filter: the only mention
 * of it in the whole repo was the line that created it. Measured on the live
 * store 2026-08-14 it cost 79.7 MB — 31.5 MB of real index plus 48.2 MB of
 * fixed null-index padding (two 1 MiB `flags_a.dat` mmaps per segment) — 13% of
 * a 600.2 MB payload index, to answer a question nothing asks. Removed.
 *
 * Keep this list in step with `toQdrantFilter` below; the guard test asserts
 * `indexed ⊆ filtered` by parsing the filter keys out of this file, so adding
 * an index nothing queries fails CI rather than quietly costing RAM. The
 * reverse is deliberately NOT enforced — filtering without an index is a
 * legitimate choice, Qdrant just full-scans.
 */
const PAYLOAD_INDEXES: [string, 'keyword' | 'integer' | 'datetime'][] = [
  ['project', 'keyword'],
  ['source_type', 'keyword'],
  ['component', 'keyword'],
  ['kind', 'keyword'],
  ['doc_status', 'keyword'],
  // Integer index so setDocStatus and deleteByEntryIds can address points by
  // entry id.
  ['entry_id', 'integer'],
  // Range filtering on occurred_at works without this — Qdrant falls back to
  // a full scan — but at a measured 3.11s vs 0.087s (36x) it was far too slow
  // to expose date scoping as a normal filter. Every point already carries
  // the RFC-3339 value; only the index was missing.
  ['occurred_at', 'datetime'],
];

/**
 * Translate search filters into a Qdrant payload filter. An over-broad filter
 * silently returns the wrong rows and an over-narrow one silently returns
 * none, so this is worth testing on its own.
 */
export function buildQdrantFilter(
  filters: SearchFilters,
): { must: object[]; must_not?: object[] } | undefined {
  const must: object[] = [];
  const mustNot: object[] = [];
  // Projects and source types take the same shape: one value is an equality
  // match, several are an OR (`any`), none means no constraint at all.
  const projects = selectedProjects(filters);
  if (projects.length === 1) must.push({ key: 'project', match: { value: projects[0] } });
  else if (projects.length > 1) must.push({ key: 'project', match: { any: projects } });
  // A subset (sourceTypes) wins over the single sourceType; the singular stays
  // for back-compat. Qdrant's `any` is the multi-value OR match.
  const types = filters.sourceTypes?.length
    ? filters.sourceTypes
    : filters.sourceType
      ? [filters.sourceType]
      : [];
  if (types.length === 1) must.push({ key: 'source_type', match: { value: types[0] } });
  else if (types.length > 1) must.push({ key: 'source_type', match: { any: types } });
  if (filters.component) must.push({ key: 'component', match: { value: filters.component } });
  if (filters.kind) must.push({ key: 'kind', match: { value: filters.kind } });
  // 'machine' is filtered but deliberately NOT in PAYLOAD_INDEXES: it is
  // two-valued today (self vs one remote) and low-selectivity — exactly the
  // per-segment null-index padding cost the 2026-08-14 payload-index work
  // (max_segment_size KB-vs-vectors, see OPTIMIZERS above) paid down. An
  // unindexed filter here is a legitimate choice (Qdrant just full-scans),
  // the same call PAYLOAD_INDEXES' own docs already permit.
  if (filters.machine) must.push({ key: 'machine', match: { value: filters.machine } });
  // 'active' is expressed as NOT archived: most points carry no doc_status at
  // all, and a positive match would silently exclude every one of them.
  if (filters.docStatus === 'archived') {
    must.push({ key: 'doc_status', match: { value: 'archived' } });
  } else if (filters.docStatus === 'active') {
    mustNot.push({ key: 'doc_status', match: { value: 'archived' } });
  }
  if (filters.since || filters.until) {
    must.push({
      key: 'occurred_at',
      range: {
        ...(filters.since ? { gte: filters.since } : {}),
        ...(filters.until ? { lte: filters.until } : {}),
      },
    });
  }
  if (!must.length && !mustNot.length) return undefined;
  return { must, ...(mustNot.length ? { must_not: mustNot } : {}) };
}

export class VectorStore {
  private client: QdrantClient;
  /** Mutable: the indexer can switch collections when the embedder changes. */
  collection: string;

  constructor(url: string, collection: string) {
    // Client-side ceiling above Qdrant's own 5s REST timeout, so a slow-but-
    // progressing request is ended by the server, not silently by us.
    this.client = new QdrantClient({ url, timeout: 60_000 });
    this.collection = collection;
  }

  /** Point this store at a different collection (e.g. after a model switch). */
  useCollection(name: string): void {
    this.collection = name;
  }

  async healthy(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  async ensure(denseDim: number): Promise<void> {
    const existing = await this.client.getCollections();
    if (!existing.collections.some((c) => c.name === this.collection)) {
      await this.client.createCollection(this.collection, {
        // on_disk from the start: the fp32 originals are memory-mapped and only
        // the int8 copy is resident (see VECTORS/QUANTIZATION). Creating the
        // collection this way means a fresh one never has to be converted.
        vectors: { dense: { size: denseDim, distance: 'Cosine', ...VECTORS.dense } },
        sparse_vectors: SPARSE_VECTORS,
        // int8-quantize the dense vectors from the start; ~4× less RAM with
        // negligible recall loss (see QUANTIZATION). Only the dense branch is
        // quantized — sparse vectors are already tiny.
        quantization_config: QUANTIZATION,
        optimizers_config: OPTIMIZERS,
      });
    }
    // Runs on existing collections too: payload fields added after a
    // collection was created (doc_status, entry_id) still need their index.
    // Re-creating an existing index is a cheap no-op for Qdrant.
    for (const [field, schema] of PAYLOAD_INDEXES) {
      await this.client
        .createPayloadIndex(this.collection, {
          field_name: field,
          field_schema: schema,
          wait: true,
        })
        .catch(() => {}); // already indexed
    }
  }

  /**
   * Retrofit the memory layout onto the active collection in place — int8
   * quantization, dense vectors on disk, sparse index on disk, optimizer
   * bounds. No re-embed: Qdrant converts each segment's storage format from
   * the vectors it already holds, and search keeps serving throughout (the
   * call blocks server-side until current optimizations finish, but the
   * collection stays queryable).
   *
   * Idempotent — re-applying an identical config is a no-op — so a caller can
   * guard it with a one-shot marker and never worry about reruns. That guard
   * is keyed by *version* in the indexer, because this method has grown once
   * already: a collection stamped for the quantization-only pass still needs
   * the on_disk conversion, and only a version bump can tell the difference.
   *
   * Measured on the live 376k-point collection (2026-07-30): conversion took
   * ~40s for the dense side and ~60s for the sparse side, point count
   * unchanged throughout, status back to green with no re-embedding.
   */
  async ensureStorageLayout(): Promise<void> {
    await this.client.updateCollection(this.collection, {
      vectors: VECTORS,
      sparse_vectors: SPARSE_VECTORS,
      quantization_config: QUANTIZATION,
      optimizers_config: OPTIMIZERS,
    });
    await this.dropUnusedPayloadIndexes();
  }

  /**
   * Delete payload indexes the live collection carries that PAYLOAD_INDEXES no
   * longer lists.
   *
   * Dropping a field from PAYLOAD_INDEXES stops it being (re)created; it does
   * nothing to a collection that already has it, and `ensure()` runs on every
   * boot so the stale index would simply persist forever. This is the reaping
   * half, and it lives here rather than in `ensure()` on purpose: `ensure()` is
   * a hot boot path and a delete is not something to run unguarded on every
   * start. `ensureStorageLayout()` is already the one-shot retrofit, gated by
   * the versioned marker in the indexer.
   *
   * ⚠️ Dropping an INDEX does not drop the payload FIELD. Every point keeps its
   * `session_id`, anything reading it off the payload is unaffected, and a
   * filter on it would still work — Qdrant would full-scan instead of using an
   * index. Nothing is deleted that could not be rebuilt by re-adding the field
   * to PAYLOAD_INDEXES.
   *
   * Best-effort by the same reasoning as the caller: a Qdrant hiccup while
   * reaping must not stop the indexer from scanning.
   */
  async dropUnusedPayloadIndexes(): Promise<string[]> {
    const wanted = new Set(PAYLOAD_INDEXES.map(([f]) => f));
    let live: string[];
    try {
      const info = (await this.client.getCollection(this.collection)) as {
        payload_schema?: Record<string, unknown>;
      };
      live = Object.keys(info?.payload_schema ?? {});
    } catch {
      return [];
    }
    // An EMPTY read is ambiguous — a collection with no indexes and a response
    // shape we failed to understand look identical — so treat it as nothing to
    // do rather than as "everything is unused". Deleting on a misread is the
    // one outcome worth engineering against here.
    if (live.length === 0) return [];

    const dropped: string[] = [];
    for (const field of live) {
      if (wanted.has(field)) continue;
      try {
        await this.client.deletePayloadIndex(this.collection, field, { wait: true });
        dropped.push(field);
      } catch {
        // leave it; next run retries
      }
    }
    return dropped;
  }

  /**
   * Suspend HNSW index building, or restore it.
   *
   * The documented Qdrant bulk-write pattern, and this codebase learned why the
   * hard way (2026-07-29). A sparse re-tokenisation writes to every segment;
   * Qdrant responds by re-optimising each one, which means rebuilding the
   * *dense* HNSW index the change never touched. On a loaded host that
   * optimisation held segment locks long enough for Qdrant to log
   *
   *   "Trying to read-lock a segment is taking a long time. This could be a
   *    deadlock and may block new updates."
   *
   * and the update queue stopped draining entirely: 4,070 operations stranded
   * in the WAL, every subsequent write returning `wait_timeout`, and a restart
   * alone did not clear it. Setting the threshold to 0 released the queue
   * immediately — the whole backlog applied within minutes.
   *
   * `null` restores the configured default. Search stays correct while
   * suspended: without HNSW, dense queries fall back to exact scan, which is
   * slower and not wrong.
   */
  async setIndexingThreshold(threshold: number | null): Promise<void> {
    await this.client.updateCollection(this.collection, {
      optimizers_config: { ...OPTIMIZERS, indexing_threshold: threshold ?? DEFAULT_INDEXING_THRESHOLD },
    });
  }

  /** Every collection name Qdrant currently holds. */
  async listCollections(): Promise<string[]> {
    const r = await this.client.getCollections();
    return r.collections.map((c) => c.name);
  }

  /**
   * Delete collections we created that are neither the active one nor the
   * currently-selected embedder's collection — the dead weight a past model
   * switch leaves behind (see the dashboard's "orphaned vectors" callout).
   *
   * Guard rails, because this deletes data: only names carrying our own
   * COLLECTION_PREFIX are ever touched, and both `keep` names are always
   * spared. Everything dropped is rebuildable from Postgres, so the worst case
   * is a re-embed, never lost source data. Returns the names actually dropped.
   */
  async reclaimOrphans(keep: string[]): Promise<string[]> {
    const spare = new Set(keep.filter(Boolean));
    const dropped: string[] = [];
    for (const name of await this.listCollections()) {
      if (!name.startsWith(COLLECTION_PREFIX)) continue; // never ours → never touch
      if (spare.has(name)) continue;
      try {
        await this.client.deleteCollection(name);
        dropped.push(name);
      } catch {
        // A collection that vanished under us is already reclaimed.
      }
    }
    return dropped;
  }

  /**
   * Bulk upsert. `wait: false` on purpose: waiting forces a synchronous flush
   * per batch, which under ingest load exceeds Qdrant's REST
   * client_request_timeout (5s) and surfaces as `fetch failed`. The write is
   * still durable (accepted into the WAL); it just isn't searchable the same
   * millisecond, which no caller requires. Retried because point ids are
   * deterministic, so a replayed batch is a no-op.
   */
  /** Drop the collection if it exists. Vectors are always rebuildable. */
  async drop(): Promise<void> {
    try {
      await this.client.deleteCollection(this.collection);
    } catch {
      // Nothing to drop.
    }
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    if (!points.length) return;
    for (let i = 0; i < points.length; i += UPSERT_BATCH) {
      const slice = points.slice(i, i + UPSERT_BATCH);
      await withRetry(() =>
        this.client.upsert(this.collection, {
          wait: false,
          points: slice.map((p) => ({
            id: p.id,
            vector: {
              ...(p.dense ? { dense: p.dense } : {}),
              sparse: { indices: p.sparse.indices, values: p.sparse.values },
            },
            payload: p.payload,
          })),
        }),
      );
    }
  }

  /**
   * Replace the sparse vector of existing points, leaving `dense` and the
   * payload untouched.
   *
   * A tokeniser change invalidates every stored sparse vector — query tokens and
   * document tokens must come from the same function or keyword search silently
   * stops matching. Rewriting them through `upsert` would mean recomputing the
   * dense vectors too, which is the expensive half (an embedding call per chunk)
   * and which the change did not affect at all. Qdrant's update-vectors endpoint
   * writes one named vector in place, so the rebuild costs local hashing only:
   * no embedding provider, no re-parsing of sources, and dense search keeps
   * serving unchanged throughout.
   *
   * A point id that does not exist is an error for the **whole batch**, not a
   * no-op for that one point, so callers must derive ids exactly as the writer
   * did (`deterministicUuid`). Because one unknown id can therefore cost 64
   * good writes, a failing slice is counted and skipped rather than thrown:
   * losing a slice is a small, reported gap, while losing the rest of a
   * multi-hour pass to it is not. Reported, never silent — a rebuild that
   * quietly wrote less than it claimed is the failure mode this whole path
   * exists to prevent.
   *
   * `wait: false`, like `upsert`: waiting forces a synchronous flush per batch
   * and exceeds Qdrant's REST timeout under load. Writes are durable on return
   * (accepted into the WAL) but become *searchable* only once Qdrant applies
   * them, which on a large pass lags the call by minutes.
   */
  async updateSparse(
    points: { id: string; sparse: SparseVector }[],
  ): Promise<{ updated: number; failed: number; failedIds: string[] }> {
    let updated = 0;
    const failedIds: string[] = [];
    for (let i = 0; i < points.length; i += SPARSE_UPDATE_BATCH) {
      const r = await this.writeSparseSlice(points.slice(i, i + SPARSE_UPDATE_BATCH));
      updated += r.updated;
      failedIds.push(...r.failedIds);
    }
    return { updated, failed: failedIds.length, failedIds };
  }

  /**
   * Write one slice, halving it on rejection until the bad ids stand alone.
   *
   * Qdrant rejects a batch containing an unknown id rather than skipping the
   * offender, so without this a single stale point costs every good point beside
   * it. Measured 2026-07-29: entry 7707 was missing one of its five chunk
   * points, and that one point failed a 250-point batch on every repair pass —
   * twice — until a per-entry run isolated it by hand.
   *
   * Bisection is the right shape because rejection is all-or-nothing and carries
   * no indication of *which* id was bad: halving converges in log2(n) round
   * trips and ends holding the answer. The happy path stays a single call, so
   * this costs nothing until something is actually wrong.
   */
  private async writeSparseSlice(
    slice: { id: string; sparse: SparseVector }[],
  ): Promise<{ updated: number; failedIds: string[] }> {
    if (!slice.length) return { updated: 0, failedIds: [] };
    try {
      await withRetry(() =>
        this.client.updateVectors(this.collection, {
          wait: false,
          points: slice.map((p) => ({
            id: p.id,
            vector: { sparse: { indices: p.sparse.indices, values: p.sparse.values } },
          })),
        }),
      );
      return { updated: slice.length, failedIds: [] };
    } catch {
      // A single point that will not write is the bad point, by definition —
      // there is nothing left to split, so name it and stop.
      if (slice.length === 1) return { updated: 0, failedIds: [slice[0]!.id] };
      const mid = slice.length >> 1;
      const [a, b] = [
        await this.writeSparseSlice(slice.slice(0, mid)),
        await this.writeSparseSlice(slice.slice(mid)),
      ];
      return { updated: a.updated + b.updated, failedIds: [...a.failedIds, ...b.failedIds] };
    }
  }

  /**
   * Flip doc_status on every chunk of the given entries, in place — no
   * re-embedding. Used when a file's archive classification changes (or the
   * parser version bumps) but its content did not.
   */
  async setDocStatus(entryIds: number[], status: 'archived' | null): Promise<void> {
    for (let i = 0; i < entryIds.length; i += 500) {
      const filter = { must: [{ key: 'entry_id', match: { any: entryIds.slice(i, i + 500) } }] };
      await withRetry(() =>
        status
          ? this.client.setPayload(this.collection, {
              payload: { doc_status: status },
              filter,
              wait: false,
            })
          : this.client.deletePayload(this.collection, { keys: ['doc_status'], filter, wait: false }),
      );
    }
  }

  /**
   * Delete every point belonging to these entries.
   *
   * By payload filter rather than by point id: an entry becomes an unknown
   * number of chunk points, and reconstructing their ids means knowing how
   * many chunks it produced — which is exactly the knowledge a caller
   * discarding the entry no longer has. `entry_id` is a payload-indexed field
   * (PAYLOAD_INDEXES), so the filter is cheap.
   *
   * `wait: true`, unlike the ingest paths. The only caller is the v3 dedup
   * migration, which deletes a collision loser's points BEFORE its Postgres
   * row (spec §6.4) — the whole safety argument rests on the points being gone
   * by the time this returns, so it must not return on mere acceptance. The
   * path is rare (collisions are essentially none), so the synchronous flush
   * costs nothing measurable.
   */
  async deleteByEntryIds(entryIds: number[]): Promise<void> {
    if (!entryIds.length) return;
    for (let i = 0; i < entryIds.length; i += 500) {
      const filter = { must: [{ key: 'entry_id', match: { any: entryIds.slice(i, i + 500) } }] };
      await withRetry(() => this.client.delete(this.collection, { filter, wait: true }));
    }
  }

  /**
   * Points vs vectors: each point carries two named vectors (dense + sparse),
   * so `indexed_vectors_count` runs at roughly twice the point count. Both are
   * shown, because one of them is always the number someone expected.
   */
  async info(): Promise<{ points: number; vectors: number; segments: number } | null> {
    try {
      const r = await this.client.getCollection(this.collection);
      return {
        points: r.points_count ?? 0,
        vectors: r.indexed_vectors_count ?? 0,
        segments: r.segments_count ?? 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Every **point id** the collection currently holds.
   *
   * The ground truth for the coverage audit: the catalog column records what we
   * *believe* we embedded, and this is what the collection actually holds.
   *
   * Point ids rather than `entry_id`s, because one entry becomes several points
   * and "has at least one point" is not the same as "is fully embedded". An
   * entry missing a single chunk answers fewer questions than it should while
   * looking perfectly covered from the entry level — that is exactly how entry
   * 7707 survived two repair passes (2026-07-29). Ids are deterministic
   * (`deterministicUuid`), so the expected set is derivable and the comparison
   * is exact.
   *
   * Cheaper than the entry-level version it replaced: no payload is fetched at
   * all. ~366k uuid strings is a few tens of MB in a Set, at this scale.
   */
  async allPointIds(): Promise<Set<string>> {
    const seen = new Set<string>();
    let offset: unknown;
    for (;;) {
      const res = await this.client.scroll(this.collection, {
        limit: 16_000,
        with_payload: false,
        with_vector: false,
        ...(offset ? { offset: offset as never } : {}),
      });
      for (const p of res.points) seen.add(String(p.id));
      if (!res.next_page_offset) break;
      offset = res.next_page_offset;
    }
    return seen;
  }

  async count(): Promise<number> {
    try {
      const r = await this.client.count(this.collection, { exact: false });
      return r.count;
    } catch {
      return 0;
    }
  }

  private buildFilter(filters: SearchFilters) {
    return buildQdrantFilter(filters);
  }

  /**
   * Hybrid (dense+sparse, RRF) when a dense query vector is supplied;
   * sparse-only nearest otherwise.
   */
  async query(opts: {
    dense?: number[];
    sparse: SparseVector;
    filters: SearchFilters;
    limit: number;
  }): Promise<{ entryId: number; score: number }[]> {
    const filter = this.buildFilter(opts.filters);
    const sparseQuery = { indices: opts.sparse.indices, values: opts.sparse.values };
    const perBranch = Math.max(opts.limit * 3, 30);

    // Only `entry_id` is read below — every hit is then rehydrated from
    // Postgres (SearchService.hydrate). Fetching the whole payload (project,
    // source_type, component, session_id, occurred_at…) shipped bytes the
    // caller throws away; scope it to the one field we use.
    const withPayload = ['entry_id'];
    const res = opts.dense
      ? await this.client.query(this.collection, {
          prefetch: [
            // `params` rides on the dense branch only — it is the quantized
            // one, and rescoring has to be asked for now that the originals
            // are on disk (see SEARCH_PARAMS).
            { query: opts.dense, using: 'dense', limit: perBranch, filter, params: SEARCH_PARAMS },
            { query: sparseQuery, using: 'sparse', limit: perBranch, filter },
          ],
          query: { fusion: 'rrf' },
          limit: opts.limit,
          with_payload: withPayload,
        })
      : await this.client.query(this.collection, {
          query: sparseQuery,
          using: 'sparse',
          limit: opts.limit,
          filter,
          with_payload: withPayload,
        });

    return res.points.map((p) => ({
      entryId: Number((p.payload as any)?.entry_id),
      score: p.score ?? 0,
    }));
  }

  /**
   * Dense branch alone, returning raw cosine similarity.
   *
   * Not a search path — nothing in the product calls this. It exists because the
   * fused `query()` above returns RRF scores, which are rank-based: `Σ 1/(k+rank)`
   * yields the same 0.75 for the top hit of a perfect match and the top hit of a
   * query with nothing relevant in the index. So no threshold on a fused score can
   * ever express "found nothing *relevant*", and there is no way to derive one
   * from the fused response either, because Qdrant reports no per-branch score.
   *
   * Cosine is comparable across queries, which is what a calibrated relevance
   * signal needs. This returns it so the evaluation harness can measure whether
   * it actually separates answerable questions from unanswerable ones, before any
   * product surface commits to a number.
   */
  async queryDense(opts: {
    dense: number[];
    filters: SearchFilters;
    limit: number;
  }): Promise<{ entryId: number; score: number }[]> {
    const res = await this.client.query(this.collection, {
      query: opts.dense,
      using: 'dense',
      limit: opts.limit,
      filter: this.buildFilter(opts.filters),
      with_payload: ['entry_id'],
      // Same rescore requirement as the fused path. It matters more here, not
      // less: this returns raw cosine, and an unrescored score is the distance
      // to the *int8 approximation*, which is precisely the calibrated number
      // this method exists to measure.
      params: SEARCH_PARAMS,
    });
    return res.points.map((p) => ({
      entryId: Number((p.payload as any)?.entry_id),
      score: p.score ?? 0,
    }));
  }
}
