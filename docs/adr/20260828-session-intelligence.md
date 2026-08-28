# ADR: Session Intelligence — Two Layers, Evidence First
Date: 2026-08-28

## Status
Accepted

## Context
- Atlas indexed 363,842 `claude_session` entries across 8,395 sessions but
  could only browse them ONE PROJECT AT A TIME, and only rank individual
  messages. "Which session was that?" — the question people actually ask of a
  transcript archive — had no answer.
- Measured on the live index (2026-08-28), the corpus is hostile to naive
  ranking: **median 3 entries and 1.6 minutes per session**, p90 151, max
  1,304. Only 2,205 sessions (26%) exceed 20 entries. A keyword match ranked
  by relevance alone buries the session that did the work under hundreds of
  ninety-second ones.
- Only 2,322 sessions (28%) record any `files_touched`, averaging 3.3 — a
  strong signal, but present for barely a quarter of the corpus.
- `sessions.files_touched` holds paths exactly as written on whatever machine
  ran the session. The most-touched paths in this index are under
  `/Users/nasta/__CODING NEW/…`, a user and machine that no longer exist here.
  String equality against today's `/Users/serge/_CODING/…` scores ZERO for the
  same file of the same repository.
- `cwd` has 71 distinct values across 8,395 sessions: it identifies a project,
  not a session, and is useless for detecting continuation.
- The parser already classifies every message (`prompt`/`plan`/`insight`/
  `summary`/`action`/`response`) at parse time. 9,075 entries are distilled
  prose (insight/summary/plan); 163,960 are the action trail.

## Decision
- **Session-level retrieval fuses two legs.** A metadata leg (id prefix, title,
  folder, project, normalised file index) is ADDITIVE to a content leg
  (existing hybrid search over `claude_session`, message scores aggregated per
  session as `best + 0.35·Σ rest_i/i`). Neither alone suffices: the metadata
  leg introduces sessions the vector index never retrieved (a file path, a
  project name, a pasted id), and the content leg finds sessions whose title
  says nothing.
- **Substance is a ranking PRIOR, never a filter.** `0.55 + 0.45·substance`,
  from entry/action/file counts and duration. It suppresses the flood of
  throwaway sessions without censoring the ninety-second one that happens to
  hold the answer.
- **Every result explains itself.** A `why` array names what matched, on every
  card and every related session. This is load-bearing: it is what lets a
  reader identify the right session without spending an LLM call, and what
  makes a wrong ranking arguable rather than mysterious.
- **File comparison happens on NORMALISED paths**, in a derived
  `session_files` table, never on the recorded absolute path. IDF is measured
  from the table, not assumed: high-frequency paths (`Makefile` 131 sessions,
  `MEMORY.md` 183) are excluded from candidate GENERATION but still contribute
  their small weight to SCORING — bounding fan-out without discarding evidence.
- **Relatedness combines its legs as a soft OR, not as a weighted mean.**
  `1 - Π(1 - w·leg)`. Each leg is evidence FOR relatedness and none is evidence
  against, so a leg with nothing to say contributes nothing rather than
  averaging a signal down. The first implementation used a weighted mean over
  "available" legs and was wrong in a way only real data showed: a 3-message
  session with no files outranked a 502-message session sharing two files,
  because the heavy session's weak-but-real file score was averaged IN while
  the trivial one had no file term to dilute it — having evidence made it score
  worse than having none. The response always reports its `basis`; a list built
  from timestamps alone says so in words, because it otherwise looks identical
  to one built from shared files.
- **The substance floor is different for search and for related** (0.55 vs
  0.25). In search the user's own words are the primary evidence, and a tiny
  session can be exactly the right answer, so it must stay findable. In
  "what else worked on this" nobody asked for the session: a three-message
  session is rarely the WORK on anything, and proposing it beside real ones is
  a false positive the reader has to rule out by hand. Measured: a 3-message
  security review outranked two substantial file-sharing sessions on subject
  similarity alone until the two floors were separated.
- **Insights are two layers, and the split is the contract.** A deterministic
  facts layer (goals, action rollup, distilled prose, follow-up markers,
  backlog overlap, and the commits/kdb entries recorded in the same window) is
  complete on its own and costs nothing. One LLM call adds decisions, problems
  and a distilled follow-up list on top of that evidence. Every generated field
  is marked `AI` end to end; an unavailable model degrades to the facts and
  says so. Reports are cached under a key that folds in sections, model,
  extraction scheme, PROMPT VERSION and the session's own size.
- **The LLM never sees the bulk.** Only prompts and distilled prose, capped at
  ~14,000 characters. The largest session here would otherwise serialise to
  megabytes.
- **One implementation, four surfaces.** All logic is server-side, so MCP stays
  the thin REST proxy it already is; presentation vocabulary and the timeline
  layout live in `@atlas/shared`, so web and native cannot describe the same
  session differently. A test pins the section registry across the two.

## Consequences
- `session_files` and `session_insights` are new tables. Both are derived and
  droppable: `session_files` rebuilds from `sessions.files_touched` (already in
  Postgres — no transcript is re-read), and losing `session_insights` costs
  only the completions that produced it.
- `/api/sessions/search` MUST be registered before `/api/sessions/:id` in
  `app.ts` AND precede it in `usage.ts`'s ordered patterns; both are the same
  segment count. Reversed, session search is served and logged as a session
  read. Pinned by tests in `test/api/routes.test.ts` and
  `test/core/usageRouteClass.test.ts`.
- Sessions is no longer gated on picking one project. Browse still needs one
  and asks for itself; Find treats scope as a filter.
- Latency is inherited from the vector index, not from this feature: measured
  end-to-end cost is uncorrelated with the retrieval pool size (3.6 s at pool
  80 vs 1.6 s at pool 250 for the same query) and is dominated by cold vector
  reads, consistent with the rescore-bound profile already recorded for this
  Qdrant deployment. The pool is therefore sized for EVIDENCE, not speed.
  Measured on the live index after two fixes (resolving the file match once in
  a CTE instead of a correlated EXISTS per session row, and not fetching a
  `body` column neither caller reads): session search 0.5–3 s warm; related
  sessions 8.8 s on a first, novel probe and ~0.55 s warm.

## Alternatives considered
- **Rank sessions by their best message alone.** Rejected: a session that
  matched in six places is better evidence than one that matched once, and the
  plain-max rule cannot see the difference.
- **Sum all message scores.** Rejected in the other direction: a 1,304-entry
  session wins on volume regardless of relevance.
- **Jaccard over file sets.** Rejected: session file-set sizes span two orders
  of magnitude (median 3, max 265), so a 3-file session fully contained in a
  265-file one scores 0.011 — reading as unrelated when it is total
  containment. IDF-weighted cosine is used instead.
- **A maintained stop-file list.** Rejected: document frequency is measured
  from the table, so it tracks a corpus that changes daily.
- **LLM-only insights.** Rejected under the answer-trust ADR
  (`20260725-ask-answer-trust-contract`): a report that is empty when the model
  is down is a report that was never evidence.
