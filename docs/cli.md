2026-07-09 01:20 UTC

# CLI — `atlas`

## Revision History
- 2026-08-28 22:30 UTC — `sessions` became a command GROUP with `list` as its default action, so `atlas sessions <project>` is unchanged while `find`, `insights` and `related` join it. `atlas session <id>` (replay) is untouched.
- 2026-07-29 20:25 UTC — New **`atlas backlog [project]`**: derived backlog status (open/resolved/dropped with provenance and lints, plus an unlinked-marker bucket). `--review` runs sequential LLM-judged reviews of open items (`--item N` for one, `--limit N` caps the run and says how many were left out); each confirmed verdict prints the exact `RESOLVED/DROPPED/REOPENED [L<n>#<hash6>]` line to append via the project's blessed kdb helper — the CLI never writes project files.
- 2026-07-19 04:15 UTC — `atlas adoption --compare <date>` / `--until <date>`: before-vs-after comparison for instruction changes, with small-sample guards.
- 2026-07-19 03:35 UTC — New `atlas adoption`: measures whether agents call Assessor/Atlas when the documented triggers apply, by reading Claude Code transcripts (usage counts + candidate missed triggers). Read-only and local.
- 2026-07-17 15:49 UTC — New `atlas usage [-d days]`: agent-usage telemetry (calls, latency, errors per tool/day; MCP + CLI traffic is labeled via `x-atlas-client`). Beta caveat added to `--help`. Unknown project slugs now error loudly (API 404) instead of printing nothing.
- 2026-07-12 13:50 UTC — Renamed the product to **Atlas**: the command is now `atlas` (was `kdbs`). Re-run `make cli-link` to install it. Source-type **values** (`kdb_changelog`, `kdb_component`, …) are unchanged — they name kinds of indexed content, not the tool.
- 2026-07-11 04:35 UTC — `search -s/--source` accepts a comma-separated subset (`doc,kdb_component`); `ask` leaves scope soft (widens to all projects when a `-p` scope is empty).
- 2026-07-10 00:00 UTC — `status` reports service health and storage; numbers are thousands-separated.
- 2026-07-09 22:30 UTC — `--kind` filter on `search`.
- 2026-07-09 01:50 UTC — Streaming `ask`, `--no-stream`, richer `status`.
- 2026-07-09 01:20 UTC — Initial version.

Install on the host: `make cli-link` (npm link). Point it elsewhere with
`KDBSCOPE_API_URL` (default `http://127.0.0.1:8710`). Every command accepts
`--json` for scripting and agents.

```bash
atlas search qdrant timeout fix -p deepcast -n 15
atlas search "video import" -s git_commit
atlas search "nexus drain" -s doc,kdb_component   # subset of source types
atlas search qdrant --kind insight        # only ★ Insight blocks
atlas search readme --kind summary        # only wrap-ups
atlas ask "what were the bug fixes in the video import microservice?"   # streams
atlas ask --no-stream "…"      # wait for the whole answer
atlas --json ask "…"           # buffered: one valid JSON document
atlas projects
atlas timeline deepcast --sources kdb_changelog,git_commit
atlas components deepcast
atlas component deepcast analyzer-worker
atlas sessions deepcast
atlas session 0075adef
atlas backlog                   # cross-project: open/resolved/dropped counts
atlas backlog deepcast          # status view: every item, provenance, lints
atlas backlog deepcast --review --limit 5   # LLM-judged review of open items
atlas backlog deepcast --item 37            # review one item (any status)
atlas reindex --full -p deepcast
atlas status
atlas usage -d 30               # how agents (MCP/CLI) have been using Atlas
atlas adoption                  # ...and when they should have and didn't

```

### `atlas adoption`

`usage` counts calls that happened. `adoption` finds the ones that **should**
have happened: it reads Claude Code transcripts, matches assistant prose against
the triggers documented in the Assessor/Atlas MCP instructions, and reports
sessions where a trigger fired but the tool was never called.

```bash
atlas adoption --since 2026-07-01 --project DeepCast --limit 20
atlas adoption --json | jq '.assessor.fireRate'
atlas adoption --compare 2026-07-19        # before vs after an instruction change
```

`fireRate` is the tuning metric — used ÷ (used + missed), or `null` when nothing
qualified. Tier-2 hits are **candidates**, not verdicts: each carries an excerpt
so you can check it at a glance. Read-only and entirely local.

See [MCP → Measuring adoption](mcp.md#measuring-adoption) for why this reads
transcripts instead of asking the agent to self-report.


## Sessions

`sessions` is a command group; `list` is its default, so the old form still
works.

```bash
atlas sessions deepcast                      # unchanged: recent sessions
atlas sessions find qdrant collection copy   # which session was that?
atlas sessions find --since 2026-07-01 -p deepcast worker pool wedge
atlas sessions insights <id>                 # did / decided / left open
atlas sessions insights <id> --no-llm        # recorded facts only, no model call
atlas sessions insights <id> --sections goals,did,followups
atlas sessions related <id>                  # what else worked on this
atlas sessions related <id> --direction before --no-cross-project
```

`find` searches every project unless `-p` narrows it — the point is that you
remember the work, not where it lived. Each result prints why it matched.

`insights` prints the provenance line first: whether the AI layer answered,
was off, or was unavailable. The factual half is always there.

`related` prints its `basis`. If it says `temporal` alone, the results are
things that happened nearby, not related work, and the command says so.

All support the global `--json`.
