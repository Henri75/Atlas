2026-07-09 00:30 UTC

# KDBScope — Cross-Project Knowledge Indexer: Design Spec

## Revision History
- 2026-07-09 00:30 UTC — Initial validated design (brainstorming session).

## 1. Purpose

KDBScope indexes everything that records "what happened" across all projects under
`/Users/nasta/__CODING NEW` — the per-project `kdb/` append-only logs, Claude Code session
transcripts in `~/.claude/projects`, git history, and project docs/ADRs — and makes it
searchable, browsable, and questionable through a web UI, a CLI, a REST API, and an MCP
server. It answers questions like "what changed in DeepCast last week?", "how does the
VidSight service work?", "what were the bug fixes in the video import microservice?".

KDBScope is a **read-only lens**: it never writes to the indexed projects. Its entire index
(Postgres + Qdrant) is a rebuildable cache.

## 2. Measured scale (2026-07-09)

| Source | Volume |
|---|---|
| kdb/ folders | 20 projects, 6.8 MB, 191 component logs |
| Claude sessions | 10,217 JSONL files, 11 GB raw (156 files > 10 MB) |
| Git repos | 28 repositories |
| Estimated catalog | ~1–2 M entry rows, ~2–4 M chunks after distillation |

## 3. Topology (Approach B — microservices, user-selected)

Docker Compose stack, all ports bound to 127.0.0.1:

| Service | Image | Role | Host port |
|---|---|---|---|
| `indexer` | node 22 (built) | scheduler + BullMQ workers: scan → parse → chunk → embed → upsert | — |
| `api` | node 22 (built) | Hono REST API | 8710 |
| `mcp` | node 22 (built) | MCP streamable-HTTP server (thin client of api) | 8711 |
| `ui` | nginx (static React build, proxies /api) | web UI | 8712 |
| `qdrant` | qdrant (pinned) | dense+sparse vectors | 6363 / 6364 |
| `redis` | redis (pinned) | BullMQ queue + scheduler lock | 6390 |
| `postgres` | postgres ≥ 18 (pinned) | catalog | 5460 |

Bind mounts (read-only): `~/.claude` → `/data/claude`, `/Users/nasta/__CODING NEW` →
`/data/code`. Named volumes for qdrant/postgres/redis data. Host CLI `kdbs` (npm package,
`npm link`) talks to the API. LLM/embedding endpoints on the host (G2P :8181, Ollama
:11434) are reached via `host.docker.internal`.

Catalog is **PostgreSQL** (not SQLite): multiple containers write concurrently
(indexer replicas + api), SQLite WAL locking is unsafe across container mounts, and the
org baseline (§10) mandates PostgreSQL ≥ 18. Confirmed with user 2026-07-09.

## 4. Data model

**Entry** = browsable unit (one changelog line, one session block, one component-log block,
one distilled conversation event, one commit, one doc section).
**Chunk** = searchable unit (~1,800 chars, heading/paragraph-aware, small overlap), FK → entry.

Postgres tables:
- `projects(id, slug, name, root_path, has_kdb, discovered_at)`
- `scan_state(id, project_id, source_type, path, mtime, size, byte_offset, content_hash, last_scanned_at)` — byte_offset enables tail-only parsing of append-only files (kdb `.log`, session `.jsonl`)
- `entries(id, project_id, source_type[kdb_changelog|kdb_session|kdb_component|kdb_backlog|claude_session|git_commit|doc], component, session_id, title, body, occurred_at, source_path, source_ref, meta jsonb)`
- `index_errors(id, project_id, path, stage, message, created_at)`
- `index_runs(id, kind[scheduled|manual|full], started_at, finished_at, stats jsonb)`

Chunks live only in Qdrant (payload carries entry_id); they are rebuilt by re-scanning,
so no relational mirror is kept. Qdrant: one collection per embedding config (`kdbscope_<provider>_<model>_<dim>`), named
vectors `dense` + `sparse` (IDF modifier), payload `{project, source_type, component,
session_id, occurred_at, entry_id}`, deterministic point IDs = UUIDv5(source_path + seq +
content hash) for idempotent re-upserts.

## 5. Ingestion pipeline

`scheduler → scan jobs (BullMQ) → parse → chunk → embed → upsert`

1. **Scheduler** (indexer, redis-lock so only one fires with replicas): every
   `SCAN_INTERVAL_MIN` (default 5) enqueues one job per (project, source_type). Manual
   trigger via API/CLI/MCP/UI enqueues immediately; `full` mode resets scan state.
2. **Discovery**: projects = dirs under `/data/code` containing `kdb/`, `.git`, or docs;
   Claude project dirs matched to projects by decoding the dashed path convention
   (`-Users-nasta---CODING-NEW-DeepCast` → path suffix match); unmatched Claude dirs
   become standalone projects (slug from dir name).
3. **Parsers** (one adapter per source_type, all emit `Entry[]`):
   - `kdb-log`: §2-format changelog lines, session blocks, component blocks, backlog lines.
     Also ingests loose `*.md` reports in kdb/ roots. Generated `.md` views are skipped.
   - `claude-jsonl`: streaming line reader; keeps user prompts, assistant text, file-edit
     tool calls (path only), session summaries; drops tool noise, base64, attachments;
     caps entry body at 8 KB. Emits per-session meta entry (files touched, duration).
   - `git`: `git log --name-status` since last indexed commit per repo (git binary in
     indexer image with `safe.directory=*` — container uid differs from host file owner;
     repos read-only, no writes).
   - `docs`: README/ADR/docs `*.md` → one entry per H1/H2 section. Skips node_modules,
     build dirs, generated kdb `*.md` views.
4. **Chunker**: paragraph-boundary splits, ~1,800 chars, 200-char overlap.
5. **Embedder**: `EmbeddingProvider` interface, four implementations —
   `ollama` (default model `nomic-embed-text`), `bundled` (transformers.js
   `Xenova/all-MiniLM-L6-v2`, CPU), `openai-compat` (any base URL + key),
   `g2p` (preset of openai-compat → `http://host.docker.internal:8181/v1`).
   `EMBEDDINGS_PROVIDER=auto` picks: ollama if reachable → bundled. Switching provider
   creates a new Qdrant collection; re-embed runs as background jobs; search uses the
   collection matching the active config.
6. **Upsert**: batch Qdrant upserts (128 points) + Postgres transaction per file.
   Failure isolation: a bad file logs to `index_errors` and never fails the run.

## 6. Search & Ask

**Search** (`GET /api/search?q=&project=&source=&component=&since=&until=&limit=`):
query → dense embed + local sparse encode → Qdrant Query API with two prefetch branches
fused by native RRF → hydrate entries from Postgres → ranked results with snippet,
source location, deep link. Degradation: Qdrant down → Postgres `tsvector` websearch
fallback (flagged `degraded: true` in response); embedding provider down → sparse-only.

**Ask** (`POST /api/ask {question, project?, k?}`): search top-k (default 12) → prompt
with numbered context blocks + instruction to cite `[n]` → OpenAI-compatible
`chat/completions` (provider `openai-compat` with base_url+key, or `g2p` preset;
`LLM_MODEL` configurable) → `{answer, sources[]}`. LLM unreachable → returns search
results plus a clear error (no retry on 4xx except 429, per §3.8; transient 5xx/timeout
retried ≤ 2 with backoff).

## 7. Surfaces

**REST** (`api`, JSON): `/api/health`, `/api/stats`, `/api/search`, `/api/ask`,
`/api/projects`, `/api/projects/:slug/timeline` (keyset-paginated merged feed),
`/api/projects/:slug/components`, `/api/projects/:slug/components/:name` (history),
`/api/projects/:slug/sessions`, `/api/sessions/:id` (reconstructed conversation),
`/api/admin/reindex` (POST, `{project?, source?, full?}`), `/api/admin/errors`.

**MCP** (`mcp`, streamable HTTP at `http://127.0.0.1:8711/mcp`, stateless): tools
`kdb_search`, `kdb_ask`, `kdb_projects`, `kdb_timeline`, `kdb_components`,
`kdb_component_history`, `kdb_session`, `kdb_reindex`, `kdb_status` — each a thin
validated (zod) proxy to REST. Registered in Claude Code with one
`claude mcp add --transport http kdbscope http://127.0.0.1:8711/mcp`.

**CLI** (`kdbs`, host npm package): `search`, `ask`, `projects`, `timeline`, `components`,
`component <name>`, `sessions`, `session <id>`, `reindex`, `status` — commander-based,
pretty terminal output, `--json` for scripting, `KDBSCOPE_API_URL` env (default
`http://127.0.0.1:8710`).

**Web UI** (React 19 + Tailwind 4 + Vite, served by nginx): four views —
1. **Search + Ask**: universal bar, filters (project/source/component/date), ranked cited
   snippets; Ask tab renders a synthesized answer with source links (non-streaming in v1).
2. **Timeline**: per-project merged chronological feed (changelog + sessions + commits),
   infinite scroll.
3. **Components**: per-project component explorer; component page = history of entries,
   decisions, linked sessions.
4. **Sessions**: browse Claude Code conversations (prompts/responses/files touched), deep
   links from search hits.
Plus a status footer: index freshness, queue depth, doc counts, "Reindex now".

## 8. Configuration (§3.1 single source)

One central config module (`packages/core/src/config.ts`) reading env (compose `.env`):
`CODE_ROOT`, `CLAUDE_PROJECTS_DIR`, `DATABASE_URL`, `REDIS_URL`, `QDRANT_URL`,
`SCAN_INTERVAL_MIN`, `EMBEDDINGS_PROVIDER|MODEL|BASE_URL|API_KEY`,
`LLM_PROVIDER|MODEL|BASE_URL|API_KEY`, service ports. No inline constants anywhere.
Secrets only via env; never logged.

## 9. Error handling & resilience

- Per-file isolation; `index_errors` table surfaced in UI/CLI/`/api/admin/errors`.
- BullMQ retries (exponential, max 3) for transient embed/upsert failures; no retry on
  4xx except 429 (§3.8).
- Graceful search degradation chain: hybrid → sparse-only → Postgres FTS.
- All services: `/health` endpoints, compose healthchecks, restart: unless-stopped.
- Indexer is idempotent: deterministic IDs make re-runs safe; `full` reindex rebuilds
  from scratch without deleting the old collection until complete.

## 10. Testing

Unit (vitest, `test/` at repo root mirroring packages): kdb-log parser (real-format
fixtures), claude-jsonl distiller, git log parser, docs sectioner, chunker, sparse
encoder, discovery path-matching, ask prompt builder, RRF hydration mapping.
API: Hono `app.request()` route tests with mocked services. UI: smoke render tests.
Out of scope v1 (documented): containerized e2e; covered by `make smoke` script that
curls health + search endpoints after `make up`.

## 11. Non-goals (v1)

Auth/multi-user (localhost only), file-content code indexing (git + docs cover it),
editing indexed sources, Windows/Linux host support, real-time (<1 min) freshness.

## 12. Risks

- **Ollama/G2P reachability from containers** depends on `host.docker.internal` (OrbStack
  and Docker Desktop both support it).
- **First full index** of 10k sessions with bundled CPU embeddings will take hours; with
  Ollama on Apple Silicon, substantially less. Mitigation: progress in UI, prioritize
  kdb+git+docs sources first, sessions newest-first.
- **transformers.js model download** requires network on first run; cached in a volume.
