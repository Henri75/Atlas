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
import type { EmbeddingProvider, Entry, InsertedEntry } from '@kdbscope/core';
import { listDocFiles, listKdbFiles, listSessionFiles } from './scanners.js';

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

/** Chunk + embed + upsert freshly inserted entries into Qdrant. */
export async function indexEntries(deps: PipelineDeps, inserted: InsertedEntry[]): Promise<number> {
  type PendingChunk = { entryId: number; entry: Entry; seq: number; text: string };
  const pending: PendingChunk[] = [];
  for (const { id, entry } of inserted) {
    const chunks = chunk(`${entry.title}\n\n${entry.body}`);
    chunks.forEach((text, seq) => pending.push({ entryId: id, entry, seq, text }));
  }
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const batch = pending.slice(i, i + EMBED_BATCH);
    const dense = await deps.embedder.embed(batch.map((b) => b.text));
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
          occurred_at: b.entry.occurredAt,
        },
      })),
    );
  }
  return pending.length;
}

interface FileStat {
  mtimeMs: number;
  size: number;
}

function fileChanged(stat: FileStat, state: { mtimeMs: number; size: number } | null, full?: boolean) {
  if (full || !state) return true;
  return stat.mtimeMs !== state.mtimeMs || stat.size !== state.size;
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

async function scanKdb(deps: PipelineDeps, job: ScanJobData, projectId: number): Promise<number> {
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
      indexed += await indexEntries(deps, inserted);
      await deps.catalog.setScanState(projectId, f.sourceType, f.path, {
        mtimeMs: stat.mtimeMs, size: stat.size, byteOffset: stat.size,
      });
    } catch (e) {
      await deps.catalog.logError(projectId, f.path, 'kdb-parse', (e as Error).message);
    }
  }
  return indexed;
}

async function scanClaude(deps: PipelineDeps, job: ScanJobData, projectId: number): Promise<number> {
  let indexed = 0;
  for (const dir of job.claudeDirs ?? []) {
    for (const path of listSessionFiles(dir)) {
      try {
        const stat = statSync(path);
        const state = job.full ? null : await deps.catalog.getScanState(projectId, 'claude_session', path);
        if (state && stat.mtimeMs === state.mtimeMs && stat.size === state.size) continue;
        // Shrunk file (rare rewrite) → restart from 0; otherwise tail from last offset.
        const offset = state && stat.size >= state.byteOffset ? state.byteOffset : 0;
        const { lines, newOffset } = readTailLines(path, offset);
        if (!lines.length) {
          await deps.catalog.setScanState(projectId, 'claude_session', path, {
            mtimeMs: stat.mtimeMs, size: stat.size, byteOffset: newOffset,
          });
          continue;
        }
        const sessionId = basename(path, '.jsonl');
        const { entries, meta } = distillClaudeJsonl(lines, {
          projectSlug: job.projectSlug, sourcePath: path, sessionId,
        });
        const inserted = await deps.catalog.insertEntries(projectId, entries);
        indexed += await indexEntries(deps, inserted);

        // Tail reads only see new events — merge with the stored session row.
        const prev = await deps.catalog.getSessionRow(sessionId);
        const merged = {
          sessionId,
          cwd: meta.cwd ?? prev?.cwd ?? undefined,
          title: meta.title ?? prev?.title ?? undefined,
          startedAt: prev?.started_at?.toISOString?.() ?? meta.startedAt,
          endedAt: meta.endedAt ?? prev?.ended_at?.toISOString?.(),
          promptCount: (offset > 0 ? (prev?.prompt_count ?? 0) : 0) + meta.promptCount,
          filesTouched: [...new Set([...(prev?.files_touched ?? []), ...meta.filesTouched])].sort(),
        };
        await deps.catalog.upsertSession(projectId, merged, path);
        await deps.catalog.setScanState(projectId, 'claude_session', path, {
          mtimeMs: stat.mtimeMs, size: stat.size, byteOffset: newOffset,
        });
      } catch (e) {
        await deps.catalog.logError(projectId, path, 'claude-distill', (e as Error).message);
      }
    }
  }
  return indexed;
}

async function scanGit(deps: PipelineDeps, job: ScanJobData, projectId: number): Promise<number> {
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
  const indexed = await indexEntries(deps, inserted);
  const newHead = entries[0]?.sourceRef ?? state?.ref;
  await deps.catalog.setScanState(projectId, 'git_commit', job.rootPath, {
    mtimeMs: 0, size: 0, byteOffset: 0, ref: newHead,
  });
  return indexed;
}

async function scanDocs(deps: PipelineDeps, job: ScanJobData, projectId: number): Promise<number> {
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
      indexed += await indexEntries(deps, inserted);
      await deps.catalog.setScanState(projectId, 'doc', path, {
        mtimeMs: stat.mtimeMs, size: stat.size, byteOffset: stat.size,
      });
    } catch (e) {
      await deps.catalog.logError(projectId, path, 'doc-parse', (e as Error).message);
    }
  }
  return indexed;
}

export async function processScanJob(deps: PipelineDeps, job: ScanJobData): Promise<{ chunksIndexed: number }> {
  const projectId = await deps.catalog.upsertProject({
    slug: job.projectSlug,
    name: job.projectName,
    rootPath: job.rootPath,
    hasKdb: job.hasKdb,
  });
  let chunksIndexed = 0;
  switch (job.sourceType) {
    case 'kdb': chunksIndexed = await scanKdb(deps, job, projectId); break;
    case 'claude_session': chunksIndexed = await scanClaude(deps, job, projectId); break;
    case 'git_commit': chunksIndexed = await scanGit(deps, job, projectId); break;
    case 'doc': chunksIndexed = await scanDocs(deps, job, projectId); break;
  }
  return { chunksIndexed };
}
