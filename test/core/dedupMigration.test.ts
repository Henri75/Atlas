import { describe, expect, it, vi } from 'vitest';
import {
  Catalog,
  DEDUP_SCHEME,
  contentHash,
  planRekey,
  runDedupMigration,
} from '@atlas/core';
import type { Entry, MigrationEntryRow, MigrationProject } from '@atlas/core';

const KDB_ROOT = '/data/code/kdb';
const CHANGELOG = `${KDB_ROOT}/kdb/changelog.log`;
const PROJECTS = new Map<number, MigrationProject>([
  [1, { slug: 'kdb', rootPath: KDB_ROOT }],
  // A ghost project: no root on this machine, only Claude transcripts.
  [2, { slug: 'ghost-users-x-kdb', rootPath: '' }],
]);
const CLAUDE_DIRS = ['/data/claude/projects', '/data/remote/m4max/claude'];

function row(
  id: number,
  sourcePath: string,
  sourceRef: string | null,
  title: string,
  body: string,
  extra: Partial<MigrationEntryRow> = {},
): MigrationEntryRow {
  return {
    id,
    project_id: 1,
    source_type: 'kdb_changelog',
    source_path: sourcePath,
    source_ref: sourceRef,
    title,
    body,
    ...extra,
  };
}

/** The v2-shaped key: what `Catalog.dedupKey` produces with no identity set. */
function legacyKey(r: MigrationEntryRow, slug: string): string {
  return Catalog.dedupKey({
    projectSlug: slug,
    sourceType: r.source_type as Entry['sourceType'],
    title: r.title,
    body: r.body,
    sourcePath: r.source_path,
    sourceRef: r.source_ref ?? undefined,
  });
}

describe('planRekey', () => {
  it('groups line-ref rows per file and assigns ordinals by line order', () => {
    const rows = [
      row(1, CHANGELOG, 'line:12', 'T', 'same'),
      row(2, CHANGELOG, 'line:5', 'T', 'same'),
    ];
    const plan = planRekey(rows, PROJECTS, CLAUDE_DIRS);
    // line:5 is occurrence 1, line:12 occurrence 2 — ordered by parsed line.
    expect(plan.get(2)!.ref).toBe('occ:1');
    expect(plan.get(1)!.ref).toBe('occ:2');
    // The path component is project-relative, so the same content on another
    // machine's mirror produces the same key.
    expect(plan.get(1)!.path).toBe('kdb/changelog.log');
    expect(plan.get(1)!.scope).toBe('kdb');
  });

  it('breaks an ordinal tie on the same line number by id', () => {
    const rows = [
      row(7, CHANGELOG, 'line:3', 'T', 'same'),
      row(3, CHANGELOG, 'line:3', 'T', 'same'),
    ];
    const plan = planRekey(rows, PROJECTS, CLAUDE_DIRS);
    expect(plan.get(3)!.ref).toBe('occ:1');
    expect(plan.get(7)!.ref).toBe('occ:2');
  });

  it('counts occurrences per (title, content), not per file', () => {
    const rows = [
      row(1, CHANGELOG, 'line:1', 'A', 'one'),
      row(2, CHANGELOG, 'line:2', 'B', 'two'),
      row(3, CHANGELOG, 'line:3', 'A', 'one'),
    ];
    const plan = planRekey(rows, PROJECTS, CLAUDE_DIRS);
    expect(plan.get(1)!.ref).toBe('occ:1');
    expect(plan.get(2)!.ref).toBe('occ:1');
    expect(plan.get(3)!.ref).toBe('occ:2');
  });

  it('rekeys non-line rows row-wise, keeping the content-derived ref', () => {
    const commit = row(4, KDB_ROOT, 'abc123', 'init', 'body', { source_type: 'git_commit' });
    const doc = row(5, `${KDB_ROOT}/docs/x.md`, '#intro', 'Intro', 'body', { source_type: 'doc' });
    const plan = planRekey([commit, doc], PROJECTS, CLAUDE_DIRS);
    expect(plan.get(4)).toMatchObject({ scope: 'kdb', path: '.', ref: 'abc123' });
    expect(plan.get(5)).toMatchObject({ scope: 'kdb', path: 'docs/x.md', ref: '#intro' });
  });

  it('keeps the stored path when it matches no known root — and the key with it', () => {
    const odd = row(6, '/weird/x.md', '#a', 'Odd', 'body', { source_type: 'doc' });
    const plan = planRekey([odd], PROJECTS, CLAUDE_DIRS);
    expect(plan.get(6)!.path).toBe('/weird/x.md');
    // Same inputs as the legacy key, so an unmatched path is a no-op UPDATE.
    expect(plan.get(6)!.newKey).toBe(legacyKey(odd, 'kdb'));
  });

  it('normalizes claude transcripts to the path inside the encoded dir, under the literal claude scope', () => {
    const self = row(8, '/data/claude/projects/-Users-x-kdb/abc.jsonl', null, 't', 'b', {
      project_id: 2,
      source_type: 'claude_session',
    });
    const mirrored = { ...self, id: 9, source_path: '/data/remote/m4max/claude/-Users-x-kdb/abc.jsonl' };
    const plan = planRekey([self, mirrored], PROJECTS, CLAUDE_DIRS);
    expect(plan.get(8)).toMatchObject({ scope: 'claude', path: 'abc.jsonl' });
    // A mirrored (or renamed-directory) copy of the same transcript dedups
    // instead of re-embedding: identical key, so the higher id is the loser.
    expect(plan.get(9)!.newKey).toBe(plan.get(8)!.newKey);
    expect(plan.get(9)!.duplicateOf).toBe(8);
  });

  it('marks a duplicate identity as a collision whose lowest id survives', () => {
    const a = row(1, KDB_ROOT, 'abc123', 'init', 'body', { source_type: 'git_commit' });
    const b = { ...a, id: 2 };
    const plan = planRekey([b, a], PROJECTS, CLAUDE_DIRS);
    expect(plan.get(1)!.duplicateOf).toBeUndefined();
    expect(plan.get(2)!.duplicateOf).toBe(1);
    expect(plan.get(2)!.newKey).toBe(plan.get(1)!.newKey);
  });

  it('is order-independent and idempotent: replanning yields identical keys', () => {
    const rows = [
      row(1, CHANGELOG, 'line:12', 'T', 'same'),
      row(2, CHANGELOG, 'line:5', 'T', 'same'),
      row(3, CHANGELOG, 'line:9', 'Other', 'x'),
    ];
    const first = planRekey(rows, PROJECTS, CLAUDE_DIRS);
    // Rows already carrying their target key replan to exactly the same key —
    // that is what makes a resumed pass a no-op rather than a second rewrite.
    const second = planRekey([...rows].reverse(), PROJECTS, CLAUDE_DIRS);
    for (const id of [1, 2, 3]) {
      expect(second.get(id)).toEqual(first.get(id));
    }
  });

  it('refuses a row whose project was not loaded rather than guessing a scope', () => {
    expect(() => planRekey([row(1, CHANGELOG, 'line:1', 'T', 'b', { project_id: 99 })], PROJECTS, []))
      .toThrow(/project 99/);
  });
});

// --- executor ---------------------------------------------------------------

interface FakeResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

const NONE: FakeResult = { rows: [], rowCount: 0 };

function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
  });
}

/** Normalize whitespace so tests can match statements written across lines. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

type QueryStub = ReturnType<typeof stubbed>['query'];

/**
 * Where a statement lands in the single shared call log. Order is the property
 * under test in several cases below — "the marker is written" is worth almost
 * nothing next to "the marker is written last".
 */
function indexesOf(query: QueryStub, match: (sql: string, params: unknown[]) => boolean): number[] {
  const out: number[] = [];
  query.mock.calls.forEach((c, i) => {
    if (match(flat(String(c[0])), (c[1] as unknown[] | undefined) ?? [])) out.push(i);
  });
  return out;
}

const settingWrite = (key: string) => (sql: string, params: unknown[]) =>
  sql.startsWith('INSERT INTO settings') && params[0] === key;
const anySettingWrite = (sql: string) => sql.startsWith('INSERT INTO settings');

function stubbed(handle: (sql: string, params: unknown[]) => FakeResult) {
  const sqlLog: string[] = [];
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    const s = flat(text);
    sqlLog.push(s);
    return handle(s, params ?? []);
  });
  const client = { query, release: vi.fn() };
  const cat = Object.create(Catalog.prototype) as Catalog;
  Object.defineProperty(cat, 'pool', { value: { query, connect: async () => client } });
  return { cat, query, sqlLog, client };
}

/**
 * One project, one file, one row — enough to drive the whole executor. The
 * `on` map lets a test override any statement it cares about.
 */
function scenario(opts: {
  entries?: Record<string, unknown>[];
  entriesFor?: (sourcePath: string) => Record<string, unknown>[];
  files?: Record<string, unknown>[][];
  scheme?: string | null;
  cursor?: string | null;
  on?: (sql: string, params: unknown[]) => FakeResult | undefined;
}) {
  const files = opts.files ?? [[{ project_id: 1, source_path: CHANGELOG }], []];
  let fileBatch = 0;
  return (sql: string, params: unknown[]): FakeResult => {
    const override = opts.on?.(sql, params);
    if (override) return override;
    if (sql.startsWith('SELECT value FROM settings')) {
      const key = params[0];
      const v = key === 'dedup_scheme' ? (opts.scheme ?? null) : (opts.cursor ?? null);
      return v === null ? NONE : { rows: [{ value: v }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id, slug, root_path FROM projects')) {
      return { rows: [{ id: 1, slug: 'kdb', root_path: KDB_ROOT }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT DISTINCT')) {
      const batch = files[fileBatch] ?? [];
      fileBatch++;
      return { rows: batch, rowCount: batch.length };
    }
    if (sql.startsWith('SELECT id, project_id, source_type')) {
      const rows = opts.entriesFor ? opts.entriesFor(String(params[1])) : (opts.entries ?? []);
      return { rows, rowCount: rows.length };
    }
    return NONE;
  };
}

const ONE_ROW = [
  {
    id: 10,
    project_id: 1,
    source_type: 'kdb_changelog',
    source_path: CHANGELOG,
    source_ref: 'line:1',
    title: 'T',
    body: 'b',
  },
];

describe('runDedupMigration', () => {
  it('does nothing when the marker already reads v3', async () => {
    const { cat, sqlLog } = stubbed(scenario({ scheme: DEDUP_SCHEME }));
    const stats = await runDedupMigration(cat, null);
    expect(stats).toEqual({ scanned: 0, rekeyed: 0, collisions: 0, ordinalGroups: 0 });
    expect(sqlLog.some((s) => s.includes('pg_advisory_lock'))).toBe(false);
  });

  it('holds advisory lock 732016 for the run and never touches 732015', async () => {
    const { cat, sqlLog } = stubbed(scenario({ entries: ONE_ROW }));
    await runDedupMigration(cat, null);
    expect(sqlLog).toContain('SELECT pg_advisory_lock(732016)');
    expect(sqlLog).toContain('SELECT pg_advisory_unlock(732016)');
    expect(sqlLog.some((s) => s.includes('732015'))).toBe(false);
  });

  it('stamps settings.dedup_scheme — never settings.id_scheme — when the sweep finishes', async () => {
    const { cat, query } = stubbed(scenario({ entries: ONE_ROW }));
    const stats = await runDedupMigration(cat, null);
    const settingWrites = query.mock.calls
      .filter((c) => flat(String(c[0])).startsWith('INSERT INTO settings'))
      .map((c) => (c[1] as unknown[])[0]);
    expect(settingWrites).toContain('dedup_scheme');
    expect(settingWrites).not.toContain('id_scheme');
    expect(stats.scanned).toBe(1);
  });

  it('stamps the marker LAST — after the final page, and after the cursor is cleared', async () => {
    // "The marker was written" is nearly worthless on its own. Stamped before
    // the sweep, a crash mid-migration leaves a half-migrated catalog whose
    // marker says it is done: this never runs again, and every row still on a
    // v2 key re-inserts as a duplicate forever.
    const { cat, query } = stubbed(scenario({ entries: ONE_ROW }));
    await runDedupMigration(cat, null);

    const marker = indexesOf(query, settingWrite('dedup_scheme'));
    const scans = indexesOf(query, (sql) => sql.startsWith('SELECT DISTINCT'));
    const settings = indexesOf(query, anySettingWrite);
    expect(marker).toHaveLength(1);
    // After the LAST page query — i.e. after the sweep ran out of files.
    expect(marker[0]!).toBeGreaterThan(scans.at(-1)!);
    // And nothing else is written to settings after it.
    expect(marker[0]!).toBe(settings.at(-1)!);
  });

  it('advances the cursor to the last file of the page, after that file commits', async () => {
    // Written before the file loop instead, a crash mid-page silently skips up
    // to a whole batch of files — forever, because the cursor already claims
    // they were done.
    const PATH_A = `${KDB_ROOT}/kdb/a.log`;
    const PATH_B = `${KDB_ROOT}/kdb/b.log`;
    const { cat, query } = stubbed(
      scenario({
        files: [
          [
            { project_id: 1, source_path: PATH_A },
            { project_id: 1, source_path: PATH_B },
          ],
          [],
        ],
        entriesFor: (sourcePath) => [{ ...ONE_ROW[0]!, source_path: sourcePath }],
      }),
    );
    await runDedupMigration(cat, null);

    const cursorWrites = indexesOf(query, settingWrite('dedup_cursor'));
    // One advance for the page, then the clear at the end.
    expect(cursorWrites).toHaveLength(2);
    const advance = query.mock.calls[cursorWrites[0]!]![1] as unknown[];
    // The LAST file of the page, verbatim — a first-file cursor would replay
    // the page's tail, a stringified anything-else would not compare.
    expect(advance[1]).toBe(JSON.stringify([1, PATH_B]));

    const commits = indexesOf(query, (sql) => sql === 'COMMIT');
    expect(commits).toHaveLength(2);
    expect(cursorWrites[0]!).toBeGreaterThan(commits.at(-1)!);
  });

  it('resumes from the stored cursor instead of rescanning from the start', async () => {
    const { cat, query } = stubbed(
      scenario({ entries: ONE_ROW, cursor: JSON.stringify([4, '/data/code/a.log']) }),
    );
    await runDedupMigration(cat, null);
    const scan = query.mock.calls.find((c) => flat(String(c[0])).startsWith('SELECT DISTINCT'));
    expect((scan![1] as unknown[]).slice(0, 2)).toEqual([4, '/data/code/a.log']);
  });

  it('deletes a collision loser from Qdrant BEFORE Postgres', async () => {
    const order: string[] = [];
    let updates = 0;
    const handler = scenario({
      entries: ONE_ROW,
      on: (sql, params) => {
        if (sql.startsWith('UPDATE entries SET dedup_key')) {
          // Both the batched statement and the per-row retry collide until the
          // holder is gone; the third attempt lands.
          if (++updates <= 2) throw uniqueViolation();
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith('SELECT id, title, body FROM entries WHERE dedup_key')) {
          // Higher id than ours → the holder is the loser and must go.
          return { rows: [{ id: 99, title: 'T', body: 'b' }], rowCount: 1 };
        }
        if (sql.startsWith('DELETE FROM entries WHERE id')) {
          order.push(`pg:${params[0]}`);
          return { rows: [], rowCount: 1 };
        }
        return undefined;
      },
    });
    const { cat } = stubbed(handler);
    const vectors = {
      deleteByEntryIds: vi.fn(async (ids: number[]) => {
        order.push(`qdrant:${ids.join(',')}`);
      }),
    };
    const stats = await runDedupMigration(cat, vectors);
    expect(vectors.deleteByEntryIds).toHaveBeenCalledWith([99]);
    expect(order).toEqual(['qdrant:99', 'pg:99']);
    expect(stats.collisions).toBe(1);
  });

  it('keeps the lowest id when the holder is older than the row being rekeyed', async () => {
    const order: string[] = [];
    let updates = 0;
    const { cat } = stubbed(
      scenario({
        entries: ONE_ROW,
        on: (sql, params) => {
          if (sql.startsWith('UPDATE entries SET dedup_key')) {
            if (++updates <= 2) throw uniqueViolation();
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('SELECT id, title, body FROM entries WHERE dedup_key')) {
            return { rows: [{ id: 2, title: 'T', body: 'b' }], rowCount: 1 };
          }
          if (sql.startsWith('DELETE FROM entries WHERE id')) {
            order.push(`pg:${params[0]}`);
            return { rows: [], rowCount: 1 };
          }
          return undefined;
        },
      }),
    );
    const vectors = {
      deleteByEntryIds: vi.fn(async (ids: number[]) => {
        order.push(`qdrant:${ids.join(',')}`);
      }),
    };
    await runDedupMigration(cat, vectors);
    // Row 10 loses to holder 2; nothing is updated afterwards.
    expect(order).toEqual(['qdrant:10', 'pg:10']);
  });

  it('refuses to delete a key holder whose content is not actually a duplicate', async () => {
    let updates = 0;
    const { cat } = stubbed(
      scenario({
        entries: ONE_ROW,
        on: (sql) => {
          if (sql.startsWith('UPDATE entries SET dedup_key')) {
            if (++updates <= 2) throw uniqueViolation();
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('SELECT id, title, body FROM entries WHERE dedup_key')) {
            return { rows: [{ id: 99, title: 'DIFFERENT', body: 'other' }], rowCount: 1 };
          }
          return undefined;
        },
      }),
    );
    const vectors = { deleteByEntryIds: vi.fn(async () => {}) };
    const err = await runDedupMigration(cat, vectors).catch((e: Error) => e);
    expect(String(err)).toMatch(/not a duplicate/);
    // This throw wedges the indexer in a restart loop, so it must name the file
    // an operator has to open — both entry ids and the (project, path) pair.
    expect(String(err)).toContain('entry 10');
    expect(String(err)).toContain('entry 99');
    expect(String(err)).toContain('project 1');
    expect(String(err)).toContain(CHANGELOG);
    expect(vectors.deleteByEntryIds).not.toHaveBeenCalled();
  });

  it('retires an in-plan duplicate Qdrant-first, without attempting an UPDATE for it', async () => {
    const order: string[] = [];
    const twins = [
      { ...ONE_ROW[0]!, id: 10, source_ref: 'abc123', source_type: 'git_commit' },
      { ...ONE_ROW[0]!, id: 11, source_ref: 'abc123', source_type: 'git_commit' },
    ];
    const { cat } = stubbed(
      scenario({
        entries: twins,
        on: (sql, params) => {
          if (sql.startsWith('DELETE FROM entries WHERE id')) {
            order.push(`pg:${params[0]}`);
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('UPDATE entries SET dedup_key')) {
            // Ids only — a generated key is a uuid whose digits would make a
            // substring assertion here quietly meaningless.
            order.push(`update:${params.filter((p) => typeof p === 'number').join(',')}`);
            return { rows: [], rowCount: 1 };
          }
          return undefined;
        },
      }),
    );
    const vectors = {
      deleteByEntryIds: vi.fn(async (ids: number[]) => {
        order.push(`qdrant:${ids.join(',')}`);
      }),
    };
    const stats = await runDedupMigration(cat, vectors);
    expect(order.slice(0, 2)).toEqual(['qdrant:11', 'pg:11']);
    // Only the survivor is rekeyed, and only after its twin is gone.
    expect(order.filter((s) => s.startsWith('update:'))).toEqual(['update:10']);
    expect(stats.collisions).toBe(1);
  });

  it('counts an ordinal group only when it holds more than one row', async () => {
    const dupes = [
      { ...ONE_ROW[0]!, id: 10, source_ref: 'line:1' },
      { ...ONE_ROW[0]!, id: 11, source_ref: 'line:7' },
      { ...ONE_ROW[0]!, id: 12, source_ref: 'line:9', title: 'other' },
    ];
    const { cat } = stubbed(scenario({ entries: dupes }));
    const stats = await runDedupMigration(cat, null);
    expect(stats.ordinalGroups).toBe(1);
    expect(stats.scanned).toBe(3);
  });

  it('releases the connection and the lock even when a batch throws', async () => {
    const { cat, client, sqlLog } = stubbed(
      scenario({
        entries: ONE_ROW,
        on: (sql) => {
          if (sql.startsWith('UPDATE entries SET dedup_key')) throw new Error('boom');
          return undefined;
        },
      }),
    );
    await expect(runDedupMigration(cat, null)).rejects.toThrow('boom');
    expect(sqlLog).toContain('SELECT pg_advisory_unlock(732016)');
    expect(sqlLog).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('uses the entry content hash the live pipeline uses (planner/executor agree)', () => {
    // Guards the one place a silent drift would double-index everything: the
    // migration must produce exactly the key insertEntries will later compute.
    const r = row(1, CHANGELOG, 'occ-free', 'T', 'body', { source_type: 'doc' });
    const plan = planRekey([r], PROJECTS, CLAUDE_DIRS);
    const live: Entry = {
      projectSlug: 'kdb',
      sourceType: 'doc',
      title: 'T',
      body: 'body',
      sourcePath: CHANGELOG,
      sourceRef: 'occ-free',
      identity: { scope: 'kdb', path: 'kdb/changelog.log', ref: 'occ-free' },
    };
    expect(plan.get(1)!.newKey).toBe(Catalog.dedupKey(live));
    expect(contentHash('body')).toHaveLength(16);
  });
});
