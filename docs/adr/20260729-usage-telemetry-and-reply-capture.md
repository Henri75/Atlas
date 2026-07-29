# ADR: Usage Telemetry — Log Every Call, Keep the Reply, Classify the Route
Date: 2026-07-29

## Status
Accepted

## Context
- `usage_log` records one row per agent-facing call (`at, client, tool, method,
  path, query, status, duration_ms`), written fire-and-forget by an API
  middleware, and exposed only as an aggregate (`GET /api/admin/usage`,
  `atlas usage`). It is one of the two durable exceptions to "the index is a
  rebuildable cache" (the other being `settings`).
- The middleware records **only** requests carrying `x-atlas-client`, on the
  stated grounds that the UI's 15–30 s status polling would drown the signal.
  The user's own use of Atlas is therefore invisible.
- **No reply is stored anywhere.** Not the answer, the result count, the cited
  entries, the model, or the token cost. Whether Atlas gave a useful answer
  cannot be established from Atlas's own records.
- Hard constraints: telemetry must never slow or fail the call it measures;
  Atlas stays localhost-only and single-user; no new runtime dependency without
  a version-policy entry.
- Two structural facts bound the design. `/api/ask/stream` returns a
  `ReadableStream`, so `await next()` in the middleware resolves before any token
  exists — the reply is unreachable from there. And `docker-compose.yml` mounts
  `~/.claude/projects` into the **indexer only**, so transcript-reading work
  (adoption) cannot run in the API container.

## Decision
- **Log every `/api/*` request**, not just labelled clients. The UI starts
  sending `x-atlas-client: ui`; an absent header becomes `unknown`, which then
  carries real meaning (direct curl/script callers).
- **Classify the route, not the intent.** A new `usage_log.route_class` column
  (`query | read | status | admin | other`) is computed by a pure
  `routeClass(path)` function in core. `/api/dashboard` is `status` whether a
  timer fired or a human opened the page — a column claiming to distinguish them
  would be fabricating. Noise is handled at *read* time: the UI hides `status` by
  default while every row stays on disk. Because the value is a pure function of
  `path`, a one-statement resync recomputes the column whenever the classifier
  improves (precedent: the backlog parser-version resync, `cd28ca3`).
- **Replies go in a 1:1 side table** `usage_reply` keyed on `call_id` with
  `ON DELETE CASCADE`, not in extra columns on `usage_log`. Most rows (reads,
  polls, health checks) have no reply, and a mostly-null `TEXT` column would be
  dragged through every aggregate query. The cascade also makes pruning a
  single-table operation that cannot orphan answer text from its question.
  No `kind` discriminator: it would duplicate `usage_log.path`, and a stored
  duplicate is free to disagree with its source.
- **One writer, two call sites.** `catalog.recordCall(call, reply?)` writes both
  rows in one transaction. The middleware calls it for normal routes; the
  streaming ask route sets `usageDeferred`, is skipped by the middleware, and
  calls `recordCall` itself on stream close or cancel. Rejected: middleware
  INSERTs then the stream UPDATEs — the middleware write is fire-and-forget and
  unordered, so the UPDATE can target a row that does not exist yet.
- **Aborted answers are recorded**, with the partial text and `status = 499`
  (nginx's client-closed convention, in an INT column we own). A question asked
  and abandoned mid-answer is a finding, not an absence.
- **Token usage is recovered for the non-streaming ask path.** `AskMetrics`
  exists only on the streaming path, which the UI uses; MCP — the primary client
  — calls `/api/ask`, which goes through `chatComplete()`. That function already
  receives the OpenAI-compatible `usage` object and types it away, declaring only
  `{ choices }`. A new `chatCompleteWithUsage()` returns `{ content, usage }` and
  `chatComplete` delegates to it, leaving all four existing call sites unchanged.
- **Adoption runs in the indexer**, as a new `trigger: 'adoption'` discriminator
  on the existing scan queue (the worker already branches this way for
  `reconcile` and `manual`), caching its report in `settings`. The API only
  serves the cache. Rejected: mounting the transcripts into the API container —
  it would put a multi-gigabyte scan on the request path and duplicate a
  responsibility the indexer already owns.
- **No charting dependency.** Chart primitives are hand-rolled SVG + CSS custom
  properties, matching the existing `ActivityChart`, so the semantic palette
  (each hue bound to a data meaning) is inherited rather than approximated.

## Consequences
- Row volume rises from ~185/month to ~2.9k per browser-day, almost all
  `status`. At ~100 bytes/row this is single-digit MB/year; no retention policy
  ships, only a `make usage-prune DAYS=n` escape hatch, unscheduled.
- The middleware change touches every `/api/*` route — the whole API is the blast
  radius, and verification must cover UI, CLI and MCP paths plus a measured cost
  for the added INSERT on polled routes.
- `usage_reply` now holds question text and full answers. This adds no exposure
  (every port binds 127.0.0.1) but it does raise the stakes of ever binding one
  more widely, and is called out in the security posture.
- The stored answer is **Atlas's API reply, not the MCP-formatted tool result**
  the model actually saw, so this table cannot debug MCP formatting.
- If the process dies mid-stream, neither the close nor the cancel callback fires
  and no row is written. Accepted deliberately over a pre-inserted row, which
  would misreport every interrupted answer as a completed one.

## Related
- Spec: `docs/superpowers/specs/2026-07-29-atlas-usage-monitoring-design.md`
- Precedent: `docs/adr/20260729-backlog-status-derivation.md` (facts at scan,
  judgment at query — here: raw path stored, class derived and resyncable)
