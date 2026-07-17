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
      // Re-derive the dedup_key column (every 11th param, 0-indexed at 10) to
      // fabricate a plausible RETURNING set — id paired with each key.
      const keys: string[] = [];
      for (let i = 10; i < params.length; i += 11) keys.push(params[i] as string);
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
    // 11 columns × 1 surviving row = 11 params, not 33.
    expect(calls[0]!.params).toHaveLength(11);
    expect(out).toHaveLength(1);
  });

  it('keeps genuinely distinct entries as distinct tuples', async () => {
    const { cat, calls } = fakeCatalog();
    const out = await cat.insertEntries(1, [
      entry({ body: 'one' }),
      entry({ body: 'two' }),
      entry({ body: 'three' }),
    ]);
    expect(calls[0]!.params).toHaveLength(33);
    expect(out).toHaveLength(3);
  });

  it('chunks so a single statement never exceeds the parameter ceiling', async () => {
    const { cat, calls } = fakeCatalog();
    // 6000 distinct entries × 11 params = 66000 > Postgres 65535 ceiling, so it
    // must split. Distinct bodies keep them from collapsing into one.
    const many = Array.from({ length: 6000 }, (_, i) => entry({ body: `body ${i}` }));
    const out = await cat.insertEntries(1, many);

    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.params.length).toBeLessThanOrEqual(65535);
      expect(c.params.length % 11).toBe(0);
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
 * logUsage is the write path added for agent telemetry. Concurrent agents each
 * append their own row, so it must be a single independent INSERT — no
 * read-modify-write that two callers could interleave — and it must clamp its
 * inputs so an oversized tool name or path can't blow the column widths.
 */
describe('Catalog.logUsage — the telemetry write path', () => {
  it('is one plain INSERT (nothing to race between concurrent callers)', async () => {
    const { cat, calls } = fakeCatalog();
    await cat.logUsage({
      client: 'mcp',
      tool: 'atlas_search',
      method: 'GET',
      path: '/api/search',
      query: 'q=x',
      status: 200,
      durationMs: 12.7,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('INSERT INTO usage_log');
    // No SELECT/UPDATE — a lone append can't corrupt under concurrency.
    expect(calls[0]!.sql).not.toMatch(/\bSELECT\b|\bUPDATE\b/);
    // duration is rounded to an int for the INT column.
    expect(calls[0]!.params).toContain(13);
  });

  it('clamps oversized fields to their column widths', async () => {
    const { cat, calls } = fakeCatalog();
    await cat.logUsage({
      client: 'x'.repeat(200),
      tool: 't'.repeat(200),
      method: 'GET',
      path: '/p'.repeat(400),
      query: 'q'.repeat(1000),
      status: 200,
      durationMs: 1,
    });
    const [client, tool, , path, query] = calls[0]!.params as string[];
    expect(client.length).toBeLessThanOrEqual(40);
    expect(tool.length).toBeLessThanOrEqual(80);
    expect(path.length).toBeLessThanOrEqual(300);
    expect(query.length).toBeLessThanOrEqual(500);
  });

  it('stores a null tool/query when the caller omits them', async () => {
    const { cat, calls } = fakeCatalog();
    await cat.logUsage({ client: 'cli', method: 'GET', path: '/api/stats', status: 200, durationMs: 3 });
    const params = calls[0]!.params;
    expect(params).toContain(null);
  });
});
