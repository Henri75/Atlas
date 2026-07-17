2026-07-09 12:20 UTC

# Getting Started

## Revision History
- 2026-07-17 15:49 UTC — Claude Code: register at **user scope** (all projects), plus how to disable/re-enable (`claude mcp remove/add`, `/mcp` in-session); agents receive beta instructions at connect time; `atlas usage` shows agent traffic.
- 2026-07-10 00:00 UTC — Overview dashboard; human-readable numbers throughout.
- 2026-07-09 22:30 UTC — Ask conversations, message kinds, timeline layouts, session filters.
- 2026-07-09 16:00 UTC — Multiple project roots; clarified that `make cli-link` is global and run once.
- 2026-07-09 12:20 UTC — Initial version.

Everything you need to start Atlas, keep its index current, and actually use
it from the browser, the terminal, and Claude Code.

---

## 1. Before you start

**Install and run Ollama.** Atlas embeds text locally; without Ollama it falls
back to a bundled CPU model that is several times slower.

```bash
brew install ollama
brew services start ollama     # launchd: survives reboots
ollama --version               # must be >= 0.13 (0.12.x crashes on embeddings)
```

You don't need to pull a model — Atlas pulls `nomic-embed-text` on first boot.

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
make smoke    # seven endpoint checks
make logs     # follow indexer/api/mcp
```

### The first index takes a while

On boot the indexer discovers every project and starts reading. Small sources
(kdb logs, git history, docs) land within minutes; the ~10k Claude Code
transcripts take an hour or so and are indexed **newest first**, so recent work
is searchable almost immediately.

Watch progress in the UI footer, or:

```bash
make cli-link      # run once, from this repo
atlas status
```

`make cli-link` installs `atlas` **globally** on your machine (an `npm link`), so
you only run it once, from this directory. After that `atlas` works from any
folder — it is a thin client for the API and always searches everything the
*server* indexes, regardless of where you happen to be standing.

---

## 3. Use it

### Web UI — <http://127.0.0.1:8712>

Five views, switchable with keys `1`–`5`:

1. **Overview** — the landing page: how many projects, documents, chunks and
   sessions are indexed; which services are running; how much disk each store
   uses; and what the index is made of. It also flags vectors left behind by an
   embedding-model change — usually a gigabyte nothing reads.
2. **Search & Ask** — press `/` to focus the box.
   - `Enter` runs a hybrid search (semantic + keyword).
   - `⌘Enter` asks the LLM, which **streams** a cited answer.
   - Ask is a **conversation**: keep asking follow-ups and the LLM sees the
     earlier turns. Hover a turn to **retry** a reply (`↻`) or **delete** it
     (`✕`); *new conversation* starts over.
   - The **kind** dropdown narrows to how a session message was classified —
     `insight`, `plan`, `summary`, `action`, `prompt`. Asking a project for its
     insights is often more useful than a keyword search.
   - A line under the box always shows the current **scope**. Changing the
     project clears the results, because their citations pointed at entries in
     the old scope.
   - Click any result — or any `[n]` citation — to open the full entry, with
     **Open in editor**.
3. **Timeline** — a project's history, newest first. Toggle **FEED** (grouped by
   day, colour-coded) or **TABLE** (date and time in their own columns, easier
   to scan by *when*). The choice is remembered. Filter the loaded entries.
4. **Components** — browse a project's components and their recorded history,
   with a filter.
5. **Sessions** — replay a Claude Code conversation. Filter the list; inside a
   session, filter the messages or narrow to a kind (`YOU`, `CLAUDE`, `INSIGHT`,
   `DID`, …). The header shows when it ran, how long it took, and how many
   prompts, actions and files were involved.

If a banner says search is *degraded*, it names what broke and what it costs.

### CLI — `atlas`

```bash
atlas search qdrant timeout fix              # across everything
atlas search "video import" -p deepcast      # one project
atlas search pgbouncer -s kdb_changelog      # one source type
atlas search qdrant --kind insight           # only ★ Insight blocks
atlas search readme --kind summary           # only wrap-ups

atlas ask "what were the bug fixes in the video import microservice?"
atlas ask "how does VidSight work?" -p deepcast

atlas projects                     # what's indexed
atlas timeline deepcast            # what happened, newest first
atlas components deepcast          # this project's components
atlas component deepcast analyzer-worker
atlas sessions deepcast
atlas session 0075adef             # replay one conversation
atlas status                       # counts, health, storage, freshness
```

Add `--json` to any command for scripting. Ask streams to your terminal;
`--json` and `--no-stream` wait for the whole answer.

Source types for `-s`: `kdb_changelog`, `kdb_session`, `kdb_component`,
`kdb_backlog`, `kdb_report`, `claude_session`, `git_commit`, `doc`.

### From Claude Code (MCP)

Register once for **all** projects (user scope):

```bash
claude mcp add --scope user --transport http atlas http://127.0.0.1:8711/mcp
```

Then just ask Claude things like *"use atlas to find how the qdrant retry
logic evolved"*. It has ten tools; the useful flow is `atlas_search` → take an
`entryId` → `atlas_entry` for the full record. `atlas_ask` gives a cited answer,
`atlas_timeline` / `atlas_component_history` / `atlas_session` widen the context.
The server sends usage instructions to the agent at connect time, including the
beta caveat (verify answers against cited sources) and a duty to report Atlas
usage + issues in its summaries.

This repo also ships `.mcp.json`, so a Claude Code session started **inside this
directory** picks the server up with no setup.

**Disable / re-enable whenever needed:**

```bash
claude mcp remove --scope user atlas       # disable everywhere
claude mcp add --scope user --transport http atlas http://127.0.0.1:8711/mcp   # re-enable
claude mcp list                            # see what is registered + connection state
```

Inside a running session, `/mcp` shows the server and lets you toggle it without
touching the config. If the Atlas stack is simply stopped (`make down`), the
tools fail fast and Claude carries on without them — deregistering is optional.

Watch what agents actually do with it: `atlas usage` (or
`GET /api/admin/usage`).

---

## 4. Keeping the index current

The indexer rescans every 5 minutes and only reads what changed (append-only
files are read from a stored byte offset, so the 11 GB of transcripts is paid
for once).

Force it when you don't want to wait:

```bash
atlas reindex                  # incremental, now
atlas reindex -p deepcast      # one project
atlas reindex --full           # forget what was scanned; re-parse everything
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

The **previous collection stays on disk** — often more than a gigabyte. The
Overview flags it as `STALE`, and `atlas status` says so too. Nothing reads it.
Reclaim the space by deleting that collection in Qdrant:

```bash
curl -X DELETE "http://127.0.0.1:6363/collections/<stale-collection-name>"
```

---

## 5. Indexing more than one project folder

By default Atlas indexes one tree: whatever `CODE_ROOT_HOST` points at
(`__CODING NEW`). You can add up to **four more**. Uncomment a slot in `.env`:

```bash
CODE_ROOT_HOST=/Users/nasta/__CODING NEW      # slot 1 (always used)
CODE_ROOT_HOST_2=/Users/nasta/Documents/CODING
CODE_ROOT_HOST_3=/Volumes/CloudBox/Projects
```

Then apply it — no reindex flag needed:

```bash
docker compose up -d
```

Each tree is mounted **read-only** at `/data/code`, `/data/code2`, … and
scanned the same way: a directory is a project if it contains `kdb/` or `.git`,
and one nesting level down is scanned too (so `DeepCast/Lycos` is its own
project).

**Why this matters for Claude Code sessions.** Claude Code names each
transcript folder after the *host* path of the session's working directory. If
that path isn't under one of your roots, Atlas cannot tell which project the
session belongs to, so it files it under a standalone project named after the
path (`users-nasta-documents-coding-deepcast`). Add the folder as a root and
those sessions merge into the real project on the next boot.

To see which of these you have:

```bash
atlas projects --json | jq -r '.[] | select(.rootPath=="") | .slug'
```

Anything listed there is a transcript folder Atlas has history for but no
files. Adding its parent as a root will attach it to the right project.

Changing the grouping rules rebuilds the derived index automatically (the
sources are read-only and untouched); it takes as long as a first index.

---

## 6. Settings worth knowing

Edit `.env`, then `docker compose up -d` to apply.

| Setting | Default | When to change it |
|---|---|---|
| `SCAN_INTERVAL_MIN` | `5` | How often to look for new content. |
| `WORKER_CONCURRENCY` | `2` | Parallel scan jobs. A local Ollama serves one embed at a time, so raising this just deepens its queue. Raise only for a remote embedding endpoint. |
| `EMBEDDINGS_PROVIDER` | `auto` | `auto` (Ollama, else bundled CPU), `ollama`, `bundled`, `openai`, `g2p`. |
| `EMBEDDINGS_MODEL` | `nomic-embed-text` | Any Ollama embedding model. Changing it triggers a rebuild. |
| `LLM_PROVIDER` / `LLM_BASE_URL` | `g2p` / `:8181/v1` | Point Ask at any OpenAI-compatible endpoint. Set `LLM_API_KEY` if it needs one. |
| `LLM_MODEL` | `gemini-2.5-flash` | The model that writes Ask answers. |
| `CODE_ROOT_HOST` | `__CODING NEW` | The main projects tree to index. Also used for editor deep links and to attach Claude sessions to projects. |
| `CODE_ROOT_HOST_2` … `_5` | unset | Extra project trees. See [section 5](#5-indexing-more-than-one-project-folder). |
| `CLAUDE_PROJECTS_HOST` | `~/.claude/projects` | Where Claude Code stores transcripts. |
| `UI_PORT` / `API_PORT` / `MCP_PORT` | 8712 / 8710 / 8711 | Only if something else owns the port. |

Everything binds to `127.0.0.1` and there is no authentication — this is a
single-user local tool. Your project folders are mounted **read-only**;
Atlas cannot modify them.

---

## 7. Everyday commands

```bash
make up / make down          # start / stop (data volumes survive)
make ps / make logs          # status / follow logs
make smoke                   # is it healthy?
make test / make lint        # 171 unit tests, typecheck
atlas status                  # index counts, freshness, recent errors
```

Reset the index completely (sources are untouched, everything re-parses):

```bash
docker compose down -v && make up
```

---

## 8. If something looks wrong

| Symptom | What it means |
|---|---|
| Search says **degraded** | The banner names the cause: embedding provider down (keyword-only) or Qdrant down (Postgres fallback). |
| **Ask returns sources but no answer** | The LLM endpoint is unreachable. Is G2P running on `:8181`? |
| **Indexing stalls, no logs, no CPU** | Almost always Ollama. Check `ollama --version` (needs ≥ 0.13) and `brew services list`. |
| **`atlas status` shows recent errors** | `curl -s localhost:8710/api/admin/errors \| jq` for detail. Errors are per-file; one bad file never stops a scan. |
| **Results seem stale** | `atlas reindex`, then watch `atlas status`. |

`atlas status` reports errors **in the last hour** — that's the number that tells
you whether something is wrong *now*. The lifetime total is shown for context.

Deeper troubleshooting, including the metrics that lie, is in
[operations](operations.md).
