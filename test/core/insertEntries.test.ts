import { describe, expect, it } from 'vitest';
import { Catalog } from '@atlas/core';
import type { Entry } from '@atlas/core';

/**
 * insertEntries is the single write path that concurrency safety rests on:
 * `ON CONFLICT (dedup_key) DO NOTHING` makes a re-scan idempotent, so two
 * indexer workers (or an agent-triggered reindex racing the scheduler) can
 * process the same file and never double-insert. But ON CONFLICT cannot
 * dedup *within one statement* — Postgres raises "ON CONFLICT DO UPDATE
 * command cannot affect row a second time", and for DO NOTHING two identical
 * keys in one VALUES list is still a correctness trap. So insertEntries
 * collapses duplicate dedup_keys before building the statement. These tests
 * pin that collapse and the parameter-ceiling chunking, without a database:
 * a fake pool captures exactly what SQL and params would be sent.
 */

const entry = (over: Partial<Entry> = {}): Entry => ({
  projectSlug: 'deepcast',
  sourceType: 'claude_session',
  title: 'a title',
  body: 'a body',
  sourcePath: '/x/a.jsonl',
  ...over,
});

/** A Catalog whose pool records every query instead of touching Postgres. */
function fakeCatalog() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const cat = new Catalog('postgres://unused');
  // The constructor builds a Pool but never connects until a query runs; swap
  // it for a stub that returns "everything inserted" (one RETURNING row per key).
  (cat as any).pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      // Re-derive the dedup_key column (every 12th param, 0-indexed at 10) to
      // fabricate a plausible RETURNING set — id paired with each key.
      const keys: string[] = [];
      for (let i = 10; i < params.length; i += 12) keys.push(params[i] as string);
      return { rows: keys.map((dedup_key, i) => ({ id: i + 1, dedup_key })) };
    },
  };
  return { cat, calls };
}

describe('Catalog.insertEntries — the idempotent write path', () => {
  it('collapses within-statement duplicate dedup_keys to a single tuple', async () => {
    const { cat, calls } = fakeCatalog();
    // Three byte-identical entries → one dedup_key. Feeding all three to one
    // INSERT unguarded is exactly the ON CONFLICT double-affect trap.
    const dup = entry();
    const out = await cat.insertEntries(1, [dup, { ...dup }, { ...dup }]);

    expect(calls).toHaveLength(1);
    // 12 columns × 1 surviving row = 12 params, not 36.
    expect(calls[0]!.params).toHaveLength(12);
    expect(out).toHaveLength(1);
  });

  it('keeps genuinely distinct entries as distinct tuples', async () => {
    const { cat, calls } = fakeCatalog();
    const out = await cat.insertEntries(1, [
      entry({ body: 'one' }),
      entry({ body: 'two' }),
      entry({ body: 'three' }),
    ]);
    expect(calls[0]!.params).toHaveLength(36);
    expect(out).toHaveLength(3);
  });

  it('chunks so a single statement never exceeds the parameter ceiling', async () => {
    const { cat, calls } = fakeCatalog();
    // 6000 distinct entries × 12 params = 72000 > Postgres 65535 ceiling, so it
    // must split. Distinct bodies keep them from collapsing into one.
    const many = Array.from({ length: 6000 }, (_, i) => entry({ body: `body ${i}` }));
    const out = await cat.insertEntries(1, many);

    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.params.length).toBeLessThanOrEqual(65535);
      expect(c.params.length % 12).toBe(0);
    }
    // Every distinct entry still comes back — chunking loses nothing.
    expect(out).toHaveLength(6000);
  });

  it('always emits ON CONFLICT DO NOTHING, so a re-scan cannot double-insert', async () => {
    const { cat, calls } = fakeCatalog();
    await cat.insertEntries(1, [entry()]);
    expect(calls[0]!.sql).toContain('ON CONFLICT (dedup_key) DO NOTHING');
  });

  it('does nothing and returns [] for an empty batch', async () => {
    const { cat, calls } = fakeCatalog();
    expect(await cat.insertEntries(1, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

/**
 * recordCall is the telemetry write path. Concurrent agents each append their
 * own call, so it must be ONE statement — no read-modify-write two callers could
 * interleave, and no separate reply INSERT that could be orphaned by a crash
 * between the two. It must also clamp its inputs so an oversized tool name or
 * path cannot blow the column widths.
 */
describe('Catalog.recordCall — the telemetry write path', () => {
  const call = {
    client: 'mcp',
    tool: 'atlas_search',
    method: 'GET',
    path: '/api/search',
    query: 'q=pgbouncer',
    status: 200,
    durationMs: 12.7,
  };

  it('writes call and reply in one statement (never two that could half-land)', async () => {
    const { cat, calls } = fakeCatalog();
    await cat.recordCall(call, { resultCount: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('INSERT INTO usage_log');
    expect(calls[0]!.sql).toContain('INSERT INTO usage_reply');
    // Never an UPDATE: this write is fire-and-forget and unordered, so an
    // update-the-row-later shape could target a row not yet inserted.
    expect(calls[0]!.sql).not.toMatch(/\bUPDATE\b/);
    // duration is rounded to an int for the INT column.
    expect(calls[0]!.params).toContain(13);
  });

  it('still writes the call row when there is no reply', async () => {
    const { cat, calls } = fakeCatalog();
    await cat.recordCall({ client: 'ui', method: 'GET', path: '/api/stats', status: 200, durationMs: 3 });
    expect(calls).toHaveLength(1);
    // The final param is the guard that makes the reply INSERT select no rows.
    expect(calls[0]!.params.at(-1)).toBe(false);
  });

  it('classifies the route itself rather than trusting the caller', async () => {
    const { cat, calls } = fakeCatalog();
    await cat.recordCall(call);
    expect(calls[0]!.params).toContain('query');

    const { cat: cat2, calls: calls2 } = fakeCatalog();
    await cat2.recordCall({ ...call, path: '/api/stats' });
    expect(calls2[0]!.params).toContain('status');
  });

  it('clamps oversized fields to their column widths', async () => {
    const { cat, calls } = fakeCatalog();
    await cat.recordCall(
      {
        client: 'x'.repeat(200),
        tool: 't'.repeat(200),
        method: 'GET',
        path: '/p'.repeat(400),
        query: 'q'.repeat(1000),
        status: 200,
        durationMs: 1,
      },
      { error: 'e'.repeat(2000) },
    );
    const [client, tool, , path, query] = calls[0]!.params as string[];
    expect(client.length).toBeLessThanOrEqual(40);
    expect(tool.length).toBeLessThanOrEqual(80);
    expect(path.length).toBeLessThanOrEqual(300);
    expect(query.length).toBeLessThanOrEqual(500);
    // Located by content, not position: this list grows every time a reply
    // column is added, and a positional assertion breaks on a change that is
    // not a regression. (It did, twice.)
    const error = calls[0]!.params.find(
      (v): v is string => typeof v === 'string' && v.startsWith('eee'),
    );
    expect(error!.length).toBeLessThanOrEqual(500);
  });

  /**
   * The answer is the record this table exists for, it lives in TEXT, and the
   * LLM's own max_tokens already bounds it. Clamping it would silently destroy
   * the evidence at exactly the moment an answer got interesting.
   */
  it('does not truncate the answer', async () => {
    const { cat, calls } = fakeCatalog();
    const answer = 'a'.repeat(20_000);
    await cat.recordCall(call, { answer });
    expect(calls[0]!.params).toContain(answer);
  });

  it('keeps only the top hits, so telemetry never becomes a second index', async () => {
    const { cat, calls } = fakeCatalog();
    const topHits = Array.from({ length: 40 }, (_, i) => ({
      entryId: i,
      score: 1 - i / 100,
      title: `hit ${i}`,
      projectSlug: 'atlas',
      sourceType: 'kdb_changelog',
    }));
    await cat.recordCall(call, { topHits });
    const stored = (calls[0]!.params as string[]).find((v) => typeof v === 'string' && v.startsWith('['));
    expect(JSON.parse(stored!)).toHaveLength(5);
  });
});
