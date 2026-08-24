import { describe, expect, it, vi } from 'vitest';
import { TRANSCRIPT_KEY_SCHEME, type TranscriptKeyRow } from '@atlas/core';
import {
  REKEY_LOCK,
  TRANSCRIPT_SCHEME_SETTING,
  planRekey,
  rekeyTranscripts,
  transcriptKey,
  type RekeyDeps,
} from '../../packages/indexer/src/rekeyTranscripts.js';

const DIR = '/data/claude/projects';
const OLD = `${DIR}/-Users-nasta---CODING-NEW-AskAll`;
const NEW = `${DIR}/-Users-serge--CODING-AskAll`;

const row = (id: number, over: Partial<TranscriptKeyRow> = {}): TranscriptKeyRow => ({
  id,
  sourcePath: `${OLD}/s1.jsonl`,
  sourceRef: null,
  title: 'a title',
  body: 'a body',
  dedupKey: `old-key-${id}`,
  ...over,
});

/** A row that is already on the current scheme. */
const current = (id: number, over: Partial<TranscriptKeyRow> = {}): TranscriptKeyRow => {
  const r = row(id, over);
  return { ...r, dedupKey: transcriptKey(r, DIR) };
};

describe('planRekey', () => {
  it('moves a row onto its host-independent key', () => {
    const r = row(1);
    const plan = planRekey([r], DIR, new Map());
    expect(plan.updates).toEqual([{ id: 1, key: transcriptKey(r, DIR) }]);
    expect(plan.drop).toEqual([]);
  });

  it('skips rows already on the current key, so a resumed run is cheap', () => {
    const plan = planRekey([current(1)], DIR, new Map());
    expect(plan).toEqual({ drop: [], updates: [], unchanged: 1 });
  });

  it('merges the post-migration copy into the pre-migration row (lowest id keeps the key)', () => {
    const before = row(10);
    const after = row(20, { sourcePath: `${NEW}/s1.jsonl` });
    expect(transcriptKey(before, DIR)).toBe(transcriptKey(after, DIR));
    const plan = planRekey([before, after], DIR, new Map());
    expect(plan.updates).toEqual([{ id: 10, key: transcriptKey(before, DIR) }]);
    expect(plan.drop).toEqual([20]);
  });

  it('drops a row whose key the database already holds under a lower id', () => {
    const later = row(20, { sourcePath: `${NEW}/s1.jsonl` });
    const plan = planRekey([later], DIR, new Map([[transcriptKey(later, DIR), 10]]));
    expect(plan.drop).toEqual([20]);
    expect(plan.updates).toEqual([]);
  });

  it('evicts a HIGHER id that already holds the key, keeping the lowest id consistently', () => {
    const earlier = row(10);
    const plan = planRekey([earlier], DIR, new Map([[transcriptKey(earlier, DIR), 99]]));
    expect(plan.drop).toEqual([99]);
    expect(plan.updates).toEqual([{ id: 10, key: transcriptKey(earlier, DIR) }]);
  });

  it('never updates a row it also drops', () => {
    const a = row(1);
    const b = row(2, { sourcePath: `${NEW}/s1.jsonl` });
    const c = row(3, { sourcePath: `${DIR}/-Volumes-CloudBox-AskAll/s1.jsonl` });
    const plan = planRekey([a, b, c], DIR, new Map());
    expect(plan.drop).toEqual([2, 3]);
    expect(plan.updates.map((u) => u.id)).toEqual([1]);
  });

  it('keeps genuinely different transcripts apart', () => {
    const plan = planRekey([row(1), row(2, { sourcePath: `${NEW}/s2.jsonl` })], DIR, new Map());
    expect(plan.drop).toEqual([]);
    expect(plan.updates).toHaveLength(2);
  });
});

function fakeDeps(rows: TranscriptKeyRow[], marker: string | null = null) {
  const settings = new Map<string, string>();
  if (marker) settings.set(TRANSCRIPT_SCHEME_SETTING, marker);
  const events: string[] = [];
  let store = [...rows];
  const catalog = {
    getSetting: vi.fn(async (k: string) => settings.get(k) ?? null),
    setSetting: vi.fn(async (k: string, v: string) => {
      settings.set(k, v);
      events.push(`setSetting ${k}=${v}`);
    }),
    countEntries: vi.fn(async () => store.length),
    withAdvisoryLock: vi.fn(async (key: number, fn: () => Promise<unknown>) => {
      events.push(`lock ${key}`);
      try {
        return await fn();
      } finally {
        events.push(`unlock ${key}`);
      }
    }),
    transcriptRowsAfter: vi.fn(async (after: number, limit: number) =>
      store.filter((r) => r.id > after).sort((a, b) => a.id - b.id).slice(0, limit),
    ),
    entryIdsByKeys: vi.fn(async (keys: string[]) => {
      const m = new Map<string, number>();
      for (const r of store) if (keys.includes(r.dedupKey)) m.set(r.dedupKey, r.id);
      return m;
    }),
    applyRekey: vi.fn(async (plan: { drop: number[]; updates: { id: number; key: string }[] }) => {
      events.push(`rows drop=[${plan.drop}] update=[${plan.updates.map((u) => u.id)}]`);
      store = store.filter((r) => !plan.drop.includes(r.id));
      for (const u of plan.updates) {
        const r = store.find((x) => x.id === u.id);
        if (r) r.dedupKey = u.key;
      }
    }),
  };
  const vectors = {
    deleteByEntryIds: vi.fn(async (ids: number[]) => {
      events.push(`points delete=[${ids}]`);
    }),
  };
  const deps: RekeyDeps = {
    catalog: catalog as unknown as RekeyDeps['catalog'],
    vectors: vectors as unknown as RekeyDeps['vectors'],
    claudeProjectsDir: DIR,
  };
  return { catalog, vectors, events, settings, store: () => store, deps };
}

describe('rekeyTranscripts', () => {
  it('does nothing when the marker already matches', async () => {
    const d = fakeDeps([row(1)], TRANSCRIPT_KEY_SCHEME);
    expect(await rekeyTranscripts(d.deps)).toBeNull();
    expect(d.catalog.withAdvisoryLock).not.toHaveBeenCalled();
  });

  it('re-keys under its own lock, deletes points BEFORE rows, then stamps the marker', async () => {
    const d = fakeDeps([row(1), row(2, { sourcePath: `${NEW}/s1.jsonl` }), current(3, { sourcePath: `${NEW}/s3.jsonl` })]);
    const result = await rekeyTranscripts(d.deps);
    expect(result).toEqual({ rekeyed: 1, merged: 1, unchanged: 1 });
    expect(d.events).toEqual([
      `lock ${REKEY_LOCK}`,
      'points delete=[2]',
      'rows drop=[2] update=[1]',
      `setSetting ${TRANSCRIPT_SCHEME_SETTING}=${TRANSCRIPT_KEY_SCHEME}`,
      `unlock ${REKEY_LOCK}`,
    ]);
    expect(d.store().map((r) => r.id)).toEqual([1, 3]);
    expect(d.store()[0]!.dedupKey).toBe(transcriptKey(row(1), DIR));
  });

  it('is idempotent: a second boot finds every row current and only stamps', async () => {
    const d = fakeDeps([row(1), row(2, { sourcePath: `${NEW}/s1.jsonl` })]);
    await rekeyTranscripts(d.deps);
    d.settings.delete(TRANSCRIPT_SCHEME_SETTING); // simulate a crash after the work, before the stamp
    const again = await rekeyTranscripts(d.deps);
    expect(again).toEqual({ rekeyed: 0, merged: 0, unchanged: 1 });
    expect(d.vectors.deleteByEntryIds).toHaveBeenCalledTimes(1);
  });

  it('stamps the marker without work on an empty catalog', async () => {
    const d = fakeDeps([]);
    expect(await rekeyTranscripts(d.deps)).toEqual({ rekeyed: 0, merged: 0, unchanged: 0 });
    expect(d.catalog.transcriptRowsAfter).not.toHaveBeenCalled();
    expect(d.settings.get(TRANSCRIPT_SCHEME_SETTING)).toBe(TRANSCRIPT_KEY_SCHEME);
  });
});
