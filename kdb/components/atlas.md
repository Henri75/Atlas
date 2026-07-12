<!-- GENERATED VIEW — do not edit. Rebuilt from atlas.log by bin/kdb_rebuild.mjs -->

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
---
### [2026-07-09] - Post-v0.2 hardening + full re-embed onto Ollama

**Objective:**
- Finish the backlog and verify the whole system on real data after the Ollama upgrade.

**Summary of Work:**
- MCP kdb_entry: agents could only ever see 280-char snippets; now they can read the full record behind any entryId, with hostPath + editor link. Verified the loop live: kdb_search -> entryId 2018 -> kdb_entry -> changelog.log:479.
- Backfill resume cursor, persisted per collection in settings; a restart mid-rebuild no longer re-embeds from entry 1 (it had thrown away 40k entries).
- Boot warning when Ollama < 0.13 (non-fatal, names the symptom and the fix).
- Degraded-search banner in UI + CLI naming the cause and the cost.
- Full re-embed onto ollama/nomic-embed-text (768-dim) completed: 74202 entries -> 102202 chunks in 2332s.

**Key Decisions & Rationale:**
- onPage reports both `done` (absolute, for the bar) and `embedded` (this run, for throughput) — computing a rate from a resumed prefix gives a nonsense ETA.
- The version guard warns and proceeds: a fork, a custom build or an unparseable version must not stop the indexer booting.
- Degradation is reported at the weight of a warning. It was an 11px grey footnote, which is exactly why the stale-collection bug ran for an hour with every query silently on the Postgres fallback.

**Code/Files Modified:**
- packages/mcp/src/tools.ts, packages/indexer/src/{pipeline,main}.ts
- packages/core/src/{catalog,embeddings/ollama,embeddings/index}.ts
- packages/ui/src/components/ui.tsx, views/SearchView.tsx, packages/cli/src/main.ts

**Outcomes & Lessons Learned:**
- **What Worked:** verified on the real corpus end-to-end — hybrid search 314ms, streaming Ask 0.79s to first token through nginx, and Ask correctly surfaced TWO distinct pgbouncer root causes across a Claude session, a README and a kdb component log. A healthy-collection restart correctly did NOT re-trigger a rebuild (needsBackfill(102202, 74202) = false). 63 -> 143 tests.
- **What Failed:** nothing new. Re-confirmed the earlier lesson: a flat Qdrant points_count and a quiet progress log both look like a stall — cross-check throughput (chunks/s) and the provider's CPU before diagnosing.

**Status:**
- Completed
---
### [2026-07-09] - Two silent correctness bugs found by testing the untested modules

**Objective:**
- Fill genuine test-coverage gaps, then write a getting-started guide.

**Summary of Work:**
- Added tests for the four untested core modules (ids, catalog.dedupKey, qdrant filter, chatComplete) and for scan-job options. 143 -> 171 tests.
- Fixed a dedup_key collision: deterministicUuid joined parts with a SPACE, so ('line:1','fix bug') and ('line:1 fix','bug') hashed identically. Proved it, switched to \x1f, bumped the namespace to v2. The indexer detects the scheme change at boot and rebuilds the derived index.
- That migration exposed a worse bug: scan jobs use deterministic ids and BullMQ retained completed jobs, so add() for an already-run id is a SILENT NO-OP. Every source that had been scanned once was never scanned again. 272 retained jobs sat under the 1000 cap, so nothing had ever been evicted.
- Rewrote chatComplete on withRetry (it hand-rolled a loop matching error TEXT).
- Wrote docs/getting-started.md and verified every command, flag, make target and the MCP tool count against the real binaries.

**Key Decisions & Rationale:**
- Truncating entries/scan_state/sessions is safe because they are derived from read-only mounts — the index is a cache, never the source of truth. Confirmed rw=false on both mounts before running it.
- removeOnComplete: true rather than dropping deterministic ids: the id still dedups PENDING work, it just must not stay reserved after the job finishes.
- The id-scheme migration obliterates the scan queue too: wiping the catalog makes the queue's memory of "already scanned this" a lie.

**Code/Files Modified:**
- packages/core/src/{ids,catalog,qdrant,llm}.ts, packages/indexer/src/{main,scheduler}.ts
- test/core/{ids,dedupKey,qdrantFilter,llmComplete}.test.ts, test/indexer/scheduler.test.ts
- docs/getting-started.md (new), docs/{index,operations}.md, README.md

**Outcomes & Lessons Learned:**
- **What Worked:** verified the destructive migration live — 'id scheme v1 -> v2', catalog cleared, no duplicate dedup_keys, rebuild running, 0 retained jobs (was 272), 0 errors. Search stayed healthy throughout.
- **What Failed:** the migration itself was initially a no-op: it wiped the catalog and then enqueued 136 jobs that BullMQ silently swallowed, because their ids matched retained completed jobs. Caught it because entries stayed at 0 with pending at 0.
- **Pattern:** three of this session's worst bugs (stale active_collection, empty-collection-only backfill trigger, retained job ids) are the same shape — two pieces of state that must agree, updated independently. Worth grepping for the shape, not the symptom.

**Status:**
- Completed
---
### [2026-07-09] - The UI was broken in three ways at once

**Objective:**
- Fix the 502s, the silent Ask, and the unusable project selection the owner reported; add support for several project folders.

**Summary of Work:**
- nginx: resolve the api upstream at request time (docker DNS 127.0.0.11 + variable proxy_pass + $request_uri) instead of once at config load.
- UI: error and result state made mutually exclusive; a real alert block; nginx HTML bodies translated into "the API is not reachable"; `return` inside the stream loop replaced with `break` so `finally` clears the streaming flag; PickProject empty state; offline banner distinguishing "no projects" from "no connection"; /api/projects reports host paths.
- Discovery: projects now carry hostPath alongside rootPath, and Claude transcript dirs match on the host path. Added PROJECT_GROUPING so the derived index rebuilds automatically.
- Multi-root: CODE_ROOT_HOST_2..5, paired {container, host} at parse time; discoverProjects takes a list; claudeDirFallbackSlug strips whichever root matches.

**Key Decisions & Rationale:**
- Config pairs container and host paths at parse time rather than keeping two arrays, because "two lists whose indices must correspond" is the exact bug shape that produced the last three outages.
- Compose cannot express an optional mount, so unused root slots re-mount root 1; the indexer only scans a slot when its _HOST var is set.
- PROJECT_GROUPING is a separate marker from ID_SCHEME: the ids did not change, the grouping did. Reusing ID_SCHEME would have been a lie.

**Code/Files Modified:**
- docker/nginx.conf, docker-compose.yml, .env.example
- packages/core/src/{config,discovery,paths,catalog}.ts
- packages/indexer/src/{scanners,scheduler,main}.ts, packages/api/src/app.ts
- packages/ui/src/{App.tsx,components/ui.tsx,views/*.tsx}
- docs/{getting-started,configuration,architecture}.md

**Outcomes & Lessons Learned:**
- **What Worked:** verified each fix against the failure, not the code: force-recreated api and hit :8712 without restarting nginx (200); search and ask/stream both work through nginx again (sources 0.44s, first token 1.24s); after the grouping migration `deepcast` holds both its files and its sessions, and the host-path-slug duplicates are gone. 171 -> 190 tests.
- **What Failed:** I "verified" the new UI by piping a 211KB minified bundle through a shell variable into grep — every string came back MISSING. Grepping the file inside the container showed all of them present. The deploy was fine; the test was wrong. Check an artifact where it lives.
- **Pattern, fourth time today:** two pieces of state that must agree, updated independently — nginx's cached IP vs Docker's DNS; the UI's `error` vs `askResult`; a project's container path vs its host path.

**Status:**
- Completed
---
### [2026-07-09] - Sessions were half-captured; Ask was a dead end

**Objective:**
- Fix the session view issues reported from screenshots, add search/filter across the views, extract structured information from transcripts, and make Ask conversational.

**Summary of Work:**
- Session titles/prompt counts: the 800-entry cap `break`ed the read loop, so Claude's `summary` event (written at either END of a transcript) was never reached. Only 24 of 1041 sessions had a title. The cap now bounds what we KEEP, not what we READ; metadata is gathered across the whole stream. Sessions with no summary fall back to their first prompt.
- Distiller: removed the 280-char assistant filter (measured: dropped ~53% of replies to save ~7% of prose volume) and added one `action` entry per turn recording what was actually done (tool + target, never the diff or command body).
- Message kinds: prompt / plan / insight / summary / action / response, classified at parse time from structures the text actually uses (`★ Insight`, `## Summary`, "Implement the following plan:"). Exposed as a `kind` filter on the Qdrant payload, the Postgres FTS fallback, /api/search, `kdbs search --kind`, and the kdb_search MCP tool.
- Ask conversation: follow-ups carry prior turns; retry re-asks with history stopping BEFORE the question being re-answered; any turn is deletable; history is whitelisted server-side. Switching project now clears results and shows the active scope.
- Filters in sessions (list + in-session with kind chips), timeline (plus a persistent FEED/TABLE layout toggle), and components.

**Key Decisions & Rationale:**
- Length is a bad proxy for value; kind is a good one. "No security findings." is exactly what you go looking for months later.
- Classification without a filter is decoration. `kind` had to reach BOTH the vector payload and the FTS fallback, or the feature would silently disappear in degraded mode.
- A retry must not send the model the answer it is replacing, or it simply agrees with it. History is sliced to stop before that question — tested directly.
- Changing the project clears results rather than silently re-running: the citations pointed at entries that no longer exist in the new scope, so keeping them on screen is actively misleading.
- A third migration marker (EXTRACTION_SCHEME) rather than abusing ID_SCHEME or PROJECT_GROUPING: the ids did not change and the grouping did not change. The three markers are now a table, not a ternary chain.

**Code/Files Modified:**
- packages/core/src/{parsers/claudeJsonl,types,qdrant,catalog,ask}.ts
- packages/indexer/src/{pipeline,main}.ts, packages/api/src/app.ts
- packages/mcp/src/tools.ts, packages/cli/src/main.ts
- packages/ui/src/{types,usePersistentState}.ts, components/ui.tsx,
  views/{SearchView,AskConversation,SessionsView,TimelineView,ComponentsView}.tsx
- docs/{architecture,api,cli,mcp,getting-started}.md, README.md

**Outcomes & Lessons Learned:**
- **What Worked:** verified on live data after the rebuild — 62/62 sessions titled (was 24/1041), 125 insights / 10 summaries / 6 plans / 1680 actions classified in DeepCast, `?kind=insight` returns only insight blocks in hybrid mode, and a live follow-up ("and how was it fixed?") correctly resolved "it" from the prior turn. 196 -> 223 tests.
- **What Failed:** the "1 prompt" in the screenshot was NOT a bug — that session really is a one-shot /security-review. Checking the raw JSONL before "fixing" it avoided inventing a defect. Separately, backticks in a `git commit -m "..."` string were shell-interpreted and silently mangled the message; amended with a heredoc.
- **Pattern:** two definitions of the same thing again — `SessionEntryKind` in the parser and `EntryKind` in types. Collapsed to one.

**Status:**
- Completed
---
### [2026-07-10] - Overview dashboard and human-readable numbers

**Objective:**
- Format every count/size/time in a human-readable way, and give the UI a landing dashboard: projects, indexed documents, vectors, space used, services running.

**Summary of Work:**
- Shared formatters: compact() for scannable counts (82k) always paired with exact() in a title attribute; bytes() in binary units; duration(); relativeTime(); plural() that never renders "1 prompts". Applied to the sidebar project counts, footer, backfill bar, sessions, components. The CLI got its own num()/bytes()/duration(): a terminal line has room, so thousands separators beat compact forms there.
- New GET /api/dashboard, deliberately separate from /api/stats (which the footer polls every 30s): it walks Qdrant's storage tree and probes every dependency. Storage figures cached 30s; measured cold 828ms / warm 64ms, and /api/stats stayed at 40ms.
- DashboardView is now the landing page (hotkey 1; the other views shifted to 2-5). Headline counts, per-service health, per-store storage, source breakdown bars, and a callout for stale vector collections.
- kdbs status now reports service health and storage too.

**Key Decisions & Rationale:**
- Postgres reports its size via pg_database_size(), Redis via INFO memory. Qdrant has NO API for disk usage: its telemetry exposes `disk_usage_bytes` and returns 0, which is worse than absent because it looks authoritative. Its volume is mounted read-only into the API at /qdrant-storage — far safer than handing a stats endpoint the Docker socket.
- Labels distinguish disk from memory. Redis holds the job queue, so its *memory* is the honest number; its disk is transient. Lumping them under "space used" would mislead.
- A null size renders as "—", never as 0: "cannot tell" is the truth, "uses no disk" is a lie.
- The dashboard reads active_collection from settings, not from vectors.collection, which only catches up when someone searches — after a model switch it would name the old collection and invert the very warning we want to show.
- health = "reachable from the API", which is exactly what determines whether search works.

**Code/Files Modified:**
- packages/core/src/{storage,catalog,qdrant,config,index}.ts (new storage.ts)
- packages/api/src/{app,main}.ts, docker-compose.yml, scripts/smoke.sh
- packages/ui/src/{format.ts,App.tsx,api.ts,types.ts}, components/Sidebar.tsx,
  views/{DashboardView,SessionsView,ComponentsView}.tsx
- packages/cli/src/{format,main}.ts, docs/{api,getting-started,cli,configuration}.md, README.md

**Outcomes & Lessons Learned:**
- **What Worked:** verified live — 2.64 GB Qdrant / 265 MB Postgres / 4.5 MB Redis, all four services running, and the dashboard correctly flagged 1,049 MB of stale vectors from the old bundled-CPU embedder. 222 -> 260 tests. The documented reclaim command was verified against a throwaway collection rather than the user's data.
- **What Failed:** I nearly shipped a dashboard reporting 0 bytes for Qdrant, because its telemetry field `disk_usage_bytes` exists and returns 0. Cross-checking against `du` on the real filesystem caught it — the same lesson as points_count lagging wait:false writes. A metric that is present but wrong is worse than one that is missing.
- **Also:** the directory walk is 187ms over 1,101 files, so it scales with file count rather than gigabytes. Worth knowing before assuming a landing page would slow as the index grows.

**Status:**
- Completed
---
### [2026-07-10] - Docs staleness handling + full docs coverage + dashboard activity stats

**Objective:**
- Index every project's docs/ completely and stop outdated docs from polluting search results and Ask research, without ever losing information; then make the overview dashboard report real inventory and indexing activity.

**Summary of Work:**
- Coverage: listDocFiles cap 400→2000, depth 4→6, returns {files, dropped}; scanDocs warns per project when the cap drops files (DeepCast was silently losing 80+ of its 481 docs).
- Staleness: archived = path conventions (archive/, _archive/, _legacy/, Previous/, old/, deprecated/, obsolete/, superseded/, outdated/, backup(s)/, bak + filename stems), computed at scan time, stored in entry meta jsonb + qdrant doc_status payload (new keyword index). aging = derived at query time from occurredAt vs KDB_DOCS_AGING_MONTHS (12) — never stored.
- Ranking: SearchService.finalize() shared by hybrid path AND fts fallback: archived score × KDB_ARCHIVED_PENALTY (0.6) + badge, aging label only, 2× over-fetch, re-sort. docStatus filter (active|archived) through Qdrant must/must_not, catalog FTS, REST (docStatus), UI select, kdbs --doc-status, MCP doc_status.
- Ask: context blocks labeled [ARCHIVED — n mo old]/[AGING — …]; system prompt says prefer fresh, disclose reliance, trust newer on conflict.
- Backfill: DOCS_PARSER_VERSION per-project setting; on mismatch scanDocs syncs unchanged files via catalog.syncDocStatus (jsonb update RETURNING id) + vectors.setDocStatus (setPayload/deletePayload by entry_id index) — no re-parse, no re-embed. entriesAfter now selects meta so collection rebuilds keep payloads.
- Dashboard: catalog sourceDetail/indexingActivity/recentRuns/archivedDocsCount; /api/dashboard exposes them best-effort; UI gets 30-day stacked activity bars (source color families, hover breakdown, idle hairlines), files/volume/last-indexed per source, recent runs; kdbs status gets activity today/7d + per-source columns.

**Key Decisions & Rationale:**
- Judge at query time, never at index time: deleting/skipping is the only irreversible act; penalty/threshold/patterns are config, tunable with zero reindex. ADR docs/adr/20260710-docs-staleness-query-time.md.
- aging is derived, not stored: scan state skips unchanged files forever, so a stored flag would freeze on index day (caught in spec self-review).
- One finalize() for both search paths: degraded FTS mode must rank by the same rules or Qdrant outages silently change result semantics.

**Code/Files Modified:**
- packages/core/src/docStatus.ts (new), parsers/docsMd.ts, types.ts, qdrant.ts, catalog.ts, search.ts, ask.ts, config.ts, index.ts
- packages/indexer/src/scanners.ts, pipeline.ts
- packages/api/src/app.ts, main.ts
- packages/ui/src/types.ts, views/SearchView.tsx, views/DashboardView.tsx
- packages/cli/src/main.ts; packages/mcp/src/tools.ts
- test/: docStatus, scanDocs (new), docsMd, scanners, indexEntries, qdrantFilter, search, ask, config, routes, mcp tools
- docs/: architecture.md, api.md, configuration.md, adr/20260710-docs-staleness-query-time.md, superpowers spec+plan

**Outcomes & Lessons Learned:**
- **What Worked:** setPayload by an integer entry_id payload index reclassifies thousands of chunks in place — the whole backfill problem disappears without touching the embedder. 310 tests green.
- **What Failed:** first design stored aging at scan time (would drift — unchanged files never rescan) and put the penalty only on the vector path (fts fallback would bypass it); both caught in self-review before code.

**Status:**
- Completed

---
### [2026-07-11] - Ask soft-scope fallback (project scope no longer hides sibling-project answers)

**Objective:**
- Stop a project-scoped kdb_ask from returning a confident "not found" when the answer lives in another project.

**Summary of Work:**
- Root cause: `filters.project` is a hard filter in search. A question about G2P's NEXUS "drain" feature scoped to `deepcast` matched nothing, because the feature is indexed under slug `google-gemini-pool`. Retrieval could not fall back, so the LLM correctly reported the feature absent. NOT an indexing lag (content was searchable within one 5-min scan cycle).
- Fix in AskService: new `retrieve()` helper keeps the hard scope by default, but on an *empty* scoped result re-runs the search across all projects; if that surfaces hits it returns them plus a `scopeFallback` marker. A `scopeNote` is appended to the prompt so the answer opens by naming the empty scope and where the answer actually came from.
- Surfaced `scopeFallback` through AskResult, the `sources` AskEvent (SSE), the MCP kdb_ask passthrough (+ description now steers callers away from over-scoping), and a UI banner in AskConversation.
- Left `search()` untouched: direct search/MCP-search callers still get a hard filter.

**Key Decisions & Rationale:**
- Fallback lives in Ask, not search: search is a low-level primitive many callers want strictly scoped; "found it elsewhere" is an Ask-layer concern.
- Only flag fallback when widening actually finds something — an all-projects miss is a real dead end, not a scope problem.

**Code/Files Modified:**
- packages/core/src/ask.ts
- packages/core/src/types.ts
- packages/mcp/src/tools.ts
- packages/ui/src/api.ts
- packages/ui/src/types.ts
- packages/ui/src/views/AskConversation.tsx
- test/core/askStream.test.ts

**Outcomes & Lessons Learned:**
- **What Worked:** Live repro against rebuilt api — scoped-to-deepcast ask now returns scopeFallback + 8 sources + an answer that explains the wrong scope. Full suite 313/313.
- **What Failed:** N/A — root cause confirmed by reproduction before any code change (unscoped ask always worked; only the scoped one failed).
- **Lesson:** "KDB can't find X" is far more often a query-scoping problem than an indexing problem. Verify with an unscoped search before suspecting the pipeline.

**Status:**
- Completed

---
### [2026-07-11] - Ask answer quality (context reranking) + multi-source filter + UI polish

**Objective:**
- Fix thin Ask answers that described a feature's plumbing but never said what it does; render answers as HTML; let users pick a subset of source types; add copy buttons; make "new conversation" visible.

**Summary of Work:**
- Root cause of the weak answer (confirmed by inspecting retrieved blocks live): self-pollution. A tool that indexes its own operators' conversations ranks the debugging transcripts about "the drain feature" ABOVE the doc that explains draining, because transcripts echo the query verbatim while the doc uses different words. 5 of 8 context blocks were our own meta-session.
- Fix: `rerankForContext(pool, k)` in AskService — over-fetch (k*3, capped 24..60), apply per-source-type weights (doc 1.35, kdb_component 1.3, … claude_session 0.8), and hard-cap claude_session at 50% of the window (held-over sessions backfill if nothing better exists). System prompt also now tells the model to lead with a direct definition and prefer descriptive sources. Live result: doc blocks now fill slots 5-8 and the answer opens "used to stop routing new traffic to a specific egress node…".
- Multi-value source filter: `SearchFilters.sourceTypes?: SourceType[]` applied in qdrant (`match.any`) and FTS (`= ANY`); API `parseSources()` accepts comma string or JSON array; singular `sourceType` kept for back-compat.
- UI: `Markdown.tsx` (marked@18 + DOMPurify@3.4 → sanitized HTML, then `[n]`→superscript on the sanitized string) with scoped `.kdb-md` CSS; `MultiSelect` checkbox popover replacing the all-or-one source dropdown; `CopyButton` for each reply and each cited source (rows de-nested from <button>); visible "＋ New conversation" pill replacing the faint underline link.

**Key Decisions & Rationale:**
- Rerank in Ask, not search: search callers want raw ranked hits; context curation is an Ask concern.
- Weight + hard cap together: weighting alone lets near-duplicate sessions still crowd the window on raw score.
- marked+DOMPurify (not raw HTML from the LLM): the answer is model output over untrusted indexed content, so parse→sanitize→inject is mandatory (XSS).

**Code/Files Modified:**
- packages/core/src/ask.ts, types.ts, qdrant.ts, catalog.ts
- packages/api/src/app.ts
- packages/ui/src/components/{Markdown.tsx,ui.tsx}, views/{SearchView.tsx,AskConversation.tsx}, api.ts, types.ts, styles.css
- packages/ui/package.json (marked, dompurify)
- test/core/{rerankForContext.test.ts,qdrantFilter.test.ts}

**Outcomes & Lessons Learned:**
- **What Worked:** rerank verified live — authoritative docs now dominate context and the answer defines the feature first. Suite 320/320.
- **What Failed:** N/A — the weak-answer cause was pinned by reading the actual retrieved source list, not guessed.
- **Lesson:** For a self-indexing knowledge tool, retrieval must defend against its own exhaust: debugging chatter about X out-matches docs that explain X. Source-type diversity is not optional.

**Status:**
- Completed

---
### [2026-07-12] - Rename the product to Atlas (kdbscope -> atlas)

**Objective:**
- Stop the tool sharing a name with the data it indexes: "kdb" meant both this app and the append-only KDB logs it reads.

**Summary of Work:**
- Split one overloaded name into two. ATLAS = the tool (npm workspace, @atlas/* packages, `atlas` CLI, `atlas` MCP server + ten atlas_* tools, UI title, LLM system prompt, service ids atlas-api/atlas-mcp). KDB = one of the four indexed sources, and keeps its prefix everywhere: source type `kdb`, entry types kdb_changelog/kdb_session/kdb_component/kdb_backlog/kdb_report, kdbLog parser, this repo's kdb/ dir, bin/kdb_append, make kdb-rebuild.
- Left every datastore identifier alone on purpose: pg db/role `kdbscope`, Qdrant prefix `kdbscope_<provider>_<model>_<dim>`, BullMQ `kdbscope-scan`, the scheduler lock, the ids.ts UUID namespace, KDBSCOPE_API_URL. Renaming any of them re-keys stored data and forces a full re-index of ~282k entries for zero user-visible gain.
- Pinned `name: kdb` in docker-compose.yml. Compose derives the volume prefix from the directory name, so without the pin, renaming the checkout would make it look for atlas_pg_data, find nothing, and silently boot on an empty index. Pinned to `kdb` (not `atlas`) because that is what the existing volumes are already called.
- Added two regression guards in test/mcp/tools.test.ts: every tool must be atlas_*, and SOURCE_TYPES must keep its kdb_ prefixes. Exported SOURCE_TYPES so the second one can pin the real enum.
- Documented the split in architecture.md ("Naming: Atlas vs KDB"), configuration.md, README, and dated revision entries in mcp/cli/operations/configuration.

**Key Decisions & Rationale:**
- Rename the MCP tools kdb_* -> atlas_*, but NOT the kdb_* source types. Tools name the product; source types name the content. `atlas search pgbouncer -s kdb_changelog` reads correctly: ask Atlas to search KDB changelogs.
- Keep the datastore names. The user explicitly chose "no reindex", and the collection prefix + id namespace are the keys ~282k entries are stored under.
- Pin the Compose project name rather than renaming volumes: it makes the directory name irrelevant forever, at zero cost and zero risk.

**Code/Files Modified:**
- package.json, package-lock.json, packages/*/package.json (@kdbscope/* -> @atlas/*), tsconfig.lint.json, vitest.config.ts
- packages/mcp/src/{tools.ts,main.ts} (ten atlas_* tools, server id `atlas`, SOURCE_TYPES exported)
- packages/cli/{package.json,src/main.ts,src/api.ts} (bin kdbs -> atlas)
- packages/api/src/app.ts, packages/core/src/ask.ts, packages/ui/{index.html,src/styles.css}
- docker-compose.yml (name: kdb), .mcp.json, Makefile, .env.example, scripts/smoke.sh
- README.md, docs/{architecture,configuration,operations,mcp,cli,getting-started,index}.md
- test/mcp/tools.test.ts (+2 naming-boundary guards)

**Outcomes & Lessons Learned:**
- **What Worked:** Live-verified on the running stack: 282,333 entries / 312,355 chunks intact (no reindex), MCP advertises all ten atlas_* tools, `atlas search -s kdb_changelog` returns real hits, smoke 7/7, 336 tests + tsc green.
- **What Failed:** A blind `sed s/kdb_/atlas_/` would have corrupted SOURCE_TYPES: `kdb_session` is BOTH an MCP tool and an entry type, 85 lines apart in tools.ts. Renaming the entry type is a SILENT failure — the API rejects the value and search just returns nothing. Caught by enumerating tool names explicitly instead of prefix-matching. A first pass of the doc sed also falsified history (revision-history lines and kdb/*.log entries claiming Atlas existed in July 9); restored from git and re-appended.
- **What Failed (2):** The first version of the SOURCE_TYPES guard passed even with the bug injected — it asserted through request(), which just serialises whatever it is handed and never consults the enum. Rewrote it to pin the exported SOURCE_TYPES, then proved it by injecting the corruption and watching it fail.
- **Lesson:** When one token means two things, exact-token replacement is the only safe transform, and a rename guard must be falsified (break it, watch it fail) before it can be trusted. Also: on macOS, BSD sed has no \b — `s/\bkdbs\b/` silently matches nothing and looks exactly like success.

**Status:**
- Completed
