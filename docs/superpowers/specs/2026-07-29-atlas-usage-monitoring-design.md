2026-07-29 19:32 UTC

# Usage monitoring: log every call, keep the reply, show it

## Status

Accepted — implementing.

## Context

Atlas records that a call happened and almost nothing about what it did.

`usage_log` (`core/src/catalog.ts:111`) holds one row per agent-facing request:
`at, client, tool, method, path, query, status, duration_ms`. `usageStats(days)`
aggregates it by tool and by day, `GET /api/admin/usage` serves that aggregate,
and `atlas usage` prints it. That is the whole surface.

Three gaps make the existing telemetry hard to actually use.

**No reply is stored.** Not the answer text, not the result count, not which
entries were cited, not what the LLM cost. The single most valuable record the
table could hold — what Atlas *told* an agent when it asked — is discarded at the
moment it is produced. Judging whether Atlas is useful is currently impossible
from Atlas's own data; you have to go read a Claude transcript.

**No way to list calls.** Only the aggregate is exposed. "Show me every ask in
the last week and what came back" cannot be answered without opening psql.

**No UI at all.** The rail has five views — Overview, Search, Timeline,
Components, Sessions — and none of them is about usage. The Overview dashboard is
about the *index* (what is in it, is it healthy, what it costs on disk), which is
a different question from "who is using this and for what".

Live volume, 30 days: 185 calls, 2 clients, 0 errors. `atlas_search` 91 calls at
2.2 s average; `atlas_ask` 14 calls at 34.9 s average, 95.6 s worst. This is a
single-user local tool, and the number matters to the design: at a few hundred
calls a month the useful instrument is **forensic** (read every call, see the
exact text) rather than **statistical** (percentile envelopes over sampled
traffic). Charts here summarise a set small enough to also enumerate.

### Two constraints found while checking feasibility

**The API container cannot see the transcripts.** `docker-compose.yml:16` mounts
`${CLAUDE_PROJECTS_HOST}` into the **indexer** only. `analyzeAdoption()`
(`core/src/adoption.ts:435`) walks that directory, so an adoption route served
directly from the API would find an empty tree and report zero sessions — a
confident, wrong answer.

**The middleware cannot see a streaming reply.** `/api/ask/stream`
(`app.ts:307`) returns a `ReadableStream` immediately; `await next()` in the
usage middleware resolves before the first token is generated. That route
therefore records time-to-headers as its duration, and its answer text is out of
reach entirely. Any reply capture on that path must live inside the stream.

## Decisions taken

1. **Capture full replies, going forward.** No retroactive backfill from Claude
   transcripts. History stays reply-less; that is accepted.
2. **Log all traffic**, including the UI and its polling — not only the
   `x-atlas-client` agents logged today.
3. **Hand-rolled chart primitives.** No charting dependency.
4. **A new `Monitor` rail view** with Overview / Calls / Adoption tabs, rather
   than extending the existing Overview or building a separate app.
5. **Adoption ships now**, not in a later phase.

## Design

### 1. Capture

#### 1.1 Log everything, classify the route

The middleware guard `if (!client) return next()` (`app.ts:96`) is removed. Every
`/api/*` request is recorded. Two changes to the row:

```
client        header 'x-atlas-client', else 'unknown'
route_class   'query' | 'read' | 'status' | 'admin' | 'other'   -- new column
```

`ui/src/api.ts` starts sending `x-atlas-client: ui` on every request, so the UI
is labelled rather than inferred from a missing header. `unknown` then keeps a
real meaning: something called the API directly — a curl, a script, an agent
following the MCP instructions' "fall back to the REST API" advice.

`route_class` comes from a pure function in core:

```ts
export type RouteClass = 'query' | 'read' | 'status' | 'admin' | 'other';
export function routeClass(path: string): RouteClass;
```

| Class | Routes | Why it is its own class |
|---|---|---|
| `query` | `/api/search`, `/api/ask`, `/api/ask/stream` | Consumes the index. The traffic anyone actually cares about. |
| `read` | `/api/projects*`, `/api/timeline`, `/api/sessions/*`, `/api/entries/*` | Navigation and follow-up reads. |
| `status` | `/api/health`, `/api/stats`, `/api/dashboard` | Health and polling. |
| `admin` | `/api/admin/*` | Reindex, errors, usage, adoption — includes the monitor observing itself. |
| `other` | anything unmatched | An explicit bucket beats silently misfiling a new route into `read`. |

This classifies the **route, not the intent**. `/api/dashboard` is `status`
whether a timer fired or you opened the page, and a column claiming to know which
would be a fabrication. The UI hides `status` by default, which removes the
polling noise from every chart while the rows stay on disk in full.

Because `route_class` is a pure function of `path`, it is never a trap: a
one-statement resync recomputes the whole column whenever the classifier
improves, exactly as the backlog parser-version resync does (`cd28ca3`).

#### 1.2 `usage_reply` — a 1:1 side table

```sql
CREATE TABLE IF NOT EXISTS usage_reply (
  call_id           BIGINT PRIMARY KEY REFERENCES usage_log(id) ON DELETE CASCADE,
  answer            TEXT,      -- ask: the full synthesized answer
  result_count      INT,       -- search: hits returned; ask: sources cited
  top_hits          JSONB,     -- [{entryId, score?, title, projectSlug, sourceType}]
  model             TEXT,      -- the model that ACTUALLY answered
  prompt_tokens     INT,
  completion_tokens INT,
  ttft_ms           INT,
  degraded          BOOLEAN,
  error             TEXT       -- the real failure message
);
```

A separate table rather than columns on `usage_log`, because the overwhelming
majority of rows (reads, polls, health checks) have no reply at all. Widening the
hot activity table with a mostly-null `TEXT` column would make every aggregate
query drag it around for nothing.

No `kind` discriminator column: it would duplicate `usage_log.path`, which the
join already provides, and a stored duplicate is free to disagree with its
source.

`ON DELETE CASCADE` means the prune escape hatch only ever touches `usage_log` —
replies follow their call out, and answer text can never be orphaned from the
question that produced it.

What is captured is **the API's reply, not the MCP tool result the agent saw**.
The MCP server reformats API responses before handing them to a model
(`mcp/src/tools.ts`), so the stored answer is Atlas's own output rather than the
exact bytes that reached Claude. That is the more useful record — it is what
Atlas is responsible for — but it means this table cannot be used to debug MCP
formatting.

#### 1.3 One write function, two call sites

`logUsage` starts returning the inserted id, and a new catalog method writes both
rows in a single transaction:

```ts
async recordCall(call: UsageCall, reply?: UsageReply): Promise<void>
```

- **Normal routes.** The handler stashes its reply on the Hono context, exactly
  as `usageQuery` already does (`app.ts:75`); the middleware calls `recordCall`
  after `next()`.
- **`/api/ask/stream`.** The handler sets `usageDeferred = true`, the middleware
  skips it, and the stream wrapper calls `recordCall` itself when it finishes.

One transaction at the point where both facts are finally known. The rejected
alternative — middleware INSERTs the call, the stream later UPDATEs it with the
reply — races: the middleware write is fire-and-forget and unordered, so the
UPDATE can target a row that does not exist yet.

`recordCall` stays fire-and-forget with a caught rejection, as `logUsage` is
today. Telemetry must never slow down or fail the call it measures.

#### 1.4 Streaming and aborted asks

`/api/ask/stream` wraps its `ReadableStream` to accumulate `delta` text and
retain the `done` event's `AskMetrics`, then records on **close** or **cancel**:

- **close** — full answer, real end-to-end duration (not time-to-headers),
  model, tokens, TTFT.
- **cancel** — the partial answer, `status = 499` (nginx's "client closed
  request" convention, not a real HTTP status — it is written into an `INT`
  column we own, and the UI labels it *aborted* rather than showing the number).
  An abandoned answer is one of the more informative things this table can hold:
  it says a question was asked and the reply was not worth waiting for.

`usageDeferred` is set at stream construction, **after** the `question is
required` validation. An early 400 returns before that point and so is still
logged normally by the middleware, rather than vanishing from the record.

If the process dies mid-stream neither callback fires and no row is written.
Accepted: the alternative is a pre-inserted row that would misreport every
interrupted answer as a completed one.

#### 1.5 Token counts for non-streaming ask

`/api/ask` — the route MCP uses, and therefore the one behind most real asks —
goes through `chatComplete()` (`llm.ts:102`), which returns a bare `string`.
`AskMetrics` exists only on the streaming path, so as written this design would
capture token costs for UI asks and nothing for agent asks.

The tokens are already on the wire. An OpenAI-compatible response carries a
`usage` object; `chatComplete` receives it and types it away, declaring only
`{ choices }` at `llm.ts:137`.

Fix, non-breaking:

```ts
export async function chatCompleteWithUsage(...): Promise<{ content: string; usage?: LlmUsage }>
export async function chatComplete(...): Promise<string>   // delegates, unchanged
```

All four existing call sites (`backlogReview.ts:44`, `eval/judge.ts:208`,
`eval/generate.ts:115`, `ask.ts:739`) keep the string-returning form. Only
`ask()` switches, and `AskResult` gains an optional `metrics`.

#### 1.6 Errors

`app.onError` (`app.ts:635`) logs the real error and returns a generic 500 to the
client. It additionally stashes the message on the context, so `usage_reply.error`
records the truth while the response body stays generic. A degraded ask (LLM
down, sources returned with an apology) sets `degraded = true` rather than an
error — it is a successful call with a poor answer, and conflating the two would
misreport the error rate.

### 2. API surface

| Route | Status | Returns |
|---|---|---|
| `GET /api/admin/usage?days=N` | extend | totals, **p50/p95**, by-tool (with per-tool p50/p95), by-day, by-class, by-hour |
| `GET /api/admin/usage/calls` | new | paged call rows + `hasReply` per row + `total`; filters `client`, `tool`, `class`, `status`, `since`, `until`, `q` (substring over query text) |
| `GET /api/admin/usage/calls/:id` | new | one call joined with its full reply |
| `GET /api/admin/adoption` | new | cached adoption report + when it was computed |
| `POST /api/admin/adoption/refresh` | new | enqueues a recompute; returns immediately |

The change to `/api/admin/usage` is purely additive — every field it returns
today keeps its name and meaning — so `atlas usage` keeps working untouched.

Percentiles use `percentile_cont(...) WITHIN GROUP (ORDER BY duration_ms)`.
Paging is server-side, 100 rows per page — at this volume, windowing in the
browser would be machinery for a problem that does not exist.

A composite index `usage_log (route_class, at DESC)` supports the filtered
listing; the existing `usage_log_at_idx` covers the unfiltered case.

### 3. Adoption pipeline

`analyzeAdoption()` runs **in the indexer**, which already mounts the transcripts
and already owns reading the world. The API only serves the cached result.

- A new job discriminator on the existing scan queue: `trigger: 'adoption'`.
  The worker already branches this way for `'reconcile'` and `'manual'`
  (`indexer/src/main.ts:360,395`), so this needs no new queue.
- The report is stored as JSON in `settings` under `adoption.report`, following
  the `backfill` precedent, with `sessions` capped at 200 entries.
- The indexer computes it on a schedule and on demand; the API's refresh route
  enqueues the job.
- The UI shows `computed <relative time>` next to a refresh button, so a stale
  report is never mistaken for a live one.

Rejected: adding the transcript mount to the API container. It would put a
multi-gigabyte filesystem scan on the request path and duplicate a
responsibility the indexer already has.

Keeping a history of adoption reports — to see whether the fire rate improves
after an instruction change — is deliberately out of scope. `atlas adoption
--compare` already answers that from the CLI. Logged to backlog.

### 4. UI

New rail item **Monitor**, keyboard `6`, in `packages/ui/src/views/MonitorView.tsx`.

**Overview tab**
- Four stat tiles: calls, errors, p50, p95.
- Stacked daily activity bars, coloured by client.
- Per-tool table: calls, avg, p95, errors, last-used, with an inline sparkline.
- A 24-cell hour-of-day strip.

An hour×weekday heatmap was designed and dropped: 168 cells against ~185
interesting calls a month averages roughly one call per cell, which renders as
scattered noise rather than a pattern. The 24-cell strip holds enough per cell to
read.

**Calls tab**
- Filter bar (client, class, tool, status, date range, free-text over the query).
- Dense table, newest first, paged.
- Clicking a row opens a drawer — following the existing `EntryDrawer` pattern —
  showing the full query, the full reply, cited sources as clickable entry links,
  token counts and timings.

**Adoption tab**
- Fire rate per tool with the sample size behind it.
- Missed-trigger list with transcript excerpts.
- Top-missed rules.
- Computed-at stamp and refresh.

**`components/charts.tsx`** — `<Bars>`, `<Sparkline>`, `<HourStrip>`.
SVG plus CSS custom properties, no dependency, the same technique as the existing
`ActivityChart` (`DashboardView.tsx:377`). Client colours reuse the semantic
palette: `mcp` → `--color-claude`, `cli` → `--color-git`, `ui` → `--color-doc`,
`unknown` → `--color-faint`.

Every chart must render correctly at zero points, one point, and one non-zero
point among many zeroes. A monitoring chart that looks broken when nothing has
happened trains you to distrust it when something has.

**Refresh is manual, with an opt-in live toggle, off by default.** A monitor that
polls itself becomes the loudest client in its own charts.

### 5. Configuration

Per the config SSoT rule, new values go in `core/src/config.ts` (zod schema) and
`config/atlas.defaults.env`, not inline:

- `usagePageSize` (default 100)
- `adoptionRefreshMin` (default 1440 — the scan is expensive and the answer moves slowly)
- `usageRetentionDays` (default 0, meaning keep everything)

### 6. Retention

None by default. At the observed rate — ~185 agent calls a month, plus roughly
2.9k poll rows per browser-day at ~100 bytes, plus ask answers at ~4 KB and ~20 a
month — this is single-digit megabytes a year. `make usage-prune DAYS=n` exists
as an escape hatch and is not scheduled.

## Blast radius

The middleware change touches **every** `/api/*` request, which is the whole
API. Verification before this is called done:

- Search, ask, streaming ask, dashboard and timeline all still work from the UI,
  the CLI and MCP.
- Exactly one `usage_log` row per request, and exactly zero written by the
  middleware for `/api/ask/stream`.
- An added INSERT on a route polled every 15–30 s is measured, not assumed.
- The existing suite stays green (baseline measured before this work: 869 tests
  across 67 files, all passing).

## Testing

| Area | Cases |
|---|---|
| `routeClass()` | Table-driven over every route the API defines, plus an unmatched path → `other` |
| Aggregation | p50/p95 correctness; a single-row window; an all-errors window |
| Reply capture | Complete stream; aborted stream (partial answer, 499); LLM error → `degraded`, not error; early 400 still logged by the middleware |
| Write path | One row per request; both rows in one transaction; a failing `recordCall` never fails the request |
| Adoption | Job discriminator routes correctly; cached report served; stale stamp rendered |
| Charts | Zero points, one point, one non-zero among zeroes |

## Out of scope

- Backfilling replies from Claude Code transcripts.
- A history of adoption reports over time (`atlas adoption --compare` covers it).
- Auth. Atlas remains localhost-only and single-user by design; this adds no new
  exposure but also no protection, and the reply table now holds question text —
  worth remembering before any port is ever bound beyond 127.0.0.1.

## Related

- ADR: `docs/adr/20260729-usage-telemetry-and-reply-capture.md`
- Component log: `kdb/components/atlas.log`
