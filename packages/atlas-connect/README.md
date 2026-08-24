# @atlas/connect

`atlas-connect` is a stdio MCP shim: Claude Code talks to it over stdio, and
it bridges those calls to whichever machine is currently running the active
Atlas instance (resolved lazily via `resolveActive()` from `@atlas/core`,
spec §8). Register it once per machine and never touch the registration
again — moving the stack (`make stop` here, `make start` there) needs no config
change on the Claude Code side.

```
make connect-link          # npm link the atlas-connect binary onto PATH
claude mcp add atlas -- atlas-connect
```

If Atlas isn't reachable at all, `tools/list` returns a single
`atlas_unavailable` tool whose description explains why (every host checked
+ the remedy) instead of failing the MCP handshake. A full ops runbook
(multi-machine setup, credentials, troubleshooting) lands in Task 27's
`docs/multi-machine.md`.
