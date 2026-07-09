2026-07-09 12:20 UTC

# Getting Started

## Revision History
- 2026-07-09 12:20 UTC — Initial version.

Everything you need to start KDBScope, keep its index current, and actually use
it from the browser, the terminal, and Claude Code.

---

## 1. Before you start

**Install and run Ollama.** KDBScope embeds text locally; without Ollama it falls
back to a bundled CPU model that is several times slower.

```bash
brew install ollama
brew services start ollama     # launchd: survives reboots
ollama --version               # must be >= 0.13 (0.12.x crashes on embeddings)
```

You don't need to pull a model — KDBScope pulls `nomic-embed-text` on first boot.

**Docker** must be running (OrbStack or Docker Desktop).

**Optional:** the G2P proxy on `:8181` for Ask-mode answers. Without it, search
works fully; Ask returns its sources and tells you the LLM is unreachable.

---

## 2. Start it

```bash
cd "/Users/nasta/__CODING NEW/kdb"
make env      # writes .env from .env.example — open it and check the two host paths
make up       # builds images, starts 7 containers
```

That's it. Three surfaces are now live:

| What | Where |
|---|---|
| Web UI | <http://127.0.0.1:8712> |
| REST API | <http://127.0.0.1:8710/api/health> |
| MCP (for Claude Code) | `http://127.0.0.1:8711/mcp` |

Check it came up:

```bash
make smoke    # six endpoint checks
make logs     # follow indexer/api/mcp
```

### The first index takes a while

On boot the indexer discovers every project and starts reading. Small sources
(kdb logs, git history, docs) land within minutes; the ~10k Claude Code
transcripts take an hour or so and are indexed **newest first**, so recent work
is searchable almost immediately.

Watch progress in the UI footer, or:

```bash
make cli-link      # once, to install the `kdbs` command
kdbs status
```

---

## 3. Use it

### Web UI — <http://127.0.0.1:8712>

Four views, switchable with keys `1`–`4`:

1. **Search & Ask** — press `/` to focus the box.
   - `Enter` runs a hybrid search (semantic + keyword).
   - `⌘Enter` asks the LLM, which streams a cited answer.
   - Click any result to open the full entry, with **Open in editor**.
2. **Timeline** — a project's history, newest first.
3. **Components** — browse a project's components and their recorded history.
4. **Sessions** — replay a Claude Code conversation.

If a banner says search is *degraded*, it names what broke and what it costs.

### CLI — `kdbs`

```bash
kdbs search qdrant timeout fix              # across everything
kdbs search "video import" -p deepcast      # one project
kdbs search pgbouncer -s kdb_changelog      # one source type

kdbs ask "what were the bug fixes in the video import microservice?"
kdbs ask "how does VidSight work?" -p deepcast

kdbs projects                     # what's indexed
kdbs timeline deepcast            # what happened, newest first
kdbs components deepcast          # this project's components
kdbs component deepcast analyzer-worker
kdbs sessions deepcast
kdbs session 0075adef             # replay one conversation
kdbs status                       # counts, freshness, errors
```

Add `--json` to any command for scripting. Ask streams to your terminal;
`--json` and `--no-stream` wait for the whole answer.

Source types for `-s`: `kdb_changelog`, `kdb_session`, `kdb_component`,
`kdb_backlog`, `kdb_report`, `claude_session`, `git_commit`, `doc`.

### From Claude Code (MCP)

Register once:

```bash
claude mcp add --transport http kdbscope http://127.0.0.1:8711/mcp
```

Then just ask Claude things like *"use kdbscope to find how the qdrant retry
logic evolved"*. It has ten tools; the useful flow is `kdb_search` → take an
`entryId` → `kdb_entry` for the full record. `kdb_ask` gives a cited answer,
`kdb_timeline` / `kdb_component_history` / `kdb_session` widen the context.

This repo also ships `.mcp.json`, so a Claude Code session started **inside this
directory** picks the server up with no setup.

---

## 4. Keeping the index current

The indexer rescans every 5 minutes and only reads what changed (append-only
files are read from a stored byte offset, so the 11 GB of transcripts is paid
for once).

Force it when you don't want to wait:

```bash
kdbs reindex                  # incremental, now
kdbs reindex -p deepcast      # one project
kdbs reindex --full           # forget what was scanned; re-parse everything
```

Or click **Reindex now** in the UI footer, or `make reindex` / `make reindex-full`.

`--full` re-reads every source file but does **not** re-embed unchanged
entries — dedup keys make that a no-op. Use it when a parser changed.

### When you change the embedding model

Set `EMBEDDINGS_MODEL` in `.env`, then `docker compose up -d indexer`.

The collection name encodes the vector dimension, so a new model gets a new
collection. The indexer rebuilds the vectors **from Postgres** (no re-parsing),
resumes if interrupted, and only switches search over when the new collection is
ready. Search keeps serving the old one throughout. A ~74k-entry rebuild takes
roughly 40 minutes.

---

## 5. Settings worth knowing

Edit `.env`, then `docker compose up -d` to apply.

| Setting | Default | When to change it |
|---|---|---|
| `SCAN_INTERVAL_MIN` | `5` | How often to look for new content. |
| `WORKER_CONCURRENCY` | `2` | Parallel scan jobs. A local Ollama serves one embed at a time, so raising this just deepens its queue. Raise only for a remote embedding endpoint. |
| `EMBEDDINGS_PROVIDER` | `auto` | `auto` (Ollama, else bundled CPU), `ollama`, `bundled`, `openai`, `g2p`. |
| `EMBEDDINGS_MODEL` | `nomic-embed-text` | Any Ollama embedding model. Changing it triggers a rebuild. |
| `LLM_PROVIDER` / `LLM_BASE_URL` | `g2p` / `:8181/v1` | Point Ask at any OpenAI-compatible endpoint. Set `LLM_API_KEY` if it needs one. |
| `LLM_MODEL` | `gemini-2.5-flash` | The model that writes Ask answers. |
| `CODE_ROOT_HOST` | `__CODING NEW` | The projects tree to index. Also used to build editor deep links. |
| `CLAUDE_PROJECTS_HOST` | `~/.claude/projects` | Where Claude Code stores transcripts. |
| `UI_PORT` / `API_PORT` / `MCP_PORT` | 8712 / 8710 / 8711 | Only if something else owns the port. |

Everything binds to `127.0.0.1` and there is no authentication — this is a
single-user local tool. Your project folders are mounted **read-only**;
KDBScope cannot modify them.

---

## 6. Everyday commands

```bash
make up / make down          # start / stop (data volumes survive)
make ps / make logs          # status / follow logs
make smoke                   # is it healthy?
make test / make lint        # 171 unit tests, typecheck
kdbs status                  # index counts, freshness, recent errors
```

Reset the index completely (sources are untouched, everything re-parses):

```bash
docker compose down -v && make up
```

---

## 7. If something looks wrong

| Symptom | What it means |
|---|---|
| Search says **degraded** | The banner names the cause: embedding provider down (keyword-only) or Qdrant down (Postgres fallback). |
| **Ask returns sources but no answer** | The LLM endpoint is unreachable. Is G2P running on `:8181`? |
| **Indexing stalls, no logs, no CPU** | Almost always Ollama. Check `ollama --version` (needs ≥ 0.13) and `brew services list`. |
| **`kdbs status` shows recent errors** | `curl -s localhost:8710/api/admin/errors \| jq` for detail. Errors are per-file; one bad file never stops a scan. |
| **Results seem stale** | `kdbs reindex`, then watch `kdbs status`. |

`kdbs status` reports errors **in the last hour** — that's the number that tells
you whether something is wrong *now*. The lifetime total is shown for context.

Deeper troubleshooting, including the metrics that lie, is in
[operations](operations.md).
