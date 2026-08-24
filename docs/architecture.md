2026-07-09 01:20 UTC

# Architecture

## Revision History
- 2026-08-19 22:01 UTC — Multi-machine: new *Machines* section (machine model, sync engine, dedup key v3, resolution). See `docs/multi-machine.md` (runbooks) and `docs/adr/20260819-multi-machine-one-active-instance.md` (decision).
- 2026-07-17 15:49 UTC — Documented *Concurrency and data integrity*: why many simultaneous agents + a background reindex never corrupt data (stateless reads, idempotent `ON CONFLICT` writes, collision-free job keys, lone-append telemetry), and the single-instance `api`/`mcp` assumption.
- 2026-07-13 00:20 UTC — Multi-project scope (search/ask/timeline); UI information architecture: rail holds views, a persistent scope bar holds projects. See *Scoping by project*.
- 2026-07-12 22:50 UTC — Answer telemetry: the served model (from the gateway's headers) replaces the configured one, plus token usage, TTFT and generation rate. See *Served model vs configured model*.
- 2026-07-12 13:50 UTC — Renamed the product to **Atlas** (was KDBScope). See *Naming: Atlas vs KDB* below for what did and did not change.
- 2026-07-11 04:35 UTC — Ask mode: soft project scope with all-projects fallback (`scopeFallback`); context reranking (doc boost + `claude_session` cap) so self-indexed chatter stops crowding out docs; multi-value `source` filter.
- 2026-07-10 22:24 UTC — Doc staleness: archived/aging model, query-time ranking, version-forced backfill.
- 2026-07-09 22:25 UTC — Message kinds; distiller keeps all prose + records actions; EXTRACTION_SCHEME.
- 2026-07-09 16:00 UTC — Host vs container paths; multi-root discovery; PROJECT_GROUPING.
- 2026-07-09 01:20 UTC — Initial version.

## Naming: Atlas vs KDB

Two different things used to share the name "kdb", which made the codebase hard
to talk about. They are now separated, and the separation is load-bearing:

- **Atlas** is *this tool* — the indexer, API, MCP server, CLI and UI. Anything
  that names the product is `atlas`: the npm workspace, the `@atlas/*` packages,
  the `atlas` CLI command, the `atlas` MCP server and its ten `atlas_*` tools.
- **KDB** is *one of the four things Atlas indexes* — the append-only knowledge
  base of `changelog.log` / `session.log` / `components/*.log` files that each
  project keeps under its own `kdb/` directory (see the root `CLAUDE.md` §2).
  Anything that names **that data** keeps the `kdb` prefix, deliberately: the
  source type `kdb`, the entry types `kdb_changelog`, `kdb_session`,
  `kdb_component`, `kdb_backlog`, `kdb_report`, the `kdbLog` parser, this repo's
  own `kdb/` directory, and the `bin/kdb_append` / `bin/kdb_rebuild` helpers.

So `atlas search pgbouncer -s kdb_changelog` reads correctly: *ask Atlas to
search KDB changelogs*. Renaming the `kdb_*` entry types to `atlas_*` would be
wrong — they would then claim the content is about Atlas, when it is content
Atlas merely reads.

Some **internal datastore identifiers still say `kdbscope`** (the Postgres
database and role, the Qdrant collection prefix `kdbscope_<provider>_<model>_<dim>`,
the BullMQ queue `kdbscope-scan`, the Redis scheduler lock, the deterministic-id
namespace in `ids.ts`, and the `KDBSCOPE_API_URL` env var). These are *not*
cosmetic leftovers to tidy up: each one is the key under which existing data is
stored. Changing the id namespace or the collection prefix invalidates every
dedup key and Qdrant point id and forces a full re-index of ~280k entries. They
were left alone on purpose. The Docker Compose project name is pinned to `kdb`
in `docker-compose.yml` for the same reason — it fixes the volume prefix
(`kdb_pg_data`, …) so the checkout directory can be renamed freely.

## Services

| Service | Package | Role |
|---|---|---|
| indexer | `packages/indexer` | discovery → incremental scan → parse → chunk → embed → upsert (BullMQ worker + cron scheduler behind a Redis lock) |
| api | `packages/api` | Hono REST; owns search/ask orchestration |
| mcp | `packages/mcp` | streamable-HTTP MCP, 10 tools proxying the API |
| ui | `packages/ui` | React SPA behind nginx (proxies `/api`) |
| qdrant | image | vectors: named `dense` + `sparse` (IDF modifier) per collection |
| redis | image | BullMQ queue, scheduler lock |
| postgres | image | catalog: projects, entries, sessions, scan state, errors, runs, settings |

All domain logic lives in `packages/core`; services are thin wrappers, which is
what keeps the unit tests fast and hermetic.

## Machines

Full design and rationale: `docs/superpowers/specs/2026-08-19-multi-machine-design.md`;
decision record: `docs/adr/20260819-multi-machine-one-active-instance.md`; the
operator runbook (enrolling a machine, moving the stack, the migration
rollout ritual, LAN access) lives at `docs/multi-machine.md`.

**One active instance holds THE index.** There is no full stack per machine
and no per-machine index to fuse — every other configured machine is a
*source*, pulled from, never a peer index. This keeps answers consistent
regardless of which machine you ask from, at the cost of the active instance
being a single point of index availability (source data is unaffected — see
*Moving the stack*, `docs/multi-machine.md`).

- **Machine model.** `config/machines.yaml` (committed, mounted read-only
  into `indexer`/`api`) is the fleet SSoT: name (frozen once data exists),
  address, SSH user, code roots, Claude projects dir, `enabled`. Each running
  host names itself via `ATLAS_SELF` in its own gitignored `.env` — never
  hostname-guessed, and boot fails loudly if it is unset or names no entry.
  `packages/core/src/machines.ts` owns the schema; `atlas machines
  add|remove|list` edits and reports on it.
- **Sync engine.** A new BullMQ job type (`sync:<machine>`, `indexer`) runs
  `rsync` over SSH into a named volume (`remote_mirror`, mounted only in
  `indexer`) on `sync.intervalMin` (default 10), skipping disabled or
  unreachable (asleep) machines cleanly rather than erroring. Once synced,
  the mirror is read by the same four scanners as any local checkout — they
  stay entirely machine-blind. Safety rails: a destination-prefix guard on
  `--delete`, `--partial-dir` (never bare `--partial`, which would leave a
  truncated file under its final name), and git transient state excluded so
  a mid-sync `.git` never poisons a `git log` watermark permanently (it
  fails into `index_errors` and self-heals next pass instead).
- **Identity — dedup key v3.** Entry identity moved from hashing the
  absolute container `sourcePath` to a machine-independent normalized form
  (project-relative paths for kdb/docs, `.` + commit sha for git, and a
  scope of the literal `claude` — deliberately dropping the project slug —
  for transcripts, so a Migration-Assistant-copied `~/.claude/projects`
  corpus dedups instead of re-embedding under new attribution). Migrated
  in-place, once, resumable, and rehearsed against a throwaway copy of the
  live catalog before ever running for real. No vector moves: Qdrant point
  ids still hash the *stored* `source_path` under the frozen v2 id
  namespace. See the ADR for the full key design and why it does not
  re-trigger the moved-checkouts alias ADR's revisit clause.
- **Resolution.** Three kinds of client (CLI, the `atlas-connect` MCP shim,
  the browser) need to find whichever machine is currently active. A
  nonce-challenged, HMAC-proved `/api/instance` endpoint lets a host-side
  resolver (`packages/core/src/resolve.ts`) probe every configured machine
  and demand **exactly one** proof-valid, non-conflicted responder — zero or
  multiple is a loud, named error, never a silent pick. A continuous
  single-active guard (the `api` service) re-probes while running, so a
  peer that comes back online mid-session is caught within one tick on both
  sides. `atlas-connect` (`claude mcp add atlas -- atlas-connect`) is a tiny
  stdio MCP shim that resolves lazily and never needs re-registering, no
  matter which machine ends up active. `atlas which` / `atlas open` expose
  the same resolution for humans.
- **Provenance.** Every entry/session carries `machine` — the machine of
  **first ingestion**, not presence (shared git-synced content belongs to
  whichever machine synced it first). Search/CLI/MCP expose it as a filter
  with that documented semantic; `project_locations` (per-project, per-
  machine) is the presence signal. See *Known limitations* in
  `docs/multi-machine.md`.

## Concurrency and data integrity

Many clients hit Atlas at once — several Claude Code agents plus the UI — while
the indexer writes in the background. Nothing corrupts, by construction:

- **Reads are stateless.** Each API request is an independent Hono handler; the
  MCP server builds a *fresh* server+transport per request
  (`sessionIdGenerator: undefined`), so no two callers share mutable state.
  Concurrent reads that outnumber the Postgres pool (`max: 10`) **queue and
  drain** — they add latency, never errors. Qdrant/Redis/the LLM gateway are
  themselves concurrency-safe.
- **The write path is idempotent.** `entries.dedup_key` is `UNIQUE` and every
  insert is `ON CONFLICT (dedup_key) DO NOTHING`, so the same content inserted
  by two workers — or by an agent-triggered reindex racing the scheduler tick —
  yields exactly one row. `insertEntries` also collapses duplicate keys *within*
  a single multi-row statement, because `ON CONFLICT` cannot dedup a row against
  itself in one statement. Readers see a consistent MVCC snapshot throughout.
- **Writers can't collide.** Scan jobs carry deterministic BullMQ ids keyed on
  `(project, source)`, so two jobs for the same file collapse into one rather
  than running in parallel. The cron scheduler runs behind a Redis lock
  (`SET NX EX`); boot migrations serialise on `pg_advisory_lock(732015)`.
- **Telemetry is a lone append.** `usage_log` writes are single fire-and-forget
  INSERTs (no read-modify-write), so concurrent agents each append their own row
  and the write never blocks or fails the request it measures.

**Load-bearing assumption: `api` and `mcp` run as single instances** (no Compose
`replicas`). The guarantees above hold regardless, but the in-process 30s
storage cache and the `active_collection` follow both assume one process each —
scaling them out needs shared caching first. See *Operations → Scaling*.

## Data model

- **Entry** (Postgres `entries`): browsable unit — one changelog line, one session
  block, one commit, one doc section, one distilled conversation event. Carries a
  deterministic `dedup_key` so re-scans are idempotent, plus a generated `tsvector`
  used as the search fallback.
- **Chunk** (Qdrant point): searchable unit (~1800 chars, 200 overlap), payload
  `{entry_id, project, source_type, component, session_id, kind, occurred_at}`,
  point id = deterministic UUID of (project, sourcePath, entryId, seq).
- **Session** (`sessions`): one Claude Code transcript; title, prompt/action
  counts, files-touched and timespan merged across incremental tail reads.

## Sources and parsers

| Source | Parser | Incremental strategy |
|---|---|---|
| kdb changelog/session/backlog/component logs | `parsers/kdbLog.ts` | whole-file on mtime/size change (files are small; dedup makes it idempotent) |
| kdb loose reports (`kdb/*.md` not generated views) | `parsers/docsMd.ts` | whole-file |
| Claude transcripts (`~/.claude/projects/**.jsonl`) | `parsers/claudeJsonl.ts` | **byte-offset tail reads** — only appended lines are parsed/embedded |
| git history | `parsers/gitLog.ts` | `git log <lastSha>..HEAD` |
| docs (`README.md`, `docs/**/*.md`) | `parsers/docsMd.ts` | whole-file on change |

The Claude distiller keeps **every** user prompt and every piece of assistant
prose, plus a compact record of the actions taken; it drops tool results,
thinking blocks, progress events and base64 payloads — the genuinely bulky,
low-signal parts. That is what turns 11 GB of transcripts into a few hundred MB
of meaningful text.

An earlier version dropped assistant messages under 280 characters. Measured on
real transcripts, that discarded ~53% of Claude's replies (a short *"No security
findings."* is exactly what you go looking for later) to save ~7% of the prose
volume. **Length is a poor proxy for value; kind is a good one.**

## Message kinds

Each captured session message is classified at parse time — deterministic, free,
no LLM — so search can ask for intent directly rather than guessing from prose:

| Kind | What it is |
|---|---|
| `prompt` | something the user asked for |
| `plan` | a plan or spec the user handed over |
| `insight` | a `★ Insight` block |
| `summary` | a `## Summary` / *What I did* wrap-up |
| `action` | tools that changed something (edits, commands, agents); one entry per turn |
| `response` | everything else Claude said |

The kind reaches the Qdrant payload **and** the Postgres fallback, so
`GET /api/search?q=…&kind=insight` works in hybrid and degraded modes alike.
`EXTRACTION_SCHEME` in `packages/core/src/parsers/claudeJsonl.ts` is bumped
whenever this rule changes, which rebuilds the derived index at the next boot.

Session metadata (title, prompt count, action count, timespan, files touched) is
gathered across the **whole** stream even once the per-session entry cap stops
entry collection: Claude writes its `summary` event at either end of the file, so
bailing out early silently loses the title. Sessions with no summary fall back to
their first prompt — a raw UUID is a useless label.

## Search pipeline

```
query ──► sparse encode (local, no network)
      └─► dense embed (provider) ──► Qdrant Query API
                                     prefetch: dense + sparse, fusion: RRF
                                     └─► hydrate entries from Postgres
degradation: hybrid → sparse-only (embedder down) → Postgres FTS (qdrant down)
```

## Ask mode

Retrieval → rerank → numbered context blocks → OpenAI-compatible
`chat/completions` (G2P preset or any endpoint) → answer with `[n]` citations.
`AskService` layers two behaviors over raw search that keep answers grounded:

- **Soft project scope.** A `project` filter is applied as a hard filter (a
  scoped question usually wants scoped results), but when it matches *nothing*
  the search widens to all projects and the result is flagged with
  `scopeFallback: {requested, usedAllProjects}`. Without this, asking about a
  feature under the "wrong" slug (G2P is indexed as `google-gemini-pool`, not
  `deepcast`) returned a confident "not found" instead of the answer that lived
  one project over. The prompt is told to open by naming the empty scope.
- **Context reranking (`rerankForContext`).** Because Atlas indexes its own
  operators' conversations, a debugging transcript about "feature X" out-matches
  the doc that *explains* X — the transcript echoes the question verbatim, the
  doc uses different words. Left alone, Ask answers from chatter. So the pool is
  over-fetched (k×3), each hit is multiplied by a per-source-type weight (docs
  ×1.35, kdb component/report/changelog boosted, `claude_session` ×0.8), and
  `claude_session` blocks are hard-capped at 50% of the k-block window (held-over
  sessions backfill only if nothing better exists). `/api/search` is not
  reranked — it returns raw relevance.
- **Answer telemetry.** The `done` event carries `metrics?` — the model that
  actually served the answer, provider-reported token counts, time to first
  token, and the resulting generation rate. See [Served model vs configured
  model](#served-model-vs-configured-model).

## Served model vs configured model

`LLM_MODEL` is a **request, not a guarantee**. G2P routes by policy and
substitutes freely: a stack configured for `gemini-2.5-flash` is regularly
answered by `gemma-4-31b-it`. This is expected, valid behaviour — not an error —
so it is reported as fact rather than flagged as a warning.

Until this was surfaced, the UI displayed `llmConfig.model` and therefore
attributed every answer to the model *we asked for*, which was frequently not the
one that wrote it. The served model now comes from the gateway itself:

| Signal | Source | Note |
|---|---|---|
| served model | `X-G2p-Reply-Model` response header | falls back to the configured name if the provider sends no header |
| gateway attempts | `X-G2p-Reply-Attempts` | `> 1` means it failed over internally — *this* is worth surfacing |
| request id | `X-Request-Id` | correlates an answer with the gateway's logs |
| token usage | trailing SSE frame | requires `stream_options: {include_usage: true}` on the request; the frame carries `choices: []`, so a content-only parser drops it |

Two rules follow, and both are load-bearing:

- **Telemetry must never break the answer it describes.** Header reads are
  defensive: a provider (or a test stub) that omits them costs the metrics, not
  the reply.
- **A failed call reports no metrics at all.** `chatStream` throws before
  yielding, so there are no headers and no usage; `done.metrics` is simply
  absent. Substituting zeroes would misreport a call that never happened.

Token rate is computed over *generation* time (`total − ttft`), not wall-clock:
dividing by total time would blame the model for a slow retrieval queue.

## Scoping by project

Project appears in two different roles, and conflating them is the mistake this
design exists to avoid:

| Role | Where | Multi? |
|---|---|---|
| **Filter** — narrows a result set | `/api/search`, `/api/ask`, `/api/timeline` | **yes** — *any of* these projects |
| **Resource** — identifies the thing being browsed | `/api/projects/:slug/components`, `/sessions` | **no** |

A component named `ui` in project A and `ui` in project B are *different things*.
Merging them under one heading would be a lie, so Components and Sessions stay
single-project browsers: with 0 or 2+ projects selected they say so and offer a
chooser rather than silently showing one project's data.

**The filter itself is the `sourceTypes` idiom applied to a second field.**
`SearchFilters` carries both `project?: string` (kept for the CLI and MCP) and
`projects?: string[]`, with the plural winning when non-empty. `selectedProjects()`
resolves that precedence once and *both* search paths use it, because they degrade
into one another and a filter that meant different things depending on which
backend answered would be a vicious bug:

- **Qdrant** — one project is `match: {value}`, several are `match: {any: [...]}`.
- **Postgres FTS** — one is `p.slug = $n`, several are `p.slug = ANY($n)`.

No payload key, column or collection changed, so **no reindex**.

**Timeline has two routes on purpose.** `/api/projects/:slug/timeline` is the
resource form and is what the CLI (`atlas timeline`) and the MCP server call —
cramming `a,b` into a slug that means "one project" would be the same category
error. `/api/timeline?projects=a,b` is the filter form, merges chronologically,
and every item carries its own `projectSlug` so a merged feed stays readable.

**Ask's soft fallback generalises rather than merely accepting a list.** With
several projects selected, *any* hit means the scope worked — the projects that
returned nothing simply had nothing to say. Widening to all projects fires only
when **none** of the selected projects match; falling back on a partial match
would trigger on nearly every multi-project ask.

## Doc staleness

docs/ folders accumulate outdated material. Atlas never excludes it — the
index would silently lose recall — it classifies and lets ranking + labels do
the judging (ADR: `docs/adr/20260710-docs-staleness-query-time.md`):

- **archived** — the file's project-relative path crosses an archive-style
  segment (`archive`, `_archive`, `legacy`, `old`, `deprecated`, `previous`,
  `obsolete`, `superseded`, `outdated`, `backup`, `bak`; filename-stem tokens
  count too). Computed at scan time, stored in entry `meta` and as `doc_status`
  in the Qdrant payload. Filterable (`docStatus=active|archived`).
- **aging** — not archived, but older than `KDB_DOCS_AGING_MONTHS` (12). Derived
  at **query time** from `occurredAt`; deliberately never stored, because
  unchanged files are never rescanned and a stored flag would freeze.

`SearchService.finalize()` is the single staleness pass: it runs on the hybrid
path *and* the FTS fallback, multiplies archived scores by
`KDB_ARCHIVED_PENALTY` (0.6), attaches labels, re-sorts (2× over-fetch so
demoted hits can actually fall out). Aging is a label only — an old runbook
that never needed edits must not be buried. Ask context blocks arrive labeled
(`[ARCHIVED — 20 mo old]`) and the system prompt tells the model to prefer
fresh sources and disclose reliance on stale ones.

Reclassification without re-embedding: `DOCS_PARSER_VERSION` is recorded per
project; on mismatch the next docs scan walks unchanged files once, updates
`meta.docStatus` in Postgres and patches the Qdrant payload via `setPayload`
on the `entry_id` index. The docs walk covers 2000 files at depth 6 per
project, and logs a per-project warning when the cap drops anything.

## Host paths vs container paths

Project trees are bind-mounted read-only: the host projects root (e.g.
`~/_CODING`) appears inside the containers as `/data/code` (and extra roots as `/data/code2` …
`/data/code5`). Every discovered project therefore carries **both** paths:

- `rootPath` — where the indexer reads files.
- `hostPath` — the same tree as the user sees it.

Two things depend on the host path, and both fail silently without it:

1. **Editor deep links.** The API translates a container path back to a host
   path before emitting `vscode://…`; nobody outside the stack has `/data/code`.
2. **Attributing Claude Code transcripts to projects** (below).

## Claude-dir ↔ project mapping

Claude Code encodes a session's cwd as a directory name by replacing every char
outside `[A-Za-z0-9-]` with `-`. That is lossy, so Atlas never decodes: it
encodes each discovered project's **hostPath** the same way and picks the
deepest prefix match.

Matching against `rootPath` matches nothing — the dir name encodes
`<projects root>/DeepCast`, never `/data/code/DeepCast` — and every
project silently splits in two: one built from its files, one from its
transcripts under a path-shaped slug. `PROJECT_GROUPING` in
`packages/core/src/discovery.ts` is bumped whenever this rule changes, which
makes the indexer rebuild the derived index at the next boot.

### Transcript identity survives a host or path change

A transcript directory name *is* a host path. Migrating to another machine
(2026-08-24: `nasta` → `serge`, `__CODING NEW` → `_CODING`) renamed every
directory under `~/.claude/projects`, and a `dedup_key` that hashed the stored
path saw 347k existing rows as brand-new content — each one re-embedded, each
one a duplicate in search. Transcript keys therefore hash only what survives:
the literal scope `claude`, the path *inside* the encoded directory (the session
UUID is globally unique), the title and the body — never the directory, never
the project slug, which is itself derived from the directory. Project-file
sources keep project + container path, which is identical on every host.
`settings.transcript_key_scheme` records the rule in force; when it changes,
the indexer re-keys stored rows **in place** at boot (`rekeyTranscripts`, own
advisory lock) — duplicates merge into the lowest id, their vector points are
deleted before their rows, and no vector moves or is re-embedded. This is
deliberately not `id_scheme`, which truncates the catalog.

Dirs that match no project (sessions from a folder outside every configured
root) become standalone projects named after the path, so no history is
invisible. Adding that folder as an extra root merges them into the real
project.
