import {
  Catalog,
  TRANSCRIPT_KEY_SCHEME,
  TRANSCRIPT_KEY_SCOPE,
  contentHash,
  deterministicUuid,
  transcriptIdentityPath,
  type TranscriptKeyRow,
  type VectorStore,
} from '@atlas/core';

/** Own key — 732015 is schema DDL, taken by the API at every boot too. */
export const REKEY_LOCK = 732016;
export const TRANSCRIPT_SCHEME_SETTING = 'transcript_key_scheme';
const BATCH = 1000;

export interface RekeyPlan {
  /** Rows to delete: duplicates of a row that keeps the key. */
  drop: number[];
  /** Rows that keep their content and move onto their new key. */
  updates: { id: number; key: string }[];
  /** Rows already on the current key — nothing to do (resumed run). */
  unchanged: number;
}

export function transcriptKey(row: TranscriptKeyRow, claudeProjectsDir: string): string {
  return deterministicUuid(
    TRANSCRIPT_KEY_SCOPE,
    transcriptIdentityPath(row.sourcePath, claudeProjectsDir),
    row.sourceRef ?? '',
    row.title,
    contentHash(row.body),
  );
}

/**
 * Decide, for one batch, which rows move and which are duplicates. Pure so it
 * can be tested without a database.
 *
 * Two rows land on the same key when the same transcript was indexed from two
 * directory names — the pre-migration path and the post-migration one. Both
 * carry identical content (the key hashes it), so either can go: the LOWEST id
 * stays, because it is the one whose vectors have been in Qdrant longest and
 * the rule is deterministic across resumed runs. `taken` is what the database
 * already holds for these keys; the batch itself can also collide internally.
 */
export function planRekey(
  rows: TranscriptKeyRow[],
  claudeProjectsDir: string,
  taken: Map<string, number>,
): RekeyPlan {
  const plan: RekeyPlan = { drop: [], updates: [], unchanged: 0 };
  // key -> id that will own it once this batch is applied
  const owner = new Map<string, number>(taken);
  // Ids in this batch we have decided to keep, so a later holder cannot be
  // re-dropped, and updates for ids that end up dropped are withdrawn.
  const dropped = new Set<number>();
  const updates = new Map<number, string>();

  for (const row of rows) {
    const key = transcriptKey(row, claudeProjectsDir);
    if (key === row.dedupKey) {
      plan.unchanged++;
      owner.set(key, row.id);
      continue;
    }
    const holder = owner.get(key);
    if (holder === undefined || holder === row.id) {
      owner.set(key, row.id);
      updates.set(row.id, key);
      continue;
    }
    if (holder < row.id) {
      dropped.add(row.id);
    } else {
      // A higher id already holds the key (only possible after a partial run
      // that got further than this cursor). Lowest id wins, consistently.
      dropped.add(holder);
      updates.delete(holder);
      owner.set(key, row.id);
      updates.set(row.id, key);
    }
  }
  for (const id of dropped) updates.delete(id);
  plan.drop = [...dropped].sort((a, b) => a - b);
  plan.updates = [...updates].map(([id, key]) => ({ id, key }));
  return plan;
}

export interface RekeyDeps {
  catalog: Pick<
    Catalog,
    | 'getSetting'
    | 'setSetting'
    | 'countEntries'
    | 'withAdvisoryLock'
    | 'transcriptRowsAfter'
    | 'entryIdsByKeys'
    | 'applyRekey'
  >;
  vectors: Pick<VectorStore, 'deleteByEntryIds'>;
  claudeProjectsDir: string;
  log?: (msg: string) => void;
}

export interface RekeyResult {
  rekeyed: number;
  merged: number;
  unchanged: number;
}

/**
 * Bring every stored transcript row onto the current key scheme, in place.
 *
 * Runs at indexer boot before any scan, under its own advisory lock, and is
 * resumable: rows already on the current key are skipped, so a crash midway
 * costs nothing but time. Vector points are never moved (their ids hash the
 * stored path under the frozen v2 namespace) — only the losers of a merge lose
 * theirs, and those are deleted before the rows so nothing is ever orphaned.
 * Returns null when the marker already matches and nothing ran.
 */
export async function rekeyTranscripts(deps: RekeyDeps): Promise<RekeyResult | null> {
  const { catalog, vectors, claudeProjectsDir } = deps;
  const log = deps.log ?? (() => {});
  if ((await catalog.getSetting(TRANSCRIPT_SCHEME_SETTING)) === TRANSCRIPT_KEY_SCHEME) return null;

  return catalog.withAdvisoryLock(REKEY_LOCK, async () => {
    // Re-check under the lock: another indexer may have finished it meanwhile.
    if ((await catalog.getSetting(TRANSCRIPT_SCHEME_SETTING)) === TRANSCRIPT_KEY_SCHEME) return null;
    const result: RekeyResult = { rekeyed: 0, merged: 0, unchanged: 0 };
    if ((await catalog.countEntries()) > 0) {
      log(`transcript keys -> ${TRANSCRIPT_KEY_SCHEME}: re-keying stored rows in place (no re-embed)`);
      let cursor = 0;
      let batches = 0;
      for (;;) {
        const rows = await catalog.transcriptRowsAfter(cursor, BATCH);
        if (!rows.length) break;
        cursor = rows[rows.length - 1]!.id;
        const keys = rows.map((r) => transcriptKey(r, claudeProjectsDir));
        const taken = await catalog.entryIdsByKeys(keys);
        const plan = planRekey(rows, claudeProjectsDir, taken);
        if (plan.drop.length) await vectors.deleteByEntryIds(plan.drop);
        await catalog.applyRekey(plan);
        result.rekeyed += plan.updates.length;
        result.merged += plan.drop.length;
        result.unchanged += plan.unchanged;
        if (++batches % 50 === 0) {
          log(
            `transcript re-key: ${result.rekeyed} moved, ${result.merged} merged, ` +
              `${result.unchanged} already current (through id ${cursor})`,
          );
        }
      }
    }
    await catalog.setSetting(TRANSCRIPT_SCHEME_SETTING, TRANSCRIPT_KEY_SCHEME);
    log(
      `transcript keys now ${TRANSCRIPT_KEY_SCHEME}: ${result.rekeyed} moved, ` +
        `${result.merged} duplicates merged, ${result.unchanged} already current`,
    );
    return result;
  });
}
