# ADR: Literals Survive Tokenisation Whole, and the Index Is Versioned On It
Date: 2026-07-29

## Status
Accepted

## Context

A real question was put to `atlas_ask` and answered wrongly:

> during a session Claude Code found that the deepcast frontend fetch a 6.8MB
> json which is quite large. to fix this issue I need the context and what was
> found

Atlas replied that the retrieved blocks did not contain it, and listed twelve
unrelated sources. The answer was honest about its own retrieval — the trust
contract of `20260725-ask-answer-trust-contract.md` held — but the retrieval
itself had failed, and five entries that answer the question outright are
indexed:

| id | source | |
|---|---|---|
| `465383` | `kdb_backlog` | "the whale user's `mv_user_metadata_aggregations.tags_with_counts` is **6.8MB JSONB** (621k videos) — every dashboard facet read detoasts+transfers+parses it (>1s)" |
| `466879` | `kdb_backlog` | the same column storing all ~476k tags per whale |
| `467265` | `kdb_changelog` | the shipped fix (Redis cache-aside) |
| `467695` | `kdb_session` | the full investigation |
| `467706` | `kdb_component` | `database-performance`, the durable record |

Replaying the question against `/api/search`: **none of the five appeared in the
top 100**, and 94 of those 100 slots were `claude_session`.

### Root cause

`tokenize()` split on `[^a-z0-9_]+` and dropped single characters. `.` was
therefore a separator inside a number, and the orphaned digit was then filtered
out:

| text | tokens |
|---|---|
| `6.8MB` | `["8mb"]` |
| `6.8 MB` | `["mb"]` |
| `1.8MB`, `0.8MB`, `8MB` | `["8mb"]` |
| `v1.18.2` | `["v1", "18"]` |
| `$4.50` | `["50"]` |

Three separate failures follow from that one regex:

1. **The significant digit is discarded.** `6.8MB` is indexed under a token that
   does not contain the `6`.
2. **Distinct values collide.** Fifteen distinct sizes in the corpus share the
   `8mb` bucket, which is why its IDF is low. Measured per-token weight for the
   question above:

   ```
   quite     17.48
   json      16.42
   8mb       16.35   ← the only discriminative term in the question
   large     16.30
   deepcast   7.34
   ```

   The filler word "quite" outranked the file size. The gold entries scored
   16–21 against a winning irrelevant document at 49.

3. **Spellings do not meet.** `6.8MB` and `6.8 MB` produce token sets with
   nothing in common, so a document written one way is lexically unreachable
   from a question written the other. No amount of ranking work fixes that; the
   terms never meet.

Version strings, IPs, prices, durations and shas were shredded the same way. The
failure is not specific to this question — it is specific to every literal in the
corpus, which is most of what makes an engineering history searchable.

A second, independent cause compounded it. `retrieveForContext` passes the raw
conversational question to both retrievers. This one contributed roughly ten
tokens of pure meta-narrative — `during`, `session`, `found`, `need`, `context`,
`what` — each competing on equal footing with the single term that mattered,
because in a question every word occurs exactly once and term frequency cannot
tell them apart.

## Decision

**1. A literal survives tokenisation whole, and its spaced and unspaced
spellings produce the same tokens.**

`.` is kept inside a run and resolved afterwards rather than discarded up front.
A dotted run is *also* emitted as its parts only when every segment starts with a
letter — which separates compound identifiers (`mv_user_..._aggregations.tags_with_counts`,
`deepcast.io`), where the parts are meaningful and splitting preserves existing
searches, from atomic values (`6.8mb`, `v1.18.2`, `127.0.0.1`), where splitting is
the bug. A number adjacent to a known unit is canonicalised in both directions,
so `6.8 MB` and `6.8MB` are the same query.

**2. Queries up-weight literals; documents do not.**

`sparseVector(text, { boostLiterals: true })` multiplies tokens shaped like
measurements, identifiers, versions and shas. This is a statement about what the
*asker* means, so it belongs to the query. Applying it to documents would distort
the corpus IDF statistics the whole ranking rests on.

**3. The sparse index is versioned, and a tokeniser change rebuilds it.**

`SPARSE_VERSION` is compared against a per-collection `sparse_version` setting at
indexer boot. This is not bookkeeping: stored and query vectors must come from
the same tokeniser or keyword search *silently stops matching* — no error, no
health-check signal, exactly the failure this ADR exists to close.

The rebuild is **sparse-only**, through Qdrant's update-vectors endpoint. A
tokeniser change invalidates the sparse half of every point and nothing else;
routing it through the normal backfill would re-embed 326k entries through Ollama
to recompute dense vectors that were never wrong. Sparse vectors are local
hashing, so the pass needs no embedding provider, and dense retrieval keeps
serving unchanged throughout. It walks only entries whose `vectorized_in` matches
the collection, because update-vectors rejects an entire batch containing one
unknown id.

**4. Retrieval guarantees the pool contains explanatory sources.**

`rerankForContext` already weights docs and kdb logs above transcripts and caps
sessions at half the window — but it can only reorder what retrieval handed it,
and 94 of 100 candidates were transcripts. A second, source-restricted retrieval
tops the pool up to `ceil(k/2)` non-session candidates: exactly the number the
existing session cap already promises, so this makes a standing guarantee
reachable rather than inventing a policy. It runs strictly *after* the
empty-scope test, or it would manufacture hits for a project scope that matched
nothing and suppress the widening.

## Consequences

- **Every stored sparse vector is rewritten once.** Cheap (local hashing, no
  embedding calls), resumable from a stored cursor, and stamped only on a
  completed pass so a crash resumes rather than declaring a half-rebuilt index
  good. `KDB_SPARSE_REBUILD=false` is the kill switch; skipping leaves keyword
  search on stale tokens — degraded, not broken, since dense retrieval is
  unaffected — and the pass reruns next boot.
- **`ftsQuery` terms must stay unquoted.** Postgres' english parser splits a
  measurement into number and unit (`to_tsvector('english','6.8MB')` is
  `'6.8':1 'mb':2`) and parses the bare term `6.8mb` into the adjacency query
  `'6.8' <-> 'mb'`, which matches. Quoting it would ask for a single lexeme no
  tsvector contains, turning a working term into a guaranteed miss.
- **Ask issues one extra Qdrant query** when a pool is session-dominated. Skipped
  when the caller pinned `sourceTypes` — an explicit filter is an instruction,
  not a default to top up.
- **The question is now a committed regression case.** Added to
  `test/fixtures/eval/queries.json` as pool B (`4a1d3705`) with all five entries
  as gold, so `20260726-retrieval-quality-is-measured-not-argued.md`'s harness
  fails if retrieval ever loses it again. Mining merges by id and never
  overwrites, so it survives regeneration.

## Alternatives considered

**Query-side boost alone, no reindex.** Rejected: it cannot fix what is not in
the index. `6.8MB` would still be stored as `8mb`, and the spaced spelling would
still be unreachable. It treats the symptom — a rare term outranked — while
leaving the cause, a rare term that was never recorded.

**Full re-index (dense + sparse).** Rejected: hours of Ollama time to recompute
vectors the change did not affect.

**Emitting the legacy fragments alongside the new tokens**, so the index needs no
rebuild. Rejected: `8mb` is precisely the collision bucket that caused the
failure. Carrying it forward would preserve the noise permanently to avoid a pass
that costs minutes, and leave dead tokens no later version could safely remove.
