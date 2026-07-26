# Spec: Retrieval Confidence (B4) and Source-Mix Tuning — deferred from Phase 3
2026-07-26 02:10 UTC

## Revision History

| Date (UTC) | Change |
|---|---|
| 2026-07-26 02:10 | Initial spec. Written as a self-contained handoff for a later session. |

---

## How to use this document

This is a **prompt for a future session**. It assumes no memory of the work that
produced it. Everything needed is either here or named by path.

Read first, in this order:
1. `docs/adr/20260725-ask-answer-trust-contract.md` — the trust contract these
   two items extend.
2. `docs/superpowers/plans/2026-07-25-atlas-trust-hardening.md` — Phases 0–3,
   what shipped and what was measured.
3. `kdb/components/atlas.md`, entries of 2026-07-25 and 2026-07-26.

Then read this spec's **Blocker** section before planning anything, because both
work items depend on it and neither can be honestly evaluated without it.

## Background: why these two were deferred

Phases 0–3 (2026-07-25/26) hardened Atlas after an agent was told *"Atlas's index
stops at 2026-07-15"* — a false claim the model produced by reading its 14
retrieved blocks as if they described the whole corpus. Beneath that, entries
were being silently lost from the vector store.

Both were fixed. Two items were deliberately left, for the same reason: **they
are tuning problems, and nothing in this repo can currently measure whether a
retrieval change made things better or worse.** Shipping either on intuition
would contradict the principle the rest of the work established — *measure, or
say nothing*.

## THE BLOCKER — build this first

**There is no retrieval evaluation harness.** No labelled query set, no
regression metric, no way to compare ranking A against ranking B.

Every existing test asserts *mechanics* (this weight is applied, this duplicate
collapses) on synthetic fixtures. None asserts *quality*. So:

- B4 needs a threshold, and a threshold without calibration data is a number
  invented and then presented as confidence — the exact failure this whole
  effort removed.
- The source-mix question ("is the 50% session cap still right?") is a claim
  about answer quality across many real questions. One hand-picked example
  proves nothing; it is trivially easy to find a query that favours either side.

### Deliverable 0: evaluation harness

Minimum viable, and genuinely sufficient:

1. **A query set of 30–50 real questions.** Do not invent them — mine them:
   - `SELECT query FROM usage_log WHERE tool IN ('atlas_ask','atlas_search')` —
     real agent traffic, already recorded.
   - Claude session transcripts under `~/.claude/projects/**` contain the
     questions agents actually asked Atlas.
   Cover the mix deliberately: "what is X" definitional, "why was X built this
   way" intent, "what happened on DATE" temporal, "what did session X conclude".
   The temporal and definitional classes pull ranking in *opposite* directions,
   which is precisely the tension being tuned.

2. **Graded relevance judgements.** For each query, the entry ids that genuinely
   answer it. Bootstrapping is acceptable and fast: run the current retrieval at
   k=30, have a strong model label each hit relevant/not with a one-line reason,
   then spot-check ~20% by hand. Store as a committed fixture (JSON under
   `test/fixtures/`), because the point is a *stable* baseline.

3. **Metrics.** nDCG@10 and recall@30, reported per query class, not just
   overall — an aggregate can hide a change that helps definitional questions
   while wrecking temporal ones.

4. **A runner.** `make eval` against the live index, printing per-class metrics
   and a diff vs the committed baseline.

Note the honest limitation up front: judgements bootstrapped from current
retrieval are biased toward what current retrieval finds. recall@30 over a pool
built by *several* configurations (union the hits from each variant before
judging) mitigates this. Say so in the ADR rather than presenting the numbers as
neutral.

---

## Work item 1 — B4: a calibrated relevance signal

### The problem, precisely

`packages/core/src/qdrant.ts` fuses dense and sparse branches server-side:

```ts
query: { fusion: 'rrf' }
```

RRF scores are **rank-based** — roughly `Σ 1/(k + rank)`. The top hit of a query
with nothing relevant scores the same as the top hit of a perfect match.
Observed values in production are the giveaway: `0.83, 0.53, 0.5, 0.33, 0.25` —
these are positions, not similarities.

Consequences, all live today:

- There is no "found nothing **relevant**" state, only "found nothing at all"
  (`hits.length === 0`).
- `AskService.retrieve()` (`packages/core/src/ask.ts`) treats *any* hit as proof
  the scope worked, so the scope-widening fallback never fires on a scope that
  returned 14 irrelevant blocks.
- Ask always hands the model k blocks and asks it to synthesise. A confident
  answer built from 14 unrelated blocks is the same failure class as the 07-15
  incident, arriving by a different route.

### What must be true when this is done

An agent calling `atlas_ask` can distinguish:
- "there is a well-supported answer here",
- "something matched but weakly — treat as a lead",
- "nothing relevant was retrieved; do not build on this".

Today all three look identical.

### Design options

**A. Dense-only cosine probe (recommended starting point).** Issue the dense
branch separately (or read prefetch branch scores) and keep the raw cosine of the
top hit alongside the fused ranking. Cosine is comparable across queries.
Cost: one extra vector query per search, or a Qdrant API shape that returns
per-branch scores — verify whether the installed version (`v1.18.2`) can return
prefetch scores before assuming a second query is needed.

**B. Score-gap heuristic.** Use the shape of the score distribution (top-1 vs
median) rather than absolute values. Free, no extra query, but RRF distributions
are dominated by pool size and are near-identical for good and bad queries.
Likely too weak; test it against the harness before dismissing it.

**C. Lexical overlap floor.** Cheap sanity check — the fraction of query content
terms appearing in the top hits. Catches the egregious "nothing matched" case,
misses semantic-but-wrong. Useful as a secondary, not a primary.

**D. LLM self-assessment.** Ask the synthesiser to rate its own confidence.
**Reject.** It is precisely the judgement the model failed at in the original
incident, and it costs a second call to get an unfalsifiable number.

### Surface

Extend `RetrievalReport` (`packages/core/src/types.ts`) — it already carries
`mode`, `degraded`, `coverage`, `window`:

```ts
relevance: {
  /** Comparable across queries; the metric and scale must be named. */
  topScore: number;
  /** Calibrated band, not a raw number, for agent branching. */
  confidence: 'strong' | 'weak' | 'none';
}
```

`atlas_ask` and `atlas_search` must surface it, and the tool descriptions must
say what an agent should *do* differently at each band. A field agents cannot act
on is decoration.

When confidence is `none`, Ask should decline to synthesise and say so plainly,
rather than producing a fluent answer from unrelated blocks.

### Constraints

- **No uncalibrated thresholds.** Every band boundary must be justified by
  harness data recorded in the ADR. If calibration is inconclusive, ship the raw
  comparable score and *no* bands — a number the caller can judge beats a label
  the system cannot defend.
- Extra latency must be measured. Search is already ~1.5s under embedder
  contention; a second dense query is not free.
- The degraded paths matter: sparse-only and FTS fallback produce different score
  semantics again. Either handle them explicitly or report `confidence` as
  unavailable there. Do **not** let a fallback silently emit numbers on a
  different scale.

---

## Work item 2 — source mix: is the 50% session cap still right?

### Current state

In `packages/core/src/ask.ts`:

```ts
const SOURCE_WEIGHT = { doc: 1.35, kdb_component: 1.3, …, claude_session: 0.8 };
const MAX_SESSION_FRACTION = 0.5;
```

Both exist for a real, documented bug: a tool that indexes its own operators'
conversations ranks a debugging transcript *about* feature X above the doc that
*explains* X, because the transcript echoes the question's words while the doc
does not. Ask then answers from chatter. Do not remove them casually — read the
comment block above `SOURCE_WEIGHT` first.

### The tension

`claude_session` is overwhelmingly the recent-dense source. Measured 2026-07-25
for DeepCast, 2026-07-16 → 07-22:

| source | entries in that week |
|---|---|
| claude_session | 12,137 |
| doc | 526 |
| git_commit | 390 |
| everything else | ~137 |

So sessions are ~92% of recent activity. For a question about the last few days,
a 0.8 weight plus a 50% cap is **a recency penalty wearing a source-quality
costume**. For "what is X", the same settings are exactly right.

Phase 3 added a gentle recency multiplier (180-day half-life, 12% max boost) and
**deliberately did not touch the cap**, so the two effects stay separable. That
was a sequencing decision, not a verdict.

### The question to answer

Is a *fixed* cap defensible now that recency exists, or should the mix adapt to
the question? Candidate designs:

1. **Leave it.** Legitimate. Requires evidence that recency already recovered
   temporal questions — which the harness can show directly.
2. **Relax the cap when the question is time-scoped** (`since`/`until` set, or
   `extractDateWindow` matched — see `packages/core/src/questionDates.ts`). If
   the user asked about a week, session dominance is the *correct* answer, not
   noise to suppress.
3. **Make the cap a floor for other types, not a ceiling on sessions.** Guarantee
   *N* slots for authoritative sources and let sessions take the rest. Same
   protection against the drain-feature bug, no penalty when nothing else exists.
   This is the most promising framing: it preserves the original guarantee while
   removing the collateral damage.
4. **Weight by recency-adjusted type.** Riskiest; hardest to reason about.

Evaluate against the harness, reporting **per query class**. Option 3 improving
temporal questions while leaving definitional ones flat is a clear win; anything
that trades one for the other needs an explicit decision, recorded.

## Definition of done

- [ ] Eval harness committed, with the query set, judgements, `make eval`, and a
      baseline recorded from current `main`.
- [ ] ADR for B4 documenting the chosen mechanism, the calibration data, and the
      band boundaries (or the decision to ship a raw score without bands).
- [ ] `relevance` on `RetrievalReport`, surfaced through API + MCP, with tool
      descriptions saying what to do at each band.
- [ ] Ask declines to synthesise at `confidence: none`.
- [ ] ADR or plan entry for the source-mix decision, with per-class before/after
      numbers — including if the decision is "change nothing".
- [ ] KDB component entry per §2.2; changelog per §2.4.

## Anti-goals

- Do **not** replace RRF fusion wholesale. That is a separate, larger decision;
  B4 only needs a comparable signal alongside it.
- Do **not** re-embed or change the embedding model. The collection prefix and id
  namespace are frozen — see the comment in `packages/core/src/qdrant.ts`.
- Do **not** tune weights by looking at a handful of favourite queries. That is
  how the current numbers got their reputation for being arbitrary, and the
  harness exists precisely to end it.
