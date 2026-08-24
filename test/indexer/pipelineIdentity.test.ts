import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Catalog } from '@atlas/core';
import type { Entry } from '@atlas/core';
import { processScanJob } from '../../packages/indexer/src/pipeline.js';

/**
 * Task 7: every entry the pipeline inserts must carry v3 identity (spec §6),
 * or `Catalog.dedupKey` silently falls back to the machine-dependent legacy
 * key and cross-machine dedup never fires.
 *
 * Covers the four scan paths (kdb/doc/git/claude), the rsync-shrink guard
 * (spec §11) combined with identity stability, and the CRITICAL wiring point
 * from the Task 6 review: `syncBacklogMeta` recomputes `dedupKey` from the
 * entries it is passed to UPDATE existing rows BY KEY — if those entries
 * never went through `applyIdentity`/`assignOccurrenceOrdinals`, the UPDATE
 * silently matches zero rows.
 */

/** Shared stub catalog: every method the four scan paths touch. */
function makeStubCatalog() {
  const settings = new Map<string, string>();
  const scanState = new Map<string, any>();
  const sessions = new Map<string, any>();
  const insertCalls: Entry[][] = [];
  const syncBacklogCalls: Entry[][] = [];
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
    syncBacklogMeta: vi.fn(async (_pid: number, entries: Entry[]) => {
      syncBacklogCalls.push(entries);
      return entries.length;
    }),
    syncDocStatus: vi.fn(async () => [] as number[]),
    markVectorized: vi.fn(async () => {}),
    logError: vi.fn(async () => {}),
    getSessionRow: vi.fn(async (id: string) => sessions.get(id) ?? null),
    upsertSession: vi.fn(async (_pid: number, merged: any) => {
      sessions.set(merged.sessionId, {
        cwd: merged.cwd,
        title: merged.title,
        started_at: merged.startedAt ? new Date(merged.startedAt) : null,
        ended_at: merged.endedAt ? new Date(merged.endedAt) : null,
        prompt_count: merged.promptCount,
        action_count: merged.actionCount,
        files_touched: merged.filesTouched,
      });
    }),
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
    syncBacklogCalls,
  };
}

describe('pipeline applies v3 identity at scan time', () => {
  const root = mkdtempSync(join(tmpdir(), 'atlas-pipeline-identity-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // --- kdb + docs + a real git repo, all under one project root ---
  const projRoot = join(root, 'Proj');
  mkdirSync(join(projRoot, 'kdb'), { recursive: true });
  writeFileSync(
    join(projRoot, 'kdb/changelog.log'),
    [
      '- [DONE] - [2026-08-01 10:00 UTC] - [Fix] - [core] - [First changelog entry]',
      '- [DONE] - [2026-08-02 10:00 UTC] - [Fix] - [core] - [Second changelog entry]',
    ].join('\n') + '\n',
  );

  mkdirSync(join(projRoot, 'docs'), { recursive: true });
  const DOC_BODY = 'A section body long enough to clear the eighty character minimum for doc sections.';
  writeFileSync(join(projRoot, 'docs/guide.md'), `# Guide\n\n${DOC_BODY}\n`);

  execFileSync('git', ['init', '-q'], { cwd: projRoot });
  writeFileSync(join(projRoot, 'NOTES.md'), '# Notes\n');
  execFileSync('git', ['add', 'NOTES.md'], { cwd: projRoot });
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'Initial commit'],
    { cwd: projRoot },
  );

  // --- a fake claude project dir, unrelated to projRoot (mirrors ~/.claude/projects/<dir>) ---
  const claudeDir = join(root, 'claude-projects', '-tmp-Proj');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, 'sess1.jsonl'),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-08-01T10:00:00Z',
      message: { content: 'hello from a claude session' },
    }) + '\n',
  );

  const baseJob = {
    projectSlug: 'proj',
    projectName: 'Proj',
    rootPath: projRoot,
    hasKdb: true,
    machine: 'local',
    isSelf: true,
  };

  it('scanKdb: every inserted entry carries identity; line entries keep sourceRef but get an occurrence ref', async () => {
    const { deps, insertCalls } = makeStubCatalog();
    await processScanJob(deps, { ...baseJob, sourceType: 'kdb' });

    const entries = insertCalls.flat();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.identity)).toBe(true);

    const lineEntry = entries.find((e) => /^line:\d+$/.test(e.sourceRef ?? ''));
    expect(lineEntry).toBeDefined();
    expect(lineEntry!.sourceRef).toMatch(/^line:\d+$/); // deep links keep the raw line (spec §6)
    expect(lineEntry!.identity!.ref).toMatch(/^occ:\d+$/); // dedup uses the stable ordinal instead
  });

  it('scanKdb: every inserted entry carries machine = job.machine, and the Qdrant payload does too', async () => {
    const { deps, insertCalls } = makeStubCatalog();
    await processScanJob(deps, { ...baseJob, machine: 'nasta-mbp', sourceType: 'kdb' });

    const entries = insertCalls.flat();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => (e as any).machine === 'nasta-mbp')).toBe(true);

    const upserted = (deps.vectors.upsert as any).mock.calls.flatMap((c: any[]) => c[0]);
    expect(upserted.length).toBeGreaterThan(0);
    expect(upserted.every((p: any) => p.payload.machine === 'nasta-mbp')).toBe(true);
  });

  it('scanDocs: every inserted entry carries identity', async () => {
    const { deps, insertCalls } = makeStubCatalog();
    await processScanJob(deps, { ...baseJob, hasKdb: false, sourceType: 'doc' });

    const entries = insertCalls.flat();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.identity)).toBe(true);
  });

  it('scanDocs: every inserted entry carries machine = job.machine', async () => {
    const { deps, insertCalls } = makeStubCatalog();
    await processScanJob(deps, { ...baseJob, hasKdb: false, machine: 'nasta-mbp', sourceType: 'doc' });

    const entries = insertCalls.flat();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => (e as any).machine === 'nasta-mbp')).toBe(true);
  });

  it('scanGit: every inserted entry carries identity', async () => {
    const { deps, insertCalls } = makeStubCatalog();
    await processScanJob(deps, { ...baseJob, hasKdb: false, sourceType: 'git_commit' });

    const entries = insertCalls.flat();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.identity)).toBe(true);
  });

  it('scanGit: every inserted entry carries machine = job.machine', async () => {
    const { deps, insertCalls } = makeStubCatalog();
    await processScanJob(deps, { ...baseJob, hasKdb: false, machine: 'nasta-mbp', sourceType: 'git_commit' });

    const entries = insertCalls.flat();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => (e as any).machine === 'nasta-mbp')).toBe(true);
  });

  it('scanClaude: every inserted entry carries claude-scoped identity', async () => {
    const { deps, insertCalls } = makeStubCatalog();
    await processScanJob(deps, {
      ...baseJob,
      hasKdb: false,
      sourceType: 'claude_session',
      claudeDirs: [claudeDir],
    });

    const entries = insertCalls.flat();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.identity)).toBe(true);
    expect(entries.every((e) => e.identity!.scope === 'claude')).toBe(true);
  });

  it('scanClaude: every inserted entry carries machine = job.machine', async () => {
    const { deps, insertCalls } = makeStubCatalog();
    await processScanJob(deps, {
      ...baseJob,
      hasKdb: false,
      machine: 'nasta-mbp',
      sourceType: 'claude_session',
      claudeDirs: [claudeDir],
    });

    const entries = insertCalls.flat();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => (e as any).machine === 'nasta-mbp')).toBe(true);
  });
});

describe('scanClaude rsync-shrink survives with identity applied (spec §11)', () => {
  const root = mkdtempSync(join(tmpdir(), 'atlas-pipeline-claude-shrink-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const claudeDir = join(root, 'claude-projects', '-tmp-shrink');
  mkdirSync(claudeDir, { recursive: true });
  const sessPath = join(claudeDir, 'sess-shrink.jsonl');

  const line1 = JSON.stringify({
    type: 'user',
    timestamp: '2026-08-01T10:00:00Z',
    message: { content: 'first prompt in the session' },
  });
  const line2 = JSON.stringify({
    type: 'user',
    timestamp: '2026-08-01T10:05:00Z',
    message: { content: 'second prompt, later trimmed by the mirror rewrite' },
  });
  writeFileSync(sessPath, `${line1}\n${line2}\n`);

  const job = {
    projectSlug: 'proj',
    projectName: 'Proj',
    rootPath: root,
    hasKdb: false,
    sourceType: 'claude_session' as const,
    claudeDirs: [claudeDir],
    machine: 'local',
    isSelf: true,
  };

  it('resets the offset, does not throw, and the re-emitted entry keeps the same v3 key', async () => {
    const { deps, catalog, insertCalls } = makeStubCatalog();

    await processScanJob(deps, job);
    expect(catalog.logError).not.toHaveBeenCalled();
    const firstPassEntries = insertCalls.flat();
    expect(firstPassEntries.length).toBeGreaterThanOrEqual(2);
    expect(firstPassEntries.every((e) => e.identity)).toBe(true);
    const firstKeys = new Set(firstPassEntries.map((e) => Catalog.dedupKey(e)));

    // Mirror rewrite: the file shrinks to a shorter but still-valid prefix
    // (e.g. an rsync from a machine whose transcript hasn't caught up yet).
    // The stored byteOffset now exceeds the file's new size.
    insertCalls.length = 0;
    writeFileSync(sessPath, `${line1}\n`);

    await expect(processScanJob(deps, job)).resolves.toBeDefined();
    expect(catalog.logError).not.toHaveBeenCalled();

    const secondPassEntries = insertCalls.flat();
    expect(secondPassEntries.length).toBeGreaterThanOrEqual(1);
    expect(secondPassEntries.every((e) => e.identity)).toBe(true);
    const secondKeys = secondPassEntries.map((e) => Catalog.dedupKey(e));
    // Re-emitted from offset 0, the line1 entry must carry the SAME v3 key as
    // before — a real catalog's UNIQUE(dedup_key) would no-op the re-insert
    // instead of duplicating the row.
    expect(secondKeys.every((k) => firstKeys.has(k))).toBe(true);
  });
});

describe('syncBacklogMeta receives identity-bearing entries (Task 6 review CRITICAL)', () => {
  const root = mkdtempSync(join(tmpdir(), 'atlas-pipeline-backlog-identity-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const projRoot = join(root, 'Proj');
  mkdirSync(join(projRoot, 'kdb'), { recursive: true });
  const backlogPath = join(projRoot, 'kdb/backlog.log');

  const lineA = '- [2026-08-01] [core] Alpha backlog item that will shift lines';
  const lineB = '- [2026-08-02] [core] Beta backlog item, stable content';
  const lineX = '- [2026-08-03] [core] Xray inserted before the others';
  writeFileSync(backlogPath, `${lineA}\n${lineB}\n`);

  const job = {
    projectSlug: 'proj',
    projectName: 'Proj',
    rootPath: projRoot,
    hasKdb: true,
    sourceType: 'kdb' as const,
    machine: 'local',
    isSelf: true,
  };

  /**
   * A backlog re-scan must find its existing row by the v3 (occurrence-based)
   * key. This is the regression the CRITICAL note guards against: if the
   * entries handed to `syncBacklogMeta` had NOT gone through the same
   * `applyIdentity` + `assignOccurrenceOrdinals` pass as `insertEntries`, the
   * key would fall back to the legacy `line:<n>` ref — and a line shift from
   * an unrelated prepended entry (exactly what concurrent kdb appends do)
   * would silently break the match, updating zero rows.
   */
  it('finds A and B by their v3 key after an unrelated line shifts their raw position', async () => {
    const { deps, catalog } = makeStubCatalog();

    // A row store keyed by dedup_key, mirroring Postgres's UNIQUE(dedup_key).
    const rows = new Map<string, { meta: unknown }>();
    catalog.insertEntries.mockImplementation(async (_pid: number, entries: Entry[]) => {
      const out: { id: number; entry: Entry }[] = [];
      let i = rows.size;
      for (const e of entries) {
        const key = Catalog.dedupKey(e);
        if (!rows.has(key)) {
          rows.set(key, { meta: e.meta ?? {} });
          out.push({ id: ++i, entry: e });
        }
      }
      return out;
    });
    let lastMatchedKeys = new Set<string>();
    catalog.syncBacklogMeta.mockImplementation(async (_pid: number, entries: Entry[]) => {
      const matched = new Set<string>();
      for (const e of entries) {
        const key = Catalog.dedupKey(e);
        if (rows.has(key)) {
          rows.set(key, { meta: e.meta ?? {} });
          matched.add(key);
        }
      }
      lastMatchedKeys = matched;
      return matched.size;
    });

    // First scan: A and B are freshly inserted, and the same-pass sync trivially
    // matches them (sanity baseline, not yet proof of cross-scan stability).
    await processScanJob(deps, job);
    expect(rows.size).toBe(2);
    expect(lastMatchedKeys.size).toBe(2);
    const firstPassKeys = new Set(rows.keys());

    // Prepend a new line: A's and B's RAW source line numbers shift (1->2,
    // 2->3), but their content — and therefore their v3 occurrence ordinal —
    // is unchanged. The file genuinely changed (size differs), so the normal
    // fileChanged() check re-parses it without any forced resync.
    writeFileSync(backlogPath, `${lineX}\n${lineA}\n${lineB}\n`);

    await processScanJob(deps, job);
    // X is new (3rd row, and trivially "matches" the row it was just inserted
    // as); the point under test is that A's and B's ORIGINAL keys are still
    // among the matched set despite their raw line numbers having shifted.
    expect(rows.size).toBe(3);
    expect([...firstPassKeys].every((k) => lastMatchedKeys.has(k))).toBe(true);
  });
});
