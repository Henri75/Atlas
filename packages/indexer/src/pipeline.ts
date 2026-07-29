import { openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import {
  Catalog,
  DOCS_PARSER_VERSION,
  GIT_LOG_FORMAT,
  VectorStore,
  chunk,
  deterministicUuid,
  distillClaudeJsonl,
  parseBacklog,
  parseChangelog,
  parseComponentLog,
  parseGitLog,
  parseMarkdownDoc,
  parseSessionLog,
  sparseVector,
} from '@atlas/core';
import { withRetry } from '@atlas/core';
import type { EmbeddingProvider, Entry, InsertedEntry } from '@atlas/core';
import { listDocFiles, listKdbFiles, listSessionFiles } from './scanners.js';

/**
 * Called after every embedded batch. Renewing the BullMQ job lock here is what
 * keeps long files from tripping the stall watchdog.
 */
export type ProgressFn = (info: { file: string; chunks: number }) => void | Promise<void>;

const execFileAsync = promisify(execFile);

export interface PipelineDeps {
  catalog: Catalog;
  vectors: VectorStore;
  embedder: EmbeddingProvider;
}

export interface ScanJobData {
  projectSlug: string;
  projectName: string;
  rootPath: string;
  hasKdb: boolean;
  sourceType: 'kdb' | 'claude_session' | 'git_commit' | 'doc';
  /** Claude project dirs mapped to this project (claude_session jobs). */
  claudeDirs?: string[];
  /** Reset scan state and reprocess everything. */
  full?: boolean;
}

const EMBED_BATCH = 32;

interface PendingChunk {
  entryId: number;
  entry: Entry;
  seq: number;
  text: string;
}

/**
 * A batch of chunks to embed, plus the entries this batch *finishes*.
 *
 * Batches span entry boundaries, so "which entries are now fully embedded" is
 * not derivable from the batch contents alone: an entry whose chunks straddle
 * the boundary is only complete once the later batch lands. Carrying the answer
 * out of the generator, where chunk order is known, keeps the caller honest.
 */
interface ChunkBatch {
  items: PendingChunk[];
  /** Entry ids whose final chunk is in this batch (or which had no chunks). */
  completed: number[];
}

/**
 * Yield chunks in fixed-size batches without materializing every chunk of a
 * file first — a single 38MB transcript produces tens of thousands of chunks.
 */
function* batchChunks(inserted: InsertedEntry[]): Generator<ChunkBatch> {
  let items: PendingChunk[] = [];
  let completed: number[] = [];
  for (const { id, entry } of inserted) {
    const chunks = chunk(`${entry.title}\n\n${entry.body}`);
    // Nothing to embed: mark it complete anyway, or the reconciler would retry
    // this entry on every single pass, forever.
    if (!chunks.length) {
      completed.push(id);
      continue;
    }
    for (const [seq, text] of chunks.entries()) {
      items.push({ entryId: id, entry, seq, text });
      if (seq === chunks.length - 1) completed.push(id);
      if (items.length === EMBED_BATCH) {
        yield { items, completed };
        items = [];
        completed = [];
      }
    }
  }
  // `completed` can be non-empty with no items left (a trailing zero-chunk
  // entry), so this cannot be guarded on items alone.
  if (items.length || completed.length) yield { items, completed };
}

/**
 * Chunk + embed + upsert freshly inserted entries into Qdrant.
 * `onProgress` lets the caller renew its BullMQ job lock during long files.
 */
export async function indexEntries(
  deps: PipelineDeps,
  inserted: InsertedEntry[],
  onProgress?: (chunksDone: number) => void | Promise<void>,
): Promise<number> {
  let done = 0;
  for (const batch of batchChunks(inserted)) {
    if (batch.items.length) {
      // Local embedders (Ollama) drop connections under sustained load; give
      // them room to recover rather than failing the whole file.
      const dense = await withRetry(() => deps.embedder.embed(batch.items.map((b) => b.text)), {
        attempts: 5,
        baseDelayMs: 1000,
      });
      await deps.vectors.upsert(
        batch.items.map((b, j) => ({
          id: deterministicUuid(b.entry.projectSlug, b.entry.sourcePath, String(b.entryId), String(b.seq)),
          dense: dense[j],
          sparse: sparseVector(b.text),
          payload: {
            entry_id: b.entryId,
            project: b.entry.projectSlug,
            source_type: b.entry.sourceType,
            component: b.entry.component,
            session_id: b.entry.sessionId,
            // Lets search ask for insights/summaries/actions directly.
            kind: (b.entry.meta?.kind as string | undefined) ?? undefined,
            // Archived docs are downranked at query time; absence means active.
            doc_status: (b.entry.meta?.docStatus as string | undefined) ?? undefined,
            occurred_at: b.entry.occurredAt,
          },
        })),
      );
    }
    // Only *after* the upsert resolves. Anything that throws above leaves these
    // entries unmarked, so the reconciler re-embeds them instead of them
    // becoming permanently unsearchable (the 2026-07-25 incident).
    if (batch.completed.length) {
      await deps.catalog.markVectorized(batch.completed, deps.vectors.collection);
    }
    done += batch.items.length;
    await onProgress?.(done);
  }
  return done;
}

interface FileStat {
  mtimeMs: number;
  size: number;
}

function fileChanged(stat: FileStat, state: { mtimeMs: number; size: number } | null, full?: boolean) {
  if (full || !state) return true;
  return Math.trunc(stat.mtimeMs) !== state.mtimeMs || stat.size !== state.size;
}

/** Read appended bytes from offset up to the last complete line. */
export function readTailLines(path: string, offset: number): { lines: string[]; newOffset: number } {
  const size = statSync(path).size;
  if (size <= offset) return { lines: [], newOffset: size < offset ? 0 : offset };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return { lines: [], newOffset: offset }; // torn line only
    return {
      lines: text.slice(0, lastNl).split('\n'),
      newOffset: offset + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8'),
    };
  } finally {
    closeSync(fd);
  }
}

async function scanKdb(
  deps: PipelineDeps,
  job: ScanJobData,
  projectId: number,
  progress?: ProgressFn,
): Promise<number> {
  let indexed = 0;
  for (const f of listKdbFiles(job.rootPath)) {
    try {
      const stat = statSync(f.path);
      const state = await deps.catalog.getScanState(projectId, f.sourceType, f.path);
      if (!fileChanged(stat, state, job.full)) continue;
      const text = readFileSync(f.path, 'utf8');
      const ctx = { projectSlug: job.projectSlug, sourcePath: f.path, component: f.component };
      let entries: Entry[];
      switch (f.sourceType) {
        case 'kdb_changelog': entries = parseChangelog(text, ctx); break;
        case 'kdb_session': entries = parseSessionLog(text, ctx); break;
        case 'kdb_backlog': entries = parseBacklog(text, ctx); break;
        case 'kdb_component': entries = parseComponentLog(text, ctx); break;
        default:
          entries = parseMarkdownDoc(text, {
            projectSlug: job.projectSlug,
            sourcePath: f.path,
            modifiedAt: new Date(stat.mtimeMs).toISOString(),
          }).map((e) => ({ ...e, sourceType: 'kdb_report' as const }));
      }
      const inserted = await deps.catalog.insertEntries(projectId, entries);
      indexed += await indexEntries(deps, inserted, (c) => progress?.({ file: f.path, chunks: c }));
      await deps.catalog.setScanState(projectId, f.sourceType, f.path, {
        mtimeMs: Math.trunc(stat.mtimeMs), size: stat.size, byteOffset: stat.size,
      });
    } catch (e) {
      await deps.catalog.logError(projectId, f.path, 'kdb-parse', (e as Error).message);
    }
  }
  return indexed;
}

async function scanClaude(
  deps: PipelineDeps,
  job: ScanJobData,
  projectId: number,
  progress?: ProgressFn,
): Promise<number> {
  let indexed = 0;
  for (const dir of job.claudeDirs ?? []) {
    // Newest transcripts first: a full pass over ~10k files takes hours, and
    // recent history is what anyone actually asks about.
    const paths = listSessionFiles(dir)
      .map((p) => {
        try {
          return { p, mtime: statSync(p).mtimeMs };
        } catch {
          return { p, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.p);

    for (const path of paths) {
      try {
        const stat = statSync(path);
        const state = job.full ? null : await deps.catalog.getScanState(projectId, 'claude_session', path);
        if (state && Math.trunc(stat.mtimeMs) === state.mtimeMs && stat.size === state.size) continue;
        // Shrunk file (rare rewrite) → restart from 0; otherwise tail from last offset.
        const offset = state && stat.size >= state.byteOffset ? state.byteOffset : 0;
        const { lines, newOffset } = readTailLines(path, offset);
        if (!lines.length) {
          await deps.catalog.setScanState(projectId, 'claude_session', path, {
            mtimeMs: Math.trunc(stat.mtimeMs), size: stat.size, byteOffset: newOffset,
          });
          continue;
        }
        const sessionId = basename(path, '.jsonl');
        const { entries, meta } = distillClaudeJsonl(lines, {
          projectSlug: job.projectSlug, sourcePath: path, sessionId,
        });
        const inserted = await deps.catalog.insertEntries(projectId, entries);
        indexed += await indexEntries(deps, inserted, (c) => progress?.({ file: path, chunks: c }));

        // Tail reads only see new events — merge with the stored session row.
        const prev = await deps.catalog.getSessionRow(sessionId);
        // Precedence: a real `summary` from any pass, then whatever is already
        // stored, then the first prompt. Most sessions never get a summary, so
        // without the fallback the UI can only show a raw UUID.
        const merged = {
          sessionId,
          cwd: meta.cwd ?? prev?.cwd ?? undefined,
          title: meta.title ?? prev?.title ?? meta.firstPrompt ?? undefined,
          startedAt: prev?.started_at?.toISOString?.() ?? meta.startedAt,
          endedAt: meta.endedAt ?? prev?.ended_at?.toISOString?.(),
          // Tail reads only see new events, so counts accumulate; a full re-read
          // (offset 0) starts over.
          promptCount: (offset > 0 ? (prev?.prompt_count ?? 0) : 0) + meta.promptCount,
          actionCount: (offset > 0 ? (prev?.action_count ?? 0) : 0) + meta.actionCount,
          filesTouched: [...new Set([...(prev?.files_touched ?? []), ...meta.filesTouched])].sort(),
        };
        await deps.catalog.upsertSession(projectId, merged, path);
        await deps.catalog.setScanState(projectId, 'claude_session', path, {
          mtimeMs: Math.trunc(stat.mtimeMs), size: stat.size, byteOffset: newOffset,
        });
      } catch (e) {
        await deps.catalog.logError(projectId, path, 'claude-distill', (e as Error).message);
      }
    }
  }
  return indexed;
}

async function scanGit(
  deps: PipelineDeps,
  job: ScanJobData,
  projectId: number,
  progress?: ProgressFn,
): Promise<number> {
  const state = job.full ? null : await deps.catalog.getScanState(projectId, 'git_commit', job.rootPath);
  const range = state?.ref ? `${state.ref}..HEAD` : 'HEAD';
  let stdout = '';
  try {
    const r = await execFileAsync(
      'git',
      ['-c', 'safe.directory=*', 'log', range, '--name-status', `--pretty=format:${GIT_LOG_FORMAT}`, '-n', '5000'],
      { cwd: job.rootPath, maxBuffer: 64 * 1024 * 1024 },
    );
    stdout = r.stdout;
  } catch (e) {
    // Empty repos / unborn HEAD exit non-zero — not an error worth logging loudly.
    const msg = (e as Error).message;
    if (!/does not have any commits|unknown revision|bad revision/i.test(msg)) {
      await deps.catalog.logError(projectId, job.rootPath, 'git-log', msg);
    }
    return 0;
  }
  const entries = parseGitLog(stdout, { projectSlug: job.projectSlug, repoPath: job.rootPath });
  const inserted = await deps.catalog.insertEntries(projectId, entries);
  const indexed = await indexEntries(deps, inserted, (c) =>
    progress?.({ file: job.rootPath, chunks: c }),
  );
  const newHead = entries[0]?.sourceRef ?? state?.ref;
  await deps.catalog.setScanState(projectId, 'git_commit', job.rootPath, {
    mtimeMs: 0, size: 0, byteOffset: 0, ref: newHead,
  });
  return indexed;
}

async function scanDocs(
  deps: PipelineDeps,
  job: ScanJobData,
  projectId: number,
  progress?: ProgressFn,
): Promise<number> {
  let indexed = 0;
  const { files, dropped } = listDocFiles(job.rootPath);
  // No silent caps: truncation must be visible in the indexer logs.
  if (dropped > 0) {
    console.warn(
      `[indexer] ${job.projectSlug}: docs cap reached — ${dropped} file(s) NOT indexed`,
    );
  }

  // Classification semantics changed since these files were last scanned →
  // walk everything once to sync docStatus, even files whose bytes are
  // unchanged (scan state would skip them forever otherwise).
  const verKey = `docs_parser_version:${projectId}`;
  const storedVersion = await deps.catalog.getSetting(verKey).catch(() => null);
  const syncAll = storedVersion !== String(DOCS_PARSER_VERSION);

  for (const { path, archived } of files) {
    try {
      const stat = statSync(path);
      const state = await deps.catalog.getScanState(projectId, 'doc', path);
      const changed = fileChanged(stat, state, job.full);
      if (changed) {
        const entries = parseMarkdownDoc(readFileSync(path, 'utf8'), {
          projectSlug: job.projectSlug,
          sourcePath: path,
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
          archived,
        });
        const inserted = await deps.catalog.insertEntries(projectId, entries);
        indexed += await indexEntries(deps, inserted, (c) => progress?.({ file: path, chunks: c }));
        await deps.catalog.setScanState(projectId, 'doc', path, {
          mtimeMs: Math.trunc(stat.mtimeMs), size: stat.size, byteOffset: stat.size,
        });
      }
      // A re-parse only inserts NEW dedup keys, so rows that already existed
      // keep their old meta; fix them in place (Postgres + vector payload,
      // no re-embedding). Runs for changed files and, on version bump, all.
      if (changed || syncAll) {
        const ids = await deps.catalog.syncDocStatus(projectId, path, archived);
        if (ids.length) await deps.vectors.setDocStatus(ids, archived ? 'archived' : null);
      }
    } catch (e) {
      await deps.catalog.logError(projectId, path, 'doc-parse', (e as Error).message);
    }
  }
  await deps.catalog.setSetting(verKey, String(DOCS_PARSER_VERSION)).catch(() => {});
  return indexed;
}

/**
 * Reconcile the coverage column against what the collection actually holds.
 *
 * Two jobs, one scroll:
 *  - **adopt**: entries whose vectors are present but unmarked. Without this the
 *    column's introduction would read as "nothing is embedded" and trigger a
 *    full re-embed of the entire catalog (hours) on the next boot.
 *  - **clear**: entries marked as covered whose points are gone. The column
 *    records what we believe we wrote; it cannot observe loss on the Qdrant side
 *    (a dropped collection, an orphan-reclaim bug, a restore from an older
 *    snapshot). Clearing turns that into ordinary reconciler work.
 *
 * Deliberately not run on every boot — it costs a full scroll. It is the slow,
 * authoritative check behind the cheap `vectorized_in IS DISTINCT FROM` query.
 */
export async function auditVectorCoverage(
  deps: PipelineDeps,
): Promise<{ adopted: number; cleared: number }> {
  const collection = deps.vectors.collection;
  const [inQdrant, believed] = await Promise.all([
    deps.vectors.allEntryIds(),
    deps.catalog.entryCoverage(),
  ]);

  // Write only the difference between what the column claims and what the
  // collection holds. Re-marking every row would make a steady-state audit cost
  // ~323k UPDATEs (measured: 13 minutes), which is far too expensive to run
  // periodically — and the periodic run is the entire point.
  const adopt: number[] = [];
  const clear: number[] = [];
  for (const { id, vectorizedIn } of believed) {
    const present = inQdrant.has(id);
    if (present && vectorizedIn !== collection) adopt.push(id);
    else if (!present && vectorizedIn !== null) clear.push(id);
  }

  // Chunked: `id = ANY($1)` with 300k parameters would blow past what the
  // driver and Postgres will accept in one statement.
  const CHUNK = 5_000;
  for (let i = 0; i < adopt.length; i += CHUNK) {
    await deps.catalog.markVectorized(adopt.slice(i, i + CHUNK), collection);
  }
  for (let i = 0; i < clear.length; i += CHUNK) {
    await deps.catalog.clearVectorized(clear.slice(i, i + CHUNK));
  }
  return { adopted: adopt.length, cleared: clear.length };
}

/**
 * Should the reconciler run?
 *
 * Counted in *entries not searchable in the active collection*, which is the
 * thing that actually matters, rather than inferred from aggregate sizes.
 *
 * The previous version compared Qdrant points to catalog entries — different
 * units. One entry yields one or more chunks, so points exceed entries even
 * with thousands of entries missing (measured 2026-07-25: 361,941 points vs
 * 323,176 entries while 39 entries, including two whole documents, had no
 * vectors at all). It could never fire, and a safety net with a unit bug reads
 * as protection while providing none.
 */
export function needsBackfill(uncoveredEntries: number): boolean {
  return uncoveredEntries > 0;
}

/**
 * Rebuild the active Qdrant collection from the catalog.
 *
 * Needed after an embedding-model switch: the collection name encodes the
 * vector dimension, so a new model starts from an empty collection. Entries
 * already in Postgres are never re-inserted (dedup_key), so a normal scan
 * would never re-emit them — the vectors must be backfilled from the catalog
 * rather than by re-parsing 11GB of source files.
 */
export async function backfillVectors(
  deps: PipelineDeps,
  opts: {
    pageSize?: number;
    /**
     * `done` and `embedded` are both counted in entries processed by this run.
     * They are equal now that only uncovered entries are ever selected — the
     * signature keeps three arguments so callers computing throughput and
     * progress separately need no change.
     */
    onPage?: (done: number, total: number, embedded: number) => void | Promise<void>;
    /**
     * Stop after this many entries, leaving the rest for the next run.
     *
     * Routine reconciliation shares the embedder with live scanning, and a local
     * Ollama serves one request at a time (~1.9s each, measured), so an uncapped
     * pass after a model switch would monopolise it for hours. Large rebuilds
     * stay the boot path's job, where nothing else is competing.
     */
    maxEntries?: number;
  } = {},
): Promise<number> {
  const pageSize = opts.pageSize ?? 200;
  const collection = deps.vectors.collection;
  const total = await deps.catalog.countUncovered(collection);

  // The cursor is per-run and in-memory only. `vectorized_in` is the durable
  // progress record, so an interrupted run resumes simply by selecting what is
  // still uncovered — there is no stored cursor left to disagree with reality.
  let cursor = 0;
  let embedded = 0;

  for (;;) {
    // Narrow the last page so a cap that is not a multiple of pageSize does not
    // overshoot — the cap exists to bound embedder time, so approximating it
    // upward would defeat it.
    const room = opts.maxEntries ? opts.maxEntries - embedded : pageSize;
    if (room <= 0) break;
    const rows = await deps.catalog.uncoveredEntriesAfter(
      collection,
      cursor,
      Math.min(pageSize, room),
    );
    if (!rows.length) break;
    // Advance past the page even if it fails, or a permanently bad row would
    // re-select forever. Its entries stay uncovered, so the next run retries
    // them — previously a failed page was skipped until a full rebuild.
    cursor = rows[rows.length - 1]!.id;

    const inserted: InsertedEntry[] = rows.map((r) => ({ id: r.id, entry: r }));
    try {
      await indexEntries(deps, inserted);
    } catch (e) {
      // A page that fails even after retries must not abandon hours of work;
      // record it and keep going.
      await deps.catalog.logError(null, `entries>${cursor}`, 'backfill', (e as Error).message);
    }
    embedded += rows.length;
    await opts.onPage?.(embedded, total, embedded);
  }

  return embedded;
}

/**
 * What the re-tokenisation pass should do on this boot.
 *
 * A pure function because the inline version of it was wrong in a way nothing
 * could see: it treated *any* backfill as proof the collection had been written
 * by the current tokeniser, when `backfillVectors` only touches uncovered
 * entries. On the 2026-07-29 boot that was 111 rows out of 326,606 — so it
 * stamped `sparse_version` over 326k stale vectors and would have skipped the
 * pass permanently. A stamp that lies is worse than no stamp, and the only
 * symptom would have been keyword search quietly not matching.
 *
 * - `none`     — the collection is already at this version.
 * - `stamp`    — a *full* rebuild just wrote every vector with this tokeniser.
 * - `skipped`  — the operator disabled the pass; keyword search stays stale.
 * - `rebuild`  — re-tokenise.
 */
export function sparseRebuildAction(input: {
  storedVersion: number;
  currentVersion: number;
  /** Entries not searchable in the collection when this boot started. */
  uncovered: number;
  totalEntries: number;
  /** Whether a backfill ran this boot at all. */
  backfilled: boolean;
  enabled: boolean;
}): 'none' | 'stamp' | 'skipped' | 'rebuild' {
  if (input.storedVersion === input.currentVersion) return 'none';
  // "Everything was uncovered" is what a model switch looks like, and the only
  // case in which the backfill rewrote the whole collection.
  if (input.backfilled && input.uncovered >= input.totalEntries && input.totalEntries > 0) {
    return 'stamp';
  }
  return input.enabled ? 'rebuild' : 'skipped';
}

/**
 * Rewrite every stored sparse vector with the current tokeniser.
 *
 * Why this is a separate path from `backfillVectors`: a tokeniser change
 * invalidates the *sparse* half of every point and nothing else. Routing it
 * through the normal rebuild would clear `vectorized_in` and re-embed 326k
 * entries through Ollama — hours of work to recompute dense vectors that were
 * never wrong. Sparse vectors are pure local hashing, so this pass needs no
 * embedding provider at all and can run while the rest of the system serves
 * traffic; dense retrieval is untouched throughout.
 *
 * Progress is a stored cursor rather than a per-row column, because there is no
 * per-row state to consult: the sparse vector of a point carries no record of
 * which tokeniser produced it. `sparse_version` is written only when the pass
 * completes, so an interrupted run resumes from the cursor and a crashed one
 * simply starts the pass again rather than declaring a half-rebuilt index good.
 */
export async function rebuildSparseVectors(
  deps: PipelineDeps,
  opts: {
    pageSize?: number;
    /** Resume point, so a restarted pass does not redo finished pages. */
    startCursor?: number;
    onPage?: (done: number, total: number, cursor: number) => void | Promise<void>;
  } = {},
): Promise<{ entries: number; points: number; skipped: number }> {
  const pageSize = opts.pageSize ?? 500;
  const collection = deps.vectors.collection;
  const total = await deps.catalog.countVectorized(collection);
  let cursor = opts.startCursor ?? 0;
  let entries = 0;
  let points = 0;
  /** Points whose re-tokenisation was rejected — reported, never swallowed. */
  let skipped = 0;

  // Suspend HNSW building for the duration. Writing to every segment otherwise
  // makes Qdrant re-optimise each one — rebuilding the dense index this pass
  // never touches — and on a loaded host that held segment locks until the
  // update queue stopped draining altogether. See `setIndexingThreshold`.
  //
  // The marker is what makes the restore survive a crash: `finally` does not run
  // if the process is killed, and a collection left at threshold 0 would serve
  // every dense query by exact scan, indefinitely and silently.
  await deps.catalog.setSetting(INDEXING_SUSPENDED, collection).catch(() => {});
  await deps.vectors.setIndexingThreshold(0);
  try {
    return await runSparsePass();
  } finally {
    await deps.vectors.setIndexingThreshold(null).catch(() => {});
    await deps.catalog.setSetting(INDEXING_SUSPENDED, '').catch(() => {});
  }

  async function runSparsePass(): Promise<{ entries: number; points: number; skipped: number }> {
  for (;;) {
    // Only entries whose points exist: update-vectors rejects a batch containing
    // any unknown id, so walking never-embedded rows would cost the whole page.
    const rows = await deps.catalog.vectorizedEntriesAfter(collection, cursor, pageSize);
    if (!rows.length) break;
    cursor = rows[rows.length - 1]!.id;

    const batch: { id: string; sparse: ReturnType<typeof sparseVector> }[] = [];
    for (const row of rows) {
      // Identical to the write path: same text, same chunker, same id derivation.
      // Anything that drifts here silently addresses points that do not exist.
      const chunks = chunk(`${row.title}\n\n${row.body}`);
      for (const [seq, text] of chunks.entries()) {
        batch.push({
          id: deterministicUuid(row.projectSlug, row.sourcePath, String(row.id), String(seq)),
          sparse: sparseVector(text),
        });
      }
    }

    try {
      const r = await deps.vectors.updateSparse(batch);
      points += r.updated;
      skipped += r.failed;
    } catch (e) {
      // updateSparse already absorbs per-slice rejections; reaching here means
      // something broader (Qdrant unreachable). Record it and keep going —
      // losing hours of a pass to one bad page is worse than the gap.
      skipped += batch.length;
      await deps.catalog.logError(null, `entries>${cursor}`, 'sparse-rebuild', (e as Error).message);
    }
    entries += rows.length;
    await opts.onPage?.(entries, total, cursor);
  }

  return { entries, points, skipped };
  }
}

/**
 * Setting key holding the collection whose HNSW building is currently
 * suspended, or '' when none is.
 *
 * Read at boot (`restoreIndexingThreshold`) so a rebuild killed mid-pass cannot
 * leave the collection permanently unindexed. The failure it guards is silent:
 * dense search still returns correct results by exact scan, just slowly, so
 * nothing would ever report it.
 */
export const INDEXING_SUSPENDED = 'indexing_suspended';

/** Undo a suspension left behind by a rebuild that did not finish. */
export async function restoreIndexingThreshold(deps: PipelineDeps): Promise<boolean> {
  const suspended = await deps.catalog.getSetting(INDEXING_SUSPENDED).catch(() => null);
  if (!suspended || suspended !== deps.vectors.collection) return false;
  await deps.vectors.setIndexingThreshold(null);
  await deps.catalog.setSetting(INDEXING_SUSPENDED, '').catch(() => {});
  return true;
}

export async function processScanJob(
  deps: PipelineDeps,
  job: ScanJobData,
  progress?: ProgressFn,
): Promise<{ chunksIndexed: number }> {
  const projectId = await deps.catalog.upsertProject({
    slug: job.projectSlug,
    name: job.projectName,
    rootPath: job.rootPath,
    hasKdb: job.hasKdb,
  });
  let chunksIndexed = 0;
  switch (job.sourceType) {
    case 'kdb': chunksIndexed = await scanKdb(deps, job, projectId, progress); break;
    case 'claude_session': chunksIndexed = await scanClaude(deps, job, projectId, progress); break;
    case 'git_commit': chunksIndexed = await scanGit(deps, job, projectId, progress); break;
    case 'doc': chunksIndexed = await scanDocs(deps, job, projectId, progress); break;
  }
  return { chunksIndexed };
}
