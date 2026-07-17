2026-07-09 01:20 UTC

# REST API

## Revision History
- 2026-07-17 15:49 UTC — Agent-safety batch: per-project routes (`/timeline`, `/components`, `/components/:name`, `/sessions`) **404 on an unknown slug** with a hint (an empty 200 read as "project has no data"). `/api/sessions/:id` accepts `limit`/`offset`/`max_body` and returns `totalEntries`; `/components/:name` accepts `limit`/`max_body`; bodies cut by `max_body` are flagged `bodyTruncated: true`. New **usage telemetry**: requests carrying `x-atlas-client` (mcp/cli) are logged to `usage_log`; aggregates at `GET /api/admin/usage?days=N`.
- 2026-07-13 00:20 UTC — Multi-project filtering: `project` accepts a comma-separated set on GET (`project=a,b`) and an array in a JSON body; `scopeFallback.requested` is now a list and widening fires only when *none* of the selected projects match. New collection route `GET /api/timeline?projects=a,b` merges feeds chronologically; the per-project route is unchanged. Timeline items carry `projectSlug`.
- 2026-07-12 22:50 UTC — The SSE `done` event carries `metrics?`: the model that actually **served** the answer (from the gateway's `X-G2p-Reply-Model`, not the configured `LLM_MODEL`), provider-reported token counts, TTFT and generation rate. Absent on a degraded answer.
- 2026-07-11 04:35 UTC — `source` accepts a comma-separated subset (`doc,kdb_component`); Ask retrieval reranks for source-type diversity; Ask returns `scopeFallback` (and the SSE `sources` event carries it) when a project scope was empty and widened to all projects.
- 2026-07-10 22:24 UTC — `docStatus` filter on search/ask; hits carry `docStatus`/`ageMonths`; dashboard adds `sourceDetail`, `activity`, `runs`, `archivedDocs`.
- 2026-07-10 00:00 UTC — /api/dashboard: storage, service health, vector stats.
- 2026-07-09 22:25 UTC — Conversation history on both Ask endpoints; `kind` filter.
- 2026-07-09 01:50 UTC — Streaming Ask (SSE), source deep links, richer /api/stats.
- 2026-07-09 01:20 UTC — Initial version.

Base: `http://127.0.0.1:8710`. JSON everywhere. No auth (localhost-only tool).

| Method | Path | Params / body | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ok}` |
| GET | `/api/stats` | — | counts, per-source breakdown, embedder, collection, lastRunAt, `queue`, `pending`, `backfill`, `recentErrors` |
| GET | `/api/dashboard` | — | everything in `/api/stats` plus `sessions`, `storage`, `health`, `vectors`, `sourceDetail` (per-source entries/files/volume/last-indexed), `activity` (30-day per-day per-source counts), `runs`, `archivedDocs` |
| GET | `/api/search` | `q` (required), `project` (one slug, or a comma-separated set: `deepcast,atlas`), `source` (one type or a comma-separated subset, e.g. `doc,kdb_component`; empty = all), `component`, `kind`, `since`, `until`, `docStatus` (`active` excludes archived docs, `archived` targets them), `limit` | `{hits[], mode, degraded, tookMs}`; each hit carries `hostPath` + `editorUrl`, and doc hits may carry `docStatus` (`archived` = downranked, `aging` = label only) + `ageMonths` |
| POST | `/api/ask` | `{question, project?` (string or string[]), `source?` (string or string[]), `component?, kind?, docStatus?, k?, history?}` | `{answer, sources[], model, degraded, scopeFallback?}` — `scopeFallback: {requested, usedAllProjects}` when a project scope matched nothing and the search widened to all projects |
| GET | `/api/timeline` | `projects` (required, comma-separated), `limit`, `before`, `sources` | merged activity feed; each item carries `projectSlug` |
| POST | `/api/ask/stream` | same as `/api/ask` | SSE: `sources` → `delta`* → `done`; `sources` carries `scopeFallback?`, `done` carries `metrics?` (served model, tokens, TTFT, tok/s) |
| GET | `/api/projects` | — | projects with entry counts |
| GET | `/api/projects/:slug/timeline` | `limit`, `before` (ISO cursor), `sources` (csv) | `{items[]}` newest first; 404 on unknown slug |
| GET | `/api/projects/:slug/components` | — | `{components[]}`; 404 on unknown slug |
| GET | `/api/projects/:slug/components/:name` | `limit` (entries, newest first), `max_body` (chars/body) | `{component, entries[]}`; cut bodies carry `bodyTruncated: true`; 404 on unknown slug |
| GET | `/api/projects/:slug/sessions` | — | `{sessions[]}`; 404 on unknown slug |
| GET | `/api/sessions/:id` | `limit` (entries/page, ≤1000), `offset`, `max_body` (chars/body) | `{session, entries[], totalEntries}` (404 if unknown); cut bodies carry `bodyTruncated: true` |
| GET | `/api/entries/:id` | — | full entry row (404 if unknown) |
| POST | `/api/admin/reindex` | `{project?, full?}` | `{enqueued}` |
| GET | `/api/admin/errors` | — | last 50 index errors |
| GET | `/api/admin/usage` | `days` (default 7) | agent-usage aggregates: `{days, calls, errors, clients, byTool[], byDay[]}` |

**Usage telemetry:** a request that carries `x-atlas-client: mcp|cli` (and
optionally `x-atlas-tool`) is recorded in the `usage_log` table — client, tool,
path, query string, status and duration. Unlabeled requests (the UI, curl) are
not recorded; the write is fire-and-forget and never slows the response.

`mode` in search responses: `hybrid` (dense+sparse RRF), `sparse-only`
(embedding provider unreachable), `fts` (Qdrant unreachable — Postgres fallback).
`degraded: true` whenever the served mode is not `hybrid`.

## Dashboard

`/api/dashboard` is deliberately separate from `/api/stats`: it walks Qdrant's
storage directory and probes every dependency, which is far too slow for the
footer that polls `/api/stats` every 30 seconds. Storage figures are cached for
30 seconds (the walk is ~200ms over ~1,100 files, and grows with file count
rather than gigabytes).

- `health` — `{postgres, qdrant, redis, ollama}`. These are *reachability from
  the API*, which is exactly what determines whether search works. Knowing a
  container's Docker state would need the Docker socket, an absurd privilege
  for a stats endpoint.
- `vectors` — `{points, vectors, segments}`. Each point carries two named
  vectors (dense + sparse), so `vectors` runs at roughly twice `points`.
- `storage` — `postgresBytes` and `qdrantBytes` are **disk**, `redisMemoryBytes`
  is **memory** (Redis holds the job queue; its disk is transient). A `null`
  means *cannot tell*, never *uses no disk*.
- `storage.collections` — per-collection sizes with an `active` flag. Switching
  the embedding model leaves the previous collection behind; on a real index
  that is over a gigabyte of vectors nothing reads.

Postgres reports its own size via `pg_database_size()` and Redis via
`INFO memory`. Qdrant has **no API for disk usage** — its telemetry exposes a
`disk_usage_bytes` field that reports `0`, which is worse than absent because it
looks authoritative. Its storage volume is therefore mounted **read-only** into
the API container at `/qdrant-storage`.

## Conversations

Both Ask endpoints accept an optional `history`: an array of prior
`{role: 'user'|'assistant', content}` turns. It is whitelisted server-side — a
`system` role from a client would rewrite the assistant's instructions — and the
newest 12 turns are replayed.

Prior turns are sent *before* the freshly retrieved context, so the `[n]`
citations in an answer always refer to the blocks directly above the question.
A follow-up such as *"why?"* carries no search signal and may retrieve nothing;
with history present that is fine (the conversation holds the answer), while a
*first* question with no hits is still a genuine dead end.

## Filtering by message kind

`kind` narrows results to how a session message was classified: `prompt`,
`plan`, `insight`, `summary`, `action`, `response`. For example
`GET /api/search?q=qdrant&kind=insight` returns only `★ Insight` blocks. See
[architecture](architecture.md#message-kinds).

`source` restricts to one or more source types. Pass a single value
(`source=doc`) or a comma-separated subset (`source=doc,kdb_component`); an
empty value searches everything. The Ask endpoints accept the same value as a
string or a JSON `string[]`.

**Ask vs. search ranking.** `/api/search` returns hits in raw relevance order.
The Ask endpoints then rerank the retrieved pool for context quality: authoritative
sources (docs, kdb component/changelog logs) are boosted and `claude_session`
blocks are capped at half the context window, so descriptive documentation is not
crowded out by transcripts that merely echo the question. See
[architecture](architecture.md#ask-mode).

## Streaming Ask

`POST /api/ask/stream` returns `text/event-stream`. Each frame is
`data: {json}\n\n`, in this order:

| Event | Payload | Meaning |
|---|---|---|
| `sources` | `{sources: [...], scopeFallback?}` | retrieved context; emitted before any prose. `scopeFallback: {requested, usedAllProjects}` appears when a project scope was empty and the search widened to all projects |
| `delta` | `{text: "…"}` | append to the answer |
| `done` | `{model, degraded, metrics?}` | terminal; `degraded` if the LLM failed |

The stream always terminates with `done`, even when the LLM is unreachable — in
that case a `delta` explains it and the sources still stand. Interactive streams
do **not** retry: a fast degraded answer beats seconds of silent backoff.

### Answer metrics

`done.metrics` reports what actually produced the answer. It is **absent** when
the LLM never responded (a degraded answer has no headers and no token usage);
consumers must render nothing rather than substitute zeroes.

| Field | Meaning |
|---|---|
| `model` | the model that **served** the answer, from the gateway's `X-G2p-Reply-Model` header — not the one `LLM_MODEL` requested |
| `substituted` | `true` when the served model differs from the configured one (vendor prefixes are ignored: `google/gemma-4-31b-it` matches `gemma-4-31b-it`) |
| `promptTokens`, `completionTokens`, `totalTokens` | provider-reported counts, never estimated. Absent unless the provider sends a usage frame |
| `ttftMs` | milliseconds to the first content token, measured API-side (so it excludes browser latency) |
| `totalMs` | wall-clock for the whole completion |
| `tokensPerSec` | `completionTokens / (totalMs − ttftMs)` — generation rate, excluding the initial wait, so a slow queue is not reported as a slow model. Omitted when it cannot be computed |
| `attempts` | gateway-side attempts (`X-G2p-Reply-Attempts`). `> 1` means it failed over internally before succeeding |
| `requestId` | `X-Request-Id`, for correlating an answer with the gateway's own logs |

**A routing gateway substitutes models by design.** G2P picks by policy, so
`LLM_MODEL` is a *request*, not a guarantee: asking for `gemini-2.5-flash` may
legitimately be answered by `gemma-4-31b-it`. Reporting the configured name would
attribute an answer to a model that never saw the question, so the served model
is authoritative everywhere it is shown.

Token counts require the provider to honour `stream_options: {include_usage:
true}`, which the client always sends. Providers that ignore it simply yield no
counts; the model, TTFT and attempts still report.

nginx must not buffer this route (`proxy_buffering off` plus the
`x-accel-buffering: no` response header), or the whole answer arrives at once.

## Source deep links

Search hits and `/api/entries/:id` carry `hostPath` (the container path mapped
back through the bind mounts) and `editorUrl` (`vscode://file/…:line`). The API
is the only component that knows both sides of the mount, so it does the
translation; a path it cannot map is returned unchanged rather than guessed at.
