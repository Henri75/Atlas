# ADR: Backlog Status — Facts at Scan, Judgment at Query, Truth in the File
Date: 2026-07-29

## Status
Accepted

## Context
- Every project keeps an append-only `kdb/backlog.log`. Resolution was
  expressed ad hoc — `DONE:` here, `RESOLVED:` there, most often nothing at
  all (the fix lands in changelog/component logs and the backlog never hears
  about it). Nobody could tell what was still open.
- The parser only indexed `- [YYYY-MM-DD]` bullets; newer free-form lines
  (no date, no bullet) were silently invisible to search.
- Hard constraints: backlog files are append-only and project-owned; Atlas is
  a read-only lens (never writes to projects); the Postgres+Qdrant index is a
  rebuildable cache (existing durable exceptions: `settings`, `usage_log`).
- Precedent (docs-staleness ADR, 2026-07-10): store what a line proves about
  itself at scan time; derive cross-line, time-dependent judgments at query
  time, where the algorithm can keep improving without a reindex.

## Decision
- **Protocol** (global `~/.claude/references/kdb-protocol.md`, the single
  canonical copy): backlog items are one physical line; resolution is a new
  appended marker line — `RESOLVED|DROPPED|REOPENED [L<n>#<hash6>]: summary` —
  where `L<n>` is the target item's absolute line number (stable: the file is
  append-only) and `#<hash6>` is the first 6 hex of SHA-256 of the target's
  trimmed line. The hash is optional when hand-writing; Atlas always includes
  it in proposed lines. **Last marker in file order wins** (file order is
  chronological by construction; parsed dates are not trusted for ordering).
- **Scan time** stores line-local facts only: `meta.lineHash` on every entry,
  `meta.marker` (structured refs and legacy `DONE:/RESOLVED:/FIXED:/WONTFIX:/
  OBSOLETE:` prefixes), `meta.unstructured` on free-form lines.
  `BACKLOG_PARSER_VERSION` forces a one-time re-parse + in-place meta sync
  (`syncBacklogMeta`) because inserts are dedup-keyed and would otherwise
  never refresh existing rows.
- **Query time** (`buildBacklogView`) does every cross-line judgment:
  hash-verified ref linking with unique-match relocation on mismatch; token-
  containment fuzzy linking for legacy markers (threshold
  `KDB_BACKLOG_MATCH_THRESHOLD`, default 0.5; near-ties and sub-threshold
  scores go to an explicit `unlinked` bucket — never a hard guess); review-
  verdict overlay with **latest signal wins** (markers by file order, verdicts
  by `reviewedAt`; ties → the file wins). Statuses carry provenance
  (`structured` | `reviewed` | `heuristic`) so a fuzzy "resolved" is visibly
  weaker than a written-back one.
- **Reviews**: evidence = scoped hybrid search over the project's other
  sources. The CLI asks Atlas's LLM to judge (a human is on the other end);
  MCP agents get the evidence and judge themselves — they can read the code,
  Atlas cannot. Verdicts are stored in `backlog_review`.
- **Durability contract**: the appended marker line in `backlog.log` is the
  canonical durable record — any index rebuild re-derives it. `backlog_review`
  is durable *working state* (usage_log precedent): it survives reindexing;
  losing the database loses only verdicts never written back, and those items
  honestly revert to open. The `not-written-back` lint keeps that gap visible
  until the caller appends the proposed line.

## Consequences
- Legacy backlogs work immediately (fuzzy linking) and converge to the
  structured format through normal use — every write-back permanently shrinks
  the fuzzy set. History is annotated forward, never edited.
- Heuristic links can legitimately change when the matcher improves — the
  docs-staleness trade, accepted again; provenance labels carry the caveat.
- Accepted limitations: log rotation (never yet observed) would reset line
  numbers and rotated files are not indexed — hash-based relocation is the
  recovery path, and rotated-file indexing is backlogged. An append-only
  violation (hand-edited line) breaks its refs detectably: hash mismatch →
  relocation or an explicit `broken-link` lint, not a silent wrong target.
- Atlas never writes project files: durable write-back stays in the caller's
  hands via each project's blessed append helper.
