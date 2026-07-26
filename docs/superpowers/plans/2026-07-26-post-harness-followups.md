# Spec: What To Do With What The Eval Harness Found
2026-07-26 14:10 UTC

## Revision History

| Date (UTC) | Change |
|---|---|
| 2026-07-26 14:10 | Initial spec. Written as a self-contained handoff for a later session. |

---

## How to use this document

This is a **prompt for a future session**. It assumes no memory of the work that
produced it. Everything needed is either here or named by path.

Read first, in this order:

1. `docs/adr/20260726-retrieval-quality-is-measured-not-argued.md` — the harness,
   its three pools, and both of its first results. **This is the important one.**
2. `docs/superpowers/specs/2026-07-26-retrieval-eval-harness-design.md` — the
   harness design, including §11/§11b/§11c which record every review finding and
   every correction implementation forced.
3. `docs/superpowers/plans/2026-07-26-retrieval-confidence-and-source-mix-spec.md`
   — the parent spec that asked for B4 and the source-mix work. Its framing of the
   source-mix question is now **known to be pointing the wrong way** (see item 4).
4. `kdb/components/atlas.md`, the two entries of 2026-07-26.

**Verify before trusting.** Every number in this document was measured on
2026-07-26 against a live index of ~324,300 entries. The index grows every five
minutes and the fixtures may have been regenerated since. Re-run `make eval` and
compare against `test/fixtures/eval/baseline.json` before acting on any figure
here.

## The instrument you have

```
make eval                        # ~45s, zero LLM calls, deterministic
make eval VARIANT=cap-as-floor FLOOR=8 POOL=A,B    # paired A/B in one process
make eval-mine                   # refresh Pool A from usage_log + transcripts
make eval-generate POOL_B=40 POOL_N=12   # ~45 min, costs LLM calls
make eval-judge TOP_UP=1         # ~40 min, costs LLM calls
make eval-baseline               # refuses if retrieval was degraded
make eval-signals                # B4 calibration panel
```

Fixtures in `test/fixtures/eval/`: `queries.json` (21 real + 40 known-item + 12
negatives), `judgements.json` (1,182 labels, 0 unjudged, quadratic-weighted
κ 0.802), `baseline.json`, `signals.json`, `arbitrate.md`.

**The κ implies a resolution floor of ~0.10.** Any metric difference smaller than
that is label noise on this fixture. Do not act on a smaller delta without first
increasing statistical power (item 4) or label quality (item 5).

---

## Item 1 — The three defects: fixed. A fourth: not.

**Answering the question directly: yes, all three are fixed, tested and pushed.**

| Defect | Fix | Test |
|---|---|---|
| `ftsSearch` returned 0 hits for any multi-word query (`websearch_to_tsquery` ANDs terms) | `ftsQuery()` in `packages/core/src/catalog.ts` ORs terms from `tokenize` | `test/core/ftsQuery.test.ts`; verified live 0 → 30 relevant hits |
| `chatComplete` returned `''` for a truncated completion and reported success | `EmptyCompletionError` in `packages/core/src/llm.ts`, naming `finish_reason` | `test/core/llmComplete.test.ts` |
| Every `atlas_ask` question logged as an empty query | `usageQuery` context slot in `packages/api/src/app.ts` | `test/api/routes.test.ts` |

**The fourth, still open — `askStream` has the same blank-answer hole
`chatComplete` just lost.** `chatComplete` now throws when a completion is empty,
so Ask takes its LLM-unavailable branch and returns sources plus an explanation.
`askStream` uses `chatStream`, which yields content deltas: if a reasoning model
truncates before emitting any content, the stream completes with **zero deltas**,
the UI renders an empty answer beside real sources, and `done` reports
`degraded: false`. A failure presented as a healthy result — the exact class the
trust contract exists to eliminate, and the UI path is the one a human sees.

**Do this.** In `AskService.askStream` (`packages/core/src/ask.ts`), track whether
any delta was yielded. If the stream ends having yielded none, emit the same
fallback text the catch branch uses and report `degraded: true`. Keep it in
`askStream` rather than `chatStream`: the generator is a transport and has no
opinion about what an empty answer means, whereas Ask does.

Test scenarios: a stream that yields nothing then ends; a stream that yields one
empty-string delta; a stream that yields content then ends (must stay
`degraded: false`); a stream that throws mid-way (existing behaviour, must not
regress).

Small, self-contained, no dependencies. Do it first.

---

## Item 2 — FTS costs ~12s/query

`ftsSearch` now returns results, but each query takes ~12s against 324k entries.
This is the fallback taken when Qdrant is unreachable, so it is a real user-facing
latency when it matters most.

**Root cause is worth stating before choosing a fix.** The `fts` column is
`to_tsvector('english', left(title || ' ' || body, 200000))` — up to 200 KB of
text per entry. Matching is index-driven and fast (GIN on `fts`). The cost is
`ts_rank`, which must fetch and score each matching row's tsvector, and an OR
query over content terms matches tens of thousands of rows.

Candidate approaches, none obviously right:

1. **Cap the ranked candidate set.** Match via the index, take a bounded candidate
   pool, rank only those. Fast, but the bound is arbitrary and can drop the best
   hit — dishonest for a search path unless the bound is generous enough to be
   shown harmless.
2. **Shrink the ranking vector.** A second, truncated tsvector (say 8 KB) used
   only for `ts_rank`, with matching still against the full one. Costs a generated
   column and a rewrite of 324k rows; changes ranking, not recall.
3. **Drop very common terms from the OR.** A term matching 100k rows contributes
   almost nothing to ranking and dominates the cost. Needs document frequencies,
   which Postgres does not make cheap.
4. **Accept it, but bound it.** Add a `statement_timeout` so a degraded search
   cannot hang the API, and surface the timeout as a distinct mode rather than as
   an empty result. Correctness-preserving, and it stops the worst case.

**Recommendation: do (4) first, then measure (1) or (2) with the harness.** (4) is
small and removes the risk of an unbounded hang. Then note the thing that makes
this tractable now: **the harness can verify an FTS change did not cost recall.**
`queries.json` records `poolB.sparseOnlyHitAt30 = 0.275`, measured through the FTS
path — a committed before-number for exactly this. Any optimisation must hold that
figure (and it is also what validates Pool B's leakage threshold, so a regression
there invalidates the pool, not just the fallback).

Do **not** treat this as urgent. It is a fallback nobody hits while Qdrant is
healthy, and it is now correct, which it was not before.

---

## Item 3 — Why did Qdrant drop under harness load?

One `eval baseline` run over 73 queries recorded `mode=fts` for at least one
query, and the harness **correctly refused to record a baseline** ("retrieval was
degraded (fts) — refusing to record a baseline"). The guard worked. The cause did
not get diagnosed.

What is known: `mode` becomes `fts` only when `this.vectors.query()` **throws**
(`packages/core/src/search.ts`). An embedder failure produces `sparse-only`, not
`fts`. So Qdrant itself failed or timed out — the client ceiling is 60s
(`packages/core/src/qdrant.ts`). A rerun of the same command succeeded, so it is
load- or timing-dependent, not a persistent fault.

Hypotheses, in the order worth testing:
- Qdrant restarted or was OOM-killed mid-run (`docker compose logs qdrant`,
  container restart count). The collection is int8-quantized with capped segment
  size specifically to bound a RAM spike, so this is plausible under concurrent load.
- Concurrent query pressure exceeded a server-side limit and a request was
  rejected rather than queued.
- A `syncCollection` race pointed a query at a collection mid-switch.

**Do this, in order.**

1. **Make it attributable.** The report currently prints which *modes* were seen,
   not which *query* degraded. Add the query id (and its mode) to the degraded
   banner in `packages/eval/src/run.ts`. Without this, diagnosis is guesswork —
   and this is cheap.
2. Reproduce: `make eval` over all pools, repeatedly, while watching
   `docker compose logs -f qdrant` and container restarts.
3. Only then decide a fix. If Qdrant is being killed, the answer is resource
   limits or lower harness concurrency, not a retry — retrying a request that
   killed the server makes it worse.

`packages/core/src/retry.ts` notes that Ollama drops connections under sustained
load; do not assume the same shape here without evidence, because the mode says
Qdrant, not the embedder.

---

## Item 4 — The session cap: what the measurement actually said, and what to do

### What was measured

Baseline, Pool A (21 real queries, 1,182 labels, κ 0.802):

| class | n | nDCG@10 | precision@12 | recall@30 |
|---|---|---|---|---|
| definitional | 7 | 0.694 | 0.583 | 0.766 |
| incident | 5 | 0.623 | 0.500 | 0.645 |
| intent | 4 | 0.748 | 0.521 | 0.858 |
| procedural | 2 | 0.573 | 0.500 | 0.700 |
| temporal | 3 | 0.617 | **0.361** | 0.781 |
| all | 21 | 0.665 | 0.512 | 0.751 |

Temporal questions have the worst *context* precision and good *pool* recall: the
answer is retrieved, then dropped before synthesis.

Variants, paired over Pools A and B:

| variant | effect |
|---|---|
| `relax-when-scoped` | **no-op.** 0W/0L/21T on Pool A nDCG. Its trigger is a parsed date; even Pool B's nine temporal questions carry none |
| `cap-as-floor` floor=4 (permits **8** sessions vs the cap's 6 — a *relaxation*) | indistinguishable, trending slightly negative: A precision −0.012 [−0.024, +0.000] |
| `cap-as-floor` floor=8 (permits **4** sessions — a *tightening*) | trending **positive**: A/temporal nDCG +0.045 [−0.008, +0.086], A/temporal precision +0.028, B hit +0.025 |

Every interval includes zero, and +0.045 < the ~0.10 resolution floor.

### The implication, stated plainly

**The parent spec's premise is probably backwards.** It argued the 50% cap is "a
recency penalty wearing a source-quality costume" and should be relaxed when the
question is time-scoped. The measurement says relaxing is mildly harmful and
tightening is mildly helpful — most helpful on temporal questions, the exact class
the premise was about. The likely reason: for "what happened last week" the answer
is usually the commit or the log entry, not the conversation around it, so sessions
crowd out better-typed material regardless of recency.

Do not rewrite the parent spec to match. Record the disagreement.

### What to do

**Do not change the cap on this evidence.** +0.045 is inside the noise floor;
shipping it would be exactly the uncalibrated confidence this whole effort removed.

Instead, buy the power to resolve it:

1. **Grow Pool B from 40 to ~120.** `make eval-generate POOL_B=120`. Mostly
   machine time (~2h; it appends and never overwrites). This takes temporal from 9
   Pool B queries to ~27 and puts most classes past the n≥8 threshold at which the
   report stops marking them indicative.
2. **Sweep the floor properly**: `FLOOR=2,4,6,8,10`, one run each. Five points
   showing a monotone trend is far more convincing than two points inside their
   own intervals — and a *non*-monotone result would say the effect is noise,
   which is equally worth knowing.
3. **Require both pools to agree on direction.** Pool B's phrasing is synthetic
   and leakage-filtered, so tripling it also triples the weight of that bias.
   Report A and B separately (the harness already refuses to average them) and
   treat a direction that appears in only one as unproven.
4. **Read real answers before shipping any ranking change.** nDCG is a proxy. For
   the 3–5 queries whose context window changes most, run Ask both ways and read
   both answers. The harness makes zero LLM calls by design, so this step is
   manual and deliberate.

If the sweep shows a monotone, both-pool improvement that clears ~0.10, change
`MAX_SESSION_FRACTION` (or adopt the floor framing) and record it in an ADR with
the per-class before/after. If it does not, write that down too — "we looked, and
the cap is defensible" is a result, and the parent spec explicitly listed it.

**Also worth fixing regardless:** `relax-when-scoped`'s trigger is broken, not just
unhelpful. If conditional relaxation is ever revisited, the trigger must be
temporal *intent* — the query class, or a classifier — not `extractDateWindow`
finding a parseable date. Currently it fires on almost nothing.

---

## Item 5 — RRF top-1 carries a signal after all: implications

### What was measured

All **12** verified-unanswerable queries score `rrf@1` = **exactly 0.500**. Twenty
of twenty-one real queries score higher.

The mechanism was confirmed independently: issuing a fused query with a
deliberately non-matching sparse vector returns exactly 0.5, with the tail at 1/3
and 1/4. RRF adds `1/(k+rank)` per branch, so 0.5 is a **single-branch
contribution** — the dense and sparse branches agreed on nothing, which is what
happens when the index holds no answer. Higher values mean both branches ranked
the same document highly.

**But it is unusable alone: 18 of 40 answerable-by-construction Pool B questions
also score exactly 0.500.** Against A-vs-N a 0.500 threshold looks 97% accurate;
add Pool B and its precision as a "nothing relevant" detector falls to ~39%.

### Implications

1. **The documented rationale for B4 was partly wrong, and the correction is
   already in the ADR** (`20260726-retrieval-quality-is-measured-not-argued.md`,
   "First result"). It was recorded as a correction rather than edited away,
   deliberately. Do not re-litigate it; do not quietly restore the old claim.
   `packages/core/src/qdrant.ts`'s `queryDense` doc comment still says fused
   scores "carry no absolute relevance" — that is true of *similarity* and
   misleading about branch agreement. Tighten that comment.
2. **The three-pool design earned its cost here, and this is the evidence.** A
   harness with only real queries and negatives would have shipped "0.500 means
   nothing relevant" at an apparent 97% accuracy. Pool B — answerable by
   construction — is what exposed it. Keep that argument in mind before anyone
   proposes simplifying the harness to two pools.
3. **Branch agreement is a real feature worth keeping on the table for B4**, just
   not as a threshold. It is free (already in the fused response), it is
   *conservative* in the useful direction (high scores reliably mean both branches
   agreed), and it fails only by being silent. It belongs in a combination, not
   alone.

### What to do

Nothing on its own. Fold it into item 6 as a third candidate feature alongside
cosine and lexical overlap, and tighten the misleading comment in `qdrant.ts`.

---

## Item 6 — B4: what the calibration data says, and how to finish it

### What was measured (`test/fixtures/eval/signals.json`)

| signal | A: real (n=21) | B: known-item (n=40) | N: unanswerable (n=12) | best A-vs-N | misclassifies B |
|---|---|---|---|---|---|
| `rrf@1` | 0.500–1.000 | 0.333–1.000 | all exactly 0.500 | 97% @ 0.500 | 18/40 (45%) |
| `cosine@1` | 0.696–0.877 | 0.676–0.845 | 0.633–0.711 | 94% @ 0.711 | 10/40 (25%) |
| lexical overlap (top-5) | 0.136–0.733 | 0.046–0.400 | 0.000–0.111 | **100% @ 0.111** | 6/40 (15%) |

Also verified: **Qdrant v1.18.2 returns no per-branch scores** for a fused query
(only `id`, `payload`, `score`, `version`). The parent spec asked that this be
checked before assuming a second query is needed. It is needed;
`VectorStore.queryDense()` exists for it, and it is currently called by nothing in
production.

### Implications

1. **No single signal is sufficient**, and the parent spec's expectations were
   inverted: it recommended dense cosine as the primary and dismissed lexical
   overlap as "a secondary, not a primary". Lexical overlap is the *best* single
   separator here and cosine is the weaker one — the distributions are narrow and
   adjacent (N tops out at 0.711, A starts at 0.696).
2. **Their errors fall on different queries**, so a combination should beat any
   single threshold. That is the design to pursue.
3. **One bias must travel with these numbers.** Pool B's questions were
   deliberately paraphrased away from their source entries and leakage-filtered,
   which makes them adversarially hard for a *lexical* signal specifically. Pool A
   is real traffic and shows much higher overlap. The true operating characteristic
   sits between the pools; quoting the Pool A figure alone would overstate it.
4. **Pool N at n=12 is too thin to calibrate a threshold on.** Generation worked
   cleanly (0 of 16 candidates had to be rejected for having real answers), so this
   is cheap to fix.
5. **The cost is one extra dense query per search.** Search is already ~1.5–2.2s
   under embedder contention. This must be measured, not assumed acceptable.

### What to do

1. **Grow Pool N to ~40** (`make eval-generate POOL_N=40`) before choosing any
   boundary. Twelve negatives cannot support a defensible threshold, and the parent
   spec's own constraint is that every band boundary must be justified by harness
   data.
2. **Frame it as a classification problem, not a threshold hunt.** Positives are
   Pools A ∪ B, negatives are Pool N. Report precision and recall *of the `none`
   verdict* specifically, per pool. Do not report accuracy: the classes are
   unbalanced and accuracy hides which way the errors go.
3. **Choose the operating point for the asymmetry that matters.** A false `none`
   tells an agent to stop investigating something Atlas *can* answer — that is the
   2026-07-15 incident's failure mode arriving by a new route. A false `weak` merely
   under-sells a good answer. So maximise **precision of `none`**, and accept poor
   recall: `none` should fire rarely and be right when it does.
4. **Test the combination, don't assume it.** At minimum: lexical-only,
   cosine-only, `lexical AND cosine` (both low → `none`), and adding
   `rrf@1 == 0.5` as a third conjunct. Report all four; ship the one whose
   operating point holds on Pool A *and* Pool B.
5. **Honour the parent spec's escape hatch.** If calibration is inconclusive, ship
   the raw comparable score and **no bands**. A number a caller can judge beats a
   label the system cannot defend. This is not a fallback to be embarrassed about —
   it is the specified outcome.
6. **Handle the degraded paths explicitly.** Sparse-only and FTS produce no cosine
   at all, so `confidence` must be reported *unavailable* there, never guessed. Do
   not let a fallback emit numbers on a different scale — the whole point of the
   signal is cross-query comparability.
7. **Measure the added latency** before and after, and put it in the ADR.
8. Then, and only then, the parent spec's remaining deliverables: `relevance` on
   `RetrievalReport`, surfaced through API and MCP, with tool descriptions saying
   what an agent should *do* differently at each band; and Ask declining to
   synthesise at `confidence: none`.

---

## Item 7 — The 98 judge disagreements in `arbitrate.md`

### What they are

`test/fixtures/eval/arbitrate.md` holds 98 (query, entry) pairs where kimi-k3 and
glm-5.2 gave different grades, drawn from the 270-label grade-stratified subsample
that produced κ 0.802 / 67% exact agreement. A label with `judge: "human"`
overrides both models (`gradesByQuery` in `packages/eval/src/pools.ts`).

The harness is designed to work without them — κ is reported with arbitration
pending — so this is an optional quality investment, not a blocker.

### What to do: measure whether it matters before spending an afternoon on it

Hand-grading 98 pairs is perhaps one to two hours of careful reading. Do not start
there. **The harness already contains the machinery to decide whether arbitration
would change anything**, and it costs minutes:

1. **Apply the existing bounds technique to the disputed labels.** `eval run`
   already computes every metric twice — once treating unjudged candidates as
   irrelevant, once as perfect — and prints INCONCLUSIVE when a verdict flips
   between the bounds. Do the same for *disputed* labels: score once with every
   disagreement resolved to the lower grade and once to the higher. If no verdict
   flips, arbitration cannot change a decision and the 98 items can wait.
2. **If verdicts do flip, arbitrate only the pairs that can flip one.** Two
   filters make this small:
   - **Cutoff-crossing only.** Relevance is grade ≥ 2. A 2-vs-3 disagreement does
     not change whether a hit counts as relevant, only its nDCG gain slightly. A
     1-vs-2 disagreement flips it. Only cutoff-crossing pairs can move
     precision or recall.
   - **Reachable only.** A disputed entry that no variant ranks into the top 12
     cannot affect `precision@12` or `nDCG@10` at all.
   Expect this to cut 98 to roughly 20–30.
3. **Sort the remaining list by how many comparisons it touches** and stop when
   the bounds converge. Record how many were arbitrated and how many were left, in
   the fixture — a partially arbitrated fixture is fine, a silently partial one is
   not.

Implement (1) as `eval run --disputed-bounds` (or fold it into the existing bounds
report) and (2) as a filter in the `arbitrate.md` generator, ordering the file so
the decision-relevant pairs come first. Both are small changes to
`packages/eval/src/{run,report,judgeAll}.ts`.

**Do not add a third model as a tie-breaker.** A third LLM opinion is not ground
truth, and majority-of-three would launder disagreement into false confidence
while removing the signal κ currently gives about label noise.

---

## Sequencing

Ordered by dependency, with the cheap and unblocking work first:

1. **Item 1** — fix `askStream`'s blank answer. Independent, small, user-visible.
2. **Item 7 step 1** — disputed-label bounds. Minutes, and it tells you whether
   label quality gates items 4 and 6.
3. **Item 3 step 1** — attribute degradation to a query id. Cheap, and every
   later measurement is more trustworthy for it.
4. **Grow the fixtures** — Pool B to ~120 (item 4), Pool N to ~40 (item 6). Mostly
   machine time; run them together, then `make eval-judge TOP_UP=1`. Everything
   quantitative downstream depends on this.
5. **Item 4** — the floor sweep, once the power exists.
6. **Item 6** — B4 proper, once Pool N is big enough.
7. **Item 2** — FTS cost, whenever convenient; verify with `sparseOnlyHitAt30`.
8. **Item 3 steps 2–3** — the Qdrant diagnosis, opportunistically while the long
   fixture builds are running under load. That load is the reproduction condition.

## Definition of done

- [ ] `askStream` cannot report an empty answer as healthy; tests cover the four
      stream shapes in item 1.
- [ ] The disputed-label bounds are computed and reported; the decision to
      arbitrate (or not) is recorded with its reason.
- [ ] The degraded banner names which query degraded and in what mode.
- [ ] Pool B ≈120 and Pool N ≈40, judged, with κ recomputed and the new
      resolution floor stated.
- [ ] Floor sweep run at 2/4/6/8/10 over both pools, per class, with the
      monotonicity of the trend reported — and a decision recorded either way,
      including "the cap is defensible", in an ADR.
- [ ] B4: `none`-verdict precision/recall per pool for at least four candidate
      signal combinations; an operating point chosen for `none`-precision, or an
      explicit decision to ship the raw score with no bands; degraded paths
      reporting confidence as unavailable; added latency measured.
- [ ] If bands ship: `relevance` on `RetrievalReport` through API + MCP, tool
      descriptions saying what to do at each band, and Ask declining to synthesise
      at `confidence: none`.
- [ ] `qdrant.ts`'s `queryDense` comment no longer implies fused scores carry no
      information at all.
- [ ] KDB component entry per §2.2; changelog per §2.4; ADR per §7 for any
      ranking or contract change.

## Anti-goals

- **Do not act on a delta below the stated resolution floor** (~0.10 today).
  Increase power or label quality first. Shipping inside the noise is the failure
  this whole line of work exists to prevent.
- **Do not average the pools.** Each has a different bias; the harness refuses to,
  and so should any report.
- **Do not replace RRF fusion, re-embed, or change the embedding model.** The
  collection prefix and id namespace are frozen — see the comment in `qdrant.ts`.
- **Do not simplify the harness to two pools.** Item 5 is the concrete
  demonstration of what that would have cost.
- **Do not tune weights by looking at a handful of favourite queries.** That is how
  the current numbers earned their reputation for being arbitrary.
