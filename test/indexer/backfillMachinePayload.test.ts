import { describe, expect, it, vi } from 'vitest';
import {
  backfillMachinePayload,
  MACHINE_PAYLOAD_BACKFILLED_KEY,
  PAGE_SIZE,
} from '../../packages/indexer/src/backfillMachinePayload.js';

/**
 * Old Qdrant points predate the `machine` payload field (Task 16 adds it only
 * to points written from here on), so a `machine` filter silently misses
 * every one of them until this one-time walk patches the field in place.
 *
 * It reuses the docStatus resync mechanism: `setPayload` filtered by
 * `entry_id match any`, chunked at 500 ids (see `VectorStore.setDocStatus` /
 * `deleteByEntryIds`) — here via the generalized `setPayloadByEntryIds`.
 */

interface Row {
  id: number;
  machine: string;
}

function makeDeps(rows: Row[], opts: { collection?: string; stamped?: string | null } = {}) {
  const collection = opts.collection ?? 'kdbscope_ollama_nomic_768';
  const settings = new Map<string, string>();
  if (opts.stamped != null) settings.set(MACHINE_PAYLOAD_BACKFILLED_KEY, opts.stamped);

  const entryMachineAfter = vi.fn(async (c: string, cursor: number, limit: number) =>
    rows
      .filter((r) => c === collection && r.id > cursor)
      .slice(0, limit)
      .map((r) => ({ id: r.id, machine: r.machine })),
  );
  const setPayloadCalls: { ids: number[]; payload: Record<string, unknown> }[] = [];
  const setPayloadByEntryIds = vi.fn(async (ids: number[], payload: Record<string, unknown>) => {
    setPayloadCalls.push({ ids: [...ids], payload });
  });

  return {
    collection,
    settings,
    entryMachineAfter,
    setPayloadByEntryIds,
    setPayloadCalls,
    deps: {
      catalog: {
        getSetting: async (k: string) => settings.get(k) ?? null,
        setSetting: async (k: string, v: string) => void settings.set(k, v),
        entryMachineAfter,
      } as any,
      vectors: {
        collection,
        setPayloadByEntryIds,
      } as any,
    },
  };
}

describe('backfillMachinePayload', () => {
  it('groups patched entry ids by machine value, one setPayloadByEntryIds call per machine per page', async () => {
    const rows: Row[] = [
      { id: 1, machine: 'mac-a' },
      { id: 2, machine: 'mac-b' },
      { id: 3, machine: 'mac-a' },
    ];
    const { deps, setPayloadCalls } = makeDeps(rows);

    const n = await backfillMachinePayload(deps);

    expect(n).toBe(3);
    expect(setPayloadCalls).toEqual([
      { ids: [1, 3], payload: { machine: 'mac-a' } },
      { ids: [2], payload: { machine: 'mac-b' } },
    ]);
  });

  it('pages the catalog cursor across multiple round-trips', async () => {
    const rows: Row[] = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => ({
      id: i + 1,
      machine: 'mac-a',
    }));
    const { deps, entryMachineAfter } = makeDeps(rows);

    const n = await backfillMachinePayload(deps);

    expect(n).toBe(PAGE_SIZE + 5);
    // Full page, then a short final page, then the empty page that ends the loop.
    expect(entryMachineAfter).toHaveBeenCalledTimes(3);
    expect(entryMachineAfter).toHaveBeenNthCalledWith(1, expect.any(String), 0, PAGE_SIZE);
    expect(entryMachineAfter).toHaveBeenNthCalledWith(2, expect.any(String), PAGE_SIZE, PAGE_SIZE);
    expect(entryMachineAfter).toHaveBeenNthCalledWith(3, expect.any(String), PAGE_SIZE + 5, PAGE_SIZE);
  });

  it('skips rows whose machine is the pre-machine-model sentinel', async () => {
    const rows: Row[] = [
      { id: 1, machine: 'mac-a' },
      { id: 2, machine: '' },
      { id: 3, machine: 'mac-a' },
    ];
    const { deps, setPayloadCalls } = makeDeps(rows);

    const n = await backfillMachinePayload(deps);

    expect(n).toBe(2);
    expect(setPayloadCalls).toEqual([{ ids: [1, 3], payload: { machine: 'mac-a' } }]);
  });

  it('stamps machine_payload_backfilled with the active collection on completion', async () => {
    const rows: Row[] = [{ id: 1, machine: 'mac-a' }];
    const { deps, settings, collection } = makeDeps(rows);

    await backfillMachinePayload(deps);

    expect(settings.get(MACHINE_PAYLOAD_BACKFILLED_KEY)).toBe(collection);
  });

  it('is idempotent: a no-op when already stamped for the active collection', async () => {
    const rows: Row[] = [{ id: 1, machine: 'mac-a' }];
    const { deps, entryMachineAfter, setPayloadByEntryIds } = makeDeps(rows, {
      stamped: 'kdbscope_ollama_nomic_768',
    });

    const n = await backfillMachinePayload(deps);

    expect(n).toBe(0);
    expect(entryMachineAfter).not.toHaveBeenCalled();
    expect(setPayloadByEntryIds).not.toHaveBeenCalled();
  });

  it('re-runs after a model switch: a stamp for a different (old) collection does not gate it', async () => {
    const rows: Row[] = [{ id: 1, machine: 'mac-a' }];
    const { deps, settings, collection } = makeDeps(rows, {
      stamped: 'kdbscope_ollama_oldmodel_512',
    });

    const n = await backfillMachinePayload(deps);

    expect(n).toBe(1);
    expect(settings.get(MACHINE_PAYLOAD_BACKFILLED_KEY)).toBe(collection);
  });

  it('calls the optional log callback', async () => {
    const rows: Row[] = [{ id: 1, machine: 'mac-a' }];
    const { deps } = makeDeps(rows);
    const log = vi.fn();

    await backfillMachinePayload(deps, log);

    expect(log).toHaveBeenCalled();
  });

  /**
   * The function itself does not catch a persistent store failure — it is
   * main.ts's job (a try/catch around the boot-time call, "will retry next
   * boot") to keep this from crash-looping the whole indexer. Pinned here
   * because main.ts has no test coverage: this is what proves the caller's
   * catch is load-bearing rather than defensive dead code.
   */
  it('rejects when the vector store fails persistently, leaving containment to the caller', async () => {
    const rows: Row[] = [{ id: 1, machine: 'mac-a' }];
    const { deps, settings } = makeDeps(rows);
    deps.vectors.setPayloadByEntryIds = vi.fn(async () => {
      throw new Error('qdrant unreachable');
    });

    await expect(backfillMachinePayload(deps)).rejects.toThrow('qdrant unreachable');
    // Not stamped: a failed pass must look exactly like one that never ran,
    // so the next boot retries it rather than treating it as done.
    expect(settings.get(MACHINE_PAYLOAD_BACKFILLED_KEY)).toBeUndefined();
  });
});
