import type { Catalog, VectorStore } from '@atlas/core';

/**
 * Settings key holding the collection name the walk last completed for — not
 * a boolean. A model switch publishes a new collection with none of this
 * backfill's writes in it, so keying the stamp on the collection (rather than
 * "have we ever run") makes the walk run again automatically after a switch.
 * That is intended: the new collection's points need the same fix, even
 * though it is the second time the fix has run for this catalog.
 */
export const MACHINE_PAYLOAD_BACKFILLED_KEY = 'machine_payload_backfilled';

/** Entries pulled per catalog round-trip (`entryMachineAfter`). */
export const PAGE_SIZE = 500;

/**
 * One-time walk that stamps the `machine` payload field onto every point
 * embedded before Task 16 added it. Old points carry no `machine` key at
 * all, so a `machine`-filtered search does not error on them — it just never
 * matches, which is invisible until someone notices results predating
 * multi-machine support have vanished from a machine-scoped query.
 *
 * Reuses the docStatus resync mechanism: `setPayload` filtered by `entry_id
 * match any`, chunked at 500 ids (`VectorStore.setDocStatus` /
 * `deleteByEntryIds`), generalized here as `setPayloadByEntryIds` since the
 * payload key isn't `doc_status`.
 *
 * Self-gating and self-stamping, so it is safe for a caller (`main.ts`) to
 * invoke unconditionally at boot: a call against an already-stamped
 * collection reads the stamp, finds it matches, and returns 0 without
 * touching the catalog or Qdrant again.
 */
export async function backfillMachinePayload(
  deps: { catalog: Catalog; vectors: VectorStore },
  log: (s: string) => void = () => {},
): Promise<number> {
  const collection = deps.vectors.collection;

  const stamped = await deps.catalog.getSetting(MACHINE_PAYLOAD_BACKFILLED_KEY).catch(() => null);
  if (stamped === collection) return 0;

  let cursor = 0;
  let patched = 0;
  for (;;) {
    const rows = await deps.catalog.entryMachineAfter(collection, cursor, PAGE_SIZE);
    if (!rows.length) break;
    cursor = rows[rows.length - 1]!.id;

    const byMachine = new Map<string, number[]>();
    for (const row of rows) {
      // '' is the pre-machine-model sentinel (never null; entries.machine is
      // NOT NULL DEFAULT ''). Nothing to write — and in practice this never
      // fires, because `backfillMachine` stamps every such row with the self
      // machine name at boot, before this walk runs (see main.ts).
      if (!row.machine) continue;
      const ids = byMachine.get(row.machine);
      if (ids) ids.push(row.id);
      else byMachine.set(row.machine, [row.id]);
    }

    for (const [machine, ids] of byMachine) {
      await deps.vectors.setPayloadByEntryIds(ids, { machine });
      patched += ids.length;
    }
    // Throttled: a full corpus is hundreds of pages, and this is a one-time
    // walk, not a failure worth a line per page.
    if (patched % 5000 < rows.length) {
      log(`[indexer] machine payload backfill: ${patched} patched so far (through entry ${cursor})`);
    }
  }

  await deps.catalog.setSetting(MACHINE_PAYLOAD_BACKFILLED_KEY, collection);
  log(`[indexer] machine payload backfill complete: ${patched} entr${patched === 1 ? 'y' : 'ies'} patched (${collection})`);
  return patched;
}
