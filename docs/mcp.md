2026-07-09 01:20 UTC

# MCP Server

## Revision History
- 2026-07-19 03:35 UTC — Added **`atlas adoption`**: measures whether agents actually call Assessor/Atlas at the moments the instructions say they should, by reading Claude Code transcripts rather than asking the agent. See *Measuring adoption* below.
- 2026-07-17 15:49 UTC — Agent-readiness batch: the server now sends **initialize-time instructions** (what Atlas is, that it is **beta** — verify answers against cited sources, prefer unscoped queries, ghost-slug warning, and the *Atlas usage* reporting duty for agent summaries). `atlas_session` is **paginated by default** (limit 50, max_body 1500, returns `totalEntries`; a 71k-char response previously landed in one tool result) and `atlas_component_history` bounded (limit 20, max_body 2000); truncated bodies carry `bodyTruncated: true` — read them in full with `atlas_entry`. Unknown project slugs now surface as API 404s instead of empty results. Every tool call is recorded in the usage log (`atlas usage`).
- 2026-07-12 13:50 UTC — Renamed the product to **Atlas**. The MCP server id is now `atlas` (was `kdbscope`) and every tool is `atlas_*` (was `kdb_*`): `kdb_search` → `atlas_search`, and so on for all ten. The `source` **values** are unchanged — `kdb_changelog`, `kdb_session`, `kdb_component`, `kdb_backlog`, `kdb_report` name kinds of indexed content (KDB logs), not the server, and keep their `kdb_` prefix. Re-register the server (see below); no reindex.
- 2026-07-11 04:35 UTC — `kdb_ask` steers callers away from over-scoping (a wrong `project` slug hides answers in sibling projects) and auto-widens to all projects on an empty scope, returning `scopeFallback`; `kdb_search` `source` accepts a comma-separated subset.
- 2026-07-09 22:30 UTC — kdb_search gains a `kind` filter (insight / plan / summary / action).
- 2026-07-09 02:00 UTC — Added kdb_entry (full entry body + deep link); clarified the agent flow.
- 2026-07-09 01:20 UTC — Initial version.

Streamable HTTP at `http://127.0.0.1:8711/mcp` (stateless). Register once:

```bash
claude mcp add --transport http atlas http://127.0.0.1:8711/mcp
```

This repo also ships `.mcp.json`, so Claude Code sessions started inside the
repo pick the server up automatically.

## Tools

| Tool | Use it for |
|---|---|
| `atlas_search` | ranked snippets across all history (query, project?, source? — one type or a comma-separated subset, component?, kind?, limit?) |
| `atlas_ask` | synthesized, cited answer to a question (question, project?, k?). Prefer leaving `project` unset — a feature may be indexed under a different slug than expected (e.g. G2P → `google-gemini-pool`, not `deepcast`), and a wrong scope is the main reason a real answer looks missing. On an empty scope the search widens to all projects and the result carries `scopeFallback`. |
| `atlas_entry` | the **full body** of one entry, plus its host path and editor link (entry_id) |
| `atlas_projects` | list indexed projects |
| `atlas_timeline` | what happened in a project, newest first (project, before?, sources?, limit?) |
| `atlas_components` | list a project's components |
| `atlas_component_history` | recorded history of one component, newest first (project, component, limit? default 20, max_body? default 2000) |
| `atlas_session` | replay one Claude Code session, paginated (session_id, limit? default 50, offset?, max_body? default 1500; response carries `totalEntries`) |
| `atlas_reindex` | trigger incremental/full reindex (project?, full?) |
| `atlas_status` | index counts, freshness, queue depth, re-embed progress |

Suggested agent flow: `atlas_search` (or `atlas_ask` for prose questions) → take an
`entryId` from a hit → `atlas_entry` for the full record → `atlas_component_history`
or `atlas_session` to widen the context. Search results are snippets; `atlas_entry`
is how you read one properly.

## What agents are told at connect time

The server sends MCP `instructions` on initialize (`SERVER_INSTRUCTIONS` in
`packages/mcp/src/tools.ts`). They carry what tool descriptions cannot:

- **Beta caveat** — results are leads, not ground truth; `atlas_ask` answers come
  from a mid-size LLM and must be verified against their cited sources before an
  agent relies on them.
- **Scoping guidance** — try unscoped first; a wrong `project` slug is the main
  reason a real answer looks missing. Ghost slugs (flattened absolute paths with
  an empty `rootPath`) are duplicates of moved checkouts.
- **Context safety** — large results arrive paginated/truncated with
  `bodyTruncated`/`totalEntries` markers; `atlas_entry` fetches any full body.
- **Reporting duty** — an agent that used Atlas must add a short "Atlas usage"
  note to its final report: which tools, for what, a 1–5 usefulness rating, and
  any issues hit. That feedback is the beta's improvement loop.

## Monitoring agent usage

Every MCP tool call is labeled (`x-atlas-client: mcp`, `x-atlas-tool`) and
recorded by the API in Postgres (`usage_log`). Inspect with `atlas usage
[-d days]` or `GET /api/admin/usage?days=N`: calls, latency, error counts per
tool and per day.

`atlas_ask` is non-streaming by design: a tool call returns one result. The
streaming endpoint (`POST /api/ask/stream`) serves the UI and CLI.

## Measuring adoption

`usage_log` answers "how often was Atlas called". It cannot answer the question
that actually drives instruction tuning: **how often should it have been called
and wasn't?** For that you need the sessions where a documented trigger applied
and no call happened — and those leave no trace in the usage log.

```bash
atlas adoption                          # all projects, all time
atlas adoption --since 2026-07-01       # recent only
atlas adoption --project DeepCast       # one project
atlas adoption --json                   # raw report for scripting
```

It reads Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) directly and
reports two things:

- **Tier 1 — usage.** Calls to `mcp__atlas__*` / `mcp__assessor__*` per session,
  plus direct HTTP calls to either API (agents fall back to `curl` when a server
  restart drops the MCP tools mid-session; that still counts as use).
- **Tier 2 — candidate missed triggers.** Assistant prose matched against the
  same conditions the server instructions document: asserting *why* something
  changed after a `git`/`grep` lookup, blaming a failing test, hedging about
  history. A hit with no matching call is a candidate miss.

**`fireRate` = sessionsUsed / (sessionsUsed + sessionsMissed)** — the number to
watch when tuning instructions. It is `null`, not `0`, when nothing qualified:
"no opportunity" and "never fired" are different findings.

### Why transcripts and not a survey

Asking the agent to self-report non-use does not work, and cannot be made to
work by asking harder. An agent that never noticed a trigger will, when
prompted, produce a fluent justification indistinguishable from a real decision
— the exact confabulation the *"report the skip you ACTUALLY made"* instruction
exists to counter. Transcripts record what happened; they do not have a memory
to reconstruct. Self-reports are still collected, but as weak evidence: their
one unique signal is *"did not think of it"* (surfaced as
`admittedNotThoughtOf`), which no transcript scan can infer. Where the two
disagree, the transcript wins.

### Treat Tier 2 as candidates, not verdicts

The detectors are regexes over prose and will produce false positives — tuning
them against 3,760 real sessions cut three noisy rules that were matching
routine phrasing (`nothing regressed` after a test run, `update the test to…`
while writing tests, `the schema rejected it` where the system does the
rejecting, not the agent). Every hit carries an excerpt precisely so a human can
check it in one glance. Under-matching is the more dangerous failure: it yields
a clean report that reads as "no misses found", so detector changes are pinned
by tests in `test/core/adoption.test.ts` in both directions.

Detectors mirror the triggers in each server's `SERVER_INSTRUCTIONS`. **Adding a
trigger there without adding a detector here makes it invisible to measurement.**

`atlas_ask` reranks its retrieved context for source-type diversity — authoritative
docs and component logs are boosted and session transcripts are capped at half the
window — so the answer is grounded in documentation rather than in chatter that
merely repeats the question. `atlas_search` is unaffected and returns raw
relevance order.
