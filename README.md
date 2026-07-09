# KDBScope

Cross-project knowledge indexer: everything that ever happened in your projects —
per-project `kdb/` logs, Claude Code session transcripts, git history, docs/ADRs —
indexed with hybrid vector search and served through a **web UI**, a **CLI (`kdbs`)**,
a **REST API**, and an **MCP server** any coding agent can call.

Ask it things like *"what changed in DeepCast last week?"*, *"how does the VidSight
service work?"*, *"what were the bug fixes in the video import microservice?"* — and
get ranked, cited results or a synthesized LLM answer.

KDBScope is a **read-only lens**: it never writes to your projects. The whole index
(Postgres + Qdrant) is a rebuildable cache.

> **New here? Read [Getting Started](docs/getting-started.md).**
> Full documentation lives in [`docs/`](docs/index.md).

## Quick start

```bash
brew install ollama && brew services start ollama   # strongly recommended
make env        # creates .env from .env.example — review paths
make up         # builds images, starts the 7-service stack
open http://127.0.0.1:8712        # web UI
make cli-link && kdbs status      # CLI
claude mcp add --transport http kdbscope http://127.0.0.1:8711/mcp   # Claude Code
```

**Run Ollama.** The `auto` embedder prefers it and pulls `nomic-embed-text` on
first boot; without it KDBScope falls back to a bundled CPU model that is several
times slower (it says so loudly in the logs). Ollama **≥ 0.13** is required —
0.12.x segfaults inside its embeddings endpoint under sustained load.

Search works immediately on whatever is already indexed; the UI shows a progress
bar while the rest fills in.

## Architecture (7 containers)

```
~/.claude  ──ro──►┌─────────┐   BullMQ    ┌────────┐
__CODING NEW ─ro─►│ indexer │◄──(redis)──►│  api   │◄── ui (nginx :8712)
                  └────┬────┘             └───┬────┘◄── kdbs CLI (host)
                       │ embed+upsert         │      ◄── mcp :8711 (Claude Code)
                  ┌────▼────┐            ┌────▼─────┐
                  │ qdrant  │            │ postgres │
                  └─────────┘            └──────────┘
```

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
make test      # vitest (222 tests)
make lint      # tsc across all packages
make smoke     # health-checks a running stack
```

## Security posture

No authentication by design: every port binds to `127.0.0.1` only and the tool is
single-user local. Do not expose the ports beyond localhost without adding auth.
Project mounts are read-only; the stack cannot modify indexed repositories.
