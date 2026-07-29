import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BACKLOG_PARSER_VERSION } from '@atlas/core';
import { processScanJob } from '../../packages/indexer/src/pipeline.js';

/**
 * The backlog parser-version resync: a bump has to re-parse `backlog.log` even
 * though its mtime and size say nothing changed, because that is the only way
 * pre-existing rows ever get the `lineHash` and `marker` meta the status view
 * derives from.
 *
 * It gets exactly one chance. Once the version is stamped, `fileChanged` goes
 * back to answering "no" and the file is never re-read — so a stamp written
 * after a scan that actually failed loses the resync permanently, and the
 * project's backlog silently keeps deriving from v1 meta forever.
 *
 * That failure is not hypothetical: this scan embeds, and embedding is the
 * thing that fails on a loaded host (batches logged at 45s against a 30s
 * ceiling on 2026-07-29). The same care is already taken with `sparse_version`,
 * which is stamped only on a completed pass.
 */

const root = mkdtempSync(join(tmpdir(), 'atlas-scanbacklog-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(join(root, 'Proj/kdb'), { recursive: true });
writeFileSync(
  join(root, 'Proj/kdb/backlog.log'),
  [
    '- [2026-07-09] [atlas] Backfill restarts from entry 1; persist a resume cursor',
    '- [2026-07-10] [atlas] DONE: backfill resume cursor persisted per collection',
    'an undated free-form line the v1 parser skipped entirely',
  ].join('\n'),
);

const VER_KEY = 'backlog_parser_version:1';

function makeDeps(opts: { storedVersion?: string | null; failIndexing?: boolean } = {}) {
  const settings = new Map<string, string>();
  if (opts.storedVersion != null) settings.set(VER_KEY, opts.storedVersion);
  const scanState = new Map<string, any>();
  const inserted: any[] = [];
  const syncedMeta: any[][] = [];
  const catalog = {
    upsertProject: vi.fn(async () => 1),
    getScanState: vi.fn(async (_p: number, _t: string, path: string) => scanState.get(path) ?? null),
    setScanState: vi.fn(async (_p: number, _t: string, path: string, s: any) => {
      scanState.set(path, s);
    }),
    getSetting: vi.fn(async (k: string) => settings.get(k) ?? null),
    setSetting: vi.fn(async (k: string, v: string) => {
      settings.set(k, v);
    }),
    insertEntries: vi.fn(async (_pid: number, entries: any[]) => {
      inserted.push(...entries);
      return entries.map((entry, i) => ({ id: inserted.length + i, entry }));
    }),
    syncBacklogMeta: vi.fn(async (_pid: number, entries: any[]) => {
      syncedMeta.push(entries);
      return entries.length;
    }),
    markVectorized: vi.fn(async () => {}),
    logError: vi.fn(async () => {}),
  };
  const vectors = {
    collection: 'test_collection',
    // Fails at the upsert rather than the embed so the test does not sit
    // through indexEntries' five retries; the scan aborts identically either
    // way, which is the thing under test.
    upsert: vi.fn(async () => {
      if (opts.failIndexing) throw new Error('qdrant rejected the batch');
    }),
  };
  const embedder = {
    name: 'fake',
    model: 'm',
    dim: 3,
    embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 2, 3])),
  };
  return {
    deps: { catalog: catalog as any, vectors: vectors as any, embedder },
    catalog,
    settings,
    inserted,
    syncedMeta,
  };
}

const job = {
  projectSlug: 'proj',
  projectName: 'Proj',
  rootPath: join(root, 'Proj'),
  hasKdb: true,
  sourceType: 'kdb' as const,
};

describe('scanKdb backlog resync', () => {
  it('re-parses an unchanged backlog on a version bump and syncs meta onto existing rows', async () => {
    const { deps, settings, inserted, syncedMeta } = makeDeps({ storedVersion: '1' });
    await processScanJob(deps, job);

    // The undated line is indexed now; v1 dropped it on the floor.
    expect(inserted.some((e) => e.meta?.unstructured === true)).toBe(true);
    expect(inserted.every((e) => typeof e.meta?.lineHash === 'string')).toBe(true);
    expect(syncedMeta).toHaveLength(1);
    expect(settings.get(VER_KEY)).toBe(String(BACKLOG_PARSER_VERSION));
  });

  it('skips the re-parse once the version is already stamped', async () => {
    const { deps, catalog } = makeDeps({ storedVersion: String(BACKLOG_PARSER_VERSION) });
    await processScanJob(deps, job); // first pass: the file is new to scan state
    catalog.syncBacklogMeta.mockClear();
    await processScanJob(deps, job); // second pass: nothing changed, nothing forced
    expect(catalog.syncBacklogMeta).not.toHaveBeenCalled();
  });

  /** The regression: one bad boot must not cost the resync forever. */
  it('does not stamp the version when the backlog scan failed', async () => {
    const { deps, settings, catalog } = makeDeps({ storedVersion: '1', failIndexing: true });
    await processScanJob(deps, job);

    expect(catalog.logError).toHaveBeenCalled();
    // Still the old version, so the next scan still sees the resync as due.
    expect(settings.get(VER_KEY)).toBe('1');
  });

  it('retries the resync on the next scan after a failure', async () => {
    const failing = makeDeps({ storedVersion: '1', failIndexing: true });
    await processScanJob(failing.deps, job);
    expect(failing.settings.get(VER_KEY)).toBe('1');

    // Same settings map, a working embedder: the second attempt must still see
    // the resync as due, and must still force the re-parse despite scan state.
    const ok = makeDeps({ storedVersion: '1' });
    await processScanJob(ok.deps, job);
    expect(ok.syncedMeta).toHaveLength(1);
    expect(ok.settings.get(VER_KEY)).toBe(String(BACKLOG_PARSER_VERSION));
  });

  /**
   * A project with no backlog.log still stamps: there is nothing to resync, and
   * leaving it unstamped would force a pointless re-parse of every other kdb
   * file on every scan forever.
   */
  it('stamps the version for a project that has no backlog at all', async () => {
    const bare = join(root, 'Bare');
    mkdirSync(join(bare, 'kdb'), { recursive: true });
    writeFileSync(join(bare, 'kdb/changelog.log'), '');
    const { deps, settings } = makeDeps({ storedVersion: '1' });
    await processScanJob(deps, { ...job, rootPath: bare });
    expect(settings.get(VER_KEY)).toBe(String(BACKLOG_PARSER_VERSION));
  });
});
