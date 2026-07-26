# Atlas Trust Hardening — Implementation Plan
2026-07-25 23:20 UTC

## Revision History

| Date (UTC) | Change |
|---|---|
| 2026-07-25 23:20 | Initial plan. Phase 0 (heal) already executed and verified. |
| 2026-07-26 04:25 | Phase 4 complete and verified: moved checkouts aliased to their canonical project, recovering 27,300 entries from scoped search; MCP guidance corrected. D2 withdrawn — the source is idle, not broken. All phases done. |
| 2026-07-26 01:55 | Phase 3 complete and verified: `since`/`until` on MCP, `occurred_at` datetime index (3.11s → 0.004s), recency term, near-duplicate collapse (14/14 distinct titles, was 11/14), age labels beyond docs. B4 deferred with reasoning. |
| 2026-07-26 01:35 | Phase 2 complete and verified: the exact incident question now answers correctly — "based on the retrieved sources… 11,227 entries in the surrounding period, 0 timestamped 2026-07-21" — and goes on to name a real mechanism instead of stopping. |
| 2026-07-26 01:10 | Phase 1 complete and verified live: coverage column, delta-only audit, unified reconciler, periodic reconcile job, `unsearchableEntries` in status. A4 withdrawn — already fixed on 2026-07-09. |
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
| A3 | Status had no way to express "N entries are unsearchable" — every field read healthy while two documents were invisible | live status output | 1 |
| A4 | ~~float `mtimeMs` reaching an int8 column~~ **NOT A BUG** — see below | — | — |
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
| D2 | ~~`kdb_report` frozen at 2025-11-18~~ **NOT A BUG** — see Phase 4 | — | — |

## Phase 0 — Heal (DONE, verified)

Re-embedded the 39 orphaned entries using the real `indexEntries()`, so
chunking, point ids and payloads match the pipeline exactly. Additive only: no
Postgres row written, nothing deleted.

Verified twice — the script re-scrolled the collection and found zero remaining
orphans, and `atlas_search` now returns the previously-invisible
`worker-pool-resize.md` sections top-ranked through the live product surface.

The script is a throwaway prototype of the Phase 1 reconciler, not a deliverable.

## Phase 1 — Integrity (DONE, verified in production)

Stopped the active data loss. Shipped 2026-07-26; every piece below is live and
was verified against the running stack, not only in tests.

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
- Added `unsearchableEntries`: entries indexed but with no vectors in the active
  collection. Flows through `/api/stats`, `/api/dashboard`, `atlas_status` and
  the CLI (shown only when non-zero, so it cannot become a permanently-green line
  nobody reads). The MCP tool description tells agents what a non-zero value
  means for the completeness of their results.
- **`recentErrors` left as-is, deliberately.** The original finding said it
  "reported 0 while errors existed"; on inspection it counts errors *in the last
  hour*, and its `0` was correct — the failures were hours old. The real gap was
  that no field could express "content is unsearchable right now", which is what
  `unsearchableEntries` now does. Changing `recentErrors` would have been fixing
  a misdiagnosis.
- Per-stage error counts and last-successful-embed were dropped from scope: with
  `unsearchableEntries` carrying the signal that matters, they are diagnostics
  better served by `/api/errors`, which already exists.

**A4 — withdrawn, not a bug.** The plan listed this from seeing 577 `invalid
input syntax for type bigint` rows in `index_errors` without checking their
dates. Every one falls in a five-minute window on **2026-07-08 23:14–23:19**,
and `Math.trunc(stat.mtimeMs)` was introduced in `87ccec6` at **2026-07-09
01:20** — two hours later. There have been none since, and every `setScanState`
call site already truncates. The rows are historical residue of a fix that
already landed.

Two lessons worth keeping: an error table is a *log*, not a *state* — counts in
it say nothing about what is broken now; and this is exactly the reasoning error
that caused the incident being fixed, reading a sample as the present.

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

**Verified live** (2026-07-26)
- Migration on 323,364 real entries: audit adopted every existing vector,
  **zero** re-embedding triggered — the outcome the whole design turns on.
- Manufactured a real orphan twice (deleted an entry's points, cleared its mark)
  and confirmed repair by both paths: on boot, and unaided by the scheduled
  reconciler in **45s**, with a warning naming the count.
- `unsearchableEntries` went 0 → 1 → 0 across that cycle.
- Steady-state boot skips the audit scroll entirely (`countUncovered` is 0).

**Also shipped beyond the original plan**
- `maxEntries` cap on reconciliation (100/tick): at ~1.9s per embed on a
  contended local Ollama, an uncapped pass after a model switch would monopolise
  the embedder for hours. Large rebuilds stay the boot path's job.
- Reconciliation runs as a queued BullMQ job, not inline in the cron tick — the
  tick holds a 55s scheduler lock while a reconcile can take minutes.

## Phase 2 — Stop the lying (DONE, verified in production)

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

**Verified live** (2026-07-26) — the same question that produced the incident:

> Before: *"The indexed history for July 2026 concludes on **2026-07-15**."*
>
> After: *"Based on **the retrieved sources**, there is no record… the INDEX
> COVERAGE indicates that while **11,227 entries were indexed in the surrounding
> period**, exactly **0 entries** carry a timestamp for July 21, 2026."*

It then produced an actual hypothesis — the stuck-job monitor failing jobs, the
failed-job drain reviving them 24h later, back into the starved
`videoinsight_low` lane — which is exactly the shape that yields a spike on an
arbitrary day. The structured report carried `mode: hybrid`, `degraded: false`
and `newest: 2026-07-26`, flatly contradicting the old coverage claim.

**Note for Phase 4:** the coverage block surfaced the ghost slug
`volumes-cloudbox-coding-deepcast` alongside `deepcast`, which is finding D1
made visible — useful confirmation that those 6,912 entries are real history.

## Phase 3 — Retrieval quality (DONE, verified in production)

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

**Verified live** (2026-07-26)
- `occurred_at` datetime payload index created (362,715 points). Range filter
  **3.11s → 0.004s** warm — far past the 36× the plan set out to close.
- Date-scoped search returns only in-window hits; the same query unscoped now
  surfaces 07-25/07-26 material first, showing the recency term working.
- Re-ran the incident question: **14 distinct titles out of 14 sources**, against
  11/14 before. The 2025-11-25 triplet collapsed to one and the freed slots went
  to genuinely different material.

**B4 — deferred, deliberately.** Fusion is server-side RRF (`qdrant.ts`,
`query: { fusion: 'rrf' }`), so scores are rank-based and carry no absolute
relevance; there is still no "found nothing *relevant*" state. A calibrated
signal needs a separate dense-only cosine probe plus threshold calibration
against real queries. Shipping an uncalibrated confidence number would be exactly
the unearned confidence this work exists to remove, so it is logged to the
backlog for its own ADR rather than half-built.

**Scope note.** The session cap (`MAX_SESSION_FRACTION`) was left at 0.5. The
recency term addresses the underlying complaint — recent material is
session-dense and was being out-ranked — without weakening the structural
guarantee that keeps explanatory sources in the window. Changing both at once
would have made neither effect measurable.

## Phase 4 — Catalog hygiene (DONE, verified in production)

**D1 — moved checkouts are aliases, not duplicates.** See
`docs/adr/20260726-moved-checkouts-are-aliases-not-duplicates.md`.

`projects.alias_of` links a project whose slug ends with another's — the
signature of a checkout that moved — to its canonical project. Scope expansion
happens in `SearchService.search()`, so the vector path and the FTS fallback
cannot disagree, and Ask measures coverage over the same widened scope.

Entries are deliberately **not** re-attributed: `Catalog.dedupKey` hashes
`projectSlug`, so migrated rows would keep dedup keys computed from the ghost
slug while the next scan computes canonical ones — and `ON CONFLICT DO NOTHING`
would then insert all 27,300 a second time. Aliasing is metadata-only, needs no
re-embed, and is reversible by clearing one column.

**Verified live** (2026-07-26): 8 aliases linked, recovering **27,300 entries**.
`…-deepcast-lycos` correctly resolved to `deepcast-lycos` rather than `deepcast`
(longest match), while genuinely standalone projects — `myllm`, `freerouting`,
the `paperclip` workspaces, and the code root `users-nasta-coding-new` — were
left alone. A search scoped to `deepcast` now returns 2025-era hits from
`volumes-cloudbox-coding-deepcast` that it previously excluded in silence.

`SERVER_INSTRUCTIONS` and the `atlas_projects` description were telling agents
these rows were "ghost duplicates — prefer the clean slug", i.e. instructing them
to discard the only copy of that period's history. Both now say the opposite, and
`aliasOf` is surfaced on every alias row.

**D2 — withdrawn, not a bug.** `kdb_report` looked frozen at 2025-11-18. It is
not broken: the source type indexes ad-hoc markdown in a project's `kdb/`
directory, `occurredAt` is the file mtime, and those DeepCast files genuinely
have not been modified since 2025-11-18 (confirmed on disk). A frozen date
correctly reflects frozen files.

That is the **third** finding in this plan to dissolve under checking (with A4
and the `recentErrors` claim), all the same shape: reading a max/count from a
table as present-tense state rather than as a record of the past. Worth naming as
a recurring failure mode, since it is a milder version of the incident this whole
plan exists to fix.

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
