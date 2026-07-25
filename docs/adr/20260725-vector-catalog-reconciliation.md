# ADR: Vector Coverage Is Tracked Per Entry and Reconciled, Not Assumed
Date: 2026-07-25

## Status
Accepted

## Context

On 2026-07-25 a verified incident showed the catalog and the vector store can
diverge permanently and silently.

Two complete documents written that day — `docs/operations/worker-pool-resize.md`
(13 sections, an operations runbook) and
`docs/superpowers/specs/2026-07-25-worker-allocation-control-design.md`
(11 sections), plus the 12 session entries that produced them and the commit
that landed them — existed in Postgres with **zero** vectors in Qdrant. They were
invisible to every semantic search, which is the only retrieval path Ask and
Search use in normal operation. `atlas_status` reported `recentErrors: 0`
throughout.

The mechanism, traced through `pipeline.ts` and `catalog.ts`:

1. `insertEntries()` commits entries to Postgres.
2. `indexEntries()` chunks, embeds and upserts to Qdrant — and **throws** when
   the embedder is briefly unavailable (`ollama embed failed`, `fetch failed`;
   55 such errors were logged, the embedder is a local Ollama that drops
   connections under load).
3. The per-file `catch` logs the error and moves on. Scan state is correctly
   *not* written, so the file is rescanned later.
4. On rescan the file is re-parsed, but `insertEntries` is
   `ON CONFLICT (dedup_key) DO NOTHING ... RETURNING id` — it returns **only
   newly inserted rows**. The orphans already exist, so they are never returned.
5. `indexEntries()` therefore receives an empty list, does not throw, and
   `setScanState()` marks the file fully scanned. The hole is sealed.

The property that makes rescanning cheap (content-hash dedup) is exactly what
makes repair impossible.

No existing mechanism repairs this:

- `make reindex-full` does not help. It resets scan state and re-parses, but
  step 4 is unchanged — dedup still returns nothing to embed.
- `needsBackfill(vectorPoints, entryCount)` compares **chunks to entries**
  (measured: 361,941 vs 323,176). One entry yields one or more chunks, so points
  exceed entries even with thousands of holes. The guard is arithmetically
  incapable of firing. It also runs only at indexer startup, never on a schedule.

A census of all 323,176 entries against all 361,941 points found 39 orphans
(0.01%), every one created that day. The volume is not the risk. The risk is
that there is no repair path and no alarm, so each embedder outage mints new
permanent holes, and the loss lands preferentially on the newest content —
exactly what agents ask about.

This directly violates the hard constraint recorded in
`20260710-docs-staleness-query-time.md`: *never lose information; excluding
content destroys recall invisibly.* That ADR defended against deliberate
exclusion at index time. This is the same failure arriving by accident.

## Decision

Vector coverage becomes explicit, per-entry catalog state rather than an
assumption derived from aggregate counts.

- **`entries.vectorized_in text NULL`** — the name of the collection this entry's
  vectors were written to. `NULL`, or any value other than the active collection,
  means "not searchable right now". Set only after every chunk of the entry has
  been successfully upserted.

  Recording the *collection* rather than a bare timestamp is what makes this
  correct across an embedding-model switch. The collection name encodes the
  provider, model and dimension, so a model change makes every row's
  `vectorized_in` stale automatically, with no mass `UPDATE` and no separate
  code path. A timestamp column would have reported full coverage against a
  brand-new empty collection — silently breaking the very case `needsBackfill`
  was originally written for.

- **`indexEntries()` marks entries as it completes them.** Chunk batches span
  entry boundaries, so an entry is marked only when its final chunk lands. A
  mid-file failure leaves the entries it never reached unmarked instead of
  silently orphaning them.

- **Reconciliation and backfill become one operation.** `backfillVectors` is
  re-pointed from "page through all entries by id cursor" to "page through
  entries where `vectorized_in IS DISTINCT FROM <active collection>`", reusing
  `indexEntries()` unchanged so chunking, point ids and payloads are identical
  to the normal path. The same code then serves both cases that previously had
  none and one respectively:
  - a model switch leaves every row stale → a full re-embed, exactly as today;
  - an embedder outage leaves a handful stale → a fast, targeted repair.

  The `backfill_cursor` setting is retired: the column *is* the progress record,
  so the operation is resumable by construction rather than by a side-channel
  that can disagree with reality.

- **A periodic deep audit** scrolls the collection's `entry_id` payloads and
  clears `vectorized_in` for entries with no surviving points, turning
  Qdrant-side loss (dropped collection, orphan-reclaim bug, restore from an older
  snapshot) into ordinary reconciler work. The catalog column cannot see that
  class of loss on its own. It runs far less often than the reconciler because it
  costs a full scroll (measured ~5–10s at current size).

- **The migration runs the audit rather than trusting a census.** Marking every
  existing row as vectorized would be sound only at an instant when coverage is
  known complete. Phase 0 established that instant, but this ships later, and any
  outage in between would mint orphans that a blanket `UPDATE` would then bless
  as covered — baking in the exact bug being fixed. So the migration adds the
  column empty and performs one audit pass to populate it from what Qdrant
  actually holds. It costs one scroll and is the difference between a measurement
  and an assumption.

- **`needsBackfill` is redefined** in terms of entries not covered in the active
  collection, and is evaluated on a schedule, not only at boot.

- **`atlas_status` reports coverage honestly**: entries not covered, errors by
  stage with their newest timestamp, and the last successful embed. A health
  endpoint that cannot express "39 entries are unsearchable" is not a health
  endpoint. A reconciler pass that ends with a non-zero count also logs a
  warning — a status field nobody reads is not detection.

## Consequences

- Positive: holes become self-healing instead of permanent. Repair no longer
  requires a full re-embed of 323k entries (hours) — only the affected entries.
  Coverage becomes queryable, so "is anything unsearchable right now?" has an
  answer. Past holes from earlier outages are recovered by the same path.
- Positive: the failure is now loud. An embedder outage shows as a rising
  `entriesWithoutVectors` in `atlas_status` rather than as silence.
- Positive: backfill and repair collapse into one code path with one progress
  record, removing the `backfill_cursor` setting that could disagree with the
  actual state of the collection.
- Negative: one added column and an `UPDATE` per completed entry on the index
  path. Batched with the existing per-batch work; negligible against embedding
  cost, which dominates by orders of magnitude.
- Negative: the deep audit holds a full set of entry ids in memory during the
  scroll (~323k integers, a few MB today). Acceptable at this scale; if the
  corpus grows an order of magnitude it should page against a sorted id range.
- Operational: the reconciler must not fight the scanner for the embedder — a
  local Ollama saturates easily, and starving live indexing to repair old holes
  would trade one staleness for another. It runs at low concurrency, off the
  scan path.
- Operational: the reconciler and a live scan can select the same entry
  concurrently. This is safe rather than guarded: point ids are deterministic
  (`deterministicUuid(project, path, entryId, seq)`), so a double embed is an
  idempotent overwrite, wasting work but never producing duplicates or a
  false mark. Adding a claim/lease was rejected as complexity buying nothing at
  this scale.

## Alternatives Considered

- **Embed before inserting into Postgres.** Removes the window entirely, but
  point ids are derived from the entry id (`deterministicUuid(..., entryId,
  seq)`), which does not exist until the row is inserted. Breaking that
  circularity means re-keying every point by `dedup_key` — a full re-embed and a
  frozen-id-namespace change (see `qdrant.ts`, `ids.ts`). Rejected: enormous
  cost to fix a problem reconciliation solves cheaply.
- **Roll back the inserted rows when `indexEntries` throws.** Restores
  retry-ability without new schema, but deletes catalog rows (against the
  never-lose-information constraint), is racy against concurrent readers, only
  partially applies when earlier chunk batches of the same file already
  succeeded, and reintroduces the same orphan if the delete itself fails.
  Rejected.
- **Make `insertEntries` return existing rows too** (`ON CONFLICT DO UPDATE ...
  RETURNING`, or a follow-up select). This alone would let a rescan re-embed
  orphans, and is a smaller change. Rejected as insufficient: it repairs only
  entries whose *source file* changes again, does nothing for the sealed files
  in the incident, and re-embeds unchanged content on every rescan. It is a
  narrower fix for one path, not coverage tracking.
- **A bare `vectorized_at timestamptz` column.** The obvious shape, and wrong.
  After an embedding-model switch every row carries a timestamp from the previous
  collection while the new one is empty, so coverage reads as complete and the
  full re-embed never runs — breaking the case `needsBackfill` exists for. Caught
  in self-review. Recording the collection name subsumes the timestamp's purpose
  and is correct across model switches. Rejected.
- **Alert only, repair by hand.** Rejected: the repair is mechanical and
  idempotent; requiring an operator guarantees the holes persist.

## References
- Plan: `docs/superpowers/plans/2026-07-25-atlas-trust-hardening.md`
- Companion ADR: `20260725-ask-answer-trust-contract.md`
- Constraint inherited from: `20260710-docs-staleness-query-time.md`
- KDB: `kdb/components/atlas.log`, entry of 2026-07-25
