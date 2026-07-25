# ADR: Ask States Coverage Only From Measurement, and Reports Its Own Degradation
Date: 2026-07-25

## Status
Accepted

## Context

On 2026-07-25 an agent investigating a spike of failed jobs asked Atlas what
happened on 2026-07-21. `atlas_ask` (k=14, `gemini-2.5-flash`) answered:

> "The indexed history for July 2026 concludes on **2026-07-15** [1, 13]."

That sentence is false. At the moment it was written the index held 34,825
entries newer than 07-15, every source type was current to that same day, and
the indexer had run two minutes earlier. Blocks [1] and [13] are merely *dated*
07-15; neither says anything about what the index contains.

The agent believed it, stopped investigating, and reported the false coverage
limit to the user as a fact about Atlas. This is the failure mode that matters
most for this product: Atlas output steers agents that then act, and a confident
false negative about coverage does not merely fail to help — it actively
terminates a line of inquiry that would have succeeded.

Three causes compound.

**The prompt authorises the claim.** Rule 2 of `SYSTEM_PROMPT` reads: *"If the
blocks do not answer the question, say so plainly and name exactly what is
missing. A short honest 'the indexed history doesn't cover X' beats a padded
guess."* It hands the model that exact phrasing — a claim about the corpus —
while the model can only ever observe its k blocks. Rule 1 forbids inventing
dates; rule 2 asks it to characterise what is absent. The model obeyed. The
instruction, not the model, is the defect.

**Nothing supplies the truth.** The model receives no information about what the
index holds, so it substitutes the only evidence it has: the newest date among
its retrieved blocks. Absence of evidence in a 14-of-361,941 sample is reported
as evidence of absence.

**Retrieval could not reach the date.** Ranking has no recency term, and
`since`/`until` — which exist in `SearchFilters` and `buildQdrantFilter` and work
against the live collection — are exposed by no MCP tool. A question naming a
date has no path to that date, so the retrieved set skewed old and the model's
inference looked locally reasonable.

Two further gaps make the answer's reliability unknowable to its consumer:

- **Degradation is discarded.** `SearchService.search()` returns `mode` and
  `degraded` (hybrid → sparse-only when the embedder is down → Postgres FTS when
  Qdrant is down). `AskService.retrieve()` destructures only `{ hits }`, and
  `ask()` returns a hardcoded `degraded: false`. The embedder demonstrably flaps,
  so Ask can answer from materially worse retrieval and report itself healthy.
- **Scores carry no absolute relevance.** Fusion is RRF, which is rank-based: the
  top hit of a query with nothing relevant scores the same as the top hit of a
  perfect match. There is no "found nothing *relevant*" state, only "found
  nothing at all", so every query returns k confident-looking blocks.

The correct answer was cheaply available and never requested. Two catalog
queries — `max(occurred_at)` for the scope, and a count for the asked date —
yield: *"DeepCast is indexed through 2026-07-25; there are 0 entries dated
2026-07-21."* True, useful, and it would have sent the agent to the worker logs
instead of to a dead end.

## Decision

Ask may state what the index contains **only** by reporting a measurement, and
must disclose the conditions its answer was produced under.

- **Grounded coverage block.** Before synthesis, query the catalog for newest and
  oldest `occurred_at` and entry count, injected as a distinct labelled context
  block.

  Coverage is reported **per project**, not for the index as a whole. The
  recommended default is an unscoped Ask, and "the index is current to
  2026-07-25" says nothing about whether *DeepCast* is covered — a global figure
  would be technically true and practically useless, which is the same class of
  answer this ADR exists to eliminate. Coverage is therefore computed for the
  scoped project(s), or, when unscoped, for the projects appearing in the
  retrieved set. When the scope-fallback widens a search, coverage describes the
  scope actually searched.

- **Window counts are reported with their neighbourhood.** When the question
  names a date or range, count entries in that window *and* in a padded window
  around it. A bare "0 entries dated 2026-07-21" is true but recreates the
  original dead end in a new form: an incident on the 21st is most often written
  up in a session dated the 22nd or later, because people record events after
  they happen. The prompt frames these as counts of entries *timestamped* in the
  window — never as evidence about whether something happened — and the padded
  count gives the model somewhere correct to point.
- **The prompt forbids ungrounded coverage claims.** Rule 2 is rewritten: the
  model states what the *retrieved blocks* do not say, and may make claims about
  what the *index* holds only by quoting the coverage block. The distinction
  between "retrieval did not surface it" and "the index does not contain it" is
  made explicit, because collapsing the two is precisely what went wrong.
- **Degradation propagates end to end.** `retrieve()` keeps `mode`/`degraded`;
  `ask()` and `askStream()` report them; the API and MCP responses carry them.
  An answer produced without dense retrieval says so.
- **Retrieval quality is returned as data, not prose.** Responses carry a
  structured `retrieval` object — mode, degraded, coverage, and the count for any
  window the question named — so a consuming agent can branch on facts instead of
  parsing hedges out of English.
- **Date filters become reachable.** `since`/`until` are exposed on `atlas_search`
  and `atlas_ask`, and `occurred_at` gets its Qdrant payload index (filtering
  works without it, but measured 3.11s vs 0.087s — 36× — which is too slow to
  make date scoping a default).

The design principle, applied wherever Atlas speaks to an agent: **measure, or
say nothing.** A claim Atlas cannot ground in a query is a claim it must not
make, however plausible.

## Consequences

- Positive: the specific failure becomes impossible — the model cannot assert a
  coverage limit that contradicts a measurement placed in front of it.
- Positive: "nothing happened on that date" becomes a *supported, useful* answer
  rather than an unsupported discouraging one. The original question would have
  been answered correctly.
- Positive: agents gain a machine-readable trust signal. `degraded: true` or a
  zero-count window is actionable; a hedge buried in prose is not.
- Negative: one or two extra catalog queries per Ask. Both are indexed aggregates
  against `occurred_at`, negligible beside an LLM call measured in seconds.
- Negative: parsing dates out of natural-language questions is inherently
  imperfect. It is used only to *add* a measured count, never to filter
  retrieval, so a missed date degrades to today's behaviour rather than hiding
  results. This asymmetry is deliberate.
- Negative: a longer system prompt for mid-size models that follow short rules
  best. Mitigated by keeping the coverage rule short and concrete.
- Limitation, stated plainly: **no test can prove the model will not make an
  ungrounded claim.** Tests pin what is deterministic — that the coverage block
  is present and correct in the prompt, that it is not citable as a source, that
  `degraded` propagates. The prompt rule is defence in depth; the coverage block
  is the actual fix. This is deliberate: the previous design relied entirely on
  instructing the model, which is the layer that failed. Putting the measurement
  in front of it removes the need to guess, rather than asking it to guess
  better. Residual risk is real and is why `retrieval` metadata is returned as
  structured data an agent can check without reading the prose.
- Operational: the `occurred_at` payload index adds Qdrant memory, consistent
  with the `entry_id` index accepted in `20260710-docs-staleness-query-time.md`.

## Alternatives Considered

- **Post-process the answer to strip coverage claims.** Regex or a second LLM
  pass over the generated text. Rejected: brittle against paraphrase, removes
  information instead of correcting it, and leaves the model reasoning from a
  false premise even when the sentence is deleted.
- **Tell the model "you may not know what the index contains".** A prompt-only
  fix with no measurement. Rejected: it suppresses the confident claim without
  enabling the true one, so the useful answer ("indexed through 07-25, nothing on
  07-21") remains unreachable. It also asks the model to reason about its own
  ignorance, which is what it is worst at.
- **Raise k.** Rejected: does not address the class. A larger sample of a
  date-blind ranking is still a sample, and the model would draw the same
  inference from a newer arbitrary boundary.
- **Have Ask refuse date-anchored questions.** Rejected: those are among the most
  valuable questions Atlas is asked, and the data to answer them is present.
- **Return raw relevance instead of RRF so scores are comparable.** Rejected for
  now as a larger change to fusion; the coverage block and degradation flags
  address the trust gap without it. A calibrated confidence signal remains open
  (see plan, Phase 3).

## References
- Plan: `docs/superpowers/plans/2026-07-25-atlas-trust-hardening.md`
- Companion ADR: `20260725-vector-catalog-reconciliation.md`
- Prior art on in-band staleness labelling: `20260710-docs-staleness-query-time.md`
- KDB: `kdb/components/atlas.log`, entry of 2026-07-25
