2026-07-09 01:20 UTC

# REST API

## Revision History
- 2026-08-28 22:30 UTC — **Session intelligence**: three routes over Claude Code sessions. `GET /api/sessions/search` ranks whole SESSIONS (not messages) by fusing a metadata leg (id prefix, title, folder, project, normalised file index) with the hybrid content index, weighted by a substance prior — the corpus median session is 3 messages, so relevance alone buries the sessions that did the work; every result carries a `why` array naming what matched. `GET /api/sessions/:id/insights` returns a customisable report: a deterministic `facts` layer (goals, action rollup, distilled prose, follow-up markers, backlog overlap, and the commits/kdb entries recorded in the same window) plus an optional LLM `narrative` (decisions, problems, distilled follow-ups), cached, with `llm.status` always stating which you got. `GET /api/sessions/:id/related` finds sessions before and after that worked on the same thing, scored from file / semantic / temporal legs and always reporting its `basis`. ⚠️ `/api/sessions/search` is registered BEFORE `/api/sessions/:id` — same segment count, so the order is what stops "search" being read as a session id. See `docs/adr/20260828-session-intelligence.md`.
- 2026-08-19 22:01 UTC — Multi-machine: auth is no longer "none" — bearer-token auth (`ATLAS_TOKEN`) is required on every route (`/api/health` and `/api/instance` excepted) once `ATLAS_BIND` leaves loopback. Localhost-only, no-`ATLAS_BIND` installs are unaffected. See `docs/multi-machine.md#lan-access-setup`.
- 2026-07-30 00:40 UTC — **Gateway headers are the source of truth for the served model.** The buffered ask path (`/api/ask`, which MCP uses) read `model` from the response *body*, which echoes the requested name — so every model substitution was recorded as the model we asked for. It now reads `x-g2p-reply-model` like the streaming path always did, via a shared `readGatewayMeta`, and also records `x-g2p-reply-attempts` and `x-request-id` in new nullable `usage_reply.attempts` / `request_id` columns. Substitution is judged in one place (`isSubstitution`) on the bare model name, so a vendor prefix (`google/x` vs `x`) is not reported as a swap. Verified live: the same route recorded `gemini-3-flash-preview` before and `google/gemini-3-flash-preview` after.
- 2026-07-30 00:25 UTC — **Monitor filters, insights, cursor paging**: `/api/admin/usage/calls` gains `hideNoise`, returns `facets` (counts by client and by tool over the filtered set) plus `nextCursor`, and pages by keyset `cursorAt`+`cursorId` rather than `offset` — the log grows while you read it, so an offset page is measured from a top that has moved. New `GET /api/admin/usage/insights?days=N`: outcome rates per mode (searches returning nothing, asks with no sources, aborted, degraded/failed), a log-scaled latency histogram, which models actually answered, weekday spread, most-repeated questions.
- 2026-07-29 21:20 UTC — **Usage monitoring**: **every** `/api/*` request is now logged (previously only `x-atlas-client` callers), with a new `route_class` column classifying the route (`query|read|write|status|admin|other`) so polling is separated at read time instead of discarded. Search and ask store what they replied — answer, result count, top hits, served model, tokens, TTFT — in a new 1:1 `usage_reply` table; `/api/ask/stream` records itself on close/cancel, so an aborted answer is kept at `status 499` with its partial text and a real duration. New routes: `GET /api/admin/usage/calls`, `GET /api/admin/usage/calls/:id`, `GET /api/admin/adoption`, `POST /api/admin/adoption/refresh`. `/api/admin/usage` gains `p50Ms`/`p95Ms`, per-tool percentiles, `byClass` and `byHour` (additively — existing fields unchanged). See `docs/adr/20260729-usage-telemetry-and-reply-capture.md`.
- 2026-07-29 20:25 UTC — **Backlog review**: `GET /api/projects/:slug/backlog` derives per-item status (open/resolved/dropped, with provenance `structured|reviewed|heuristic` and lints) at request time from the indexed backlog; `POST …/backlog/review` gathers scoped evidence and (unless `judge:false`) stores an Atlas-LLM verdict; `POST …/backlog/verdict` records a caller's own verdict. Both POSTs answer with `proposedLine` — the exact `RESOLVED/DROPPED/REOPENED [L<n>#<hash6>]` marker to append via the project's blessed helper; Atlas never writes project files. Verdicts live in the `backlog_review` table (survives reindex; the appended marker line is the canonical durable record). See `docs/adr/20260729-backlog-status-derivation.md`.
- 2026-07-17 15:49 UTC — Agent-safety batch: per-project routes (`/timeline`, `/components`, `/components/:name`, `/sessions`) **404 on an unknown slug** with a hint (an empty 200 read as "project has no data"). `/api/sessions/:id` accepts `limit`/`offset`/`max_body` and returns `totalEntries`; `/components/:name` accepts `limit`/`max_body`; bodies cut by `max_body` are flagged `bodyTruncated: true`. New **usage telemetry**: requests carrying `x-atlas-client` (mcp/cli) are logged to `usage_log`; aggregates at `GET /api/admin/usage?days=N`.
- 2026-07-13 00:20 UTC — Multi-project filtering: `project` accepts a comma-separated set on GET (`project=a,b`) and an array in a JSON body; `scopeFallback.requested` is now a list and widening fires only when *none* of the selected projects match. New collection route `GET /api/timeline?projects=a,b` merges feeds chronologically; the per-project route is unchanged. Timeline items carry `projectSlug`.
- 2026-07-12 22:50 UTC — The SSE `done` event carries `metrics?`: the model that actually **served** the answer (from the gateway's `X-G2p-Reply-Model`, not the configured `LLM_MODEL`), provider-reported token counts, TTFT and generation rate. Absent on a degraded answer.
- 2026-07-11 04:35 UTC — `source` accepts a comma-separated subset (`doc,kdb_component`); Ask retrieval reranks for source-type diversity; Ask returns `scopeFallback` (and the SSE `sources` event carries it) when a project scope was empty and widened to all projects.
- 2026-07-10 22:24 UTC — `docStatus` filter on search/ask; hits carry `docStatus`/`ageMonths`; dashboard adds `sourceDetail`, `activity`, `runs`, `archivedDocs`.
- 2026-07-10 00:00 UTC — /api/dashboard: storage, service health, vector stats.
- 2026-07-09 22:25 UTC — Conversation history on both Ask endpoints; `kind` filter.
- 2026-07-09 01:50 UTC — Streaming Ask (SSE), source deep links, richer /api/stats.
- 2026-07-09 01:20 UTC — Initial version.

Base: `http://127.0.0.1:8710`. JSON everywhere. Localhost-only by default, no
auth required. Once `ATLAS_BIND` is set to serve the LAN (multi-machine
setups), every route requires `Authorization: Bearer <ATLAS_TOKEN>` except
`GET /api/health` and `GET /api/instance` — see
[Configuration → Multi-machine](configuration.md#multi-machine) and
[`multi-machine.md`](multi-machine.md#lan-access-setup).

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
| GET | `/api/projects/:slug/backlog` | — | backlog status view: `{items[], unlinked[], counts, latestActivityAt}`; 404 on unknown slug |
| POST | `/api/projects/:slug/backlog/review` | `{line, sourcePath?, k?, judge?}` | `{item, evidence[]}` + (unless `judge:false`) `{verdict, proposedLine?}`; 503 `llm_unavailable` keeps the evidence; 404 on unknown line |
| POST | `/api/projects/:slug/backlog/verdict` | `{line, status, confidence?, note?, evidence?, citations?, propose?}` | `{ok, proposedLine?}` — the marker line the caller appends to the project's backlog.log |
| GET | `/api/sessions/:id` | `limit` (entries/page, ≤1000), `offset`, `max_body` (chars/body) | `{session, entries[], totalEntries}` (404 if unknown); cut bodies carry `bodyTruncated: true` |
| GET | `/api/entries/:id` | — | full entry row (404 if unknown) |
| POST | `/api/admin/reindex` | `{project?, full?}` | `{enqueued}` |
| GET | `/api/admin/errors` | — | last 50 index errors |
| GET | `/api/admin/usage` | `days` (default 7), `class` (comma-separated) | usage aggregates: `{days, calls, errors, clients, p50Ms, p95Ms, byTool[], byDay[], byClass[], byHour[]}` |
| GET | `/api/admin/usage/calls` | `class`, `client`, `tool`, `status` (`ok`\|`error`), `since`, `until`, `q`, `hideNoise`, `limit` (≤500), `cursorAt`+`cursorId` | `{calls[], total, facets, nextCursor?}` |
| GET | `/api/admin/usage/insights` | `days` (default 7) | outcome rates per mode, latency histogram, models that answered, weekday spread, most-repeated questions |
| GET | `/api/admin/usage/calls/:id` | — | one call joined with its full reply (404 if unknown) |
| GET | `/api/admin/adoption` | — | cached adoption report `{report, computedAt, pending?, tookMs?}` |
| POST | `/api/admin/adoption/refresh` | — | `{enqueued}`; returns before the scan runs |

**Usage telemetry.** **Every** `/api/*` request is recorded in `usage_log` —
client, tool, path, query, status, duration and `route_class`. The write is
fire-and-forget and never slows the response.

Callers identify themselves with `x-atlas-client` (`mcp`, `cli`, `ui`) and
optionally `x-atlas-tool`; an unlabeled caller is logged as `unknown`, which
means a curl or a script rather than an oversight.

`route_class` classifies the **route**, never the intent — `/api/dashboard` is
`status` whether a poll timer or a human hit it, and a column claiming otherwise
would be inventing evidence:

| Class | Routes |
|---|---|
| `query` | `/api/search`, `/api/ask`, `/api/ask/stream`, `…/backlog/review` |
| `read` | `/api/projects*`, `/api/timeline`, `/api/sessions/:id`, `/api/entries/:id` |
| `write` | `…/backlog/verdict` |
| `status` | `/api/health`, `/api/stats`, `/api/dashboard` |
| `admin` | `/api/admin/*` |
| `other` | anything unmatched — a growing count means a route was added without a class |

Polling is therefore *recorded* rather than discarded, and separated at read
time: the Monitor UI hides `status` and `admin` by default. Because the value is
a pure function of the path, `make usage-resync` recomputes the whole column
whenever the classifier improves.

**Replies.** Search and ask additionally store what came back, in a 1:1
`usage_reply` table (`ON DELETE CASCADE`, so pruning only touches `usage_log`):
the full answer, result count, top 5 hits with scores, the model that *actually*
answered, prompt/completion tokens, TTFT, and a `degraded` flag.

The served model, `attempts` and `request_id` all come from the gateway's
`x-g2p-reply-model` / `x-g2p-reply-attempts` / `x-request-id` **response
headers**, never from the response body. The body's `model` field is frequently
the requested name echoed back, so reading it attributes an answer to a model
that may never have seen the question — which is precisely the substitution this
record exists to expose. `attempts > 1` means the gateway failed over internally
before succeeding; `request_id` is the handle for correlating a suspect answer
against the gateway's own logs. Both the buffered and streaming paths read them
through one shared helper (`readGatewayMeta`), because they previously read them
separately and only one of them actually did. A call and its
reply are written in one data-modifying CTE, so a reply can never half-land.

`/api/ask/stream` records itself rather than going through the middleware, which
measures around `await next()` — for a streaming response that resolves before
the first token exists.

On that route `status` is the **outcome**, not the wire byte, because 200 headers
flush before the outcome is known:

| Outcome | Recorded | Reply kept |
|---|---|---|
| Answer completed | `200` | answer, sources, served model, tokens, TTFT |
| Client gave up mid-answer | `499` | the partial answer produced so far |
| Stream emitted an `error`, or threw | `500` | the error message |
| LLM down, sources returned instead | `200` + `degraded` | the explanation |

Recording the literal 200 for a failure would exclude every streamed failure from
the error rate. A client that disconnects before the first event produces a call
row with **no** reply row — an all-null reply says less than none.

What is stored is the API's reply, **not** the MCP-formatted tool result the
model saw, so this table cannot debug MCP formatting.

**Paging is cursor-based, not offset-based.** Pass `cursorAt`+`cursorId` from the
previous response's `nextCursor`; an absent `nextCursor` means the page was short
and provably nothing follows. The table gains rows continuously, so an `OFFSET`
page is measured from a top that has moved — it re-serves rows already shown and
skips others. `total` and `facets` describe the whole filtered set and ignore the
cursor, so both stay stable while you scroll.

**`hideNoise=true`** drops `/api/projects` and any call with no query text — both
traffic rather than intent. On real data it takes 744 calls down to 118. Opt-in
server-side and default-on in the UI, so a bare API call still gets the
unfiltered truth.

**Adoption** is served from a cache the indexer fills. The analysis reads every
Claude transcript on the machine (~2 minutes over 4400 sessions) and the API
container has no transcript mount, so it cannot be computed on request. It
refreshes daily (`KDB_ADOPTION_REFRESH_MIN`) and on demand.

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

## Sessions

Three routes answer the three questions people ask of a transcript archive.
All are `query`-class in the usage monitor: they consume the index, and
insights additionally consumes the LLM.

### `GET /api/sessions/search`

`q` (required) · `projects` (comma-separated; `project` also accepted) ·
`machine` · `since` · `until` · `limit` (default 20) · `pool` (retrieval
breadth) · `thread=false` (do not fold contiguous runs).

Ranks whole sessions. Pasting a session id (8+ hex characters) is an exact
hit rather than a semantic guess. An explicit date written into `q` is lifted
into the window and echoed back as `interpreted`, so a narrowed result set
never looks like an empty index.

Each session carries `why` (what matched, and how much), `excerpts` (the best
matching messages, prose preferred over the action trail), `substance` (0–1),
and `thread` when the card stands for a run of resumed sessions.

### `GET /api/sessions/:id/insights`

`sections` (comma-separated subset of `overview, goals, did, highlights,
decisions, problems, followups, backlog, trail`; default all) · `llm=false`
(recorded facts only, no model call) · `refresh=1`.

`facts` is derived from the index and always present. `narrative` is one LLM
call over that evidence and may be absent; `llm.status` is `off`, `ok`, or
`unavailable` with a reason. A failed model call is never cached. Reports are
cached under a key folding in the sections, the model, the extraction scheme,
the prompt version and the session's own size — so a session that grew, a
changed prompt or a switched model all miss by construction.

### `GET /api/sessions/:id/related`

`direction=before|after` · `crossProject=false` · `context=false` ·
`limit`.

Scored from three legs — shared normalised files (IDF-weighted cosine),
subject similarity, and timing — renormalised over the legs actually
available, because 72% of sessions record no files at all. **Read `basis`**:
`["temporal"]` means the results are merely things that happened nearby, and
the response says so in `note`. `contextEvents` lists commits and kdb entries
that touched the same files, because work on a thing is often recorded there
rather than in another session.

Unknown session ids 404 on all three, never an empty-looking 200.

## Source deep links

Search hits and `/api/entries/:id` carry `hostPath` (the container path mapped
back through the bind mounts) and `editorUrl` (`vscode://file/…:line`). The API
is the only component that knows both sides of the mount, so it does the
translation; a path it cannot map is returned unchanged rather than guessed at.
