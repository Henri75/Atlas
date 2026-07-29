# Backlog Review — Design

2026-07-29 18:00 UTC

## Problem

Every project keeps an append-only `kdb/backlog.log`. Because the file is
append-only, resolution is expressed — inconsistently — by appending a new line
(`DONE: …`, `RESOLVED: …`) or, most often, not at all: the fix lands in
changelog/component/session logs and the backlog never hears about it. Neither
users nor coding agents can tell what is still open. Compounding this, the
current parser (`packages/core/src/parsers/kdbLog.ts`) only indexes
`- [YYYY-MM-DD]` bullet lines; newer free-form lines (no date, no bullet —
observed in this repo's own backlog) are silently skipped.

## Goals

1. **Status view** (fast, LLM-free): per project, every backlog item with a
   derived status — open / resolved / dropped — plus how that status is known.
   Served via REST, CLI and MCP.
2. **Optional review**: confirm that pending items are still pending and/or
   that resolved items were really resolved, using evidence from the indexed
   history (changelog, component/session logs, git commits). CLI callers get an
   Atlas-LLM verdict; MCP callers (coding agents — stronger judges, able to
   read code) get the evidence bundle and judge themselves.
3. **Durable verdicts**: reviews survive; confirmed statuses converge into the
   backlog file itself via proposed write-back lines that the *caller* appends.

## Constraints

- Backlog files are append-only and owned by projects. Atlas is a read-only
  lens: it never writes project files.
- The Atlas Postgres+Qdrant index is a rebuildable cache (existing durable
  exceptions: `settings`, `usage_log`).
- ADR precedent (docs-staleness, 2026-07-10): store what a line proves about
  itself at scan time; derive cross-line / time-dependent judgments at query
  time.
- Backlogs are small (largest observed ~530 lines) — query-time derivation is
  milliseconds.
- kdb log files are re-read in full on every change (`pipeline.ts` uses
  `readFileSync`, not the byte-offset tail reader), so absolute line numbers in
  `sourceRef` are reliable.
- Log rotation (protocol §5 MB) has never occurred and rotated files are not
  indexed today. Accepted limitation, noted in the ADR; hash-based relocation
  (below) is the recovery path if it ever happens.

## Design

### A. Protocol (`~/.claude/references/kdb-protocol.md`)

A machine census found exactly **one** copy (the canonical global file);
project docs reference it rather than copy it. It gains:

- A header line declaring it the single canonical copy (projects reference,
  never copy) plus a timestamped revision-history line per the documentation
  rules. `~/.claude` is not a git repo; the in-file history is the record.
- **Backlog section** (formats were never defined — the root cause of marker
  drift): one physical line per item:
  `- [YYYY-MM-DD] [component] <description>` (component optional).
  Multi-line entries are prohibited going forward; existing ones are tolerated
  by readers.
- **Resolution markers**, each a normal appended backlog line:
  - `- [YYYY-MM-DD] RESOLVED [L<n>#<hash6>]: <summary restating the item> (evidence: …)`
  - `- [YYYY-MM-DD] DROPPED  [L<n>#<hash6>]: <reason>` (wontfix / obsolete)
  - `- [YYYY-MM-DD] REOPENED [L<n>#<hash6>]: <reason>` (regression)
  - `L<n>` is the **absolute line number of the original item** (stable:
    append-only). `#<hash6>` = first 6 hex chars of SHA-256 of the original
    physical line with trailing whitespace stripped. The hash is **optional
    for hand-written lines**; Atlas computes it whenever it proposes a
    write-back line, so the machine-mediated path always carries it.
  - The summary restates the item so the link is self-verifying even without
    the hash.
  - **Last marker in file order wins** (file order is chronological by
    construction; more trustworthy than parsed timestamps).
  - How to find `L<n>`: `atlas backlog <project>` prints it per item; without
    Atlas, `grep -n` the file.
- **index.log format** (also previously undefined; matches existing practice):
  `- [YYYY-MM-DD] <component> — <one-line role>. Log: kdb/components/<component>.log`
- An efficiency pass: compress the Integrity Safeguards prose; keep the file
  small (~4 KB) since it is read at use-time.

### B. Scan time — parser stores line-local facts only

`parseBacklog` is extended (same file, `packages/core/src/parsers/kdbLog.ts`):

- Blank lines and `#`-prefixed lines are skipped. Every other line becomes an
  entry. Lines not matching the dated-bullet format are indexed with
  `meta.unstructured: true` and no `occurredAt` (today they are dropped).
- Every backlog entry stores `meta.lineHash` — the first 6 hex chars of
  SHA-256 of the trimmed physical line. Ref verification, relocation and
  write-back proposals then work from the database alone, without re-reading
  project files (the API container does not mount them).
- Marker detection runs after the optional date/component prefixes:
  - Structured: `RESOLVED|DROPPED|REOPENED [L<n>(#<hash6>)?]:` →
    `meta.marker = { kind, targetLine, targetHash? }`.
  - Legacy (no target): `DONE:|RESOLVED:|FIXED:` → resolution,
    `WONTFIX:|OBSOLETE:` → drop; `meta.marker = { kind, legacy: true }`.
- Marker lines are entries too (searchable), but the status view treats them
  as **annotations**, not items (see C).
- `BACKLOG_PARSER_VERSION` (exported from core, mirroring
  `DOCS_PARSER_VERSION`) is stored per project in `settings`; on mismatch the
  indexer re-parses backlog files even if mtime/size are unchanged. Entry
  identity is deterministic, so unchanged lines keep their ids; previously
  skipped lines appear as new entries.

### C. Query time — `BacklogService` (new, `packages/core/src/backlog.ts`)

Builds the status view on request from the project's `kdb_backlog` entries:

1. **Partition** entries into items vs annotations (marker lines).
2. **Link structured refs**: verify `targetHash` (when present) against the
   stored line content; on mismatch, attempt deterministic relocation (scan
   the file's entries for the unique line matching the hash); unique match →
   relink + lint note; none/multiple → `broken-link` lint, no guess. Without a
   hash, verify via summary↔target token containment; low similarity →
   `ref-mismatch` lint.
3. **Link legacy markers** by fuzzy match: token containment — the share of
   the marker summary's normalized tokens (lowercased, punctuation stripped,
   length ≥ 3) found in the candidate item. Candidates are earlier lines only,
   same-component preferred. Threshold from config
   (`KDB_BACKLOG_MATCH_THRESHOLD`, default 0.5, tuned against real-file
   fixtures). Multiple candidates above threshold → highest score; a near-tie
   (runner-up within 0.1 of the best) → `unlinked resolutions` bucket listing
   the candidates, never a hard guess.
4. **Derive per-item status**: order all signals — markers by file order,
   review verdicts by `reviewedAt` — and let the **latest signal win**; on a
   tie the file wins (file is truth). Statuses: `open`, `resolved`, `dropped`
   (REOPENED yields `open` with history). Provenance is always attached:
   `structured` | `reviewed` | `heuristic`.
5. **Badges**: `stale-review` (project has indexed activity newer than the
   verdict), `not-written-back` (DB verdict without a corresponding file
   marker), `superseded-marker`, `broken-link`, `unstructured`.

Determinism note: heuristic links can legitimately change when the matcher
improves — that is the docs-staleness trade, accepted. Provenance labeling
keeps heuristic statuses visibly weaker, and every write-back permanently
converts a fuzzy link into a structured one, so the fuzzy set only shrinks.

### D. Review engine (optional, per item)

- **Evidence gathering** (shared by both paths): scoped hybrid search over the
  project's `kdb_changelog`, `kdb_component`, `kdb_session`, `git_commit`
  (and `doc`) entries, query = item text; top-k (default 8) with the existing
  degradation ladder (hybrid → sparse → FTS). Results carry entryId, source
  type, date, excerpt, score, hostPath deep link.
- **CLI path (human)**: Atlas's LLM judges per item on the existing
  ask/chatComplete infrastructure (including `EmptyCompletionError`
  handling). Verdict `{status: confirmed-open | likely-resolved |
  confirmed-resolved | inconclusive, confidence, reasoning, citations}` is
  stored in `backlog_review` and the CLI prints the proposed write-back line
  (hash pre-computed). Defaults: open items only, `--item N` for one,
  `--limit N`, sequential with progress.
- **MCP path (agent)**: three tools —
  - `atlas_backlog` — the status view;
  - `atlas_backlog_evidence` — per-item evidence bundle (agent judges,
    optionally verifies in code);
  - `atlas_backlog_verdict` — records the agent's judgment; the response
    returns the exact marker line for the agent to append via the project's
    own blessed helper.
- Verdict rows: `{project, sourcePath, line, status, confidence, note,
  citations, reviewer, reviewedAt}`, upsert keyed on (project, sourcePath,
  line). `reviewer` distinguishes `atlas-llm:<model>` from agent/CLI callers.
- Atlas never writes project files.

### E. Surfaces

- **REST**: `GET /api/projects/:slug/backlog` (view);
  `POST /api/projects/:slug/backlog/review` `{line}` (evidence + LLM verdict,
  one item per call); `POST /api/projects/:slug/backlog/verdict` (record a
  caller verdict). Evidence-only: `review` with `{judge:false}` — returns the
  bundle and stores nothing; a verdict row is written only by a judged review
  or an explicit `verdict` call.
- **CLI**: `atlas backlog <project> [--review] [--item N] [--limit N]
  [--json]`; bare `atlas backlog` = cross-project open/resolved/dropped
  counts.
- **MCP**: the three tools above, registered alongside the existing ten in
  `packages/mcp/src/tools.ts`.
- **UI**: out of scope (feature is scoped to CLI/MCP); a line goes to
  `kdb/backlog.log`.
- **Docs**: `docs/api.md`, `docs/cli.md`, `docs/mcp.md` updated with the new
  surfaces.

### F. Durability contract (ADR)

The appended marker line in `backlog.log` is the canonical durable record —
it survives any index rebuild because it is re-derived from the file. The
`backlog_review` row is working state plus evidence detail (precedent:
`usage_log`): it survives reindexing; losing the database loses only verdicts
never written back, and those items honestly revert to `open`. The
`not-written-back` badge makes the gap visible and self-healing. Recorded in
`docs/adr/20260729-backlog-status-derivation.md` together with the `L<n>`
limitations (rotation, append-only violations) and their mitigations
(hash verification, relocation, echo-summary check).

### G. Error handling

- Lints, not failures: dangling/broken refs, ref-target mismatches,
  superseded markers, unstructured lines — all surfaced as annotations on the
  view, the view itself always renders.
- Review degrades along the existing search ladder; when the LLM is
  unavailable the API returns the evidence with an explicit
  `llm_unavailable` error rather than a fabricated verdict (per the ask
  answer-trust ADR).

### H. Testing

- Parser fixtures drawn from the real observed variants across the 14
  projects' backlogs (dated bullets with/without component, `DONE:` /
  `RESOLVED:` legacy markers, structured markers, free-form undated lines,
  `#` comments).
- Unit: hash verify/relocate, containment matcher + threshold, last-wins
  ordering (markers × verdicts), annotation partitioning, badge derivation.
- API: endpoint tests alongside `test/api/routes.test.ts`.
- CLI/MCP: smoke tests following existing patterns.

## Out of scope (backlogged, not built)

- Web UI backlog view.
- Indexing rotated `*.log.YYYYMMDDTHHMMSS` files.
- Index-time changelog cross-referencing.

## Review trail

Design red-teamed by the independent Assessor (session
`9fff7d2a383547ba9682a3265132a654`, verdict needs-work → all four concerns
addressed above: hash-verified refs, last-wins rule, provenance-labeled
fuzzy links, not-written-back badge).
