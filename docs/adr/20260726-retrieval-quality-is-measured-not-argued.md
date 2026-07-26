# ADR: Retrieval Quality Is Measured Against Committed Judgements, Not Argued
Date: 2026-07-26

## Status
Accepted

## Context

`20260725-ask-answer-trust-contract.md` established the principle that Atlas may
state only what it has measured. Three phases of retrieval work then shipped
under that principle — grounded coverage, degradation propagation, a recency term,
near-duplicate collapse — and two items were deliberately left undone:

- **B4**, a calibrated relevance signal, so that "found nothing *relevant*" becomes
  expressible. RRF fusion scores are rank-based rather than similarities, so no
  threshold on them was believed to mean anything. (Measurement later refined this
  — see "First result".)
- **The source mix**, specifically whether `MAX_SESSION_FRACTION = 0.5` is still
  right now that ranking has a time term.

Both were deferred for the same reason: **nothing in the repository could measure
whether a retrieval change made things better or worse.** Every existing test
asserts mechanics — this weight is applied, this duplicate collapses — on
synthetic fixtures. None asserts quality. Shipping a threshold or a weight change
on intuition would have contradicted the principle the rest of the work
established.

Two facts made this worse than a missing convenience:

- The corpus is **90.4% `claude_session`** (292,757 of 323,825 entries). Any
  change to how sessions are weighted or capped moves almost everything, and the
  direction is not guessable.
- The mineable query set is **21 real queries**, not the 30–50 assumed when the
  work was scoped. `usage_log` holds 94 rows with a query, of which 60 are
  `burst N` load tests and 20 are `qdrant quantization concurrency N`; and every
  `atlas_ask` call had recorded an **empty** query, because ask is a POST and only
  the URL was ever logged. Transcripts add 8 distinct questions, almost all
  overlapping.

21 queries is ~4 per class. A single query swings such a class by a quarter.

## Decision

Build the measuring instrument first, and design it so that it cannot flatter a
change.

**Three query pools, reported separately and never averaged.** Each has a
different bias, and mixing them would let a change that helps one and hurts
another read as neutral.

| Pool | n | Ground truth | Bias |
|---|---|---|---|
| A — real agent traffic | 21 | graded 0–3 by an LLM judge | judged over candidates that some configuration already found |
| B — corpus-derived known-item | ~40 | the entry the question was written from | synthetic phrasing, unlike an agent's |
| N — verified negatives | ~12 | no relevant entry exists | absence is verified by retrieval + judge, not assumed |

**Two measurement stages, always both.** The deferred items live at different
places in the pipeline, and conflating them would make one of them unmeasurable:

- *retrieval* — the over-fetched pool from `SearchService.search()`; `recall@30`.
- *context* — the k blocks `rerankForContext()` selects, which is what Ask
  synthesises from; `nDCG@10`, `precision@12`.

`MAX_SESSION_FRACTION` cannot change the retrieval pool at all. A harness that
measured only one stage would have reported the source-mix question as either
unmeasurable or trivially flat.

**Paired deltas with a bootstrap interval, not two absolute numbers.** Both
variants run over the same queries in the same process, and the report gives
per-query win/loss/tie counts and a mean delta with a percentile bootstrap 95% CI
(10,000 resamples, committed seed). At n=21 the per-query difference cancels most
of the variance; comparing aggregate means would need far more queries to see the
same effect. `+0.03 [95% CI −0.01, +0.07]` is falsifiable. `0.64 → 0.67` is not.

**The baseline is re-measured every run.** The committed baseline is a trend
marker only. The index grows every five minutes — it gained ~250 entries during
the session that built this — so a diff against a stored number folds corpus
growth into the delta and reports it as a ranking improvement.

**Unjudged candidates bound the metric rather than invalidating the run.** Every
metric is computed twice: optimistically (unlabelled = grade 3) and
pessimistically (unlabelled = 0). A conclusion that survives both stands; one that
flips prints INCONCLUSIVE and names `eval judge --top-up`. The alternative — "more
than N% unjudged is invalid" — would have been an invented threshold in a project
whose entire thesis is that invented numbers are the bug.

**An unlabelled candidate is never graded 0.** It is recorded as `unjudged`.
Scoring it as irrelevant fabricates a label, and every metric is a function of
these labels.

**Judging.** `cline-pass/kimi-k3` grades every pooled candidate at temperature 0;
a grade-stratified 25% subsample is re-judged by `cline-pass/glm-5.2`, giving a
quadratic-weighted κ. Weighted, because the grades are ordinal and plain κ would
treat a 2-vs-3 disagreement as harshly as 0-vs-3, understating agreement and so
overstating how small a difference the harness can resolve. Stratified by grade,
because most of a candidate pool is irrelevant and a uniform sample would measure
agreement on obvious negatives.

The judge never sees rank or score, and candidates are shuffled under a committed
seed. A judge shown the ranking it is grading would let the current ranking bless
itself.

**Candidates are pooled across retrieval mechanisms, not variants.** Every
variant here overrides `RerankOptions`, which only affects context selection — the
retrieval pool is byte-identical for all of them, so unioning variant pools would
add nothing while looking thorough. The pool is hybrid RRF ∪ Postgres FTS ∪
dense-only: three mechanisms with different blind spots.

**Ranking knobs became injectable.** `rerankForContext(pool, k, opts?)` takes
source weights, session fraction, an alternative slot floor, recency parameters
and an injectable clock, all defaulting to the shipped constants. Without this a
variant is a source edit plus a container restart, one at a time — which is why
the session-cap question survived three phases unanswered.

## Consequences

- Positive: both deferred items become decidable, with numbers that can be
  reproduced from committed fixtures.
- Positive: `make eval` makes **zero LLM calls** — retrieval, rerank and metrics
  only — so it is free, deterministic, and can run on every change. The two steps
  that cost money are separate commands.
- Positive: three real defects surfaced while building it, none of which any
  existing test could have caught. See "Found by building this".
- Positive: `rerankForContext`'s injectable clock makes runs reproducible and
  removes wall-clock dependence from the existing tests.
- Negative: the harness needs the live stack, Ollama and the LLM gateway, so it
  cannot run in CI as configured. Its unit tests do run in `make test`; the
  measurement does not.
- Negative: the two LLM steps are slow, measured rather than guessed — building
  Pools B and N took ~45 minutes and a full judging pass ~50, because the judge is
  a reasoning model answering sequentially and each Postgres FTS probe costs ~12s.
  Mitigated by keeping both out of `eval run` (which stays at ~45s and free) and
  by `--top-up`. Sequential on purpose: the gateway and the embedder are shared
  with the indexer, and a fixture built once does not justify saturating them.
- Negative: one more workspace to build and type-check.
- Operational: the fixtures embed project-identifying text — real queries name
  real systems — so the repository must remain private.

### Found by building this

Three defects the harness exposed, each invisible to the existing suite because
each rendered a failure as a plausible result:

1. **`ftsSearch` returned nothing for any multi-word query.**
   `websearch_to_tsquery` ANDs every term, so
   `worker pool resize procedure supervisorctl stopwaitsecs` became a six-way
   conjunction matching **0** entries, while `worker pool resize` matched 31 and
   `supervisorctl` alone matched 182. This is the fallback used when Qdrant is
   unreachable, and `search()` returned `{ hits: [], mode: 'fts' }` — a broken
   fallback indistinguishable from an index that holds nothing on the subject.
   Fixed by OR-ing terms from `tokenize`, the sparse branch's own tokeniser, so
   the two keyword paths cannot disagree about what a term is. Verified live:
   0 hits → 30 relevant hits.
2. **`chatComplete` returned `''` for a truncated completion.** A reasoning model
   spends completion tokens thinking before emitting content, so `max_tokens`
   sized for the visible answer yields `finish_reason: "length"` and an empty
   string. Measured on kimi-k3: 200 tokens → empty, 800 → a 492-token answer.
   The empty string was returned as a successful result, which on the Ask path is
   a blank answer reported as healthy. Now throws `EmptyCompletionError` naming
   the finish reason. The harness escalates its token budget on retry, because
   repeating an identical truncated request cannot succeed — learned by watching
   45 consecutive empty completions.
3. **Ask questions were never recorded.** Every `atlas_ask` row in `usage_log`
   had an empty query. Fixed, so the real query pool grows from here instead of
   being frozen at 21.

### First result: the B4 calibration data, and a correction

The signal panel was run over all three pools. It refines a claim this ADR made in
its own Context section, so the correction is recorded here rather than quietly
edited away.

| signal | A — real traffic (n=21) | B — known-item (n=40) | N — unanswerable (n=12) |
|---|---|---|---|
| `rrf@1` | 0.500–1.000, p50 0.700 | 0.333–1.000, p50 0.507 | **all twelve exactly 0.500** |
| `cosine@1` | 0.696–0.877, p50 0.781 | 0.676–0.845, p50 0.745 | 0.633–0.711, p50 0.693 |
| lexical overlap (top-5) | 0.136–0.733, p50 0.311 | 0.046–0.400, p50 0.187 | 0.000–0.111, p50 0.070 |

**The correction.** "RRF scores carry no absolute relevance" was taken from the
parent spec and repeated above; the stronger form of it — that a hopeless query
and a perfect match produce the same top score — is **false**. Every unanswerable
query scored exactly 0.500, and 20 of 21 real queries scored higher. The fused
top-1 value encodes *cross-branch agreement*: when the dense and sparse branches
both rank a document first their reciprocals add (0.75, 0.83, 1.0), and when the
branches agree on nothing — which is what happens when the index holds no answer —
the top hit carries a single branch's contribution alone. That is a real signal,
and it is not a similarity.

**It is nevertheless unusable on its own, and Pool B is what proves it.** Eighteen
of forty questions that are answerable *by construction* also score exactly 0.500.
Judged only against A-versus-N, a 0.500 threshold looks 97% accurate; add Pool B
and its precision as a "nothing relevant" detector falls to roughly 39%. A
two-pool harness would have shipped that number with a straight face. This is the
clearest vindication of the three-pool design in the whole exercise.

**Where that leaves B4.** No single signal separates cleanly:

- `cosine@1` is the theoretically right shape — comparable across queries — but the
  distributions are narrow and adjacent (N tops out at 0.711, A starts at 0.696),
  giving 94% on A-vs-N and misclassifying 25% of Pool B.
- Lexical overlap separates A from N *perfectly* (no overlap at all, 100% at a
  0.111 threshold) and misclassifies 15% of Pool B — the best of the three, and
  the opposite of the parent spec's expectation that it would serve only as a
  secondary check.
- Their errors are on different queries, so a **combination** is the promising
  direction rather than any single threshold.

One bias must be stated with these numbers: Pool B's questions were deliberately
paraphrased away from their source entries and then leakage-filtered, which makes
them adversarially hard for a *lexical* signal specifically. Pool A is real
traffic and shows much higher overlap. The true operating characteristic therefore
sits somewhere between the two pools, and B4 must not quote the Pool A figure
alone.

**Two mechanical facts B4 needs, both measured rather than assumed.**

Qdrant v1.18.2 returns only `id`, `payload`, `score` and `version` for a fused
query — **no per-branch scores at all**. The parent spec asked that this be
verified before assuming a second query is needed; it is needed, which is why
`VectorStore.queryDense()` exists.

The same probe confirms the branch-agreement explanation independently. Issuing a
fused query with a deliberately non-matching sparse vector — so the sparse branch
can contribute nothing — returns a top score of **exactly 0.5**, with the tail at
1/3 and 1/4. A single-branch contribution is 0.5, which is precisely the value all
twelve unanswerable questions produced, from precisely that cause.

No band is drawn and nothing is surfaced. That is B4's decision, and it now has
data to make it from.

### Second result: the source mix, measured

The harness's first job was the question it was built for. Baseline over Pool A
(21 queries, 1,182 labels, 0 unjudged, κ 0.802 → differences below ~0.10 are label
noise):

| class | n | nDCG@10 | precision@12 | recall@30 |
|---|---|---|---|---|
| definitional | 7 | 0.694 | 0.583 | 0.766 |
| incident | 5 | 0.623 | 0.500 | 0.645 |
| intent | 4 | 0.748 | 0.521 | 0.858 |
| procedural | 2 | 0.573 | 0.500 | 0.700 |
| temporal | 3 | 0.617 | **0.361** | 0.781 |
| all | 21 | 0.665 | 0.512 | 0.751 |

Temporal questions have by far the worst *context* precision while their *pool*
recall is among the better figures. The relevant material is retrieved and then
dropped before synthesis — which is the shape the source-mix complaint predicted,
and it is now visible rather than argued.

Two of the parent spec's candidate fixes were then measured, paired, over Pools A
and B:

- **`relax-when-scoped` (option 2) is a no-op.** 0W/0L/21T on Pool A nDCG and
  nothing at all on Pool B. Its trigger is `extractDateWindow` matching the
  question or an explicit `since`/`until`, and that fires on almost nothing — even
  Pool B's nine temporal questions carry no parseable date. If the idea is worth
  keeping, the trigger has to be temporal *intent*, not a parsed date.
- **`cap-as-floor` (option 3) is not distinguishable from baseline.** At
  `floor = 4` every interval includes zero, and the movement that exists trends
  slightly negative (Pool A precision −0.012 [−0.024, +0.000], Pool B hit
  −0.025 [−0.075, +0.000]). Note the direction: `floor = 4` at k = 12 permits
  eight session blocks where the 0.5 cap permits six, so it is a *relaxation* —
  and relaxing did not help, which is consistent with the reasoning that put the
  cap there.

Sweeping the floor in the other direction is the result worth recording.
`floor = 8` at k = 12 permits only **four** session blocks, a *tighter* guarantee
than the shipped cap's six, and it trends positive:

| comparison | Δ | 95% CI | W/L/T |
|---|---|---|---|
| A/temporal nDCG@10 | **+0.045** | [−0.008, +0.086] | 2W/1L/0T |
| A/temporal precision@12 | +0.028 | [+0.000, +0.083] | 1W/0L/2T |
| A/all nDCG@10 | +0.008 | [−0.003, +0.021] | 3W/3L/15T |
| B/all hit@12 | +0.025 | [+0.000, +0.075] | 1W/0L/39T |

**This points the opposite way to the premise the work item was written on.** That
premise was that the 50% cap is "a recency penalty wearing a source-quality
costume" and should be relaxed for temporal questions. On this evidence relaxing
it is slightly harmful and *tightening* it is slightly helpful — most helpful on
temporal questions, the very class the premise was about. The plausible reading is
that sessions crowd out better-typed material even when the question is about last
week, because the answer is usually the commit or the log entry rather than the
conversation around it.

Every interval still includes zero, and +0.045 is below the κ-derived noise floor
of ~0.10.

**So the source-mix decision, on this evidence, is to change nothing** — which the
parent spec listed as a legitimate outcome requiring evidence rather than
assertion. That evidence now exists. What has also changed is the shape of the
open question: it is no longer "should the cap be loosened for temporal questions"
but "is the cap too loose in general", and the harness can answer that once the
query set grows. `/api/ask` now records questions, so it will.

One structural result is worth naming: `recall@30` came back +0.000 with 0W/0L in
every class of every variant. That is not a null finding but a validation —
`RerankOptions` provably cannot reach the retrieval pool, so a harness measuring
only one stage would have been blind either to the variants' whole effect or to the
fact that retrieval was untouched.

## Alternatives Considered

- **Judge nothing; compare variants by eyeballing a few favourite queries.**
  Rejected: it is how the current weights earned their reputation for being
  arbitrary, and it is trivially easy to find a query favouring either side.
- **Use only the 21 real queries.** Rejected: ~4 per class cannot support a
  per-class comparison, and there are no negatives, so B4's `none` band would have
  had nothing to calibrate against. Pool A is kept as the closest thing to product
  truth and reported as such.
- **Generate the whole query set synthetically.** Rejected: the phrasing
  distribution is not an agent's, and a set with no real traffic in it measures the
  generator's idea of a question.
- **Judge with the model that serves Ask (`gemini-2.5-flash`).** Rejected: it is
  the model whose judgement failed in the incident this work descends from, and a
  cheap judge is a false economy when every metric derives from its labels.
- **Have the synthesiser rate its own confidence for B4.** Rejected in the parent
  spec and still rejected: it is exactly the judgement the model failed at, and it
  produces an unfalsifiable number for the price of a second call.
- **A fixed "unjudged > 5% is invalid" gate.** Rejected: an invented threshold.
  The optimistic/pessimistic bound is derived from the data and strictly more
  honest.
- **Run the harness in a container.** Rejected: `docker/node.Dockerfile` copies
  source in, so every harness edit would need an image rebuild, and a variant A/B
  in one process would be impossible.

## References
- Spec: `docs/superpowers/specs/2026-07-26-retrieval-eval-harness-design.md`
- Parent spec (B4 + source mix): `docs/superpowers/plans/2026-07-26-retrieval-confidence-and-source-mix-spec.md`
- Trust contract this extends: `20260725-ask-answer-trust-contract.md`
- Ranking decision the recency term must not reverse: `20260710-docs-staleness-query-time.md`
- KDB: `kdb/components/atlas.log`, entry of 2026-07-26
