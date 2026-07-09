import { openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import {
  Catalog,
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
} from '@kdbscope/core';
import { withRetry } from '@kdbscope/core';
import type { EmbeddingProvider, Entry, InsertedEntry } from '@kdbscope/core';
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
 * Yield chunks in fixed-size batches without materializing every chunk of a
 * file first — a single 38MB transcript produces tens of thousands of chunks.
 */
function* batchChunks(inserted: InsertedEntry[]): Generator<PendingChunk[]> {
  let batch: PendingChunk[] = [];
  for (const { id, entry } of inserted) {
    const chunks = chunk(`${entry.title}\n\n${entry.body}`);
    for (const [seq, text] of chunks.entries()) {
      batch.push({ entryId: id, entry, seq, text });
      if (batch.length === EMBED_BATCH) {
        yield batch;
        batch = [];
      }
    }
  }
  if (batch.length) yield batch;
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
    // Local embedders (Ollama) drop connections under sustained load; give
    // them room to recover rather than failing the whole file.
    const dense = await withRetry(() => deps.embedder.embed(batch.map((b) => b.text)), {
      attempts: 5,
      baseDelayMs: 1000,
    });
    await deps.vectors.upsert(
      batch.map((b, j) => ({
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
          occurred_at: b.entry.occurredAt,
        },
      })),
    );
    done += batch.length;
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
  for (const path of listDocFiles(job.rootPath)) {
    try {
      const stat = statSync(path);
      const state = await deps.catalog.getScanState(projectId, 'doc', path);
      if (!fileChanged(stat, state, job.full)) continue;
      const entries = parseMarkdownDoc(readFileSync(path, 'utf8'), {
        projectSlug: job.projectSlug,
        sourcePath: path,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
      });
      const inserted = await deps.catalog.insertEntries(projectId, entries);
      indexed += await indexEntries(deps, inserted, (c) => progress?.({ file: path, chunks: c }));
      await deps.catalog.setScanState(projectId, 'doc', path, {
        mtimeMs: Math.trunc(stat.mtimeMs), size: stat.size, byteOffset: stat.size,
      });
    } catch (e) {
      await deps.catalog.logError(projectId, path, 'doc-parse', (e as Error).message);
    }
  }
  return indexed;
}

/**
 * Should the active collection be rebuilt from the catalog?
 *
 * True when the catalog has entries the collection cannot possibly serve.
 * Every entry produces at least one chunk, so `points < entries` means either
 * the embedding model changed (new, empty collection) or an earlier backfill
 * died partway. Both are repaired by the same idempotent rebuild.
 */
export function needsBackfill(vectorPoints: number, entryCount: number): boolean {
  return entryCount > 0 && vectorPoints < entryCount;
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
     * `done` is the absolute number of entries covered (including any prefix a
     * previous run finished); `embedded` counts only this run. Progress bars
     * want `done`; throughput and ETA must be computed from `embedded`.
     */
    onPage?: (done: number, total: number, embedded: number) => void | Promise<void>;
    /** Resume from a stored cursor rather than restarting from entry 1. */
    resume?: boolean;
  } = {},
): Promise<number> {
  const pageSize = opts.pageSize ?? 200;
  const total = await deps.catalog.countEntries();
  // Keyed by collection: a different model's rebuild must start from scratch.
  const cursorKey = `backfill_cursor:${deps.vectors.collection}`;

  let cursor = 0;
  if (opts.resume !== false) {
    const stored = await deps.catalog.getSetting(cursorKey).catch(() => null);
    cursor = stored ? Number(stored) || 0 : 0;
  }
  // Entries at or below the cursor were embedded by an earlier run.
  const alreadyDone = cursor > 0 ? await deps.catalog.countEntriesUpTo(cursor) : 0;
  let embedded = 0;

  for (;;) {
    const rows = await deps.catalog.entriesAfter(cursor, pageSize);
    if (!rows.length) break;
    const pageEnd = rows[rows.length - 1]!.id;

    const inserted: InsertedEntry[] = rows.map((r) => ({ id: r.id, entry: r }));
    try {
      await indexEntries(deps, inserted);
    } catch (e) {
      // A page that fails even after retries must not abandon hours of work;
      // record it and keep going. The next full backfill picks it up.
      await deps.catalog.logError(null, `entries>${cursor}`, 'backfill', (e as Error).message);
    }
    cursor = pageEnd;
    embedded += rows.length;
    // Persist after the page lands, so a restart resumes here rather than at 1.
    await deps.catalog.setSetting(cursorKey, String(cursor)).catch(() => {});
    await opts.onPage?.(alreadyDone + embedded, total, embedded);
  }

  // Finished: drop the cursor so a later rebuild of this collection starts clean.
  await deps.catalog.setSetting(cursorKey, '').catch(() => {});
  return embedded;
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
