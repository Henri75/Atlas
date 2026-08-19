import { describe, expect, it, vi } from 'vitest';
import { Catalog } from '@atlas/core';

function stubbed(): { cat: Catalog; q: ReturnType<typeof vi.fn> } {
  const cat = Object.create(Catalog.prototype) as Catalog;
  // { id: 1 } so upsertProject's RETURNING id read doesn't throw on the
  // default stub; nothing else in this file inspects the row shape.
  const q = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
  Object.defineProperty(cat, 'pool', { value: { query: q } });
  return { cat, q };
}

describe('machine accessors', () => {
  it('upsertProjectLocation upserts on (project_id, machine)', async () => {
    const { cat, q } = stubbed();
    await cat.upsertProjectLocation({ projectId: 3, machine: 'm4max', rootPath: '/data/remote/m4max/code1/x', hostPath: '/Users/serge/CODING/x', hasKdb: true });
    expect(q.mock.calls[0]![0]).toMatch(/ON CONFLICT \(project_id, machine\)/);
    expect(q.mock.calls[0]![1]).toEqual([3, 'm4max', '/data/remote/m4max/code1/x', '/Users/serge/CODING/x', true]);
  });

  it('listProjectLocations groups rows by project_id with camelCase fields', async () => {
    const { cat, q } = stubbed();
    q.mockResolvedValueOnce({
      rows: [
        { project_id: 1, machine: 'm1', root_path: '/p1/m1', host_path: '/h1', has_kdb: true },
        { project_id: 1, machine: 'm2', root_path: '/p1/m2', host_path: '/h2', has_kdb: false },
        { project_id: 2, machine: 'm1', root_path: '/p2/m1', host_path: '/h3', has_kdb: true },
      ],
    });
    const result = await cat.listProjectLocations();
    expect(result.get(1)).toEqual([
      { machine: 'm1', rootPath: '/p1/m1', hostPath: '/h1', hasKdb: true },
      { machine: 'm2', rootPath: '/p1/m2', hostPath: '/h2', hasKdb: false },
    ]);
    expect(result.get(2)).toEqual([
      { machine: 'm1', rootPath: '/p2/m1', hostPath: '/h3', hasKdb: true },
    ]);
  });

  it('backfillMachine touches only empty-machine rows', async () => {
    const { cat, q } = stubbed();
    await cat.backfillMachine('nasta-mbp');
    for (const call of q.mock.calls) expect(call[0]).toMatch(/machine = ''/);
  });

  it('upsertProject with isSelf:false does not rename an existing project on conflict', async () => {
    const { cat, q } = stubbed();
    await cat.upsertProject({ slug: 'x', name: 'x', rootPath: '/data/remote/m4max/code1/x', hasKdb: true }, { isSelf: false });
    // A no-op `slug = EXCLUDED.slug` update, not `name = ...` — only that
    // makes `ON CONFLICT ... RETURNING id` return a row without touching a
    // real column, so a second, differently-named mirror discovery of the
    // same slug can never clobber the name a self (or earlier) discovery set.
    expect(q.mock.calls[0]![0]).toMatch(/DO UPDATE SET slug = EXCLUDED.slug\s+RETURNING/);
    expect(q.mock.calls[0]![0]).not.toMatch(/name = EXCLUDED.name/);
  });

  it('upsertProject with isSelf:false and a different name still leaves the stored name untouched', async () => {
    const { cat, q } = stubbed();
    await cat.upsertProject({ slug: 'x', name: 'x (self)', rootPath: '/data/code/x', hasKdb: true });
    await cat.upsertProject(
      { slug: 'x', name: 'x (as seen by m4max)', rootPath: '/data/remote/m4max/code1/x', hasKdb: true },
      { isSelf: false },
    );
    // Both calls hit the stubbed pool independently — what matters is that the
    // SECOND (isSelf:false) call's SQL never assigns `name`, so replaying it
    // against a real conflict can never overwrite the first call's name.
    const secondCallSql = q.mock.calls[1]![0];
    expect(secondCallSql).not.toMatch(/name = EXCLUDED.name/);
  });

  it('upsertProject with isSelf:false inserts an empty root_path', async () => {
    const { cat, q } = stubbed();
    await cat.upsertProject({ slug: 'x', name: 'x', rootPath: '/data/remote/m4max/code1/x', hasKdb: true }, { isSelf: false });
    expect(q.mock.calls[0]![1]).toEqual(['x', 'x', '', true]);
  });

  it('upsertProject defaults to isSelf:true and writes root_path/has_kdb on conflict', async () => {
    const { cat, q } = stubbed();
    await cat.upsertProject({ slug: 'x', name: 'x', rootPath: '/data/code/x', hasKdb: true });
    expect(q.mock.calls[0]![0]).toMatch(/DO UPDATE SET root_path = EXCLUDED.root_path, has_kdb = EXCLUDED.has_kdb/);
    expect(q.mock.calls[0]![1]).toEqual(['x', 'x', '/data/code/x', true]);
  });

  it('upsertSession inserts machine and keeps existing non-empty value on conflict', async () => {
    const { cat, q } = stubbed();
    await cat.upsertSession(1, {
      sessionId: 's1', promptCount: 1, actionCount: 0, filesTouched: [],
    } as any, '/path/s1.jsonl', 'm4max');
    expect(q.mock.calls[0]![0]).toMatch(/machine = CASE WHEN sessions\.machine = '' THEN EXCLUDED\.machine ELSE sessions\.machine END/);
    expect(q.mock.calls[0]![1]).toEqual([
      's1', 1, null, null, null, null, 1, 0, JSON.stringify([]), '/path/s1.jsonl', 'm4max',
    ]);
  });

  it('recordSyncStart uses ON CONFLICT and resets error on retry', async () => {
    const { cat, q } = stubbed();
    await cat.recordSyncStart('m4max');
    expect(q.mock.calls[0]![0]).toMatch(/ON CONFLICT \(machine\)/);
    expect(q.mock.calls[0]![0]).toMatch(/error = NULL/);
    expect(q.mock.calls[0]![1]).toEqual(['m4max']);
  });

  it('recordSyncResult ok branch stamps last_success_at with correct params', async () => {
    const { cat, q } = stubbed();
    q.mockClear();
    await cat.recordSyncResult('m4max', { status: 'ok', bytes: 10, durationMs: 5 });
    expect(q.mock.calls[0]![0]).toMatch(/last_success_at = now\(\)/);
    expect(q.mock.calls[0]![1]).toEqual(['m4max', 10, 5]);
  });

  it('recordSyncResult non-ok branch omits last_success_at with correct params', async () => {
    const { cat, q } = stubbed();
    q.mockClear();
    await cat.recordSyncResult('m4max', { status: 'unreachable', error: 'timeout' });
    expect(q.mock.calls[0]![0]).not.toMatch(/last_success_at = now\(\)/);
    expect(q.mock.calls[0]![1]).toEqual(['m4max', 'unreachable', 'timeout']);
  });

  it('recordSyncResult non-ok with null error defaults correctly', async () => {
    const { cat, q } = stubbed();
    q.mockClear();
    await cat.recordSyncResult('m4max', { status: 'error' });
    expect(q.mock.calls[0]![1]).toEqual(['m4max', 'error', null]);
  });

  /**
   * spec §6: the two search paths must never disagree. `buildQdrantFilter`
   * (qdrantFilter.test.ts) emits `{ key: 'machine', match: { value } }`; this
   * is the FTS mirror, at the same precedence as component/kind/docStatus.
   */
  it('ftsSearch adds e.machine = $n when a machine filter is given', async () => {
    const { cat, q } = stubbed();
    q.mockResolvedValueOnce({ rows: [] });
    await cat.ftsSearch('bug', { machine: 'nasta-mbp' });
    expect(q.mock.calls[0]![0]).toMatch(/AND e\.machine = \$\d+/);
    expect(q.mock.calls[0]![1]).toContain('nasta-mbp');
  });

  it('ftsSearch omits the machine WHERE clause when no machine filter is given', async () => {
    const { cat, q } = stubbed();
    q.mockResolvedValueOnce({ rows: [] });
    await cat.ftsSearch('bug', {});
    // The SELECT list still carries e.machine (ENTRY_COLUMNS, for hydration
    // provenance) even with no filter — only the WHERE-clause equality is
    // conditional on one being given.
    expect(q.mock.calls[0]![0]).not.toMatch(/AND e\.machine = \$/);
  });

  /**
   * Carried-forward prerequisite from Task 18's review: getEntries/ftsSearch
   * did not SELECT `machine` at all, so a hydrated search hit's `.machine`
   * was undefined on every response even though decoration would pass it
   * through. Both now go through ENTRY_COLUMNS, which carries it.
   */
  it('getEntries selects e.machine so hydration can carry provenance through', async () => {
    const { cat, q } = stubbed();
    q.mockResolvedValueOnce({ rows: [] });
    await cat.getEntries([1]);
    expect(q.mock.calls[0]![0]).toMatch(/e\.machine/);
  });

  it('ftsSearch returns machine on each hit, normalizing the \'\' sentinel to absent', async () => {
    const { cat, q } = stubbed();
    q.mockResolvedValueOnce({
      rows: [
        {
          id: 1, source_type: 'doc', component: null, session_id: null, title: 't',
          body: 'b', occurred_at: new Date('2026-08-01T00:00:00Z'), source_path: '/x',
          source_ref: null, meta: null, machine: 'nasta-mbp', slug: 'p', rank: 0.5,
        },
        {
          id: 2, source_type: 'doc', component: null, session_id: null, title: 't2',
          body: 'b2', occurred_at: new Date('2026-08-01T00:00:00Z'), source_path: '/y',
          source_ref: null, meta: null, machine: '', slug: 'p', rank: 0.4,
        },
      ],
    });
    const hits = await cat.ftsSearch('bug', {});
    expect(hits[0]!.machine).toBe('nasta-mbp');
    expect(hits[1]!.machine).toBeUndefined();
  });

  /**
   * CRITICAL (pre-flight-scan defect): insertEntries never wrote the machine
   * column at all, so every row inserted after a boot kept the schema default
   * '' regardless of what the scanning job actually tagged the entry with —
   * silently missing it on the FTS side of the machine filter forever, since
   * a re-scan never re-inserts an existing dedup_key.
   */
  it('insertEntries writes the machine column from e.machine, defaulting to \'\'', async () => {
    const { cat, q } = stubbed();
    q.mockResolvedValueOnce({ rows: [{ id: 1, dedup_key: 'k1' }, { id: 2, dedup_key: 'k2' }] });
    const entries = [
      { projectSlug: 'p', sourceType: 'kdb_changelog' as const, title: 't1', body: 'b1', sourcePath: '/x', machine: 'nasta-mbp' },
      { projectSlug: 'p', sourceType: 'kdb_changelog' as const, title: 't2', body: 'b2', sourcePath: '/y' },
    ];
    await cat.insertEntries(7, entries as any);
    const [sql, params] = q.mock.calls[0]!;
    expect(sql).toMatch(/INSERT INTO entries \([^)]*machine[^)]*\)/);
    // First row carries its explicit machine; the second (no `machine` set)
    // must default to '' rather than null or undefined reaching Postgres.
    expect(params).toContain('nasta-mbp');
    expect(params).toContain('');
  });

  /**
   * spec §8: `install_id` must stay stable once minted, which rules out a
   * check-then-act `getSetting` + `setSetting` pair (two concurrent boots
   * could each mint a different id, and `setSetting`'s last-writer-wins
   * upsert silently picks one). `ensureSetting` is the atomic replacement:
   * `INSERT ... ON CONFLICT (key) DO NOTHING RETURNING value`.
   */
  it('ensureSetting inserts with ON CONFLICT (key) DO NOTHING and returns the inserted value on a fresh key', async () => {
    const { cat, q } = stubbed();
    q.mockResolvedValueOnce({ rows: [{ value: 'minted-uuid' }] });
    const result = await cat.ensureSetting('install_id', 'minted-uuid');
    expect(q.mock.calls[0]![0]).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    expect(q.mock.calls[0]![0]).toMatch(/RETURNING value/);
    expect(q.mock.calls[0]![1]).toEqual(['install_id', 'minted-uuid']);
    expect(result).toBe('minted-uuid');
    // Only one query when the INSERT itself returns a row — no fallback SELECT needed.
    expect(q).toHaveBeenCalledTimes(1);
  });

  it('ensureSetting falls back to the existing row when the INSERT returns nothing (a concurrent writer already won)', async () => {
    const { cat, q } = stubbed();
    // First call: the INSERT lost the race (ON CONFLICT DO NOTHING → no row).
    q.mockResolvedValueOnce({ rows: [] });
    // Second call: the follow-up SELECT reads whatever the winner persisted.
    q.mockResolvedValueOnce({ rows: [{ value: 'other-boots-uuid' }] });
    const result = await cat.ensureSetting('install_id', 'this-boots-uuid');
    // The value returned is the durably-persisted one, NOT the freshly-minted
    // candidate this call offered — that's the whole point of the guard.
    expect(result).toBe('other-boots-uuid');
    expect(result).not.toBe('this-boots-uuid');
    expect(q).toHaveBeenCalledTimes(2);
    expect(q.mock.calls[1]![0]).toMatch(/SELECT value FROM settings WHERE key=\$1/);
    expect(q.mock.calls[1]![1]).toEqual(['install_id']);
  });

  it('listMachineSync returns camelCase rows with ISO dates', async () => {
    const { cat, q } = stubbed();
    q.mockResolvedValueOnce({
      rows: [
        {
          machine: 'm1',
          last_attempt_at: new Date('2026-08-19T10:00:00Z'),
          last_success_at: new Date('2026-08-19T09:00:00Z'),
          status: 'ok',
          bytes: 1024,
          duration_ms: 500,
          error: null,
        },
      ],
    });
    const result = await cat.listMachineSync();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      machine: 'm1',
      status: 'ok',
      bytes: 1024,
      durationMs: 500,
      error: null,
    });
    expect(result[0]!.lastAttemptAt).toBe('2026-08-19T10:00:00.000Z');
    expect(result[0]!.lastSuccessAt).toBe('2026-08-19T09:00:00.000Z');
  });
});
