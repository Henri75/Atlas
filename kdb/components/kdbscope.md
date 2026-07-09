<!-- GENERATED VIEW — do not edit. Rebuilt from kdbscope.log by bin/kdb_rebuild.mjs -->

---
### [2026-07-08] - KDBScope v0.1.0 — cross-project knowledge indexer built end-to-end

**Objective:**
- Build a Web+CLI+MCP tool that indexes all projects' kdb/ logs, Claude Code session transcripts, git history and docs, with hybrid vector search and an Ask (LLM) mode.

**Summary of Work:**
- TS monorepo (npm workspaces): packages/core (parsers, chunker, sparse encoder, catalog, qdrant wrapper, embeddings, search/ask), indexer (BullMQ+cron), api (Hono), mcp (streamable HTTP, 9 tools), cli (kdbs), ui (React 19 + Tailwind 4).
- 7-service docker compose (indexer/api/mcp/ui/qdrant/redis/postgres), ro bind mounts of ~/.claude and __CODING NEW, all ports 127.0.0.1, images pinned tag@digest.
- Hybrid search: dense (pluggable provider: auto/ollama/bundled/openai-compat/g2p) + hash-based sparse with qdrant IDF, RRF fusion; degradation chain hybrid → sparse-only → postgres FTS.
- Claude jsonl distiller with byte-offset tail reads (11GB corpus paid once).

**Key Decisions & Rationale:**
- Microservices + Postgres 18 catalog (user choice; SQLite rejected: multi-container writers, WAL over docker mounts unsafe, org baseline). ADR: docs/adr/20260709-microservices-architecture.md.
- Chunks live only in Qdrant (rebuildable by rescan) — no relational mirror.
- Indexer publishes active_collection in settings table so api/mcp query the same embedding space.
- Claude dir → project mapping by ENCODING project paths (lossy dash encoding cannot be decoded).

**Code/Files Modified:**
- packages/* (new), docker/*, docker-compose.yml, Makefile, scripts/smoke.sh, docs/*, test/* (63 tests)

**Outcomes & Lessons Learned:**
- **What Worked:** stack live on first deploy after 3 real fixes; 63 unit tests green; smoke 6/6; boot tick discovered 90 projects, 138 scan jobs; hybrid search answering in ~60ms.
- **What Failed:** (1) postgres:18 image wants volume at /var/lib/postgresql not .../data — container crash-looped; (2) concurrent boot migrations raced on pg_type — fixed with pg_advisory_lock(732015); (3) macOS statSync mtimeMs is fractional, BIGINT column rejected it — Math.trunc at every read/write/compare site; (4) TS7 removed baseUrl from tsconfig paths; (5) bullmq pins its own ioredis (5.10.1) — aligning avoids type clashes.

**Status:**
- Completed
---
### [2026-07-08] - Bugfix: search hydration dropped all hits (pg int8-as-string)

**Objective:**
- Fix /api/search returning 0 hits while Qdrant contained matching points.

**Summary of Work:**
- Root cause (verified by querying Qdrant directly, then the API): node-postgres returns BIGSERIAL ids as strings; SearchService.hydrate keyed its Map by string '7256' while Qdrant payload lookups used number 7256 — every hit dropped. FTS fallback worked, masking it as "hybrid but empty".
- Fix: pg.types.setTypeParser(20, parseInt) in Catalog constructor (ids fit in a double).

**Code/Files Modified:**
- packages/core/src/catalog.ts

**Outcomes & Lessons Learned:**
- **What Worked:** live verify post-rebuild: "pgbouncer crash loop" returns the real DeepCast changelog/component entries; Ask returns a cited answer via g2p; MCP tools/list green.
- **What Failed:** n/a (first-principles gate: hypothesis confirmed at each layer before the fix).

**Status:**
- Completed
---
### [2026-07-09] - v0.2: streaming Ask, Ollama-by-default, deep links — and the backlog that running it for real produced

**Objective:**
- Implement streaming Ask and Ollama-by-default, then work the whole backlog and keep improving.

**Summary of Work:**
- Streaming Ask: chatStream() + a reusable SSE parser; askStream() shares retrieval with ask() via a prepare() step (DRY). POST /api/ask/stream emits sources -> delta* -> done. UI paints sources first then streams tokens, AbortController cancels a superseded question; CLI streams to TTY and buffers for --json. nginx proxy_buffering off + x-accel-buffering:no. Verified live: sources 0.19s, first token 1.13-1.37s of a 2-5s answer, through nginx.
- Ollama-by-default: 'auto' now pulls the model and LOUDLY logs every fallback. Installed ollama was 0.12.6 and its daemon was dead because ~/.ollama symlinked to an unmounted /Volumes/CloudBox/_OLLAMA; created the dir, upgraded, moved to a launchd service.
- Entry drawer + deep links: hostPath + vscode:// (line-accurate for kdb logs) computed in the API, which is the only component that knows both sides of the bind mounts. Clicking any hit or Ask citation opens the full entry body.
- Progress + honest metrics: /api/stats gains queue depth, pending, live backfill progress/ETA, and recentErrors (last hour).
- backfillVectors(): rebuild vectors from Postgres after a model switch.

**Key Decisions & Rationale:**
- Interactive streams do NOT retry (1 attempt): a fast degraded answer beats 6s of silent backoff. Batch paths keep exponential retries. Retry policy belongs to the interaction mode, not just the error class.
- Backfill runs to completion BEFORE scan jobs start: both embed, and a local Ollama serves one request at a time (measured 70s/batch under contention vs 0.69s standalone). WORKER_CONCURRENCY default 4 -> 2.
- active_collection is published only after the rebuild finishes, so readers stay on the previous populated collection — the zero-downtime model switch the design promised but had not implemented.
- errors reported as 'last hour', not lifetime: a monotonic counter never resets and gets ignored.
- An unmappable container path is returned untouched: a deep link to the WRONG file is worse than none.

**Code/Files Modified:**
- packages/core/src/{llm,ask,search,qdrant,catalog,retry,paths,config}.ts, embeddings/*
- packages/indexer/src/{pipeline,scheduler,main}.ts
- packages/api/src/{app,main}.ts
- packages/ui/src/{api,App,types}.ts, components/{EntryDrawer,Sidebar}.tsx, views/SearchView.tsx
- packages/cli/src/{api,main}.ts, docker/nginx.conf, docker-compose.yml, docs/*

**Outcomes & Lessons Learned:**
- **What Worked:** first-principles gate held every time — each 'stall' was root-caused at the layer below before any fix. 63 -> 129 tests. Zero index errors in the 17 minutes after the Ollama fix (newest error 01:31Z, restart 01:32Z).
- **What Failed:** (1) The headline bug was NOT ours: Ollama 0.12.6 panics in llamarunner.(*Server).embeddings under load (796 x HTTP 500 + a Go stack trace), then hangs. Only found by reading the ollama serve log instead of trusting our metrics. (2) Qdrant points_count LIES — it lags wait:false writes, so a frozen counter looked like a stall while the re-embed log showed steady progress. Cross-checking the metric against the process is what separated the real crash from the artifact. (3) Our own 120s embed timeout turned a fast retryable failure into a silent 2-minute stall; a healthy 32-batch takes 0.69s. Timeouts must come from observed latency. (4) isTransient() classified by err.status but the provider stringified the status into the message — a whole 70k-entry re-embed died on an error we had explicitly decided to retry. (5) The backfill trigger required an EMPTY collection, so the partially-filled state a crash actually leaves behind was never repaired. (6) BullMQ 5.79 rejects ':' in custom job ids; the original code worked by luck and my per-dir ids crash-looped the indexer.

**Status:**
- Completed
