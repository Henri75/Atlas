# Spec: Retrieval Evaluation Harness (Deliverable 0)
2026-07-26 03:25 UTC

## Revision History

| Date (UTC) | Change |
|---|---|
| 2026-07-26 03:25 | Initial spec. Design self-review folded in (S1–S11, §11). |
| 2026-07-26 03:40 | Spec self-review pass: twelve fixes (SR1–SR12, §11b), incl. three inconsistencies — `retrieveForContext`'s signature could serve neither measurement stage, plain κ was wrong for ordinal grades, and the κ subsample would have been flattered by easy negatives. |
| 2026-07-26 06:30 | Implementation corrections (I1–I6, §11c). Three are Atlas defects the harness exposed: the FTS fallback returned nothing for any multi-word query, `chatComplete` reported a truncated completion as an empty success, and ask questions were never logged. Pooling corrected from variants to mechanisms. |

---

## Why this exists

`docs/superpowers/plans/2026-07-25-atlas-trust-hardening.md` deferred two items —
B4 (a calibrated relevance signal) and the source-mix question — for one reason:
**nothing in this repo can measure whether a retrieval change made things better
or worse.** Every existing test asserts mechanics (this weight is applied, this
duplicate collapses) on synthetic fixtures. None asserts quality.

Shipping either deferred item on intuition would contradict the principle the
rest of that work established: *measure, or say nothing.* This spec builds the
measuring instrument and stops there.

Parent spec: `docs/superpowers/plans/2026-07-26-retrieval-confidence-and-source-mix-spec.md`.

## What was verified before designing

Measured against the live stack on 2026-07-26, not assumed:

| Claim | Measurement |
|---|---|
| RRF scores are rank arithmetic | Top-8 for a real query: `0.7500 0.5000 0.4000 0.3487 0.3333 0.2500 0.2037 0.1667` — unit fractions (½+¼, ½, ⅖, ⅓, ¼, ⅙) |
| Corpus is session-dominated | 292,757 / 323,825 entries are `claude_session` (90.4%) |
| Index is live and hybrid | 362,973 points, `mode=hybrid`, `degraded=false`, 2.19s for k=30 |
| Host-side in-process retrieval works | pg `127.0.0.1:5460`, qdrant `6363`, Ollama `11434` (nomic-embed-text, dim 768) all reachable; `SearchService` + `rerankForContext` run unmodified from the host |
| Judge model is usable | `cline-pass/kimi-k3` → served `moonshotai/kimi-k3`; clean unfenced JSON; graded a half-answer `2` rather than `3` |
| Second judge is usable | `cline-pass/glm-5.2` → `zai/glm-5.2`, 7s; `Qwen3.5-397B-A17B` 24s; all three agreed on the probe |
| Bodies are small | `claude_session` p50 86 chars; `kdb_component` p90 4,878 — judging at 800-char truncation is cheap |

### The mineable query set is 21, not 30–50

The parent spec assumes real traffic can supply 30–50 questions. It cannot:

| Source | Reality |
|---|---|
| `usage_log`, 94 rows with a query | **13 distinct real search queries.** 60 rows are `burst N` load-test noise; 21 are `qdrant quantization concurrency N` variants of one query |
| `usage_log`, `atlas_ask` | **Zero questions recorded.** All 8 rows have an empty `query` — `/api/ask` is a POST and `app.ts` logs only the URL query string |
| `~/.claude/projects/**` (12 GB, 60 projects) | 10 `atlas_search` + 10 `atlas_ask` invocations, 8 distinct questions, almost entirely overlapping `usage_log` |

Deduplicated: **21 distinct real queries**, ~4 per class. That is enough to
sanity-check a change and not enough for a per-class absolute metric to carry a
decision. §4 and §6 are shaped by this constraint rather than pretending it away.

## Non-goals

Held from the parent spec, plus one addition:

- **No fusion change.** RRF stays.
- **No re-embed, no embedding-model change.** Collection prefix and id namespace
  are frozen (`qdrant.ts`).
- **No B4 code.** No `relevance` field, no bands, no thresholds, nothing new on
  `RetrievalReport`. This spec produces the calibration data B4 consumes.
- **No ranking change.** `MAX_SESSION_FRACTION` stays 0.5. The harness measures;
  work item 2 decides in a later change.
- **No answer-quality metric.** `make eval` makes zero LLM calls (see §7).

---

## 1. Architecture

A sixth workspace, `packages/eval`, built by the existing `npm run build` and
type-checked by `make lint`. It runs on the host and talks to the live stack
through the 127.0.0.1 ports, constructing `Catalog` / `VectorStore` /
`SearchService` in process.

```
packages/eval/src/
  main.ts        CLI: mine | generate | judge | run | signals | baseline
  pools.ts       fixture load/save, schema validation, leakage filter
  judge.ts       kimi-k3 client (via chatComplete), parsing, repair, kappa
  metrics.ts     nDCG@10, recall@30, MRR, precision@k, bootstrap CI, kappa
  variants.ts    baseline + candidate rerank configurations
  report.ts      per-pool/per-class tables, paired deltas, drift banner
test/fixtures/eval/
  queries.json      all three pools, with provenance
  judgements.json   (query, entryId) -> grade + reason + judge
  baseline.json     committed metrics + corpus fingerprint
  arbitrate.md      generated: judge disagreements awaiting a human call
```

**Why in-process and not HTTP.** The knobs the harness exists to compare
(`SOURCE_WEIGHT`, `MAX_SESSION_FRACTION`, `RECENCY_*`) are module constants. Over
HTTP a variant is a code edit plus `make restart` (~30s), one variant per run,
and no A/B in a single command. In process a variant is a config object.

**Why not in Docker.** `docker/node.Dockerfile` copies source in; there is no
bind mount for code, so every harness edit would need an image rebuild.

## 2. Two measurement stages (S3)

The deferred work items live at *different* stages, so every metric is labelled
with the stage it was computed at.

| Stage | Code path | Governed by |
|---|---|---|
| **retrieval** — the pool, 30–60 hits | `SearchService.search()` | dense/sparse fusion, archived-doc penalty, filters |
| **context** — the k blocks Ask synthesises from, k=12 | `rerankForContext()` | source weight, session cap, recency, near-duplicate collapse |

Both come from **one call** to `AskService.retrieveForContext()` (§9), which
returns the pool and the reranked context together. The harness must not call
`SearchService.search()` itself: that would duplicate Ask's pool-size formula and
guarantee the two drift apart.

`MAX_SESSION_FRACTION` cannot change the retrieval pool at all — only which
members of it survive into the context window. A harness that measured one stage
would render work item 2 either unmeasurable or trivially flat.

Metrics per stage:

| Stage | Metrics |
|---|---|
| retrieval | `recall@30` (pool A), `MRR@30` + `hit@30` (pool B) |
| context | `nDCG@10`, `precision@12` (pool A), `hit@12` + reciprocal rank (pool B) |

Definitions, so none of these is ambiguous later:

- `recall@30` — judged-relevant entries (grade ≥ 2) in the top 30 of the pool,
  over all judged-relevant entries for that query.
- `nDCG@10` — gains `[0,1,2,3]` by grade, `log2(rank+1)` discount, ideal DCG from
  the judged set for that query. Queries with no relevant entry are excluded from
  the nDCG mean and counted separately.
- `precision@12` — fraction of the 12 context blocks with grade ≥ 2.
- `hit@30` / `hit@12` — 1 if **any** gold entry (§3, Pool B) appears in that
  window, else 0.
- `MRR@30` — reciprocal rank of the first gold entry in the pool, 0 if absent.

## 3. The three pools

Reported separately, never averaged. Each carries a different bias, disclosed in
the ADR rather than presented as neutral.

### Pool A — real traffic (n=21)

Mined from `usage_log` (13) and Claude transcripts (8), committed verbatim with
provenance: source, timestamp, and the filters the agent actually passed
(`project`, `kind`, `limit`). Graded relevance judgements, §5.

**Filters are replayed on every run.** Four of the mined queries carry
`project=deepcast|assessor` or `kind=summary`. Relevance was judged under those
filters, so evaluating the query unfiltered would score it against the wrong
candidate universe.

**Classes are hand-assigned** for these 21 (§4's class list was derived by reading
them, so the labelling is already done) and committed. No LLM classification step,
so the class of a query never changes between runs.

**`eval mine` merges, never overwrites.** Queries are keyed by a hash of
`(query text, filters)`; re-running mining adds newly-seen queries and leaves
existing class labels and judgements untouched.

Bias: judged over a candidate pool that current retrieval and its variants
produced, so it favours what some configuration already finds. Mitigated by §5's
pooling, never eliminated.

### Pool B — corpus-derived known-item (n≈40)

Questions generated *from* known entries, so the gold answer is free and needs no
judge. This is where the statistical power comes from.

Stratified by source type — `doc`, `kdb_component`, `git_commit`,
`kdb_changelog`, and **`claude_session` deliberately included**, because
session-sourced questions are exactly the ones the session cap suppresses and
work item 2 is undecidable without them — crossed with the classes in §4.

**Lexical-leakage control.** A model asked to write a question from an entry
copies the entry's rare tokens, making the query trivially findable by the sparse
branch. That would inflate every number *and* bias against changes that improve
semantic matching. Two mitigations:

1. The generator is instructed to phrase the question as somebody who has *not*
   seen the entry would ask it, and forbidden from reusing identifiers, file
   names, or verbatim phrases longer than three words.
2. A leakage filter computes term overlap using `sparse.ts`'s own tokenisation —
   `|terms(Q) ∩ terms(E)| / |terms(Q)|` — and rejects a question above **0.6**.
   Threshold, per-question overlap and rejection rate are all recorded in the
   fixture, so the filter is auditable rather than trusted.

   The threshold itself is validated rather than asserted: **if the accepted
   questions were still leaking, sparse-only retrieval would find nearly all of
   them.** So the fixture-build step measures Pool B's `hit@30` under
   `mode=sparse-only`; a value near 1.0 means leakage survives and the threshold
   must come down. That number is committed alongside the pool, making 0.6 a
   measured starting point instead of a guess.

The generator is told which class (§4) and which source type to write for, so
Pool B's stratification and class labels are declarative, not inferred.

**Gold set = the source entry plus its dedupe-key siblings** (S2). `rerankForContext`
collapses near-duplicates keyed on `projectSlug|sourceType|title|occurredAt` and
keeps the *best-scoring* member, which may not be the entry the question was
written from. Scoring only the exact entry would systematically punish the
near-duplicate collapse Phase 3 shipped. Siblings are computed at fixture-build
time using the existing `dedupeKey`.

Bias: questions are synthetic, so their phrasing distribution is not an agent's.

### Pool N — verified negatives (n≈12)

Plausible questions with no answer in the corpus — domains absent from it (Kafka
consumer-group rebalancing, Stripe webhook idempotency). B4 must distinguish
`weak` from `none`, and with no negatives there is nothing to calibrate `none`
against.

**Absence is verified, not assumed:** each candidate negative is run through
hybrid *and* FTS retrieval and the judge confirms no hit is relevant. Anything
with a real answer is promoted into Pool A instead. That verification is what
makes them *known* negatives.

## 4. Query classes (evidence-driven)

`definitional`, `intent`, `temporal`, `incident`, `procedural`.

This **replaces** the parent spec's "what did session X conclude" class with
`incident`. The mined traffic contains 3 intent questions, 2–3 incident questions
("what root causes were found, what fixes were tried, what leads remain"), 2
temporal, and zero session-recap questions. Labelling a class nobody asks would
spend effort on a phantom. `definitional` and `temporal` still pull ranking in
opposite directions, which is the tension being tuned.

## 5. Judging

**Primary judge: `cline-pass/kimi-k3`, temperature 0.** Reuses `chatComplete`
with an overridden model — `chatComplete({...cfg.llm, model: JUDGE_MODEL}, …)` —
so there is no second HTTP client (§3.3 direct reuse).

**Candidate pooling (S9, corrected in implementation — I1).** For each Pool A
query the judged candidate set is the union of top-30 from three retrieval
**mechanisms**: hybrid RRF (what the product serves), Postgres FTS (pure lexical)
and dense-only (pure semantic).

Not across variants, as originally written. Every variant in §6 overrides
`RerankOptions`, which affects *context selection only* — the retrieval pool comes
from `SearchService.search()` and is byte-identical for all of them, so unioning
variant pools would have added nothing while looking thorough. What actually
widens the pool is a different mechanism with different blind spots.

**Presentation.** The judge sees question, and per candidate: type, project,
date, title, body truncated to 800 chars. It never sees rank or score — showing
the judge the ranking it is grading lets today's ranking bless itself. Candidates
are shuffled under a seed committed to the fixture.

**Rubric anchors, verbatim in the prompt (S8).** Each is a trap this corpus is
full of:

- A transcript where somebody *asks* this question and receives no answer is
  grade 0–1, never 3 — lexically perfect, informationally empty.
- An entry about a *different instance* of the same class (the 07-15 incident vs
  the 07-21 one) is 0.
- For temporal questions: in-window but unrelated subject is 0; about the
  in-window event but timestamped later is 3 — people record events after they
  happen (`20260725-ask-answer-trust-contract.md`).

Grades 0–3 with a ≤12-word reason. Only `entryId`, grade, reason and judge id are
stored; bodies are re-fetchable from the catalog.

**Resolution floor via κ.** A 25% subsample (~350 of ~1,470 labels) is re-judged
by `cline-pass/glm-5.2` (7s, different vendor). Full double-labelling is
unnecessary — 350 double labels estimate agreement well at 1.25× cost rather
than 2×.

Two methodological points that decide whether the number means anything:

- **Quadratic-weighted κ, not plain Cohen's κ.** The grades are ordinal, and
  plain κ treats a 2-vs-3 disagreement as severely as 0-vs-3. Weighted κ is the
  correct statistic for an ordered scale, and the harness reports the raw
  agreement matrix too so the claim is checkable.
- **The subsample is stratified by grade, not drawn uniformly.** Most of a
  70-candidate pool is irrelevant, so a uniform sample would be mostly grade-0
  and κ would be flattered by easy agreement on obvious negatives. Stratifying
  across the grade range (and across §4's classes) measures agreement where
  decisions actually live.

The resulting κ states the smallest metric difference the harness can honestly
resolve, and goes in the ADR.

**Human arbitration.** Only subsample disagreements — expected 30–60 items —
written to `arbitrate.md` for a human call, which then becomes gold. The harness
is usable before arbitration completes; κ is reported with arbitration pending.

### Retry and failure handling (§3.8, and heavy models flap)

Three layers, because a heavy model fails in two different ways:

1. **Transport.** `chatComplete`'s existing `retry: RetryOptions` — `withRetry`
   already classifies correctly (429/5xx/network retryable, other 4xx not,
   exponential backoff with jitter). Inner attempts capped at **2**.
2. **Semantic.** A malformed or truncated reply is a parse failure, not an HTTP
   error, so nothing retries it today. `RetryOptions` gains an optional
   `isRetryable?: (err) => boolean` (additive; default preserves behaviour
   exactly), and the judge wraps [call + parse] in an outer retry, capped at
   **3**, that also accepts `JudgeFormatError`. Retry #2+ appends a repair turn:
   *"your previous reply was not valid JSON; reply with only the array."*
   Caps are explicit because nested retries otherwise multiply to 25 attempts
   against a dead gateway.
3. **Give up honestly.** A candidate the judge could not label becomes
   `unjudged`. **Never grade 0** — grading an unlabelled candidate as irrelevant
   fabricates a label, which is the failure class this whole effort exists to
   remove.

**Unjudged candidates bound the metric instead of invalidating it (S5).** Every
metric is computed twice: optimistic (unjudged = grade 3) and pessimistic
(unjudged = 0). If an A/B decision holds under both bounds it stands; if it flips
the run prints **INCONCLUSIVE** and names `eval judge --top-up` as the remedy. No
invented percentage threshold.

## 6. Variants

| Name | Change | Question it answers |
|---|---|---|
| `baseline` | today's constants | reference; re-measured every run |
| `no-recency` | `RECENCY_MAX_BOOST = 0` | how much is the Phase 3 recency term actually doing? |
| `no-source-weight` | all weights 1.0 | how much is source weighting doing? |
| `relax-when-scoped` | session cap lifted when the question is time-scoped (`since`/`until` set, or `extractDateWindow` matched) | work item 2, option 2 |
| `cap-as-floor` | guarantee `floor = 4` of the 12 slots for non-session types, sessions take the rest | work item 2, option 3 — the most promising framing |

`floor` is a swept parameter (`--floor 2|4|6`), not a fixed constant: the point of
the harness is that the value gets chosen from measurements. `4` is the starting
point because it is what the current 50% cap yields in the common case where
authoritative hits exist, so `floor=4` isolates *removing the ceiling* from
*changing the guarantee*.

The two ablations exist because **"change nothing" is a legitimate outcome** for
work item 2, and it needs evidence that the existing levers earn their keep
rather than an assertion.

## 7. Runner, drift, and reproducibility

`eval run` measures the baseline variant **in the same process** as any candidate
and reports paired deltas. The committed baseline is for trend detection only.

**Why (S1).** Two absolute numbers from different runs conflate ranking change
with corpus growth — the index gained ~1,000 points during this design session.
Paired per-query deltas on identical queries extract far more signal at n=21 than
comparing aggregates. Reported as win/loss/tie counts plus mean Δ with a
**bootstrap 95% CI**: `+0.03 [95% CI −0.01, +0.07]` is a claim that can be
falsified; `0.64 → 0.67` is not.

The CI is a percentile bootstrap over the per-query deltas — 10,000 resamples,
fixed seed committed with the report so a number can be reproduced exactly. A CI
straddling zero means the harness cannot distinguish the variants on this query
set, which is a finding to report, not a result to round in the preferred
direction.

**Corpus fingerprint** stamped on every run and stored with the baseline: entry
count, `max(occurred_at)`, active collection name, embedder model+dim, judgement
fixture hash. A mismatch prints a drift banner.

**Reproducibility (S7).** `rerankForContext` calls `Date.now()` for recency, so
identical query + identical index ranks differently on a different day. The
options object gains an injectable `nowMs`, pinned by the harness to the
fingerprint timestamp. This also de-flakes the existing core tests.

**A degraded run refuses to write a baseline.** If `mode !== 'hybrid'` (embedder
down → sparse-only; Qdrant down → FTS) the score semantics differ entirely, and
recording that as a baseline would poison every later comparison. `eval baseline`
aborts; `eval run` proceeds but stamps the report `DEGRADED`.

**Zero LLM calls.** `make eval` is retrieval + rerank + metrics only — fast,
deterministic and free. Judging is a separate, explicit command.

**Concurrency.** 4 queries in flight. Ollama serialises embeddings (see
`workerConcurrency`'s comment), so more just queues. The run records whether an
`index_runs` row was open, since a live scan competes for the embedder — that
skews latency, not ranking, and saying so beats an unexplained slow run.

**Budget**, measured rather than estimated:

| Step | Cost | Notes |
|---|---|---|
| `eval run`, one variant | ~45s for 21 queries (~2.2s each) | no LLM calls; ~2.5 min for all 73 |
| `eval run --variant`, A/B | ~2× the above, one process | |
| `eval signals` | ~40s for 21 queries | one extra dense query per query |
| `eval generate` | **~45 min** | 40+ sequential reasoning-model calls at 25–40s each, plus 12s per FTS probe for the leakage validation. One-off |
| `eval judge` | ~60 calls per full pass | rerun only via `--top-up` |

Generation and judging are sequential on purpose — the gateway is shared with the
indexer's embedder and with whatever else is using it, and a fixture built once
does not justify saturating it.

## 8. Signal panel — what actually unblocks B4 (S4)

`eval signals` records, per query across all three pools, with **no bands and no
thresholds**:

- the fused RRF score **at rank 1 and at rank 5** (expected to be uninformative —
  that is the finding);
- **top-1 dense cosine** from a separate dense-only query, the recommended B4
  mechanism (parent spec option A);
- **mean lexical overlap over the top 5** — fraction of the query's content terms
  present in each hit, `sparse.ts` tokenisation (option C);
- **top-1 ÷ median-of-top-30 fused score** (option B);
- per-branch prefetch scores **if** Qdrant v1.18.2 returns them — the parent spec
  says to verify this before assuming a second query is needed, so the harness
  tests it and records the answer.

Output is a per-pool distribution table. Pool N is the load-bearing row: a signal
that does not separate Pool N from Pool A/B cannot support a `none` band, and
proving that about RRF is the point.

This is measurement, not B4. Nothing is surfaced on `RetrievalReport`, no
boundary is drawn, no product behaviour changes.

## 9. Source changes (blast radius, §1.3)

| Change | File | Why | Regression risk |
|---|---|---|---|
| `rerankForContext(pool, k, opts?)` — options for source weights, session fraction, recency params, `nowMs`; defaults exported and byte-identical to today's constants | `packages/core/src/ask.ts` | a variant must be data, not a code edit | Pinned by a test asserting defaults reproduce current output exactly |
| `AskService.retrieve()` → public `retrieveForContext(question, filters, k, rerank?)`, returning `{ hits, pool, scopeFallback, mode, degraded }` | `packages/core/src/ask.ts` | §3.4: the harness must measure the product's exact path — the pool formula `min(max(k*3,24),60)`, scope widening, `mode`/`degraded`. Reimplementing it guarantees future divergence | Visibility + additive return field; production callers pass no `rerank` and ignore `pool` |
| `RetryOptions.isRetryable?` | `packages/core/src/retry.ts` | retry malformed judge replies without message-pattern hacks | Additive; default unchanged |
| Log the `/api/ask` question | `packages/api/src/app.ts` | **all 8 ask calls recorded an empty query** — the most valuable class of real traffic is invisible, so without this the query set is frozen at 21 forever | Truncated to the column's 500 chars; UI traffic still excluded by the client-header rule |

The fourth is the one item beyond Deliverable 0. It is included deliberately: a
mined query set that cannot grow makes the harness a one-off measurement instead
of a standing instrument.

Three further core changes were **not** foreseen and are recorded here rather than
absorbed silently. The first two are bug fixes the harness surfaced (§11c):

| Change | File | Why | Regression risk |
|---|---|---|---|
| `ftsQuery()` — OR the query terms via `tokenize` instead of `websearch_to_tsquery`'s implicit AND | `catalog.ts` | the Qdrant-down fallback returned 0 hits for every multi-word query and reported it as an empty index (I2) | Changes degraded-path behaviour from "nothing" to "ranked results". Pinned by `test/core/ftsQuery.test.ts`, incl. that no `to_tsquery` operator can survive tokenisation |
| `EmptyCompletionError` — reject an empty completion instead of returning `''` | `llm.ts` | a truncated reasoning model was reported as a successful blank answer (I3) | Ask now takes its LLM-unavailable branch (sources + explanation) instead of rendering a blank answer as healthy — strictly more honest |
| `VectorStore.queryDense()` | `qdrant.ts` | §8 needs a raw cosine; the fused query returns only RRF scores and Qdrant reports no per-branch score | Additive; no production caller |

Also touched: `package.json` workspaces + build script, `tsconfig.lint.json`
(otherwise `packages/eval` is never type-checked), `Makefile`.

## 10. Tests (§3.6.1)

**New**, deterministic, no network, under `test/eval/`:

| File | Scenarios |
|---|---|
| `metrics.test.ts` | nDCG@10 against hand-computed values; ties; all-zero gains; fewer than 10 hits; graded vs binary; MRR; recall@30; bootstrap CI on a known distribution; Cohen's κ on hand-built agreement matrices incl. perfect and chance-level |
| `pools.test.ts` | fixture schema validation; leakage filter rejects a question copied from its source entry and accepts a paraphrase; dedupe-sibling gold expansion; unjudged detection; optimistic/pessimistic bounds flip a decision |
| `judgeParse.test.ts` | clean JSON; fenced JSON; trailing prose; partial array; malformed → `JudgeFormatError` **and not grade 0**; repair turn appended on retry; retry caps respected |
| `variants.test.ts` | each variant changes rerank output as intended; **defaults reproduce today's constants exactly** (the regression guard for §9's first row); `nowMs` injection makes recency deterministic |

**Modified:** `test/core/rerankForContext.test.ts` (defaults unchanged, `nowMs`
injected), `test/core/retry.test.ts` (`isRetryable`), `test/api/routes.test.ts`
(ask question logged and truncated).

**Live smoke**, outside `make test` because it needs the stack: `make eval` over
3 queries, asserting `mode=hybrid` and a non-empty report.

## 11. Design review findings folded in

| # | Finding | Resolution |
|---|---|---|
| S1 | Pool A per-class nDCG is noise at n≈4 | paired deltas + bootstrap CI; per-class claims at n<8 marked indicative (§7) |
| S2 | Pool B would punish Phase 3's dedupe | gold = entry + dedupe-key siblings (§3) |
| S3 | Measurement stage unspecified | two stages, both always reported (§2) |
| S4 | Pool N's RRF signal is useless → B4 still blocked | signal panel incl. dense cosine (§8) |
| S5 | 5% unjudged threshold was invented | optimistic/pessimistic bounds (§5) |
| S6 | Harness would reimplement Ask's retrieval | `retrieveForContext()` made public (§9) |
| S7 | `Date.now()` makes runs irreproducible | injectable `nowMs` (§7) |
| S8 | Judge rubric underspecified for this corpus | three verbatim anchors (§5) |
| S9 | Pooling inherits dense retrieval's blind spots | FTS path added to the pool (§5) |
| S10 | Over-built surface | cut `eval compare` and per-pool targets; added ablation variants (§6) |
| S11 | nDCG is not answer quality | stated limitation; decision procedure includes reading real Ask answers (§12) |

### 11b. Spec review findings folded in

A second pass over the written spec found twelve more, three of them genuine
inconsistencies rather than omissions:

| # | Finding | Resolution |
|---|---|---|
| SR1 | `retrieveForContext()` as specified could serve neither stage — it returned only the reranked k, and took no rerank override, so variants were unreachable through it | signature returns `{hits, pool, …}` and accepts `rerank?` (§9, §2) |
| SR2 | Plain Cohen's κ on ordinal 0–3 grades treats 2-vs-3 as badly as 0-vs-3 | quadratic-weighted κ + raw agreement matrix (§5) |
| SR3 | A uniform κ subsample would be mostly grade-0 and κ flattered by easy negatives | stratified by grade and class (§5) |
| SR4 | Pooling text double-counted `baseline` as both baseline and variant | wording fixed (§5) |
| SR5 | Leakage threshold was unspecified | 0.6, plus a sparse-only `hit@30` check that validates it empirically (§3) |
| SR6 | `hit@30`, `recall@30`, `precision@12`, top-5 RRF, lexical overlap were all undefined | defined explicitly (§2, §8) |
| SR7 | `cap-as-floor`'s N was unspecified | `floor=4`, swept `2|4|6`, with the reason 4 is the neutral starting point (§6) |
| SR8 | Bootstrap method unspecified | percentile bootstrap, 10,000 resamples, committed seed (§7) |
| SR9 | Mined queries carry filters; ignoring them scores against the wrong universe | filters replayed every run (§3) |
| SR10 | Class assignment mechanism unstated | hand-assigned for A, declared by the generator for B (§3) |
| SR11 | Re-running `eval mine` could clobber labels | merge by `(query, filters)` hash, never overwrite (§3) |
| SR12 | Nothing said how queries with zero relevant entries affect the nDCG mean | excluded and counted separately (§2) |

### 11c. Corrections forced by implementation

Findings that only appeared once the harness ran against the live stack. The first
three are defects in Atlas, not in the harness — each rendered a failure as a
plausible result, which is why no existing test caught them.

| # | Finding | Resolution |
|---|---|---|
| I1 | Pooling "across variants" is degenerate — variants change context selection only, so every variant's retrieval pool is identical | pool across three *mechanisms*: hybrid ∪ FTS ∪ dense-only (§5) |
| I2 | **`ftsSearch` returned 0 hits for any multi-word query.** `websearch_to_tsquery` ANDs terms: a 6-term query matched 0 entries where `worker pool resize` matched 31 and `supervisorctl` matched 182. This is the Qdrant-down fallback, and it returned `{hits: [], mode: 'fts'}` — a broken fallback reading as "the index holds nothing" | `ftsQuery()` ORs terms from `tokenize`, the sparse branch's own tokeniser. Verified live: 0 → 30 relevant hits. Cost logged to backlog (~12s/query) |
| I3 | **`chatComplete` returned `''` for a truncated completion.** A reasoning model spends completion tokens thinking first, so kimi-k3 at `max_tokens: 200` returns `finish_reason: length` and an empty string; at 800 it returns a 492-token answer. The empty string was reported as success — on the Ask path, a blank answer marked healthy | throws `EmptyCompletionError` naming the finish reason; the harness escalates its token budget per retry |
| I4 | Retrying a truncated request unchanged can never succeed — observed as 45 consecutive empty completions | retry **escalates** `max_tokens` (×2/attempt) rather than repeating |
| I5 | `precision@12` printed `0.000` for a never-judged query while `nDCG`/`recall` printed `—`, reading as "nothing relevant was retrieved" | a query with no labels at all scores `null` on every metric (§2) |
| I6 | Asking a reasoning model for 18 negatives in one call exceeded `chatComplete`'s 120s ceiling every time | negatives generated in batches of 4, each themed to a different absent domain |

## 12. Implementation sequence

Ordered so nothing is blocked and each step is independently verifiable:

1. **Core changes** (§9 rows 1–3) + their tests. Ends with `make test` green and
   defaults provably unchanged.
2. **`packages/eval` skeleton**: `metrics.ts`, `pools.ts`, `variants.ts` + unit
   tests. Pure functions, no stack needed.
3. **`eval mine`** → Pool A, 21 queries with provenance and hand-assigned classes.
4. **`/api/ask` question logging** (§9 row 4) so the pool grows from here on.
5. **`eval generate`** → Pool B with leakage filter + sparse-only validation, and
   Pool N with absence verification.
6. **`eval judge`** → kimi-k3 pass, glm-5.2 subsample, weighted κ, `arbitrate.md`.
7. **`eval run`** → per-stage/per-class metrics, paired deltas, bounds, drift and
   degradation banners; `eval baseline` records the committed baseline.
8. **`eval signals`** → the B4 calibration panel, including the v1.18.2
   prefetch-score question.
9. **Makefile targets, ADR, KDB entries, changelog.**

## 13. Definition of done

- [ ] `packages/eval` committed, type-checked by `make lint`, built by `make build`.
- [ ] `test/fixtures/eval/queries.json` — 21 Pool A with provenance, ~40 Pool B
      with gold sets and leakage stats, ~12 verified Pool N.
- [ ] `judgements.json` — Pool A graded by kimi-k3, κ from the glm-5.2 subsample
      recorded, `arbitrate.md` generated.
- [ ] `baseline.json` — committed baseline with corpus fingerprint, from a
      non-degraded run on current `main`.
- [ ] `make eval` prints per-pool, per-class, per-stage metrics plus paired
      deltas against the in-run baseline, with drift and degradation banners.
- [ ] `make eval VARIANT=<name>` runs an A/B in one process.
- [ ] `eval signals` output recorded, including whether v1.18.2 returns prefetch
      scores.
- [ ] New and modified tests pass; `make test` unchanged in scope (no network).
- [ ] ADR: the three-pool design, each pool's bias, the κ resolution floor, and
      the explicit statement that bootstrapped judgements are not neutral.
- [ ] KDB component entry per §2.2; changelog lines per §2.4.

**Not done here, by design:** no B4 field, no bands, no ranking change. The
source-mix decision is a later change that *uses* this harness and records
per-class before/after numbers — including if the decision is "change nothing".

## 14. Stated limitations

1. **Judgements bootstrapped from current retrieval are not neutral.** Pooling
   across five variants plus FTS mitigates it; it does not remove it. The ADR
   says so rather than presenting the numbers as objective.
2. **n=21 real queries is small.** Pool B carries the statistical weight; Pool A
   is the closest thing to product truth and is reported as such.
3. **Pool B's phrasing is synthetic** and systematically unlike an agent's, even
   after leakage filtering.
4. **nDCG is a proxy for answer quality, not answer quality.** The harness makes
   no LLM calls. For any decision to change ranking, read the actual Ask answers
   for the 3–5 queries whose context window changed most.
5. **The corpus moves under the harness.** Fingerprints and in-run baselines
   handle it; a months-old committed baseline is still only a trend indicator.
6. **The fixtures embed project-identifying text** (real queries name real
   systems). The repo must stay private.
