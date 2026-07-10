2026-07-10 UTC

# Design: Complete docs/ Indexing + Staleness Handling

**Revision History**
- 2026-07-10: Initial version (post self-review: query-time aging, parser-version backfill, shared post-processing for FTS fallback).

## Problem

1. **Coverage gap.** `listDocFiles()` walks root `*.md` + `docs/` but caps at 400 files and depth 4, silently. DeepCast has 481 docs → 80+ files are dropped with no trace.
2. **No staleness signal.** Projects keep outdated docs in conventional folders (`AskAll/docs/archive`, `Velvet/docs/_legacy`, `google-gemini-pool/docs/_archive`, `DeepCast/docs/Previous/`), but every doc section ranks purely on similarity. Stale docs compete head-to-head with current ones in search and pollute ask-mode answers.

**Constraint:** never lose information. Nothing may be deleted, skipped, or hidden at index time. Staleness is metadata; all handling happens at query/presentation time so every knob is tunable later without re-reading files.

## Design

### 1. Coverage

- Cap 400 → 2000 files/project; walk depth 4 → 6.
- **No silent caps:** if a project still exceeds the cap or depth, log a warning naming the project and the number of dropped files.
- `.md` only (unchanged). Survey found only ~45 non-md files across 20 projects, mostly machine artifacts (html/yaml/dbml).

### 2. Staleness model

Two orthogonal signals; only one is stored:

- **`archived`** — computed at scan time from the path (relative to project root). True when any directory segment or the filename stem matches, case-insensitive, optional leading `_`:
  `archive`, `archives`, `archived`, `legacy`, `old`, `deprecated`, `previous`, `obsolete`, `superseded`, `outdated`, `backup`, `backups`, `bak`.
  Stored in the entry's existing `meta` jsonb (no Postgres migration) and as indexed keyword `doc_status` in the Qdrant payload (server-side filterable).
- **`aging`** — derived at **query time**: `docStatus !== 'archived'` and `occurredAt` (file mtime, already stored) older than `KDB_DOCS_AGING_MONTHS` (default 12). Never stored — stored aging would drift because unchanged files are never rescanned. Entries with no `occurredAt` are treated as active (no false labels).

### 3. Backfill

Doc scan state gains a parser version (`docsParserVersion`). Bumping it invalidates existing doc scan states, forcing one full docs re-parse that attaches `archived` to pre-existing entries. Without this, mtime-based scan state would skip unchanged files forever.

### 4. Ranking & display — downrank + label, never hide

- One shared post-processing step in `SearchService` that **both** the vector path and the Postgres FTS fallback flow through:
  - over-fetch ~1.5× limit,
  - multiply the score of `archived` hits by `KDB_ARCHIVED_PENALTY` (default 0.6),
  - derive `aging` labels,
  - re-sort, trim to limit.
- `aging` gets a label only — **no penalty** (old-but-valid runbooks must not be buried).
- `SearchHit` gains `docStatus: 'active' | 'aging' | 'archived'` (+ age in months for display). `catalog.getEntries` and `catalog.ftsSearch` surface `meta.docStatus`.
- UI, CLI, MCP render a badge: `archived` / `aging (14 mo)`.
- New optional search filter `docStatus` (UI toggle, CLI flag, MCP param) to exclude or target archived docs explicitly.

### 5. Ask mode

- Context blocks are labeled: `[ARCHIVED — Velvet/docs/_legacy/auth.md, last modified 2024-03]`, `[AGING — …]`.
- System prompt addition: prefer active and recent sources; if relying on archived/aging material, say so explicitly; when sources conflict, trust the newer one.

### 6. Information preservation

Archived docs remain fully indexed, embedded, and searchable. The penalty, threshold, patterns, and badges are all configuration — changing them never requires touching source files. A forced docs reindex restores any state.

## Testing plan

- **New unit tests:** path classifier (each convention, `_`-prefixed variants, nested `Previous/archive/`, negatives like `docs/architecture/`); aging derivation boundary (11 vs 13 months, missing occurredAt); parser carries archived flag; shared post-processor (archived similar-score hit ranks below active; applies on FTS path too); ask context labeling; cap-warning fires when > 2000 files.
- **Modified:** existing `docsMd` parser tests gain the new ctx field.

## Blast radius

`scanners.ts` (cap/depth/warning + path classifier), `pipeline.ts` (scanDocs version bump), `parsers/docsMd.ts` (ctx flag), `types.ts` (SearchHit, filters), `qdrant.ts` (payload field + payload index), `search.ts` (shared post-processing), `catalog.ts` (expose meta.docStatus in getEntries/ftsSearch), ask context builder, UI/CLI/MCP rendering. No Postgres migration; one additive Qdrant payload index. Cross-component → ADR required (docs/adr/).
