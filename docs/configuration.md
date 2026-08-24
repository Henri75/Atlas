2026-07-09 01:20 UTC

# Configuration

## Revision History
- 2026-08-24 15:10 UTC — Host paths derived (`${ATLAS_REPO_PARENT}`, `${HOME}`) instead of committed absolute paths; compose fallbacks fail loud; guard test.
- 2026-08-19 22:01 UTC — Multi-machine: `ATLAS_SELF`, `ATLAS_MACHINES_FILE`, `ATLAS_BIND`, `ATLAS_TOKEN`, `ATLAS_KEYS_DIR`, `ATLAS_FORCE_ACTIVE`, and `config/machines.yaml`. See `docs/multi-machine.md` for the operator runbook.
- 2026-07-30 00:45 UTC — Qdrant memory layout documented: dense originals and the sparse index moved to disk, why `always_ram` is not the flag that does that, and why `rescore` must be set explicitly once they are.
- 2026-07-29 18:40 UTC — Configuration sources restructured: `config/atlas.defaults.env` is committed and authoritative, Doppler supplies secrets, `.env` is an optional override that is absent by default. `make env` removed.
- 2026-07-29 17:50 UTC — `KDB_ALLOW_EMBEDDER_DOWNGRADE` and *Why `auto` will refuse to start*: the probe retries, and a fallback can no longer silently migrate the index.
- 2026-07-29 14:35 UTC — `KDB_SPARSE_REBUILD`, the kill switch for the sparse re-tokenisation pass.
- 2026-07-12 13:50 UTC — Product renamed to **Atlas**; documented why the `KDBSCOPE_*` / `kdbscope` identifiers survive the rename.
- 2026-07-10 22:24 UTC — Doc staleness knobs: `KDB_DOCS_AGING_MONTHS`, `KDB_ARCHIVED_PENALTY`.
- 2026-07-10 00:00 UTC — QDRANT_STORAGE_PATH for dashboard disk usage.
- 2026-07-09 16:00 UTC — Multiple project roots; why host paths are passed into the containers.
- 2026-07-09 01:50 UTC — Ollama-preferred `auto` + version floor, WORKER_CONCURRENCY default 2, host-path passthrough, model-switch rebuild.
- 2026-07-09 01:20 UTC — Initial version.

All configuration is environment-driven through the central module
`packages/core/src/config.ts` (§3.1: no inline constants anywhere).

## Where values come from

Three sources, lowest precedence first:

| # | source | holds | committed |
|---|---|---|---|
| 1 | **`config/atlas.defaults.env`** | everything non-secret — host paths, ports, providers, models, intervals, thresholds | yes |
| 2 | **Doppler** | secrets only (`*_API_KEY`), when a session is configured | n/a |
| 3 | **`.env`** | anything, to override on one machine | no (gitignored) |

**Edit `config/atlas.defaults.env`.** It is the source of truth, and the stack
runs correctly with **no `.env` at all** — that is the normal state, not a
degraded one. Create a `.env` only to change a value on one machine, containing
just the lines you are changing.

Then apply it with **`make restart-build`**. `make restart` will not: container
environment is fixed when the container is created (see
[operations.md](operations.md)).

Compose reads both files natively, in order — `--env-file` for `${...}`
interpolation and a two-entry `env_file:` for container environment — so there is
no generator and no copy step. The `.env` entry is `required: false`, which is
what lets it be absent.

**Secrets.** `EMBEDDINGS_API_KEY` and `LLM_API_KEY` are declared as empty slots
and are passed through `environment:` as `${VAR:-}`. Under `doppler run --` the
injected value wins (shell beats file); without Doppler the expression resolves
from the files; with neither it is empty — which is Atlas's actual state today,
since Ollama and the local G2P proxy need no key. Doppler is never required: the
Makefile detects a configured session and runs without it otherwise.

Because this design rests on six measured Compose behaviours, `make config-check`
asserts them against the real `docker compose` — a release that changed any one
of them would otherwise start the stack with the wrong values and no error.

> The Makefile passes explicit `--env-file` flags, which **suppresses Compose's
> implicit `./.env`**. A bare `docker compose …` is therefore no longer
> equivalent to going through `make`; the Makefile is the entry point (§3.5).

### A note on the `kdbscope` / `KDB_` names you will see here

The product is **Atlas**, but several settings still say `kdbscope`, and others
say `KDB_`. Both are intentional; do not "tidy" them.

- `KDBSCOPE_API_URL`, the Postgres db/role `kdbscope`, and the Qdrant collection
  prefix `kdbscope_*` are **legacy datastore identifiers**. They are the keys the
  existing index is stored under. Renaming the collection prefix or the id
  namespace invalidates every dedup key and Qdrant point id and forces a full
  re-index of ~280k entries, so they were deliberately left as-is.
- `KDB_DOCS_AGING_MONTHS` / `KDB_ARCHIVED_PENALTY` refer to **KDB**, the
  append-only knowledge base Atlas indexes — a different thing from Atlas itself.
  See *Naming: Atlas vs KDB* in [architecture.md](architecture.md).

## Host paths

| Var | Default | Meaning |
|---|---|---|
| `CODE_ROOT_HOST` | `${ATLAS_REPO_PARENT}` — this repo's parent directory, exported by the Makefile | main projects root, mounted **read-only** at `/data/code` |
| `CODE_ROOT_HOST_2` … `_5` | unset | up to four more project roots, mounted at `/data/code2` … `/data/code5` |
| `CLAUDE_PROJECTS_HOST` | `${HOME}/.claude/projects` | transcripts, mounted **read-only** at `/data/claude/projects` |

Both defaults are **derived, never written down** — no committed file carries an
absolute path from one machine (`test/core/configDefaults.test.ts` fails on one),
so a checkout works unchanged on any host, user or path. Compose interpolates
`${...}` inside env files, which is how the derivation reaches both the mounts
and the container environment. Running `docker compose` outside `make` fails
loud (`ATLAS_REPO_PARENT is missing`) rather than mounting a guessed path.

A `CODE_ROOT_HOST_n` slot is active only when it is set; compose cannot express
an optional mount, so unset slots re-mount root 1 harmlessly and the indexer
ignores them.

These host paths are passed into the containers for two reasons: the API maps an
indexed container path back to a host path for editor deep links, and the indexer
needs them to attribute Claude Code transcripts to projects — Claude names each
transcript directory after the session's **host** working directory, so matching
on container paths finds nothing and splits every project in two.

The container-side mount points (`CODE_ROOT`, `CODE_ROOT_2` …) can be overridden
but rarely need to be.

## Storage

| Var | Default | Meaning |
|---|---|---|
| `QDRANT_STORAGE_PATH` | `/qdrant-storage` | Where Qdrant's data volume is mounted **read-only** into the API, so the dashboard can report real disk usage. Qdrant exposes no API for it. |
| `QDRANT__STORAGE__ASYNC_SCORER` | `true` | Set on the Qdrant container in `docker-compose.yml`. Uses io_uring for the on-disk vector reads that rescoring performs. Needs Linux 5.11+; Qdrant warns and falls back on older kernels. |

### Qdrant memory layout

The collection is tuned for **lowest resident memory first, then speed**. Four
settings do the work, and they are not independent — changing one without the
others gives back most of the win:

| Setting | Value | Effect |
|---|---|---|
| `vectors.dense.on_disk` | `true` | fp32 originals are memory-mapped, not resident (~1.1GB at 377k points) |
| `quantization.scalar.always_ram` | `true` | the int8 copy (~290MB) *is* pinned in RAM — this is what keeps search fast |
| `sparse_vectors.sparse.index.on_disk` | `true` | sparse inverted index memory-mapped (~98MB) |
| `hnsw_config.on_disk` | `false` | the graph stays in RAM **on purpose** — ~31MB, and every query walks it |

Measured on the live 377k-point collection (2026-07-30): container peak
**2,275 MiB → 747 MiB**, with no re-embedding — Qdrant converts each segment's
storage format in place.

**Two traps, both of which have already caught this repo once:**

1. **`always_ram` does not put the originals on disk.** It only controls where
   the *quantized* copy lives. `vectors.dense.on_disk` is the flag for the
   originals, and its default is *in RAM*. Setting quantization alone means the
   collection carries both copies. That was the state from 2026-07-15 to
   2026-07-30; the symptom is segments reporting
   `storage_type: InRamChunkedMmap` instead of `Mmap`/`ChunkedMmap`.

2. **`rescore` must be explicit once vectors are on disk.** Qdrant's default for
   it flips to *off* when the originals are on disk, to avoid the disk read —
   silently trading recall for latency. Measured recall@10 against an exact
   full-precision scan: **0.992** with `rescore: true`, **0.956** with the
   default. It is set in `SEARCH_PARAMS` (`packages/core/src/qdrant.ts`) and
   pinned by `test/core/qdrantStorage.test.ts`.

To verify the live collection matches this:

```
curl -s localhost:6363/collections/<name> | jq '.result.config | {vectors: .params.vectors, sparse: .params.sparse_vectors, hnsw: .hnsw_config.on_disk, quant: .quantization_config}'
```

## Indexing

| Var | Default | Meaning |
|---|---|---|
| `SCAN_INTERVAL_MIN` | `5` | incremental scan cadence |
| `WORKER_CONCURRENCY` | `2` | parallel scan jobs. Every job embeds, and a local Ollama serves one request at a time — more workers only deepen its queue. Raise for a remote/batched endpoint. |
| `KDB_SPARSE_REBUILD` | `true` | run the sparse re-tokenisation pass when `SPARSE_VERSION` moves ahead of the collection's stamp. Set `false` to stop a rebuild that is misbehaving without editing source: keyword search then runs on stale tokens (degraded, not broken — dense retrieval is unaffected) and the pass retries next boot. |
| `KDB_ALLOW_EMBEDDER_DOWNGRADE` | `false` | permit `EMBEDDINGS_PROVIDER=auto` to move the index to a different collection after falling back to a non-preferred embedder. See below. |

### Why `auto` will refuse to start

The collection name encodes the embedding dimension, so resolving a different
embedder means a *different collection* — and the boot sequence then re-embeds
every entry into it, publishes it as active, and reclaims the previous one as an
orphan. That is correct when you switch models deliberately, and catastrophic
when `auto` merely failed to reach Ollama for a moment.

It is not hypothetical. On 2026-07-29, with the host at load 26, the 2-second
probe timed out while Ollama was running and reachable throughout; the indexer
booted on the bundled 384-dim model and began rebuilding 326k entries.

Two guards now:

- the probe **retries** (3 attempts, backoff) before conceding, so a loaded host
  gets the benefit of the doubt — a genuinely absent Ollama still answers in
  about seven seconds;
- the indexer **refuses to start** when `auto` falls back *and* a populated
  collection exists under a different name. It exits non-zero; compose restarts
  it, and by then the provider is usually up. Search is unaffected throughout,
  because `active_collection` is exactly what the refusal declines to change.

To switch models on purpose, set `EMBEDDINGS_PROVIDER` explicitly — an explicit
provider is an instruction and is always honoured. `KDB_ALLOW_EMBEDDER_DOWNGRADE=true`
is the escape hatch for letting a one-off `auto` downgrade through.

`GET /api/dashboard` carries `embedderHealth` — which embedder is actually
serving and whether it is a fallback — and the UI shows it beside the service
list. `health` cannot express this: it measures reachability, and during that
incident everything was reachable.

### The sparse re-tokenisation pass

Stored sparse vectors and query sparse vectors must come from the same
tokeniser. When they do not, keyword search does not error — it silently stops
matching, which is how a question about a "6.8MB json" once came back with the
five entries that answered it nowhere in the top 100
(`docs/adr/20260729-literals-survive-tokenisation.md`).

`SPARSE_VERSION` in `packages/core/src/sparse.ts` is compared at indexer boot
against a per-collection `sparse_version` setting. A mismatch rewrites the sparse
half of every point in place through Qdrant's update-vectors endpoint — **no
embedding calls, no re-parsing of sources**, because a tokeniser change does not
touch dense vectors. A collection the backfill just rebuilt is stamped rather
than rewritten: it was already written by the current tokeniser.

Progress is a stored cursor (`sparse_cursor:<collection>`), and the version is
stamped only when the pass completes, so an interrupted run resumes instead of
declaring a half-rebuilt index good. Watch it with `make logs`:

```
[indexer] re-tokenising sparse vectors to v2 — no embedding calls
[indexer] re-tokenise 10000/326405 entries
[indexer] re-tokenise complete: 326405 entries / 366559 points in 214s
```

## Doc staleness

Docs under archive-style paths (`docs/archive`, `_legacy`, `Previous`, `old`,
`deprecated`…) are indexed like everything else but downranked and labeled in
results; docs merely untouched for a long time get an `aging` label with no
rank penalty. All of it is query-time behavior — changing these never requires
a reindex.

| Var | Default | Meaning |
|---|---|---|
| `KDB_DOCS_AGING_MONTHS` | `12` | age (months since file mtime) past which an unarchived doc is labeled `aging` |
| `KDB_ARCHIVED_PENALTY` | `0.6` | multiplier applied to the search score of archived doc hits (0–1; lower buries them deeper) |

## Embeddings

| Var | Default | Meaning |
|---|---|---|
| `EMBEDDINGS_PROVIDER` | `auto` | `auto` \| `ollama` \| `bundled` \| `openai` \| `g2p` |
| `EMBEDDINGS_MODEL` | `nomic-embed-text` | model name for ollama/openai/g2p |
| `EMBEDDINGS_BASE_URL` | — | required for `openai`; optional override for `g2p` |
| `EMBEDDINGS_API_KEY` | — | bearer token when the endpoint needs one |
| `OLLAMA_URL` | `http://host.docker.internal:11434` | probed by `auto`/`ollama` |

`auto` prefers Ollama, pulling `EMBEDDINGS_MODEL` on first boot, and falls back
to the bundled CPU model (`Xenova/all-MiniLM-L6-v2`, cached in the `hf_cache`
volume) — logging loudly whenever it does. **Ollama ≥ 0.13** is required;
0.12.x segfaults inside its embeddings endpoint.

**Switching provider/model creates a new Qdrant collection** (its name encodes
the vector dimension). The indexer rebuilds the vectors from Postgres on the
next boot — no `make reindex-full` needed, and no re-parsing of sources — then
publishes `active_collection`, which api/mcp follow within 15s. Search serves
the previous collection until the new one is ready. See
[operations](operations.md#switching-the-embedding-model).

## Ask-mode LLM

| Var | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `g2p` | `g2p` \| `openai` (both speak the OpenAI wire protocol) |
| `LLM_MODEL` | `gemini-2.5-flash` | |
| `LLM_BASE_URL` | `http://host.docker.internal:8181/v1` | G2P default; set your endpoint for `openai` |
| `LLM_API_KEY` | — | not needed for G2P |

Retry policy per §3.8: 429/5xx retried ≤ 2 with backoff; other 4xx fail fast.

### Identifying ourselves to G2P

| Var | Default | Meaning |
|---|---|---|
| `KDB_G2P_CLIENT_ID` | `Atlas` | Sent as `X-G2P-Client-Id` on every LLM **and** embedding call |

G2P attributes each request to a caller and rolls it up in its `/hstats`
dashboard (unique clients, per-client volume and cost). Without the header our
traffic lands in the anonymous bucket alongside every other tool pointed at the
same proxy, which is what made per-consumer accounting unreadable.

The header is purely observational — **G2P never routes on it** — and a non-G2P
OpenAI-compatible endpoint ignores an unknown header, so it is sent regardless
of `LLM_PROVIDER` rather than gated on it.

One value covers both surfaces on purpose: it identifies *this deployment*, not
one endpoint. Set it per instance to tell two Atlas installs apart on the
dashboard. Set it to an **explicitly empty** string to send no header at all —
note that unset is different from empty, since unset falls back to the default.

We trim, strip control characters, and truncate to 128 chars before sending —
mirroring G2P's own server-side sanitising — so a client id read off the
dashboard always matches what is configured here.

## Multi-machine

Full design: `docs/superpowers/specs/2026-08-19-multi-machine-design.md`.
Operator runbook (enrolling a machine, moving the stack, the migration
rollout, LAN access): [`multi-machine.md`](multi-machine.md).

| Var | Default | Meaning |
|---|---|---|
| `ATLAS_MACHINES_FILE` | `/config/machines.yaml` (container) | Path to the fleet SSoT. Host-side tools (CLI, `atlas-connect`) resolve the repo-relative `config/machines.yaml` instead when unset — leave this unset on the host. Absent file = legacy single-machine mode. |
| `ATLAS_SELF` | unset | Which `config/machines.yaml` entry is **this** host. Belongs in the per-machine gitignored `.env`, never in the committed defaults. Boot fails loudly if a machines file exists and this is unset or names no entry — no hostname guessing. |
| `ATLAS_BIND` | `127.0.0.1` | Host bind address for `api`/`mcp`/`ui` (also drives their `docker-compose.yml` port bindings). Set `0.0.0.0` to serve the LAN — **only** together with `ATLAS_TOKEN`: a non-loopback bind with no token refuses to boot (fail closed). `qdrant`/`redis`/`postgres` stay `127.0.0.1` regardless. |
| `ATLAS_TOKEN` | unset | Secret bearer token required on every `api`/`mcp` route once `ATLAS_BIND` is non-loopback (the liveness routes and `/api/instance` are exempt). Via Doppler or `.env`, never committed. Host clients read it from `~/.atlas/credentials`, written once per machine by `atlas connect --token <token>`. |
| `ATLAS_KEYS_DIR` | `${HOME}/.atlas/keys` | Host directory holding the dedicated `atlas_sync` SSH keypair, bind-mounted read-only into `indexer` at `/keys`. Directory (not file) mount on purpose — Docker turns a missing bind-mount *file* into a directory, which would hand ssh a directory as an identity file; `make start`'s preflight creates it and warns if the key itself is missing while a remote is enabled. Compose-consumed only — never read by `packages/core`. |
| `ATLAS_FORCE_ACTIVE` | `false` | Emergency escape hatch for the boot-time single-active guard: a live peer normally refuses to let this instance start. Deliberately absent from the committed defaults — it overrides a safety check meant to prevent two stacks writing the same index at once, so it belongs in a one-off shell/Doppler override for the boot that needs it. Documented value is `true`/`false`; also lenient-accepts `1`/`0`, unlike every other boolean flag here, because an operator reaching for this is already mid-incident. |

`config/machines.yaml` (committed, mounted read-only into `indexer`/`api`) is
the fleet itself — name (frozen once indexed data exists), address, SSH
user, code roots, Claude projects dir, `enabled`, plus per-machine
`remoteRsyncPath`/`slugOverrides` overrides and a top-level `sync.intervalMin`/
`sync.excludes`. Edited directly or via `atlas machines add|remove|list`; the
UI Machines page is read-only in v1. See `multi-machine.md` for the
add-machine runbook and `packages/core/src/machines.ts` for the schema.

## Ports (all bound to `127.0.0.1`, or `ATLAS_BIND` for `api`/`mcp`/`ui` — see *Multi-machine* above)

| Var | Default | Service |
|---|---|---|
| `API_PORT` | 8710 | REST |
| `MCP_PORT` | 8711 | MCP (`/mcp`) |
| `UI_PORT` | 8712 | web UI |
| `QDRANT_PORT` / `QDRANT_GRPC_PORT` | 6363 / 6364 | qdrant |
| `REDIS_PORT` | 6390 | redis |
| `POSTGRES_PORT` | 5460 | postgres |

Ports were chosen to avoid this machine's existing stacks (G2P on 8181,
kbdv3's qdrant on 6353/6354, DeepCast services).
