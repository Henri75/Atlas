import { describe, expect, it } from 'vitest';
import { chunk, deterministicUuid } from '@atlas/core';
import { auditVectorCoverage } from '../../packages/indexer/src/pipeline.js';

/**
 * The deep audit reconciles what the catalog *claims* is embedded against what
 * Qdrant actually holds.
 *
 * It used to reconcile at **entry** granularity — a set of entry ids scraped
 * from the point payloads — so an entry whose chunks were only partly present
 * read as fully covered. Entry 7707 (2026-07-29) had one of its five chunk
 * points missing: that one point rejected every write batch it landed in during
 * two separate repair passes, and each boot the audit re-marked the entry as
 * covered rather than repairing it. Nothing reported it, because from the
 * outside a partly-embedded entry is simply an entry that answers fewer
 * questions than it should.
 *
 * Reconciling per point id is what closes that: an entry is covered when *every*
 * chunk it would produce has a point, and not before.
 */

const PROJECT = 'deepcast';

interface Row {
  id: number;
  body: string;
  vectorizedIn: string | null;
  /** Defaults to a non-empty title; set '' to build an entry that yields no chunks. */
  title?: string;
}

const titleOf = (row: Row) => row.title ?? `entry ${row.id}`;

/** The point ids an entry ought to have, derived exactly as the writer does. */
function expectedIds(row: Row): string[] {
  const path = `/x${row.id}.log`;
  return chunk(`${titleOf(row)}\n\n${row.body}`).map((_, seq) =>
    deterministicUuid(PROJECT, path, String(row.id), String(seq)),
  );
}

function makeDeps(rows: Row[], present: Set<string>) {
  const marked: number[] = [];
  const cleared: number[] = [];
  return {
    marked,
    cleared,
    deps: {
      catalog: {
        entriesWithCoverageAfter: async (cursor: number, limit: number) =>
          rows
            .filter((r) => r.id > cursor)
            .slice(0, limit)
            .map((r) => ({
              id: r.id,
              projectSlug: PROJECT,
              sourceType: 'kdb_changelog',
              title: titleOf(r),
              body: r.body,
              sourcePath: `/x${r.id}.log`,
              vectorizedIn: r.vectorizedIn,
            })),
        markVectorized: async (ids: number[]) => void marked.push(...ids),
        clearVectorized: async (ids: number[]) => void cleared.push(...ids),
      },
      vectors: {
        collection: 'c1',
        allPointIds: async () => present,
      },
    } as never,
  };
}

/** A body long enough that the chunker splits it into several chunks. */
const LONG = 'lorem ipsum dolor sit amet '.repeat(400);

describe('auditVectorCoverage', () => {
  it('adopts an entry whose every chunk is present but unmarked', async () => {
    const row: Row = { id: 1, body: 'short', vectorizedIn: null };
    const d = makeDeps([row], new Set(expectedIds(row)));

    const r = await auditVectorCoverage(d.deps);

    expect(r.adopted).toBe(1);
    expect(d.marked).toEqual([1]);
    expect(d.cleared).toEqual([]);
  });

  it('clears an entry marked covered whose points are all gone', async () => {
    const row: Row = { id: 2, body: 'short', vectorizedIn: 'c1' };
    const d = makeDeps([row], new Set());

    const r = await auditVectorCoverage(d.deps);

    expect(r.cleared).toBe(1);
    expect(d.cleared).toEqual([2]);
  });

  /** The regression. Entry 7707 in miniature. */
  it('clears an entry marked covered that is missing only some of its chunks', async () => {
    const row: Row = { id: 3, body: LONG, vectorizedIn: 'c1' };
    const ids = expectedIds(row);
    expect(ids.length).toBeGreaterThan(1); // the fixture must actually split
    const d = makeDeps([row], new Set(ids.slice(1))); // chunk 0 missing

    const r = await auditVectorCoverage(d.deps);

    expect(r.cleared).toBe(1);
    expect(d.cleared).toEqual([3]);
  });

  it('does not adopt an unmarked entry that is only partly present', async () => {
    const row: Row = { id: 4, body: LONG, vectorizedIn: null };
    const ids = expectedIds(row);
    const d = makeDeps([row], new Set(ids.slice(1)));

    const r = await auditVectorCoverage(d.deps);

    // Adopting would declare a half-embedded entry searchable; it must stay
    // uncovered so the ordinary backfill re-embeds it.
    expect(r.adopted).toBe(0);
    expect(d.marked).toEqual([]);
  });

  it('leaves a fully covered, correctly marked entry alone', async () => {
    const row: Row = { id: 5, body: 'short', vectorizedIn: 'c1' };
    const d = makeDeps([row], new Set(expectedIds(row)));

    const r = await auditVectorCoverage(d.deps);

    expect(r).toMatchObject({ adopted: 0, cleared: 0 });
    expect(d.marked).toEqual([]);
    expect(d.cleared).toEqual([]);
  });

  it('treats an entry that yields no chunks as covered, not as permanently broken', async () => {
    // Nothing to embed means nothing can be missing. Clearing it would make the
    // reconciler retry the same entry on every pass, forever — the same reason
    // indexEntries marks a zero-chunk entry complete.
    const row: Row = { id: 6, title: '', body: '', vectorizedIn: 'c1' };
    expect(expectedIds(row)).toHaveLength(0); // the fixture must really be empty
    const d = makeDeps([row], new Set());

    const r = await auditVectorCoverage(d.deps);

    expect(d.cleared).toEqual([]);
    expect(r.cleared).toBe(0);
  });

  it('clears an entry whose only chunk is gone, even with an empty body', async () => {
    // A title alone still produces one chunk, so this entry is genuinely broken
    // — distinct from the zero-chunk case above.
    const row: Row = { id: 7, body: '', vectorizedIn: 'c1' };
    expect(expectedIds(row)).toHaveLength(1);
    const d = makeDeps([row], new Set());

    expect((await auditVectorCoverage(d.deps)).cleared).toBe(1);
    expect(d.cleared).toEqual([7]);
  });

  it('counts partial losses separately from total ones', async () => {
    const whole: Row = { id: 8, body: LONG, vectorizedIn: 'c1' };
    const partial: Row = { id: 9, body: LONG, vectorizedIn: 'c1' };
    // 8 has nothing; 9 has all but its first chunk.
    const d = makeDeps([whole, partial], new Set(expectedIds(partial).slice(1)));

    const r = await auditVectorCoverage(d.deps);

    expect(r.cleared).toBe(2);
    // `partial` is the number worth alarming on: total loss has visible causes
    // (a dropped collection, a restore), while a half-embedded entry does not.
    expect(r.partial).toBe(1);
  });
});
