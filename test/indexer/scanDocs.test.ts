import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DOCS_PARSER_VERSION } from '@atlas/core';
import { processScanJob } from '../../packages/indexer/src/pipeline.js';

/**
 * scanDocs behavior: archived flag reaches inserted entries, and the
 * parser-version bump forces a one-time meta/payload sync for files the
 * mtime-based scan state would otherwise skip forever.
 */

const root = mkdtempSync(join(tmpdir(), 'kdbscope-scandocs-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BODY = 'A section body long enough to clear the eighty character minimum for doc sections.';
mkdirSync(join(root, 'Proj/docs/archive'), { recursive: true });
writeFileSync(join(root, 'Proj/docs/guide.md'), `# Guide\n\n${BODY}\n`);
writeFileSync(join(root, 'Proj/docs/archive/old.md'), `# Old stuff\n\n${BODY}\n`);

function makeDeps(opts: { storedVersion?: string | null; scanned?: boolean } = {}) {
  const settings = new Map<string, string>();
  if (opts.storedVersion != null) settings.set('docs_parser_version:1', opts.storedVersion);
  const scanState = new Map<string, any>();
  const inserted: any[] = [];
  const synced: [string, boolean][] = [];
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
    syncDocStatus: vi.fn(async (_pid: number, path: string, archived: boolean) => {
      synced.push([path, archived]);
      return archived ? [41, 42] : [];
    }),
    markVectorized: vi.fn(async () => {}),
    logError: vi.fn(async () => {}),
  };
  const vectors = {
    collection: 'test_collection',
    upsert: vi.fn(async () => {}),
    setDocStatus: vi.fn(async () => {}),
  };
  const embedder = {
    name: 'fake',
    model: 'm',
    dim: 3,
    embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 2, 3])),
  };
  return { deps: { catalog: catalog as any, vectors: vectors as any, embedder }, catalog, vectors, inserted, synced, scanState };
}

const job = {
  projectSlug: 'proj',
  projectName: 'Proj',
  rootPath: join(root, 'Proj'),
  hasKdb: false,
  sourceType: 'doc' as const,
  machine: 'local',
  isSelf: true,
};

describe('scanDocs', () => {
  it('indexes fresh files with the archived flag and records the parser version', async () => {
    const { deps, catalog, inserted, synced } = makeDeps();
    await processScanJob(deps, job);

    const byPath = (frag: string) => inserted.filter((e) => e.sourcePath.includes(frag));
    expect(byPath('guide.md').every((e) => e.meta?.docStatus === undefined)).toBe(true);
    expect(byPath('archive/old.md').every((e) => e.meta?.docStatus === 'archived')).toBe(true);
    // Changed files sync too: a re-parse only inserts NEW dedup keys, so
    // pre-existing rows of the same file must be updated in place.
    expect(synced.length).toBe(2);
    expect(catalog.setSetting).toHaveBeenCalledWith(
      'docs_parser_version:1',
      String(DOCS_PARSER_VERSION),
    );
  });

  it('skips unchanged files entirely when the parser version matches', async () => {
    const { deps, catalog, synced } = makeDeps({ storedVersion: String(DOCS_PARSER_VERSION) });
    await processScanJob(deps, job); // first pass: everything is new
    catalog.insertEntries.mockClear();
    synced.length = 0;

    await processScanJob(deps, job); // second pass: mtime/size unchanged
    expect(catalog.insertEntries).not.toHaveBeenCalled();
    expect(synced).toEqual([]);
  });

  it('version bump forces a status sync on unchanged files, without re-parsing', async () => {
    const { deps, catalog, vectors, synced } = makeDeps({ storedVersion: String(DOCS_PARSER_VERSION) });
    await processScanJob(deps, job);
    catalog.insertEntries.mockClear();
    synced.length = 0;

    // Simulate an older stored version → the next scan must sync every file.
    await catalog.setSetting('docs_parser_version:1', '1');
    await processScanJob(deps, job);

    expect(catalog.insertEntries).not.toHaveBeenCalled(); // no re-parse
    expect(synced.map(([p, a]) => [p.split('/').pop(), a]).sort()).toEqual([
      ['guide.md', false],
      ['old.md', true],
    ]);
    // Only the archived file had rows to fix (fake returns ids for archived only).
    expect(vectors.setDocStatus).toHaveBeenCalledWith([41, 42], 'archived');
  });
});
