# Docs Staleness + Stats Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete docs/ indexing (cap 2000, loud truncation), tag archived docs at index time, derive aging at query time, downrank+label stale docs in every surface (search, ask, UI, CLI, MCP) — then extend the dashboard with per-source detail and indexing activity.

**Architecture:** Staleness is metadata, never a filter at index time. `archived` (path conventions) is stored in entry `meta` jsonb + Qdrant `doc_status` payload; `aging` is derived at query time from the stored `occurredAt` so it can never drift. One shared post-processing step in `SearchService` decorates and downranks on both the vector path and the FTS fallback. A parser-version setting forces a one-time meta/payload sync for pre-existing entries without re-embedding (Qdrant `setPayload` by `entry_id`).

**Tech Stack:** TypeScript monorepo (packages/core, indexer, api, ui, cli, mcp), Postgres 18, Qdrant, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-10-docs-staleness-design.md`
- Never delete/skip content at index time; all staleness handling is query/presentation time.
- New env vars: `KDB_DOCS_AGING_MONTHS` (default 12), `KDB_ARCHIVED_PENALTY` (default 0.6).
- Docs cap 2000 files, depth 6, `.md` only; truncation logs a per-project warning.
- No `Date.now()` inside pure functions — pass `now` for testability.
- Tests live in `test/<package>/`, vitest. Run: `npx vitest run test/...`
- Commits: casual human tone, category prefix, NO Claude/Anthropic co-author trailer.
- KDB logging per CLAUDE.md §2 via `bin/kdb_append` (component: kdbscope).

---

### Task 1: `docStatus` core module (classifier + derivation)

**Files:**
- Create: `packages/core/src/docStatus.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `test/core/docStatus.test.ts`

**Interfaces:**
- Produces: `DOCS_PARSER_VERSION: number`, `isArchivedDocPath(relPath: string): boolean`, `deriveDocAge(occurredAt: string | undefined, agingMonths: number, nowMs: number): { status: 'active' | 'aging'; ageMonths?: number }`, `DEFAULT_AGING_MONTHS = 12`, `DEFAULT_ARCHIVED_PENALTY = 0.6`.

- [ ] Write failing tests: archived matches every convention (`archive`, `archives`, `archived`, `_archive`, `legacy`, `_legacy`, `old`, `deprecated`, `previous`, `Previous/archive` nested, `obsolete`, `superseded`, `outdated`, `backup`, `backups`, `bak`, filename stem `auth.deprecated.md`), negatives (`docs/architecture/x.md`, `docs/golden/x.md`, `README.md`), case-insensitivity. Aging: 13 months old → `aging` with `ageMonths: 13`; 11 months → `active`; missing occurredAt → `active` without ageMonths.
- [ ] Implement:

```ts
const ARCHIVED_SEGMENT =
  /^_?(archived?s?|legacy|old|deprecated|previous|obsolete|superseded|outdated|backups?|bak)$/i;

export const DOCS_PARSER_VERSION = 2;
export const DEFAULT_AGING_MONTHS = 12;
export const DEFAULT_ARCHIVED_PENALTY = 0.6;

/** Path is relative to the project root; filename stem tokens count too. */
export function isArchivedDocPath(relPath: string): boolean {
  const parts = relPath.split('/');
  const file = parts.pop() ?? '';
  if (parts.some((seg) => ARCHIVED_SEGMENT.test(seg))) return true;
  const stem = file.replace(/\.md$/i, '');
  return stem.split(/[._-]/).some((tok) => ARCHIVED_SEGMENT.test(tok));
}

const MONTH_MS = 30.44 * 24 * 3600 * 1000;

/** Derived at query time on purpose: stored aging would drift (unchanged files are never rescanned). */
export function deriveDocAge(
  occurredAt: string | undefined, agingMonths: number, nowMs: number,
): { status: 'active' | 'aging'; ageMonths?: number } {
  if (!occurredAt) return { status: 'active' };
  const t = Date.parse(occurredAt);
  if (Number.isNaN(t)) return { status: 'active' };
  const ageMonths = Math.floor((nowMs - t) / MONTH_MS);
  return ageMonths >= agingMonths ? { status: 'aging', ageMonths } : { status: 'active', ageMonths };
}
```

- [ ] Tests pass; commit `feature: doc staleness classifier + query-time aging derivation`.

### Task 2: scanner — cap 2000, depth 6, archived flag, dropped count

**Files:**
- Modify: `packages/indexer/src/scanners.ts:122-140` (`listDocFiles`)
- Test: `test/indexer/scanners.test.ts`

**Interfaces:**
- Produces: `listDocFiles(projectRoot: string, cap = 2000): { files: { path: string; archived: boolean }[]; dropped: number }`

- [ ] Failing tests: temp tree with `docs/archive/old.md` → archived true; `docs/guide.md` → false; root `README.md` → false; cap exceeded → `dropped > 0`.
- [ ] Implement: walk depth ≤ 6; classify with `isArchivedDocPath(p.slice(projectRoot.length + 1))`; count files beyond cap in `dropped` (keep walking to count, or stop and report `found - cap` from a counter).
- [ ] Update `scanDocs` caller (Task 3 does the pipeline change; here just keep compile green by adjusting the one call site).
- [ ] Tests pass; commit `feature: docs scan covers 2000 files deep 6, flags archived paths, counts dropped`.

### Task 3: pipeline — payload doc_status, truncation warning, version-forced sync

**Files:**
- Modify: `packages/indexer/src/pipeline.ts` (`indexEntries` payload, `scanDocs`)
- Modify: `packages/core/src/parsers/docsMd.ts` (ctx gains `archived?: boolean` → entries `meta: { docStatus: 'archived' }`)
- Modify: `packages/core/src/qdrant.ts` (`ensure()` always creates payload indexes incl. `doc_status` keyword + `entry_id` integer; new `setDocStatus(entryIds, status)` via setPayload/deletePayload with `entry_id` any-match filter, batches of 500)
- Modify: `packages/core/src/catalog.ts` (new `syncDocStatus(projectId, sourcePath, archived): Promise<number[]>` — jsonb update returning changed ids; `entriesAfter` selects `meta` so backfills keep payload)
- Test: `test/core/docsMd.test.ts`, `test/indexer/pipeline.test.ts`, `test/indexer/indexEntries.test.ts`

**Interfaces:**
- Consumes: `listDocFiles` new shape, `DOCS_PARSER_VERSION`.
- Produces: Qdrant payload `doc_status?: 'archived'`; setting key `docs_parser_version:<projectId>`.

- [ ] Failing tests: parser sets meta.docStatus when ctx.archived; indexEntries payload carries `doc_status`; scanDocs with fake catalog: version mismatch → unchanged file still gets `syncDocStatus` + `vectors.setDocStatus` called; version match → skipped; dropped>0 → warning logged once per project.
- [ ] scanDocs core:

```ts
const { files, dropped } = listDocFiles(job.rootPath);
if (dropped > 0) console.warn(`[indexer] ${job.projectSlug}: docs cap hit, ${dropped} file(s) not indexed`);
const verKey = `docs_parser_version:${projectId}`;
const syncAll = (await deps.catalog.getSetting(verKey)) !== String(DOCS_PARSER_VERSION);
for (const { path, archived } of files) {
  // parse when changed (ctx.archived), else when syncAll: catalog.syncDocStatus + vectors.setDocStatus
}
await deps.catalog.setSetting(verKey, String(DOCS_PARSER_VERSION));
```

- [ ] `catalog.syncDocStatus` SQL: archived → `UPDATE entries SET meta = meta || '{"docStatus":"archived"}' WHERE project_id=$1 AND source_path=$2 AND source_type='doc' AND meta->>'docStatus' IS DISTINCT FROM 'archived' RETURNING id`; not archived → `meta - 'docStatus'` where currently set.
- [ ] Tests pass; commit `feature: archived docs tagged in pg meta + qdrant payload, one-time version sync, loud cap warning`.

### Task 4: filters + shared post-processing in search

**Files:**
- Modify: `packages/core/src/types.ts` (`SearchFilters.docStatus?: 'active' | 'archived'`; `SearchHit.docStatus?: 'aging' | 'archived'`, `SearchHit.ageMonths?: number`)
- Modify: `packages/core/src/qdrant.ts` (`buildQdrantFilter` returns `{ must, must_not? }`; `docStatus: 'archived'` → must match, `'active'` → must_not match)
- Modify: `packages/core/src/catalog.ts` (`getEntries`/`ftsSearch` select `e.meta`; ftsSearch docStatus WHERE; ftsSearch hits carry meta through)
- Modify: `packages/core/src/search.ts` (constructor opts `{ archivedPenalty?, agingMonths? }`; over-fetch 2× (≤100); `decorate(hits)`: for `source_type === 'doc'` — meta.docStatus archived → penalty × score + docStatus 'archived'; else deriveDocAge → 'aging' label; re-sort desc, trim)
- Modify: `packages/api/src/main.ts` (pass cfg.docs to SearchService), `packages/api/src/app.ts` (`docStatus` query param)
- Modify: `packages/core/src/config.ts` (`docs: { agingMonths, archivedPenalty }` from env)
- Test: `test/core/qdrantFilter.test.ts`, `test/core/search.test.ts`, `test/core/config.test.ts`, `test/api/routes.test.ts`

- [ ] Failing tests: filter builder both directions; search: archived hit with equal raw score lands below active hit, `docStatus`/`ageMonths` populated, FTS fallback path decorated identically; config env parsing.
- [ ] Tests pass; commit `feature: search downranks archived docs + labels aging, docStatus filter end to end`.

### Task 5: ask mode gets the signal

**Files:**
- Modify: `packages/core/src/ask.ts` (`buildAskPrompt` block header gains ` [ARCHIVED]` / ` [AGING — 14 mo old]`; SYSTEM_PROMPT gains: 'Context blocks may be labeled ARCHIVED or AGING. Prefer active and recent sources; if you rely on labeled material, say so; when sources conflict, trust the newer one.')
- Test: `test/core/ask.test.ts`

- [ ] Failing test: hit with docStatus 'archived' renders `[ARCHIVED]` in prompt; aging renders age.
- [ ] Tests pass; commit `feature: ask prompt labels stale sources so the LLM can discount them`.

### Task 6: surfaces — UI badge + filter, CLI badge + flag, MCP param

**Files:**
- Modify: `packages/ui/src/types.ts` (SearchHit mirror), `packages/ui/src/views/SearchView.tsx` (status select `['', 'active', 'archived']` labeled `any status / exclude archived / archived only`; badge next to Stamp: `archived` in report color, `aging (Nmo)` faint)
- Modify: `packages/cli/src/main.ts` (`--doc-status <s>` option; printHit appends red `[archived]` / yellow `[aging 14mo]`)
- Modify: `packages/mcp/src/tools.ts` (kdb_search `doc_status: z.enum(['active','archived']).optional()` → `docStatus` qs param; description notes archived docs are downranked and labeled)
- Test: `test/mcp/tools.test.ts`

- [ ] Tests pass; UI typechecks (`npx tsc -p packages/ui` or build); commit `feature: stale-doc badges + filters in UI, CLI, MCP`.

### Task 7: dashboard data — per-source detail, activity, runs

**Files:**
- Modify: `packages/core/src/catalog.ts`: add

```ts
sourceDetail(): // per source_type: entries, files (distinct source_path), volumeBytes (sum length(body)), lastIndexedAt (max created_at)
indexingActivity(days = 30): // [{ day: 'YYYY-MM-DD', sourceType, count }] from created_at
recentRuns(limit = 10): // id, kind, startedAt, finishedAt, stats
archivedDocsCount(): // count where source_type='doc' and meta->>'docStatus'='archived'
```

- Modify: `packages/api/src/app.ts` `/api/dashboard` → add `sourceDetail`, `activity`, `runs`, `archivedDocs` (Promise.all alongside existing).
- Test: `test/api/routes.test.ts` (fake catalog returns fixtures; response carries the new fields)

- [ ] Tests pass; commit `feature: dashboard api exposes per-source detail, 30-day indexing activity, recent runs`.

### Task 8: dashboard UI + CLI status

**Files:**
- Modify: `packages/ui/src/types.ts` (Dashboard gains `sourceDetail`, `activity`, `runs`, `archivedDocs`)
- Modify: `packages/ui/src/views/DashboardView.tsx`:
  - Upgrade "What is indexed" rows with files / volume / last-indexed columns (same SpineRow-less row idiom, `bytes()`/`relativeTime()` from format.ts).
  - New "Indexing activity" section: 30 daily stacked bars (divs, SOURCE_META colors, hover title with exact per-source counts), consistent with the existing SourceBreakdown idiom.
  - New "Recent runs" list: kind, relative time, duration, chunks.
  - Archived docs count shown as a hint row under docs.
- Modify: `packages/cli/src/main.ts` `status`: by-source table gains files + last-indexed columns; add `indexed today / last 7 days` line from activity.
- Test: `test/ui/format.test.ts` unaffected; typecheck + vitest run all.

- [ ] All tests pass; commit `feature: overview shows per-source volumes, indexing activity, recent runs`.

### Task 9: docs, ADR, KDB logs, push

**Files:**
- Create: `docs/adr/20260711-docs-staleness-query-time.md` (template per CLAUDE.md §7)
- Modify: `docs/configuration.md` (new envs), `docs/api.md` (docStatus param, dashboard fields), `docs/architecture.md` (staleness section), `docs/index.md` if it lists pages
- KDB: `bin/kdb_append` — changelog COMPLETED lines, component entry to `kdb/components/kdbscope.log`, session block to `kdb/session.log`; rebuild views (`node bin/kdb_rebuild.mjs` or make target)
- [ ] `npx vitest run` full suite green; commit `documentation: staleness design, new envs, dashboard fields; kdb entries`; `git push`.
