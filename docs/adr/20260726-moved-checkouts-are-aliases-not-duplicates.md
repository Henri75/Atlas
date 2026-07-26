# ADR: A Moved Checkout Is the Same Project — Alias It, Don't Re-Attribute It
Date: 2026-07-26

## Status
Accepted

## Context

Atlas attributes Claude Code transcripts to projects by matching the session
directory name — which encodes the session's working directory — against the
configured code roots (`matchClaudeDirToProject`, `packages/core/src/discovery.ts`).
When nothing matches, `claudeDirFallbackSlug` derives a slug from the entire
path, so no history is ever dropped.

That fallback is correct, and it produces a silent problem when a repo moves.
DeepCast has lived at three paths. Its transcripts are therefore filed under
three slugs:

| slug | entries | period |
|---|---|---|
| `deepcast` (rootPath set) | 151,368 | current |
| `users-nasta-documents-coding-new-deepcast` | 16,272 | to 2025-12-22 |
| `volumes-cloudbox-coding-deepcast` | 6,912 | to 2025-11-28 |

Across all projects, **27,300 entries** sit under such slugs — `deepcast`,
`deepcast-lycos`, `google-gemini-pool` and `askall` all have them.

Two consequences, both measured:

- A search scoped to `project: "deepcast"` silently excluded 23,184 entries.
  The user gets a confident, incomplete answer with no indication anything was
  omitted — the same failure class as the 2026-07-15 incident that prompted this
  work: a true-looking answer whose gaps are invisible.
- `SERVER_INSTRUCTIONS` actively told agents these were *"ghost duplicates from
  moved checkouts — prefer the clean slug"*. They are not duplicates. They are
  distinct transcript files from a period the canonical slug has no record of.
  The guidance instructed agents to discard the only copy of that history.

Note this is not the same as an empty-`rootPath` project being *wrong*. Several
such projects are genuinely standalone (`myllm`, `freerouting`, and the
`paperclip` workspaces) and must stay separate.

## Decision

A project whose slug ends with another project's slug is treated as an **older
location of it** — an alias — and scoping expands to include it.

- **`projects.alias_of`** references the canonical project. `resolveProjectAlias`
  matches on slugs alone: both are derived from the same trailing path segments,
  so a moved checkout's slug always ends with its canonical slug. Three guards:
  a `-` boundary (so `notdeepcast` never matches `deepcast`), a non-empty
  `rootPath` on the target (so a ghost cannot alias onto another ghost and
  chain), and longest-match (so `…-deepcast-lycos` resolves to `deepcast-lycos`,
  not `deepcast`). No tie-breaking is needed — `projects.slug` is `UNIQUE`.
- **Recomputed every scheduler tick.** Cheap (tens of rows) and order-independent:
  a canonical project discovered later can adopt a ghost created earlier.
- **`SearchService.search()` expands the scope** before anything filters on it,
  so the vector path and the FTS fallback cannot disagree about what "scoped to
  deepcast" means. Ask measures coverage over the same widened scope, so the
  reported figures describe what was actually searched.
- **`aliasOf` is surfaced** on `atlas_projects`, and the MCP guidance is
  corrected to say these rows are earlier locations whose entries are already
  included when scoping to the canonical slug.

Entries are **not** re-attributed. That is the load-bearing part of this
decision, and the reason for the alias indirection.

## Consequences

- Positive: `project: "deepcast"` now reaches all 174,552 of its entries. The
  incomplete-scoped-answer failure is gone.
- Positive: agents stop being told to discard real history.
- Positive: nothing is re-embedded and no vector payload is rewritten. The
  change is metadata-only and reversible by clearing one column.
- Negative: `atlas_projects` still lists alias rows, so the project list is
  longer than the number of real projects. They now carry `aliasOf`, which is
  honest — folding them away would hide that the split exists at all.
- Negative: alias resolution is a heuristic over slugs. A project genuinely named
  as a suffix of another (`/a/tools` and `/b/x/tools`, unrelated) would be merged
  incorrectly. Accepted: the `rootPath` and longest-match guards make it
  conservative, and the failure is visible in `atlas_projects` rather than silent.
- Operational: entries keep their original `projectSlug` in search results and
  in the Qdrant payload, so a hit may report a slug the caller did not ask for.
  This is deliberate — it shows *where* the history actually came from.

## Alternatives Considered

- **Re-attribute the entries** (`UPDATE entries SET project_id`) and delete the
  ghost rows. The intuitive fix, and unsafe: `Catalog.dedupKey` hashes
  `projectSlug`, so every migrated row would keep a dedup key computed from the
  ghost slug while the next scan computes one from the canonical slug — and
  `ON CONFLICT (dedup_key) DO NOTHING` would then insert all 27,300 entries a
  second time. Doing it correctly means recomputing every dedup key (requires
  reading and re-hashing each body in application code) *and* rewriting the
  `project` payload on every affected vector. Rejected: high blast radius,
  hard to reverse, for a purely cosmetic gain over aliasing.
- **Bump `PROJECT_GROUPING`** and let the indexer's existing scheme-change path
  wipe and re-parse everything. Sanctioned and correct, but it re-embeds 323k
  entries — hours on a contended local Ollama — to fix a scoping bug that
  metadata solves. Rejected as disproportionate.
- **Fix attribution only** (match moved dirs to their project at discovery
  time). Prevents new ghosts but leaves the existing 27,300 entries stranded,
  and mixes new sessions into the canonical project while old ones stay behind —
  the worst of both. Rejected. Worth revisiting *with* aliasing if a future
  re-index happens for another reason.
- **Fold aliases out of `atlas_projects`.** Rejected: the split is real and
  agents benefit from seeing which era came from where.

## References
- Plan: `docs/superpowers/plans/2026-07-25-atlas-trust-hardening.md` (finding D1)
- Companion ADRs: `20260725-vector-catalog-reconciliation.md`,
  `20260725-ask-answer-trust-contract.md`
- KDB: `kdb/components/atlas.log`, entry of 2026-07-26
