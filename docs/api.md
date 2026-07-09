2026-07-09 01:20 UTC

# REST API

## Revision History
- 2026-07-09 01:50 UTC — Streaming Ask (SSE), source deep links, richer /api/stats.
- 2026-07-09 01:20 UTC — Initial version.

Base: `http://127.0.0.1:8710`. JSON everywhere. No auth (localhost-only tool).

| Method | Path | Params / body | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ok}` |
| GET | `/api/stats` | — | counts, per-source breakdown, embedder, collection, lastRunAt, `queue`, `pending`, `backfill`, `recentErrors` |
| GET | `/api/search` | `q` (required), `project`, `source`, `component`, `since`, `until`, `limit` | `{hits[], mode, degraded, tookMs}`; each hit carries `hostPath` + `editorUrl` |
| POST | `/api/ask` | `{question, project?, source?, component?, k?}` | `{answer, sources[], model, degraded}` |
| POST | `/api/ask/stream` | same as `/api/ask` | SSE: `sources` → `delta`* → `done` |
| GET | `/api/projects` | — | projects with entry counts |
| GET | `/api/projects/:slug/timeline` | `limit`, `before` (ISO cursor), `sources` (csv) | `{items[]}` newest first |
| GET | `/api/projects/:slug/components` | — | `{components[]}` |
| GET | `/api/projects/:slug/components/:name` | — | `{component, entries[]}` |
| GET | `/api/projects/:slug/sessions` | — | `{sessions[]}` |
| GET | `/api/sessions/:id` | — | `{session, entries[]}` (404 if unknown) |
| GET | `/api/entries/:id` | — | full entry row (404 if unknown) |
| POST | `/api/admin/reindex` | `{project?, full?}` | `{enqueued}` |
| GET | `/api/admin/errors` | — | last 50 index errors |

`mode` in search responses: `hybrid` (dense+sparse RRF), `sparse-only`
(embedding provider unreachable), `fts` (Qdrant unreachable — Postgres fallback).
`degraded: true` whenever the served mode is not `hybrid`.

## Streaming Ask

`POST /api/ask/stream` returns `text/event-stream`. Each frame is
`data: {json}\n\n`, in this order:

| Event | Payload | Meaning |
|---|---|---|
| `sources` | `{sources: [...]}` | retrieved context; emitted before any prose |
| `delta` | `{text: "…"}` | append to the answer |
| `done` | `{model, degraded}` | terminal; `degraded` if the LLM failed |

The stream always terminates with `done`, even when the LLM is unreachable — in
that case a `delta` explains it and the sources still stand. Interactive streams
do **not** retry: a fast degraded answer beats seconds of silent backoff.

nginx must not buffer this route (`proxy_buffering off` plus the
`x-accel-buffering: no` response header), or the whole answer arrives at once.

## Source deep links

Search hits and `/api/entries/:id` carry `hostPath` (the container path mapped
back through the bind mounts) and `editorUrl` (`vscode://file/…:line`). The API
is the only component that knows both sides of the mount, so it does the
translation; a path it cannot map is returned unchanged rather than guessed at.
