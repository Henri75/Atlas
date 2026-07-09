2026-07-09 01:20 UTC

# MCP Server

## Revision History
- 2026-07-09 22:30 UTC — kdb_search gains a `kind` filter (insight / plan / summary / action).
- 2026-07-09 02:00 UTC — Added kdb_entry (full entry body + deep link); clarified the agent flow.
- 2026-07-09 01:20 UTC — Initial version.

Streamable HTTP at `http://127.0.0.1:8711/mcp` (stateless). Register once:

```bash
claude mcp add --transport http kdbscope http://127.0.0.1:8711/mcp
```

This repo also ships `.mcp.json`, so Claude Code sessions started inside the
repo pick the server up automatically.

## Tools

| Tool | Use it for |
|---|---|
| `kdb_search` | ranked snippets across all history (query, project?, source?, component?, kind?, limit?) |
| `kdb_ask` | synthesized, cited answer to a question (question, project?, k?) |
| `kdb_entry` | the **full body** of one entry, plus its host path and editor link (entry_id) |
| `kdb_projects` | list indexed projects |
| `kdb_timeline` | what happened in a project, newest first (project, before?, sources?, limit?) |
| `kdb_components` | list a project's components |
| `kdb_component_history` | full recorded history of one component |
| `kdb_session` | replay one Claude Code session (session_id) |
| `kdb_reindex` | trigger incremental/full reindex (project?, full?) |
| `kdb_status` | index counts, freshness, queue depth, re-embed progress |

Suggested agent flow: `kdb_search` (or `kdb_ask` for prose questions) → take an
`entryId` from a hit → `kdb_entry` for the full record → `kdb_component_history`
or `kdb_session` to widen the context. Search results are snippets; `kdb_entry`
is how you read one properly.

`kdb_ask` is non-streaming by design: a tool call returns one result. The
streaming endpoint (`POST /api/ask/stream`) serves the UI and CLI.
