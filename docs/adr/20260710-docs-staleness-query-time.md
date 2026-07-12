# ADR: Doc Staleness — Store `archived`, Derive `aging`, Judge at Query Time
Date: 2026-07-10

## Status
Accepted

## Context
- Projects keep outdated docs in conventional folders (`docs/archive`, `_legacy`,
  `Previous`, `_archive`…) that ranked head-to-head with current docs in search
  and polluted Ask answers.
- Hard constraint: never lose information. The index is a cache over read-only
  mounts, but *excluding* files at index time destroys recall invisibly.
- The indexer skips unchanged files via mtime/size scan state, so any stored,
  time-dependent classification would freeze on index day and silently rot.

## Decision
- Index everything; staleness is metadata, applied at query/presentation time.
- `archived` (path conventions, immutable per location) is computed at scan time
  and stored in entry `meta` jsonb + Qdrant `doc_status` payload.
- `aging` (older than `KDB_DOCS_AGING_MONTHS`, default 12) is **derived at query
  time** from the already-stored `occurredAt`; never persisted.
- One shared post-processing step in `SearchService.finalize()` runs on both the
  vector path and the Postgres FTS fallback: archived → score × `KDB_ARCHIVED_PENALTY`
  (default 0.6) + badge; aging → badge only; re-sort; trim (with 2× over-fetch).
- Ask context blocks carry `[ARCHIVED — n mo old]` / `[AGING — …]` labels and the
  system prompt instructs the model to prefer fresh sources and disclose reliance.
- Backfill for pre-existing entries: `DOCS_PARSER_VERSION` setting per project;
  on mismatch, scanDocs syncs meta (jsonb UPDATE) and vector payload
  (`setPayload` by `entry_id`) for unchanged files — no re-parse, no re-embed.

## Consequences
- Positive: nothing is ever hidden or deleted; every knob (penalty, threshold,
  patterns) is config, tunable without touching source files; degraded FTS mode
  ranks by the same rules; agents (MCP) see labeled staleness in-band.
- Negative: doc hits pay one `deriveDocAge` pass per query (negligible); the
  `entry_id` payload index adds a little Qdrant memory; archive detection is
  convention-based — a stale doc sitting in `docs/` root gets only the aging label.
- Operational: docs cap raised 400 → 2000 (depth 4 → 6); overflow now logs a
  per-project warning instead of truncating silently.

## Alternatives Considered
- Exclude archived docs by default, opt back in: cleanest results, but hides
  history users don't know exists. Rejected — labels + downrank preserve recall.
- Store `aging` at scan time: drifts because unchanged files are never rescanned.
  Rejected after self-review.
- LLM classification of staleness: expensive, non-deterministic, unneeded — path
  conventions cover the real corpus (AskAll, Velvet, google-gemini-pool, DeepCast).

## References
- Spec: `docs/superpowers/specs/2026-07-10-docs-staleness-design.md`
- Plan: `docs/superpowers/plans/2026-07-11-docs-staleness-and-stats.md`
- KDB: `kdb/components/atlas.log` entry of 2026-07-10 (the log was `kdbscope.log` until the 2026-07-12 rename)
