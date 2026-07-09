2026-07-09 01:20 UTC

# Operations

## Revision History
- 2026-07-09 02:10 UTC — Backfill resume cursor; degraded-search banner behaviour.
- 2026-07-09 01:50 UTC — Model-switch/backfill behaviour, Ollama ≥ 0.13 requirement, misleading-metric warnings, recentErrors.
- 2026-07-09 01:20 UTC — Initial version.

## Day-to-day

```bash
make up / make down / make ps / make logs
make reindex          # incremental, now
make reindex-full     # rebuild everything (dedup keys make it safe)
make smoke            # 6 endpoint checks against the running stack
```

Freshness: the indexer scans every `SCAN_INTERVAL_MIN` (default 5) minutes;
"Reindex now" in the UI / `kdbs reindex` / `kdb_reindex` (MCP) trigger instantly.

## First index

The boot tick enqueues one job per (project, source), and one job per Claude
transcript directory. kdb/git/docs sources are small and finish first;
transcripts (~10k files, indexed newest-first) take longest. Everything already
indexed is searchable while the rest fills in. Progress: `kdbs status`, the UI
footer, or `/api/stats` (`pending`, `backfill`).

## Switching the embedding model

The Qdrant collection name encodes `provider_model_dimension`, so changing
`EMBEDDINGS_MODEL` or `EMBEDDINGS_PROVIDER` starts a **new, empty collection**.

On the next boot the indexer notices the collection holds fewer vectors than
the catalog has entries and rebuilds them **from Postgres** — it does not
re-parse the sources. It runs the rebuild to completion before starting scan
jobs (both embed, and a local Ollama serves one request at a time), and only
publishes `active_collection` when the new collection can serve. Search keeps
running against the previous collection throughout.

A rebuild of ~74k entries takes roughly 30–40 minutes on Ollama/Apple Silicon
(~40 entries/s). `kdbs status` and the UI show progress and an ETA.

The rebuild **resumes**: a cursor is persisted after every page, keyed by
collection name, so restarting the indexer mid-rebuild continues where it left
off instead of re-embedding from the first entry. A *different* model still
rebuilds from scratch — its vectors have a different dimension.

## Troubleshooting

- **`degraded: true` / mode `fts`** — Qdrant is unreachable, so search falls back
  to Postgres text search (weaker ranking and recall). The UI and `kdbs search`
  now say so in a banner. Check `docker logs kdb-qdrant-1`.
- **mode `sparse-only`** — embedding provider unreachable (e.g. Ollama stopped).
  Keyword matching still works, but semantically similar wording is missed;
  hybrid resumes automatically when the provider is back.
- **Search silently returns nothing useful after a model change** — the API
  follows `settings.active_collection` within 15s. If it lags, check that the
  indexer finished its rebuild (`kdbs status` shows `re-embed`).
- **Ask returns sources but no answer** — LLM endpoint unreachable (G2P not
  running?). The response says so explicitly; sources are still returned.
- **Index errors** — `GET /api/admin/errors`, or `kdbs status`, which reports
  errors *in the last hour* (a lifetime counter never resets and gets ignored).
  Errors are per-file; one corrupt transcript never fails a scan, and a failed
  backfill page is logged and skipped rather than abandoning the rebuild.
- **Indexing stalls, no log output, ~0% CPU everywhere** — the embedding
  provider accepted a request and never answered. Ollama **0.12.x segfaults
  inside `/api/embed`** under sustained load (a Go panic in
  `llamarunner.(*Server).embeddings`, then silence). Check
  `brew services list`, `ollama --version`, and the serve log for a stack
  trace. Upgrade to ≥ 0.13. Embed calls now time out after 30s and retry.
- **Ollama/G2P from containers** — reached via `host.docker.internal`
  (extra_hosts is set for OrbStack/Docker Desktop compatibility). Verify with
  `docker exec kdb-api-1 node -e "fetch('http://host.docker.internal:11434/api/tags').then(r=>console.log(r.status))"`.
- **Postgres 18 volume** — mounted at `/var/lib/postgresql` (image convention;
  data lives in a subdirectory).

### Metrics that lie

- **Qdrant `points_count` lags** `wait: false` writes until the optimizer
  indexes them, so a frozen count does **not** mean a stalled indexer. Trust
  the `re-embed N/M` log line (it prints an ETA), or scroll the collection.
- **`/api/stats` `chunks`** comes from that same approximate count.
- **`errors`** is a lifetime total. Use `recentErrors` to answer "is it
  failing right now?".

## Data reset

```bash
docker compose down -v   # wipes qdrant/postgres/redis volumes (the source files
make up                  # are untouched — everything reindexes from scratch)
```
