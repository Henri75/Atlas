2026-07-09 01:20 UTC

# CLI — `kdbs`

## Revision History
- 2026-07-09 22:30 UTC — `--kind` filter on `search`.
- 2026-07-09 01:50 UTC — Streaming `ask`, `--no-stream`, richer `status`.
- 2026-07-09 01:20 UTC — Initial version.

Install on the host: `make cli-link` (npm link). Point it elsewhere with
`KDBSCOPE_API_URL` (default `http://127.0.0.1:8710`). Every command accepts
`--json` for scripting and agents.

```bash
kdbs search qdrant timeout fix -p deepcast -n 15
kdbs search "video import" -s git_commit
kdbs ask "what were the bug fixes in the video import microservice?"   # streams
kdbs ask --no-stream "…"      # wait for the whole answer
kdbs --json ask "…"           # buffered: one valid JSON document
kdbs projects
kdbs timeline deepcast --sources kdb_changelog,git_commit
kdbs components deepcast
kdbs component deepcast analyzer-worker
kdbs sessions deepcast
kdbs session 0075adef
kdbs reindex --full -p deepcast
kdbs status
```
