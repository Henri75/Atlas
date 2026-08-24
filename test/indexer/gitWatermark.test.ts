import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Catalog } from '@atlas/core';
import type { Entry } from '@atlas/core';
import { processScanJob } from '../../packages/indexer/src/pipeline.js';

/**
 * Task 8: git watermark wedge fix — stored git watermark invalidated by
 * a remote force-push+gc currently fails silently FOREVER (the catch swallows
 * `unknown revision` without logging or resetting), so new commits are never
 * indexed again.
 *
 * The fix: invalid watermark now logs and falls back to `git log HEAD -n 5000`.
 */

function makeStubCatalog() {
  const settings = new Map<string, string>();
  const scanState = new Map<string, any>();
  const insertCalls: Entry[][] = [];
  let nextId = 1;
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
    insertEntries: vi.fn(async (_pid: number, entries: Entry[]) => {
      insertCalls.push(entries);
      return entries.map((entry) => ({ id: nextId++, entry }));
    }),
    syncBacklogMeta: vi.fn(async () => 0),
    syncDocStatus: vi.fn(async () => [] as number[]),
    markVectorized: vi.fn(async () => {}),
    logError: vi.fn(async () => {}),
    getSessionRow: vi.fn(async () => null),
    upsertSession: vi.fn(async () => {}),
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
  return {
    deps: { catalog: catalog as any, vectors: vectors as any, embedder },
    catalog,
    settings,
    scanState,
    insertCalls,
  };
}

describe('scanGit: invalid watermark self-heals (Task 8)', () => {
  let projRoot: string;
  let realHeadSha: string;

  beforeAll(() => {
    // Create a temp directory and real git repo with one commit
    const root = mkdtempSync(join(tmpdir(), 'atlas-git-watermark-'));
    projRoot = root;

    // Initialize git repo locally
    execFileSync('git', ['init', '-q'], { cwd: projRoot });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'config', 'user.email', 'test@example.com'], { cwd: projRoot });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'config', 'user.name', 'Test'], { cwd: projRoot });

    // Create and commit a file
    writeFileSync(join(projRoot, 'README.md'), '# Test Repo\n');
    execFileSync('git', ['add', 'README.md'], { cwd: projRoot });
    execFileSync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'Initial commit'],
      { cwd: projRoot },
    );

    // Get the real HEAD sha
    realHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projRoot }).toString().trim();
  });

  afterAll(() => {
    rmSync(projRoot, { recursive: true, force: true });
  });

  it('logs error and falls back to HEAD when watermark is invalid', async () => {
    const { deps, catalog, insertCalls, scanState } = makeStubCatalog();

    // Pre-populate scanState with an invalid watermark (force-push/gc scenario)
    scanState.set(projRoot, {
      ref: 'deadbeef'.repeat(5),
      mtimeMs: 0,
      size: 0,
      byteOffset: 0,
    });

    const job = {
      projectSlug: 'test-proj',
      projectName: 'TestProj',
      rootPath: projRoot,
      sourceType: 'git_commit' as const,
      hasKdb: false,
      machine: 'local',
      isSelf: true,
    };

    await processScanJob(deps, job);

    // Assert: logError called with watermark message
    expect(catalog.logError).toHaveBeenCalledOnce();
    const errorCall = (catalog.logError as any).mock.calls[0];
    expect(errorCall[2]).toBe('git-log'); // log type
    expect(errorCall[3]).toMatch(/watermark/i); // message contains "watermark"

    // Assert: insertEntries received entries (the commit we created)
    expect(insertCalls.length).toBeGreaterThan(0);
    const entries = insertCalls.flat();
    expect(entries.length).toBeGreaterThan(0);

    // Assert: setScanState called with real HEAD sha
    const setScanStateCalls = (catalog.setScanState as any).mock.calls;
    const gitCommitSetCall = setScanStateCalls.find(
      (call: any) => call[1] === 'git_commit' && call[2] === projRoot,
    );
    expect(gitCommitSetCall).toBeDefined();
    expect(gitCommitSetCall[3].ref).toBe(realHeadSha);
  });
});
