2026-07-09 01:20 UTC

# Architecture

## Revision History
- 2026-07-09 22:25 UTC — Message kinds; distiller keeps all prose + records actions; EXTRACTION_SCHEME.
- 2026-07-09 16:00 UTC — Host vs container paths; multi-root discovery; PROJECT_GROUPING.
- 2026-07-09 01:20 UTC — Initial version.

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

Ask mode: top-k retrieval → numbered context blocks → OpenAI-compatible
`chat/completions` (G2P preset or any endpoint) → answer with `[n]` citations.

## Host paths vs container paths

Project trees are bind-mounted read-only: `/Users/nasta/__CODING NEW` appears
inside the containers as `/data/code` (and extra roots as `/data/code2` …
`/data/code5`). Every discovered project therefore carries **both** paths:

- `rootPath` — where the indexer reads files.
- `hostPath` — the same tree as the user sees it.

Two things depend on the host path, and both fail silently without it:

1. **Editor deep links.** The API translates a container path back to a host
   path before emitting `vscode://…`; nobody outside the stack has `/data/code`.
2. **Attributing Claude Code transcripts to projects** (below).

## Claude-dir ↔ project mapping

Claude Code encodes a session's cwd as a directory name by replacing every char
outside `[A-Za-z0-9-]` with `-`. That is lossy, so KDBScope never decodes: it
encodes each discovered project's **hostPath** the same way and picks the
deepest prefix match.

Matching against `rootPath` matches nothing — the dir name encodes
`/Users/nasta/__CODING NEW/DeepCast`, never `/data/code/DeepCast` — and every
project silently splits in two: one built from its files, one from its
transcripts under a path-shaped slug. `PROJECT_GROUPING` in
`packages/core/src/discovery.ts` is bumped whenever this rule changes, which
makes the indexer rebuild the derived index at the next boot.

Dirs that match no project (sessions from a folder outside every configured
root) become standalone projects named after the path, so no history is
invisible. Adding that folder as an extra root merges them into the real
project.
