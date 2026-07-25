# Atlas Trust Hardening — Implementation Plan
2026-07-25 23:20 UTC

## Revision History

| Date (UTC) | Change |
|---|---|
| 2026-07-25 23:20 | Initial plan. Phase 0 (heal) already executed and verified. |
| 2026-07-25 23:35 | Self-review pass. Four defects found and fixed: `vectorized_at` → `vectorized_in` (a timestamp column breaks the model-switch backfill); migration audits instead of blanket-marking; coverage reported per project; window counts padded. Backfill and reconciler unified. |

---

## Why

Atlas output steers agents that then act on it. A wrong answer is not a wasted
query — it terminates a correct line of inquiry and gets written into a summary
as fact. On 2026-07-25 both failure modes fired at once: Ask asserted a coverage
limit that was false, and beneath it the indexer was silently losing whole
documents.

Two ADRs record the decisions:

- `docs/adr/20260725-vector-catalog-reconciliation.md` — integrity
- `docs/adr/20260725-ask-answer-trust-contract.md` — answer trust

The organising principle across every phase: **measure, or say nothing.** Atlas
must never assert what it has not verified, and never lose data quietly.

## Findings this plan closes

Severity is judged by *what an agent does wrong* as a result.

| # | Finding | Evidence | Phase |
|---|---|---|---|
| A1 | Transient embed failure orphans entries permanently; dedup blocks repair | 39 orphans, incl. 2 whole documents | 1 |
| A2 | `needsBackfill` compares chunks to entries; boot-only | 361,941 vs 323,176 — cannot fire | 1 |
| A3 | `atlas_status` reported `recentErrors: 0` with 4 errors that day and 39 orphans | live status output | 1 |
| A4 | `invalid input syntax for bigint: "1781472590066.0684"` — float `mtimeMs` reaching int8 | 14+ logged | 1 |
| B1 | Prompt rule 2 hands the model the phrase "the indexed history doesn't cover X" | `ask.ts:23` | 2 |
| B2 | No coverage metadata injected; model substitutes newest retrieved date | incident answer | 2 |
| B3 | `mode`/`degraded` discarded; `ask()` hardcodes `degraded: false` | `ask.ts:251`, `ask.ts:343` | 2 |
| B4 | RRF scores carry no absolute relevance; no "nothing relevant" state | `search.ts:10` | 2/3 |
| C1 | `since`/`until` exist and work but no MCP tool exposes them | `tools.ts` | 3 |
| C2 | `claude_session` weighted 0.8 and capped at 50% — the only recent-dense source | `ask.ts:56-72` | 3 |
| C3 | `occurred_at` in every payload but not indexed — 3.11s vs 0.087s | measured | 3 |
| C4 | No content-level dedup; 3 of 14 blocks were near-duplicates | incident sources | 3 |
| C5 | `finalize()` applies age handling only to `sourceType === 'doc'` | `search.ts:104` | 3 |
| D1 | Ghost slugs hold 23,184 real DeepCast entries that scoped queries miss | census | 4 |
| D2 | `kdb_report` frozen at 2025-11-18 | 226 entries, one timestamp | 4 |

## Phase 0 — Heal (DONE, verified)

Re-embedded the 39 orphaned entries using the real `indexEntries()`, so
chunking, point ids and payloads match the pipeline exactly. Additive only: no
Postgres row written, nothing deleted.

Verified twice — the script re-scrolled the collection and found zero remaining
orphans, and `atlas_search` now returns the previously-invisible
`worker-pool-resize.md` sections top-ranked through the live product surface.

The script is a throwaway prototype of the Phase 1 reconciler, not a deliverable.

## Phase 1 — Integrity

Stops active data loss. Highest priority: every embedder outage until this ships
mints new permanent holes.

**Schema**
- Migration: `ALTER TABLE entries ADD COLUMN vectorized_in text` — the collection
  the entry's vectors live in. Collection-valued, not a timestamp: the name
  encodes provider/model/dimension, so a model switch invalidates every row for
  free. A bare `vectorized_at` would report full coverage against a new empty
  collection and break the model-switch backfill (caught in self-review).
- Partial index on `(id) WHERE vectorized_in IS NULL` for the common case.
- The migration **runs one audit pass** to populate the column from what Qdrant
  actually holds. It must not blanket-mark rows: Phase 0 verified coverage now,
  but this ships later, and any outage in between would be blessed as covered —
  baking in the bug being fixed.

**`indexEntries()`**
- Track chunks-per-entry; mark an entry only when its final chunk is upserted.
  Chunk batches span entry boundaries, so a naive per-batch mark would claim
  entries whose later chunks never landed.
- On throw, entries not yet completed stay unmarked — recoverable by construction.

**Reconciler = backfill (unified)**
- Re-point `backfillVectors` from "page all entries by id cursor" to "page
  entries where `vectorized_in IS DISTINCT FROM <active collection>`", reusing
  `indexEntries()` unchanged. One code path now serves both a model switch (every
  row stale → full re-embed, as today) and an outage (a handful stale → targeted
  repair).
- Retire the `backfill_cursor` setting: the column is the progress record, so the
  operation is resumable by construction instead of via a side channel that can
  disagree with reality.
- Low concurrency, off the scan path: a local Ollama saturates easily and
  starving live indexing to repair old holes trades one staleness for another.
- Racing a live scan is safe, not guarded — point ids are deterministic, so a
  double embed is an idempotent overwrite.

**Deep audit**
- Scrolls `entry_id` payloads, clears `vectorized_in` for entries with no
  surviving points, converting Qdrant-side loss into ordinary reconciler work.
- Runs rarely — costs a full scroll (~5–10s at current size).

**`needsBackfill`**
- Redefined over entries not covered in the active collection; evaluated on a
  schedule, not only boot.
- A pass ending with a non-zero count logs a warning. A status field nobody reads
  is not detection.

**`atlas_status`**
- Report `entriesWithoutVectors`, per-stage error counts with newest timestamp,
  and last successful embed. Fix `recentErrors` so it cannot read `0` while
  content is unsearchable.

**A4** — trace the float `mtimeMs` path reaching an int8 column and apply the
same `Math.trunc` the scan-state writes already use. Each occurrence is a
silently skipped file.

**Tests** — `test/indexer/{indexEntries,backfill,pipeline}.test.ts`,
`test/core/insertEntries.test.ts`, `test/api/routes.test.ts`
1. New: entry left unmarked when `indexEntries` throws mid-file — the regression
   test for the incident, written first and failing.
2. New: reconciler embeds exactly the uncovered entries and is a no-op on a
   second run.
3. New: an entry whose chunks straddle a batch boundary is marked only once its
   last chunk lands.
4. New: **a model switch makes every row uncovered** — the regression test for
   the `vectorized_at` design flaw found in self-review. Rows marked against
   collection A must read as uncovered when the active collection is B.
5. New: deep audit clears `vectorized_in` when points are missing.
6. New: `needsBackfill` fires on uncovered entries and not on a healthy
   chunk/entry ratio (pins the unit bug that let this incident through).
7. Modify: `backfill.test.ts` for the unified select-and-page behaviour; assert
   `backfill_cursor` is no longer consulted.
8. Edge cases: empty entry list; entry producing exactly one chunk; embedder
   throwing on the first batch (nothing marked); Qdrant rejecting an upsert;
   reconciler and scan selecting the same entry (idempotent overwrite).

## Phase 2 — Stop the lying

**Coverage block**
- Catalog helper: newest/oldest `occurred_at` + entry count, **per project** —
  scoped projects, or the projects present in the hits when unscoped. A global
  "index current to 2026-07-25" is true and useless, which is the same class of
  answer this phase exists to eliminate. When scope-fallback widens the search,
  coverage describes the scope actually searched.
- Window counts come with a padded neighbourhood count. A bare "0 entries dated
  2026-07-21" recreates the original dead end: an incident on the 21st is usually
  written up on the 22nd or later. Framed as entries *timestamped* in the window,
  never as evidence about whether something happened.
- Injected as a distinct labelled block, never as a pseudo-source — it must not
  be citable as evidence about the subject.

**Prompt**
- Rewrite rule 2: state what the *retrieved blocks* lack; claim what the *index*
  holds only by quoting the coverage block. Name the distinction between
  "retrieval did not surface it" and "the index does not contain it" explicitly.

**Degradation**
- `retrieve()` keeps `mode`/`degraded`; `ask()`/`askStream()` report them; API and
  MCP carry them through.

**Structured retrieval metadata**
- Responses carry `retrieval: { mode, degraded, coverage, windowCount }` so agents
  branch on data, not prose.

**Date extraction**
- Parse explicit dates/ranges from the question to *add* a measured count only —
  never to filter retrieval. A missed date degrades to current behaviour rather
  than hiding results. This asymmetry is deliberate and tested.

**Tests** — `test/core/{ask,askStream}.test.ts`, `test/api/routes.test.ts`,
`test/mcp/`
1. New: given blocks that all predate the asked window, the prompt contains the
   measured coverage and the asked-window count — the direct regression test for
   the 07-15 answer.
2. New: coverage is per-project and reflects the scope actually searched,
   including after a scope-fallback widening.
3. New: a named date yields both the exact-window and padded-neighbourhood counts.
4. New: `degraded: true` and `mode: 'sparse-only'` survive from `SearchService`
   to the MCP response (embedder down).
5. New: same for `mode: 'fts'` (Qdrant down).
6. New: date extraction — ISO dates, "on 21 July", ranges, and text with no date
   (must not fabricate a window).
7. New: coverage block is not citable as a source `[n]`.
8. Modify: existing prompt-shape assertions in `ask.test.ts`.
9. Edge cases: empty scope (no entries at all); scope-fallback path; follow-up
   turn with no fresh retrieval.

**What these tests cannot do.** No test proves the model won't make an ungrounded
claim. They pin the deterministic layer — the coverage block is present, correct,
and uncitable; `degraded` propagates. The prompt rule is defence in depth; the
coverage block is the fix. The old design relied entirely on instructing the
model, which is the layer that failed.

## Phase 3 — Retrieval quality

- **C1** Expose `since`/`until` on `atlas_search`/`atlas_ask` → API → core.
- **C3** Add the `occurred_at` datetime payload index; verify the 36× gap closes.
- **C2** Recency term in `rerankForContext`, tuned so it lifts recent material
  without undoing the source weighting that keeps docs above chatter. The session
  cap needs re-examining specifically: sessions are ~92% of recent entries, so a
  50% cap is a recency penalty in disguise.

  Applied with care, and weakly by default: `20260710-docs-staleness-query-time.md`
  deliberately keeps old-but-current docs ranking well ("an old runbook that
  simply never needed edits must not be buried"). A blanket recency boost would
  quietly reverse that decision. For "what is X" questions the best answer is
  often the oldest stable doc, so the boost should be strongest where the question
  carries temporal intent and near-neutral otherwise.
- **C4** Near-duplicate suppression before the context window is filled.
- **C5** Extend age handling in `finalize()` beyond `doc`.
- **B4** Investigate a calibrated relevance signal so "nothing relevant" is
  expressible. Spike first — this may warrant its own ADR.

**Tests** — `test/core/{rerankForContext,search,qdrantFilter}.test.ts`
Recency ordering; date filters reaching Qdrant; near-duplicate collapse;
non-doc aging; and a guard that recency does not starve authoritative sources.

## Phase 4 — Catalog hygiene

- **D1** Alias ghost slugs to canonical projects so scoping stops silently
  dropping 23,184 real entries. These are older checkout paths with unique
  transcripts, **not** duplicates — `SERVER_INSTRUCTIONS` currently tells agents
  to discard them, which must be corrected. Changes project identity semantics,
  so it needs its own ADR.
- **D2** Decide `kdb_report`: repair or remove. A source frozen since 2025-11-18
  that still answers queries is a trap.

**Tests** — `test/core/{discovery,selectedProjects}.test.ts`: alias resolution,
scoped search spanning aliases, no double-counting in `atlas_projects`.

## Sequencing and risk

Phase 1 first — it is the only active data loss. Phase 2 next: it is what made
the incident visible and is mostly additive. Phase 3 changes ranking for every
query and needs the most regression care. Phase 4 changes identity semantics and
is the most invasive to the catalog.

Each phase ships behind its own tests, commits separately (§11), and lands KDB
entries per §2.2/§5.

**Blast radius.** Phase 1 touches the write path — a bug there corrupts coverage
tracking, so the reconciler is additive-only and every failure mode leaves
entries `NULL` (retryable) rather than falsely marked. Phase 2 touches every Ask
answer; prompt changes are pinned by tests asserting behaviour, not wording.
Phase 3 touches ranking for every query, including the FTS fallback via
`finalize()`. Phase 4 touches project identity, which both search scoping and the
UI depend on.

## Explicitly out of scope

- Renaming the `kdbscope_` collection prefix or the id namespace — frozen, and
  changing either forces a full re-embed for cosmetic gain.
- Replacing RRF fusion. Phase 3 investigates a confidence signal; a fusion
  rewrite is a separate decision.
- Re-embedding with a different model.
