# Atlas

Cross-project knowledge indexer: everything that ever happened in your projects —
per-project `kdb/` logs, Claude Code session transcripts, git history, docs/ADRs —
indexed with hybrid vector search and served through a **web UI**, a **CLI (`atlas`)**,
a **REST API**, and an **MCP server** any coding agent can call.

Ask it things like *"what changed in DeepCast last week?"*, *"how does the VidSight
service work?"*, *"what were the bug fixes in the video import microservice?"* — and
get ranked, cited results or a synthesized LLM answer.

Atlas is a **read-only lens**: it never writes to your projects. The whole index
(Postgres + Qdrant) is a rebuildable cache.

> **Atlas vs KDB.** *Atlas* is this tool. *KDB* is one of the four things it
> indexes — the append-only `kdb/` logs each project keeps. So the `atlas` command
> and the `atlas_*` MCP tools name the tool, while source types like
> `kdb_changelog` name the data: `atlas search pgbouncer -s kdb_changelog`. The
> `kdb_` prefix on those is deliberate, not a leftover.

> **New here? Read [Getting Started](docs/getting-started.md).**
> Full documentation lives in [`docs/`](docs/index.md).

## Quick start

```bash
brew install ollama && brew services start ollama   # strongly recommended
make start         # builds images, starts the 7-service stack
open http://127.0.0.1:8712        # web UI
make cli-link && atlas status      # CLI
claude mcp add --transport http atlas http://127.0.0.1:8711/mcp   # Claude Code
make mobile-start                 # native iOS/Android app (Expo; docs/mobile.md)
```

Configuration is committed in `config/atlas.defaults.env` — nothing to copy,
and nothing machine-specific in it: Atlas indexes the tree it lives in (this
repo's parent directory) and `~/.claude/projects`, both derived at start. Point
it elsewhere with `CODE_ROOT_HOST` in a gitignored `.env`, which overrides the
committed file per machine and is absent by default; secrets come from Doppler
when a session is configured.

**Run Ollama.** The `auto` embedder prefers it and pulls `nomic-embed-text` on
first boot; without it Atlas falls back to a bundled CPU model that is several
times slower (it says so loudly in the logs). Ollama **≥ 0.13** is required —
0.12.x segfaults inside its embeddings endpoint under sustained load.

Search works immediately on whatever is already indexed; the UI shows a progress
bar while the rest fills in.

## Architecture (7 containers)

```
other machines ──ssh-pull──► remote_mirror
                                   │
                                   ▼
~/.claude  ──ro──►┌─────────┐   BullMQ    ┌────────┐
projects root ─ro─►│ indexer │◄──(redis)──►│  api   │◄── ui (nginx :8712)
                  └────┬────┘             └───┬────┘◄── atlas CLI (host)
                       │ embed+upsert         │      ◄── mcp :8711 (Claude Code)
                  ┌────▼────┐            ┌────▼─────┐
                  │ qdrant  │            │ postgres │
                  └─────────┘            └──────────┘
```

**Multi-machine (optional).** Atlas can index more than one Mac: one active
instance holds the index and SSH-pulls every other configured machine's code
+ Claude transcripts into the `remote_mirror` volume above, on a cadence
(`sync.intervalMin`, default 10 min) — the scanners read it exactly like a
local checkout, machine-blind. A cross-machine-safe dedup key means
git-synced content (and Migration-Assistant-copied transcripts) collapses
onto one entry instead of double-indexing. See
[`docs/multi-machine.md`](docs/multi-machine.md) for enrolling a machine,
moving the stack, and opening LAN access; single-machine installs are
unaffected — nothing here activates without a `config/machines.yaml`.

- **Hybrid search**: dense embeddings + hash-based sparse (BM25/IDF in Qdrant),
  fused with RRF. Degrades gracefully: hybrid → sparse-only → Postgres FTS.
- **Embeddings** (pluggable): `auto` (Ollama if reachable, else bundled CPU model),
  `ollama`, `bundled`, `openai` (any OpenAI-compatible endpoint), `g2p`.
- **Ask mode**: retrieval + cited synthesis through any OpenAI-compatible LLM;
  preset for the local G2P proxy (no API key needed). Answers **stream** to the
  UI and CLI (sources first, then tokens); `--json` buffers for scripting.
- **Incremental**: append-only sources (kdb `.log`, session `.jsonl`) are re-read
  from a stored byte offset — the 11 GB transcript corpus is only paid once.
- **Zero-downtime model switches**: the collection name encodes the embedding
  dimension, so a new model builds a new collection while search keeps serving
  the old one. Vectors are rebuilt from Postgres, not by re-parsing sources.
- **Deep links**: every hit maps its container path back to a host path and a
  `vscode://` link, down to the line.
- **Conversational Ask**: follow-up questions carry the earlier turns; retry or
  delete any turn.
- **Message kinds**: session messages are classified at parse time (`insight`,
  `plan`, `summary`, `action`…) and filterable in search, CLI and MCP.
- **Overview dashboard**: what is indexed, which services are running, what it
  costs on disk — and a callout for vectors orphaned by a model change.

## Version table (§10)

| Component | Version | Source/Command | Notes |
|---|---|---|---|
| Node | 22.23.1 | `docker manifest inspect node:22.23.1-bookworm-slim` | glibc needed by onnxruntime |
| TypeScript | 7.0.2 | `npm view typescript version` | |
| PostgreSQL | 18.4 | `docker manifest inspect postgres:18.4` | org baseline ≥ 18 |
| Qdrant | v1.18.2 | `docker manifest inspect qdrant/qdrant:v1.18.2` | |
| Redis | 8.8.0-alpine | `docker manifest inspect redis:8.8.0-alpine` | |
| nginx | 1.31.2-alpine | `docker manifest inspect nginx:1.31.2-alpine` | |
| Hono | 4.12.28 | `npm view hono version` | |
| BullMQ | 5.79.3 | `npm view bullmq version` | |
| ioredis | 5.10.1 | matches bullmq's own dependency | intentional non-latest |
| MCP SDK | 1.29.0 | `npm view @modelcontextprotocol/sdk version` | |
| React | 19.2.7 | `npm view react version` | |
| Vite | 8.1.3 | `npm view vite version` | |
| Tailwind | 4.3.2 | `npm view tailwindcss version` | |
| Vitest | 4.1.10 | `npm view vitest version` | |
| zod | 4.4.3 | `npm view zod version` | |
| @huggingface/transformers | 4.2.0 | `npm view @huggingface/transformers version` | bundled embedder |
| Ollama (host) | ≥ 0.13 (tested 0.31.1) | `brew info ollama` | 0.12.x segfaults on `/api/embed` |

All Docker images are pinned `tag@digest` in `docker-compose.yml` / `docker/*.Dockerfile`.

## Development

```bash
make install   # npm workspaces
make test      # vitest (260 tests)
make lint      # tsc across all packages
make smoke     # health-checks a running stack
```

## Security posture

Single-user local by default: every port binds to `127.0.0.1` only, no
authentication required. Opting into LAN access (`ATLAS_BIND=0.0.0.0`, for
multi-machine setups) **requires** `ATLAS_TOKEN` — a non-loopback bind with
no token refuses to boot rather than serve unauthenticated. Qdrant, Redis
and Postgres never leave loopback regardless of `ATLAS_BIND`. The threat
model is a trusted home LAN over cleartext HTTP, not a hostile network —
see [`docs/multi-machine.md`](docs/multi-machine.md#lan-access-setup) for
setup and the documented Tailscale/TLS upgrade path. Project mounts are
read-only; the stack cannot modify indexed repositories.

Reaching Atlas from **outside** the LAN is a separate, opt-in path: an
outbound Cloudflare tunnel with Cloudflare Access in front, so no port is
opened on the host and unauthenticated requests never reach the origin at
all. `ATLAS_TOKEN` still applies on top, because a tunnelled request arrives
through nginx and is therefore never loopback — two independent layers. See
[`docs/public-access.md`](docs/public-access.md).
