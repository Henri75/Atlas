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
---
### [2026-07-12] - UI batch: ask composer, project filter/favourites, animations, answer telemetry, retry + list-marker fixes, clickable footnotes, md/PDF export

**Objective:**
- Ten requested UI improvements, two of them bug fixes with confirmed root causes.

**Summary of Work:**
- **List markers (bug).** Tailwind's preflight sets `list-style: none`; styles.css restored the padding but never the marker, so answers rendered as unlabelled indented paragraphs. Restored disc/decimal/circle, dimmed `::marker`, and suppressed the bullet on GFM task items (they carry their own checkbox).
- **Retry (bug).** `run()` reset content/sources/streaming/error but NOT `degraded` — and the banner renders on `degraded && !error`, so clearing `error` on retry actively turned the stale "LLM unavailable" banner back ON. Now resets the whole per-attempt result (EMPTY_RESULT). Also replaced the static "reading sources…" text with an animated indicator.
- **Answer telemetry (correctness, not just display).** Probed the live G2P gateway during design and found the UI was reporting the WRONG model: it displayed `llmConfig.model` (what we requested) while the gateway served something else. Now reads `X-G2p-Reply-Model` / `X-G2p-Reply-Attempts` / `X-Request-Id` from the response, opts into `stream_options.include_usage` for real token counts, measures TTFT server-side, and derives tok/s over generation time (total − ttft) so a slow queue is not reported as a slow model. Model substitution is normal G2P routing, so it is stated as fact, not flagged.
- **Footnotes.** `[n]` citations became real controls that scroll to + flash their source row, with a hover card. Gated on the known source set, so a model-invented `[9]` stays inert rather than becoming a button to nowhere.
- **Export.** Markdown + PDF (jsPDF v4 standalone) + copy, generated from the answer's markdown and structured sources — not from the DOM.
- **Composer + sidebar.** Follow-up field under the reply sharing one text value with the top bar; project filter reusing the existing FilterInput/matches/Highlight; favourites pinned when idle, flattening to a ranked list while filtering.

**Key Decisions & Rationale:**
- **Additive `llm.ts` signatures over a tagged-union rewrite.** The first design changed `chatStream`/`createSseParser` to yield a union. Reading the tests killed it: six parser tests pin `string[]`. An optional usage sink + an `onMeta` callback deliver the same feature with a strictly smaller diff and zero test churn (§3.3 "Modify & Reuse").
- **jsPDF WITHOUT html2canvas.** The usual pairing rasterises the DOM: dead footnote links, unselectable text, and it cannot parse the `color-mix()` this theme is built on (badges would render as black boxes). It would also have exported the dark theme onto paper. Generating from the source data gives selectable text, live links and a light page. Measured 242 KB gzip, lazy-imported so only the person exporting pays. Rejected pdf-lib (dead since 2022) and pdfmake (355 KB for a layout engine we would not use).
- **Telemetry must never break the answer it describes.** Header reads are defensive and a failed call reports NO metrics rather than zeroes.

**Code/Files Modified:**
- packages/core/src/llm.ts
- packages/core/src/ask.ts
- packages/ui/src/components/Markdown.tsx
- packages/ui/src/components/Sidebar.tsx
- packages/ui/src/components/ExportReply.tsx
- packages/ui/src/components/ui.tsx
- packages/ui/src/views/AskConversation.tsx
- packages/ui/src/views/SearchView.tsx
- packages/ui/src/usePersistentState.ts
- packages/ui/src/styles.css
- packages/ui/src/types.ts
- packages/ui/src/api.ts
- packages/ui/vite.config.ts
- docs/architecture.md, docs/api.md
- docs/superpowers/specs/2026-07-12-atlas-ui-improvements-design.md

**Outcomes & Lessons Learned:**
- **What Worked:** Probing the real gateway *before* designing — it exposed the wrong-model bug that reframed a "display toggle" as a correctness fix, and proved token usage was available rather than needing estimation. Verifying in a real browser engine (the CSS fix is untestable in jsdom, which applies no stylesheets).
- **What Failed:** (1) Deployed stale JS for ~15 min: `tsc --noEmit` typechecks but emits nothing, and the Docker build ships `packages/*/dist` as-is — the container ran old code while the source was correct. Logged to backlog. (2) Two React memo bugs the unit tests could not see: passing a fresh `new Set()` each render defeated Markdown's `useMemo`, and a fresh `{__html}` object literal made React re-set `innerHTML` even when the string was identical — together they rebuilt the answer's DOM continuously, so citations were destroyed faster than they could be clicked. Found via a MutationObserver in a real browser; now pinned by render-stability tests. (3) A Playwright click "failure" that was a harness artifact (its synthetic pointer fights the hover card it triggers); the DOM and keyboard paths both work, and the peek card now dismisses on jump.
- Verified live: served model `google/gemini-2.5-flash`, 8453/893 tokens, TTFT 1568ms, 346.8 tok/s, 2 gateway attempts.

**Status:**
- Completed
---
### [2026-07-13] - UI information architecture: scope bar, multi-project selection, Search/Ask mode switch

**Objective:**
- Fix five UI complaints that all trace to one root cause.

**Summary of Work:**
- **Root cause.** The UI mixed *modes* (how you look: search/ask/timeline) with *objects* (what you look at: which projects), stacking both in one column with identical treatment. That is why the selection was invisible, the scope line was easy to lose, and the rail read as arbitrary — three of the five complaints were the same bug seen from different seats.
- **Layout.** The rail now holds views only. Scope became a persistent bar directly above the content it governs, because placement encodes authority: a filter above its results says "I govern everything below me"; one in a side rail reads as a peer of the navigation. With ~50 projects, a highlighted row scrolled out of the rail is invisible — a chip in the bar is always on screen.
- **Multi-project.** Search, Ask and Timeline take any number of projects. Components and Sessions stay single-project browsers and *say so* under a 0- or 2+-project scope, because a component named `ui` in two projects is two different things and merging them would be a lie.
- **Search vs Ask.** Twin submit buttons became a segmented mode switch on the input, which restyles (amber) when Ask is armed. Enter submits in both; the ⌘Enter secret handshake is gone.
- Timeline gained a collection route; every row carries its project when the scope spans more than one.

**Key Decisions & Rationale:**
- **Multi-project reused the `sourceTypes` idiom rather than inventing one.** Both search paths already solved this exact problem for source filtering (qdrant `match:{any}`, FTS `= ANY($n)`), so the change is that idiom applied to a second field, with `selectedProjects()` resolving precedence once for both paths — they degrade into one another, and a filter that meant different things depending on which backend answered would be vicious to debug. No payload key, column or collection changed: **no reindex**.
- **Timeline kept its per-project route and gained a collection route beside it.** `/api/projects/:slug/timeline` is a *resource*; `a,b` in a slug that means "one project" would be the same category error this rework exists to fix — and the CLI and MCP server both call that path.
- **Ask's soft fallback was generalised, not merely handed a list.** With several projects selected, *any* hit means the scope worked; widening fires only when NONE of them match. Falling back on a partial match would have triggered on nearly every multi-project ask.
- **One `useScope()` hook exposing two shapes** (`projects: string[]` and `project: string | null`, non-null only at exactly one) kept this from becoming a 39-call-site refactor: the per-project views keep their existing contract untouched.

**Code/Files Modified:**
- packages/core/src/types.ts (projects[], selectedProjects, ScopeFallback.requested → string[], TimelineItem.projectSlug)
- packages/core/src/qdrant.ts, packages/core/src/catalog.ts, packages/core/src/ask.ts
- packages/api/src/app.ts (parseProjects; GET /api/timeline)
- packages/ui/src/useScope.ts (new), components/ScopeBar.tsx (new)
- packages/ui/src/App.tsx, components/Sidebar.tsx, components/ui.tsx (ModeSwitch, ProjectTag)
- packages/ui/src/views/SearchView.tsx, TimelineView.tsx, AskConversation.tsx
- packages/ui/src/styles.css, api.ts, types.ts
- docs/architecture.md, docs/api.md

**Outcomes & Lessons Learned:**
- **What Worked:** Reading the code before designing. `sourceTypes` had already solved multi-value filtering on both paths, which turned "add multi-project" from a risky change into a symmetric one-line generalisation per path. Auditing the tests while speccing showed the back-compat net was imaginary (the MCP suite only asserts the tool is *listed*; the CLI has no test), so the timeline signature was widened rather than changed and the missing coverage was written as part of the work.
- **What Failed:** (1) The UI redeclared `ScopeFallback` inline instead of importing it, so it kept typechecking against a stale contract after core changed — now imported, so a future drift fails loudly. (2) The `:focus-visible` ring was amber, the same colour that now means "Ask mode is armed", so a focused Search box looked like Ask; focus moved to blue. Once a hue carries a meaning it cannot also be generic chrome. (3) A test mock that only knew `filters.project` reported a partial multi-project match as a full one and hid the very bug its test existed to catch.
- Live-verified: search across deepcast+ezdeploy returns 30 hits from both, every row tagged, no out-of-scope leakage; the per-project timeline route still serves the CLI/MCP path. 372 → 417 tests.

**Status:**
- Completed
---
### [2026-07-13] - Markdown renders as HTML in every view, not just the Ask answer

**Objective:**
- Every surface that shows indexed content renders its markdown as formatted HTML (bold, lists, headings, code) instead of printing the raw syntax.

**Summary of Work:**
- Everything Atlas indexes is markdown at the source — kdb logs are written as `**Objective:**` / `- bullet` / `### heading` blocks, and commit bodies and docs are markdown by nature. Four surfaces were printing that source verbatim inside `<pre whitespace-pre-wrap>`: EntryDrawer (`entry.body`), ComponentsView (`e.body`), SessionsView detail (`e.body`), SearchView (`h.snippet`). A correct renderer already existed but was wired only into the Ask answer.
- Widened `Markdown.tsx` from an Ask-answer component into the single renderer for all indexed content, and wired it into all four surfaces.
- Two Ask-specific behaviours had to become optional first:
  - **Citations are now opt-in.** `citationize` rewrote every `[n]` into an amber superscript. That is correct for an answer with a source list, but in a git commit body or a transcript `[1]` is array syntax — turning it into a citation marker is corruption. The transform now runs only when the caller passes `citations`.
  - **Filter highlighting moved into the pipeline.** SessionsView composed `<Highlight>` (returns React nodes) inside the `<pre>`. Rendered markdown is injected as an HTML *string*, so the two cannot nest. Highlighting is now an optional `needle` prop applied as a post-sanitize string transform — the same discipline `citationize` already used.
- Added a `compact` variant for search snippets and dense rows: block elements collapse to body size with no vertical margin, so a result row stays two lines tall and `line-clamp-2` keeps measuring correctly. It also repairs markdown cut mid-syntax before parsing.
- `.kdb-md` font-size became `inherit` (was a hard 15px): the same markup is read at 15px in an answer and 12.5px in a component row, so the caller now owns the size. Restored 15px explicitly at the Ask call site.

**Key Decisions & Rationale:**
- **Reuse (modify), not a second renderer.** A parallel "plain markdown" component would have duplicated the parse → sanitize → inject pipeline, i.e. duplicated the security-critical part. One renderer, two optional enrichments.
- **Snippets render rather than being stripped to plain text (user's call).** The cost is that `body.slice(0, 280)` cuts mid-construct, and marked is tolerant but not *repairing* — a dangling `**` emits the literal asterisks we are trying to remove, and an open fence swallows the rest. `repairTruncated` closes unbalanced `` ` ``, `**`, `~~` and fences before parsing. Only applied under `compact`, since a full body is never cut.
- **Highlighting splits on tags and only transforms the text between them.** Without that, typing `li` or `strong` into the filter box would match the tag names in the HTML just generated and wrap them in `<mark>`, destroying the document. The needle is also escaped on the way in — it is raw user input spliced into sanitized HTML, the one place DOMPurify never sees.
- The needle is escaped to match the *haystack*, not the reverse: the sanitized HTML holds `&` as `&amp;`, so an unescaped `&` would never match.

**Code/Files Modified:**
- packages/ui/src/components/Markdown.tsx
- packages/ui/src/components/EntryDrawer.tsx
- packages/ui/src/views/ComponentsView.tsx
- packages/ui/src/views/SessionsView.tsx
- packages/ui/src/views/SearchView.tsx
- packages/ui/src/views/AskConversation.tsx
- packages/ui/src/styles.css
- test/ui/markdown.test.tsx

**Outcomes & Lessons Learned:**
- **What Worked:** 430/430 tests pass (26 in markdown.test.tsx, up from 14). Verified against live data: real `kdb_component` hits pulled from the running API render `### […]` → `<h3>`, `**Objective:**` → `<strong>`, and a list item truncated mid-sentence by the 280-char cut still renders as a proper `<li>`.
- **What Worked:** the rewrite incidentally fixed a real pre-existing type error — the old `citationize` ended in `as string & typeof whole`, referencing a parameter not in scope (`Markdown.tsx(46,25): Cannot find name 'whole'`). tsc errors went 3 → 2.
- **What Failed:** two existing tests pinned "always linkify `[n]`", which is only safe while the Ask answer is the sole caller. Widening the component invalidated the assumption, so those tests were rewritten rather than preserved — keeping them green would have meant shipping the bug.
- **Note:** the two remaining tsc errors (`TimelineItem` lacks `projectSlug`) are pre-existing on HEAD and out of scope; logged to backlog.

**Status:**
- Completed
---
### [2026-07-15] - Footprint reduction: Qdrant int8 quantization, orphan reclaim, PG insert batching

**Objective:**
- Cut Atlas memory/CPU footprint (esp. Qdrant's ~2GB boot peak) while keeping search 100% reliable.

**Summary of Work:**
- Qdrant: enabled scalar int8 quantization (quantile 0.99, always_ram) on the dense vectors — new collections get it in ensure(), and a one-shot guarded boot step (ensureQuantized + `quantized:<collection>` marker) retrofits it onto the live collection in place, no re-embed. Added max_segment_size=64000 to cap the boot re-optimization RAM spike.
- Qdrant: added reclaimOrphans() — drops collections carrying our COLLECTION_PREFIX that aren't the active/current one. Ran at boot, reclaimed kdbscope_bundled_xenova_all_minilm_l6_v2_384 (338MB, dead since the Ollama model switch).
- Postgres: rewrote insertEntries from one INSERT round-trip per entry to a single multi-row INSERT per ~5400-row chunk (dedup within the batch, RETURNING id+dedup_key to re-pair). Dominant historical indexer cost (292k sequential queries) collapsed to batched statements.
- Search: query() now fetches with_payload:['entry_id'] instead of the whole payload (hydrate reads only entry_id; the rest comes from Postgres).
- Docs: tightened the frozen-name comments in qdrant.ts (product is Atlas; kdbscope_ prefix is a permanent storage key, rename only during a re-embed).

**Key Decisions & Rationale:**
- No rename of kdbscope_ storage keys: my optimizations need no reindex, so renaming would mean deliberately triggering an hours-long re-embed for internal cosmetics. Frozen names stay frozen; user confirmed.
- Dropped the planned FTS length-cap change (200KB->8/32KB): measured pg_column_size showed the 128MB tsvector total comes from 292k normal rows, not outliers — the huge (>32KB) rows contribute <1MB. Lowering the cap would rewrite the whole table for <1MB. Not worth it; kept FTS fallback untouched.
- Quantization keeps fp32 originals on disk for rescoring (always_ram quantizes the RAM-resident copy), so recall loss is <1% for Cosine — verified search stayed mode=hybrid, degraded=false across sample queries.

**Code/Files Modified:**
- packages/core/src/qdrant.ts
- packages/core/src/catalog.ts
- packages/indexer/src/main.ts

**Outcomes & Lessons Learned:**
- **What Worked:** Qdrant cold-boot RAM ~590MB peak / ~530-597MB settled, down from the ~2GB peak the user observed. Orphan gone. 430/430 tests pass; new scans index via the batch path with no errors; entry count grew with no data loss.
- **What Failed:** Initial hypothesis that FTS bloat was outlier-driven — measurement disproved it, so that change was correctly abandoned before implementation. On-disk only dropped 1.7G->1.6G because always_ram quantization adds int8 vectors alongside the fp32 originals; the disk win is the orphan (-338M), the RAM win is quantization.

**Status:**
- Completed
---
### [2026-07-17] - Beta hardening: agent-readiness (MCP/CLI), prompt rework, usage telemetry

**Objective:**
- Make Atlas ready for coding agents (Claude Code): test every surface, fix agent-hostile behaviors, and register it for all future sessions.

**Summary of Work:**
- Live-tested all 10 MCP tools + all CLI subcommands against the running stack (300k entries). Search/ask/timeline/components/session/reindex/status all functional; Ask answers verified accurate and cited (gemini-2.5-flash via G2P).
- Context safety: atlas_session returned 71k chars in one MCP result. /api/sessions/:id now takes limit/offset/max_body and returns totalEntries; /components/:name takes limit/max_body; capped bodies flagged bodyTruncated:true (id kept for atlas_entry follow-up). MCP defaults: session limit 50 / max_body 1500, component_history limit 20 / max_body 2000. UI/no-param calls unchanged.
- Unknown project slugs: per-project routes (timeline/components/component/sessions) used to return empty 200s (CLI printed nothing) — now 404 with a hint, backed by Catalog.projectExists.
- MCP server now sends initialize-time instructions (SERVER_INSTRUCTIONS): what Atlas is, BETA caveat (verify against cited sources), unscoped-first guidance, ghost-slug warning, truncation semantics, and a mandatory 'Atlas usage' note (tools used, 1-5 rating, issues) in agent reports.
- Ask SYSTEM_PROMPT rewritten for the mid-size models that serve it: 8 numbered rules in priority order (grounding + no-fabrication first, honest 'not found', direct-answer-first); context blocks cut at 1500 chars now end with an explicit …[truncated] marker.
- Usage telemetry: new pg table usage_log; API middleware records requests labeled x-atlas-client (mcp sends x-atlas-tool too), fire-and-forget; GET /api/admin/usage aggregates; new 'atlas usage' CLI command. UI traffic deliberately unlabeled/unlogged.
- Registered Atlas at user scope (claude mcp add --scope user) and added CLAUDE.md §12 (usage guidance + beta reporting duty). Docs updated: api/mcp/cli/getting-started (incl. disable/re-enable).
- Also fixed a pre-existing make lint failure (TimelineItem lacked projectSlug; ProjectTag now tolerates a missing slug).

**Key Decisions & Rationale:**
- Telemetry lives in the API (one table, one write path); clients only self-identify via headers. UI polling would bury agent signal, so unlabeled traffic is not recorded.
- Truncation is flagged, never silent: agents get bodyTruncated + totalEntries + the entry id to re-fetch, matching the 'no silent caps' principle.
- MCP over CLI for Claude Code: typed schemas + connect-time instructions beat parsing --json output; CLI stays for humans/scripts.

**Code/Files Modified:**
- packages/core/src/catalog.ts, packages/core/src/ask.ts
- packages/api/src/app.ts
- packages/mcp/src/tools.ts, packages/mcp/src/main.ts
- packages/cli/src/main.ts, packages/cli/src/api.ts
- packages/ui/src/types.ts, packages/ui/src/components/ui.tsx
- test/api/routes.test.ts, test/mcp/tools.test.ts
- docs/api.md, docs/mcp.md, docs/cli.md, docs/getting-started.md

**Outcomes & Lessons Learned:**
- **What Worked:** 444 -> 449 tests green, lint clean, smoke 7/7. Live-verified: 404 hint, bounded session page (50/118 entries, flags), MCP instructions served on initialize, telemetry loop closed (the test call itself appeared in 'atlas usage').
- **What Failed:** Nothing rolled back. Note: the linked CLI binary runs from dist/ — a new subcommand silently doesn't exist until npm run build.

**Status:**
- Completed
---
### [2026-07-17] - Concurrency safety: audit, regression tests, docs

**Objective:**
- Confirm many simultaneous agents (+ background reindex) can't corrupt Atlas data, and lock that in with tests + docs.

**Summary of Work:**
- Audited the concurrency story end to end. Reads are stateless (fresh MCP server+transport per request; independent Hono handlers; shared pg pool max:10 that queues rather than fails). Writes are idempotent (entries.dedup_key UNIQUE + ON CONFLICT DO NOTHING; insertEntries also collapses duplicate keys within one statement). Writers can't collide (deterministic BullMQ job ids per project+source; Redis scheduler lock; pg_advisory_lock(732015) for migrations). usage_log is a lone fire-and-forget INSERT.
- Live stress test on the running stack: 80 searches + 60 entry reads + a reindex, all concurrent → 0 failures, 0 NULL rows, 0 duplicate dedup_keys, 0 index errors. 60-way search burst (6x pool) queued (avg 1.6s) instead of erroring; entry reads stayed ~13ms.
- Added test/core/insertEntries.test.ts (8 tests) with a fake-pool Catalog: pins the within-statement dedup collapse, distinct-entry preservation, the 65535 param-ceiling chunking, the ON CONFLICT DO NOTHING clause, and the logUsage write path (single INSERT, no SELECT/UPDATE, field clamping, null tool/query).
- Documented it: architecture.md gains 'Concurrency and data integrity'; operations.md gains 'Scaling / concurrency' with the load-bearing rule — do NOT add Compose replicas to api/mcp without shared caching first (in-process 30s storage cache + active_collection follow assume one process); indexer scales fine (WORKER_CONCURRENCY>1) because writes are idempotent.

**Key Decisions & Rationale:**
- No code change needed: single-instance api/mcp + dedup_key UNIQUE already make corruption structurally impossible. The work was proving it and preventing regressions (a future 'replicas: 2' or a refactor that drops the in-statement dedup collapse).
- Tested insertEntries via a fake pool rather than a live DB to keep the suite hermetic and fast, matching the existing test style.

**Code/Files Modified:**
- test/core/insertEntries.test.ts (new)
- docs/architecture.md
- docs/operations.md

**Outcomes & Lessons Learned:**
- **What Worked:** 449 -> 457 tests green, lint clean. Live burst of 140+ concurrent requests stayed healthy.
- **What Failed:** Nothing. The 907ms avg latency I first saw was the full search path under a 60-way burst (Qdrant+embed+PG queued behind pool), not a usage-log cost — the log write is off the response path.

**Status:**
- Completed
---
### [2026-07-19] - Deploy-induced permanent loss of atlas_* tools in live agent sessions

**Objective:**
- Find out why an agent reported it "should have called Atlas" on a history question, and fix the real cause.

**Summary of Work:**
- An agent's self-report blamed itself for not calling Atlas during a session about recorded history. Investigation showed it could not: `make restart` recreated the mcp container ~80 min into its session, the atlas_* tools were dropped, and nothing re-listed them. Its transcript has 0 atlas tool_use blocks and 16 occurrences of the instruction text, i.e. instructions delivered, tools absent.
- Root cause of the no-recovery half is packages/mcp/src/main.ts: `sessionIdGenerator: undefined` makes the server stateless, building a throwaway McpServer per request and tearing it down on res.close. It holds no client reference, so it cannot push tools/list_changed. The `listChanged: true` in the initialize response is an SDK default that is never implemented (grep finds no references in our source).
- Fixed the instruction that told agents to wait for a recovery that cannot happen, and removed mcp from the default restart path so ordinary deploys stop breaking live sessions.

**Key Decisions & Rationale:**
- Did NOT make the server stateful to support tools/list_changed. Statelessness is deliberate (main.ts:8-10, chosen so `claude mcp add --transport http` works cleanly); session lifecycle management is a large cost to fix a problem that deploy hygiene fixes for free.
- Did NOT revise the trigger prose again. Three revisions landed in one night (2f96e1d, b20486a) and none has been tested with an agent that actually had the tools. The feedback prompting this came from a toolless session, so it carries no signal about whether the triggers work. Let the skip-reporting duty produce real evidence first.
- `restart-mcp` uses `up -d --no-deps --force-recreate`, not `compose restart`: the latter reuses the old image, so it would not pick up a rebuild.
- Assessor shares the disconnect behaviour but is a single container, so its `make restart` cannot avoid restarting the MCP server. No Makefile fix is possible there; the corrected disconnect guidance is the portable part.

**Code/Files Modified:**
- packages/mcp/src/tools.ts
- test/mcp/tools.test.ts
- Makefile

**Outcomes & Lessons Learned:**
- **What Worked:** Container lifecycle evidence (StartedAt, RestartCount, image timestamps) against the session transcript. Parsing tool_use blocks rather than grepping tool names — the grep counted tool-listing metadata and suggested calls that never happened.
- **What Failed:** Two of my own conclusions, both from inferring cause from a single artifact. (1) "The agent never attempted Atlas" — 0 tool_use meant the tools were not callable, not that it declined. (2) "The prose layer has failed twice, stop iterating" — the prose was never fairly tested, as the tools were gone for 80 of 81 minutes. Both corrections came from evidence outside the artifact I was reading. Docker had already discarded events from the incident window, so the deploy attribution rests on strong circumstantial evidence, not a directly observed event.
- An agent's account of its own failure is itself a reconstruction and must be verified like any other historical claim; this one misattributed a capability loss to a motivational lapse.

**Status:**
- Completed

---
### [2026-07-19] - Tool-adoption measurement (atlas adoption)

**Objective:**
- Replace agents' self-reported tool use with a measurement taken from evidence, so MCP instruction tuning has a real feedback loop.

**Summary of Work:**
- New packages/core/src/adoption.ts: streams Claude Code transcripts (~/.claude/projects/**/*.jsonl), counts assessor/atlas calls (Tier 1) and matches assistant prose against the documented triggers (Tier 2).
- New `atlas adoption` CLI command (--since/--project/--min-turns/--limit, --json via the shared out() helper).
- 21 tests in test/core/adoption.test.ts; docs in docs/mcp.md ("Measuring adoption") and docs/cli.md.

**Key Decisions & Rationale:**
- Transcripts, not a Stop hook. A hook only sees sessions after install; transcripts are retrospective over all 3,760 existing sessions, so we get a baseline immediately and cannot silently stop collecting.
- Direct HTTP calls to :8710/:8711/:8770 count as use — the MCP tools drop out of a running session when a server restarts and agents fall back to curl. Counting only mcp__* would misread that as a miss.
- fireRate is null (not 0) when nothing qualified: "no opportunity" and "never fired" are different findings and must not render identically.
- Detectors mirror SERVER_INSTRUCTIONS triggers. Documented in docs/mcp.md that adding a trigger without adding a detector makes it invisible to measurement.

**Code/Files Modified:**
- packages/core/src/adoption.ts (new), packages/core/src/index.ts
- packages/cli/src/main.ts
- test/core/adoption.test.ts (new)
- docs/mcp.md, docs/cli.md

**Outcomes & Lessons Learned:**
- **What Worked:** First real run over 3,760 sessions — assessor fireRate 16%, atlas 5%, with 38 and 142 calls respectively. First hard evidence that under-use is systemic rather than two anecdotes, and that it is under-use rather than non-use.
- **What Failed:** Three detectors were badly noisy on real data and only running them exposed it: a bare /regressed/ matched the routine "nothing regressed" after every test run (175 hits, ~all noise); /update the test to/ matched ordinary test-writing; /rejected it/ matched "the strict schema rejected it", where the system rejects, not the agent. All three narrowed with the noise cases pinned as non-matches.
- **Also failed, opposite direction:** {3,60} in rejected-alternative silently missed "I considered X but rejected it" (2-char subject). Under-matching is the more dangerous bug here — it yields a clean report that reads as "no misses found". Tests now pin both directions.
- **Third bug:** declaring a local --json shadowed the program-level global and never bound, so --json printed human output. Fixed by using the existing out() helper.

**Status:**
- Completed

---
### [2026-07-19] - adoption --compare (before/after windows)

**Objective:**
- Close the tuning loop: after changing MCP instructions, check in one command whether the change moved anything.

**Summary of Work:**
- `compareAdoption(at, opts)` in packages/core/src/adoption.ts: splits history at a date, diffs both windows, returns per-tool ToolDelta + moved rules + caveats.
- `--compare <date>` and `--until <date>` on the CLI; `until` is exclusive so windows partition cleanly.
- 6 new tests (27 total in the file); docs/mcp.md gains a "Before/after an instruction change" section.

**Key Decisions & Rationale:**
- The guard is the feature, not the diff. Fire rate is a ratio over few sessions and swings hard at low n: comparing across the 2026-07-19 rewrite yields "+84pp, all rules improved" off a ONE-session after-window. Output therefore always carries n, marks <10 qualifying sessions as small, and emits caveats for thin samples, empty windows, and >2x size mismatch.
- Rule deltas are absolute counts, so unequal windows inflate them. Documented and caveated rather than normalised — a normalised count would look authoritative and hide the same problem.
- MIN_SAMPLE_FOR_SIGNIFICANCE exported so the threshold is visible and testable rather than a magic number.

**Code/Files Modified:**
- packages/core/src/adoption.ts, packages/cli/src/main.ts
- test/core/adoption.test.ts, docs/mcp.md, docs/cli.md

**Outcomes & Lessons Learned:**
- **What Worked:** Running it on a balanced window (compare 2026-06-01, n=16→39 and 137→111, no small-sample warning) surfaced a real finding: both tools had 0 calls across 2,257 sessions before June 2026 because they did not exist yet. The all-time 16%/5% figures are therefore diluted by months with no tool to call, and the honest baseline for judging the rewrite is June-onward.
- **What Failed:** Nothing broke, but the first real run is a good example of why the guard was needed — without the caveats the output reads as proof the instruction rewrite worked, when the after-window is a single session in which the agent was actively building these tools.

**Status:**
- Completed
---
### [2026-07-19] - G2P client-id attribution on outbound LLM calls

**Objective:**
- Identify Atlas to G2P on every LLM/embedding call so our token spend is attributed instead of landing in G2P's anonymous bucket.

**Summary of Work:**
- Added `packages/core/src/g2pHeaders.ts` as the single home for outbound caller identity: header name, default id, and sanitising.
- Header `X-G2P-Client-Id` now sent from all three call sites: `chatComplete`, `chatStream` (packages/core/src/llm.ts) and the OpenAI-compatible embeddings client.
- New config `g2pClientId` (`KDB_G2P_CLIENT_ID`, default `Atlas`), threaded from api/indexer mains into AskService and createEmbedder.
- Docs: new "Identifying ourselves to G2P" section in docs/configuration.md; .env.example entry.

**Key Decisions & Rationale:**
- ONE top-level `g2pClientId` rather than per-surface `llm.clientId`/`embeddings.clientId`: the id names the *deployment*, not an endpoint. User chose this shape when both existed in the tree.
- Sent unconditionally, not gated on `LLM_PROVIDER`: G2P treats it as pure telemetry (never routes on it) and non-G2P endpoints ignore unknown X- headers, so a provider check would be complexity with no benefit.
- Sanitise client-side (trim, strip control chars, 128 cap) mirroring G2P's server-side rules, so a value read off /hstats always matches config.
- `KDB_G2P_CLIENT_ID` is read RAW, not through `opt()`: opt() maps '' to undefined, which zod then replaces with the default — silently turning the documented "send nothing" opt-out into a no-op.

**Code/Files Modified:**
- packages/core/src/g2pHeaders.ts
- packages/core/src/llm.ts
- packages/core/src/config.ts
- packages/core/src/ask.ts
- packages/core/src/embeddings/openaiCompat.ts
- packages/core/src/embeddings/index.ts
- packages/api/src/main.ts
- packages/indexer/src/main.ts
- test/core/llmComplete.test.ts
- docs/configuration.md
- .env.example

**Outcomes & Lessons Learned:**
- **What Worked:** Live probe against the running G2P (port 8181) with `X-G2P-Client-Id: AtlasProbe` returned 200 and the durable stats row in google-gemini-pool/stats/2026-07-19.jsonl recorded `client_id: "AtlasProbe"` — end-to-end confirmation, not just a stubbed-fetch assertion.
- **What Failed:** Two competing implementations briefly coexisted (a per-surface `clientId` and a top-level `g2pClientId` referencing an unimported constant), which broke the config module with `DEFAULT_G2P_CLIENT_ID is not defined`. Resolved by consolidating on g2pHeaders.ts and asking which shape to keep rather than picking unilaterally.
- **Lesson:** The empty-string-vs-unset distinction is load-bearing here; routing the var through the usual `opt()` helper would have quietly removed the opt-out.

**Status:**
- Completed
---
### [2026-07-19] - G2P client-id attribution on all outbound LLM calls

**Objective:**
- Identify Atlas to G2P via the X-G2P-Client-Id header so our token spend is attributed to us in /hstats instead of the anonymous bucket.

**Summary of Work:**
- Added packages/core/src/g2pHeaders.ts: a single g2pClientHeaders() helper that builds the header, mirroring G2P's own sanitising (strip control chars, truncate to 128) so what we send is byte-identical to what the dashboard records.
- Wired it into all three outbound transports: chatComplete, chatStream (packages/core/src/llm.ts) and createOpenAICompatProvider (embeddings).
- New top-level config field g2pClientId (env KDB_G2P_CLIENT_ID, default 'Atlas'), threaded through AskService and createEmbedder from api + indexer entrypoints.

**Key Decisions & Rationale:**
- ONE top-level field rather than nesting under llm: embeddings against the g2p provider are billed traffic on the same proxy, so an llm-only knob would have left the highest-volume caller (indexing) unattributed. The id names the deployment, not an endpoint.
- Sent unconditionally, NOT gated on provider=g2p: G2P only reads the header for stats and never routes on it, and non-G2P OpenAI-compatible endpoints ignore unknown X- headers. A provider gate would be dead weight that silently breaks if someone points LLM_PROVIDER=openai at G2P.
- Read KDB_G2P_CLIENT_ID raw instead of through the local opt() helper: opt() maps '' to undefined, which zod then replaces with the default, turning the documented opt-out into a silent no-op. Covered by a regression test.
- Client id is 'Atlas' (capital A) per user directive; casing is contract, not cosmetics, since 'atlas' and 'Atlas' would appear as two separate clients on the dashboard. Asserted literally in tests.

**Code/Files Modified:**
- packages/core/src/g2pHeaders.ts (new)
- packages/core/src/llm.ts
- packages/core/src/config.ts
- packages/core/src/embeddings/openaiCompat.ts
- packages/core/src/embeddings/index.ts
- packages/core/src/ask.ts
- packages/api/src/main.ts
- packages/indexer/src/main.ts
- test/core/g2pHeaders.test.ts (new)
- test/core/llmComplete.test.ts, llmStream.test.ts, embeddings.test.ts, config.test.ts
- docs/configuration.md, .env.example

**Outcomes & Lessons Learned:**
- **What Worked:** One shared helper as the single seam. Verified by mutation test: suppressing the header failed 12 tests across all four files, confirming coverage spans every transport rather than just the helper's unit tests.
- **What Failed:** llmStream.test.ts previously only exercised the SSE parser, never chatStream's actual request — the streaming path (the bulk of interactive traffic) had zero header coverage until it was added here. A helper that nobody calls is the real failure mode for this kind of change, so per-transport wire assertions matter more than the unit tests.

**Status:**
- Completed
---
### [2026-07-19] - CORRECTION: duplicate entries for the G2P client-id work

**Objective:**
- Reconcile two component entries and two changelog lines that describe the SAME change, so a later reader does not infer two separate pieces of work.

**Summary of Work:**
- No code change. The G2P client-id feature was logged twice on 2026-07-19: "G2P client-id attribution on outbound LLM calls" and "...on all outbound LLM calls" (plus changelog lines at 15:09 and 15:30 UTC). One implementation, one commit.
- The FIRST entry is authoritative: it is accurate and records the live end-to-end probe. The second adds only the mutation-test detail (suppressing the header failed 12 tests across 4 files, confirming coverage spans every transport).
- Logs are append-only per §2.6, so the duplicates stay; this note is the reconciliation.

**Key Decisions & Rationale:**
- Appended a correction rather than editing the earlier blocks: append-only means the record of what was believed at the time has value, including the redundancy.

**Outcomes & Lessons Learned:**
- **What Worked:** Re-verified the live probe independently before trusting the earlier entry: POST to G2P with `X-G2P-Client-Id: Atlas` returned 200 and google-gemini-pool/stats/2026-07-19.jsonl now carries `client_id:"Atlas"` rows alongside the original `AtlasProbe`.
- **What Failed:** I briefly doubted the earlier entry's probe claim because a too-narrow grep (sorted by count, tail truncated) did not surface the AtlasProbe row. The entry was truthful; the search was wrong. Verify the query before doubting the record.
- **Observation for later:** Existing G2P callers use a `service/operation` convention (`Lycos/title_backfill`, `deepcast/analysis`). Our flat `Atlas` cannot separate ask-mode from indexing spend on the dashboard. Deliberate for now — see backlog.

**Status:**
- Completed
---
### [2026-07-25] - Silent vector loss + Ask asserting unmeasured coverage (investigation, heal, ADRs)

**Objective:**
- Find why an agent was told "Atlas's index stops at 2026-07-15" and fix the class of problem, not the instance.

**Summary of Work:**
- Reproduced from the agent's own transcript: one atlas_ask (k=14, gemini-2.5-flash) answered "The indexed history for July 2026 concludes on 2026-07-15 [1, 13]". False — the index held 34,825 entries newer than that and had run 2 min earlier. All 14 retrieved blocks happened to max out at 07-15; the model reported its sample as the corpus.
- While tracing it, found worse: entries can be committed to Postgres and never embedded. Census of 323,176 entries vs 361,941 Qdrant points found 39 orphans — including ALL 13 sections of docs/operations/worker-pool-resize.md and ALL 11 of the 2026-07-25 worker-allocation design spec. Invisible to every semantic search; atlas_status said recentErrors: 0.
- Healed all 39 by re-embedding through the real indexEntries(); verified by re-scroll and by live atlas_search returning the previously-missing runbook top-ranked.
- Wrote 2 ADRs + a 4-phase plan, then self-reviewed and fixed 4 defects in my own design.

**Key Decisions & Rationale:**
- Coverage tracked as `vectorized_in` (collection name), NOT `vectorized_at` (timestamp). Self-review caught that a timestamp reports full coverage against a new empty collection after a model switch, breaking the one case needsBackfill exists for. The collection name encodes provider/model/dim, so a switch invalidates every row for free.
- Backfill and reconciliation unified into one path; the column replaces backfill_cursor, so the operation is resumable by construction.
- Migration performs an audit instead of blanket-marking rows: Phase 0 verified coverage now, but Phase 1 ships later, and any outage between would be blessed as covered.
- Ask coverage reported per project, not index-wide: unscoped ask is the default, and "index current to 07-25" says nothing about whether DeepCast is covered.
- Window counts padded with a neighbourhood count: "0 entries dated 07-21" is true but an incident on the 21st is usually written up on the 22nd.
- Principle for the whole service: measure, or say nothing.

**Code/Files Modified:**
- docs/adr/20260725-vector-catalog-reconciliation.md (new)
- docs/adr/20260725-ask-answer-trust-contract.md (new)
- docs/superpowers/plans/2026-07-25-atlas-trust-hardening.md (new)

**Outcomes & Lessons Learned:**
- **What Worked:** Reading the agent's own transcript to get the exact failing call instead of guessing at the symptom. Reusing the real indexEntries() for the heal, so point ids/payloads provably match the pipeline.
- **What Failed:** Two of my own hypotheses, both killed by measurement. (1) Suspected the occurred_at range filter was broken because the field has no payload index — it works, returning 34,865 points, just 36x slower (3.11s vs 0.087s). (2) Suspected a random sample would reveal orphans — 600/600 had vectors; only sampling the outage window (recent entries) exposed the 39. Sampling strategy, not sample size, was what mattered.
- **Lesson:** needsBackfill compared chunks (361,941) to entries (323,176) — different units, so it could never fire. A safety net with a unit bug reads as protection while providing none.

**Status:**
- In-Progress
---
### [2026-07-26] - Phase 1: per-entry vector coverage tracking + unified reconciler

**Objective:**
- Make it impossible for an entry to sit in Postgres, unsearchable, with nothing detecting or repairing it.

**Summary of Work:**
- entries.vectorized_in TEXT: the collection an entry's vectors live in. NULL or != active means "not searchable now".
- indexEntries marks an entry only after its FINAL chunk upserts. batchChunks now yields {items, completed} because chunk order (and therefore "this entry is finished") is only knowable inside the generator.
- auditVectorCoverage: scrolls the collection's entry_ids and writes only the DELTA against the column. Adopts present-but-unmarked rows, clears marked-but-missing rows.
- backfillVectors re-pointed from "page all entries by id" to "page entries not covered in the active collection". Backfill and repair are now one path; backfill_cursor retired since the column is the progress record.
- needsBackfill(uncoveredEntries) replaces needsBackfill(points, entries).
- Boot runs the audit only when countUncovered > 0, so a healthy boot skips the scroll entirely.

**Key Decisions & Rationale:**
- Collection-valued, not a timestamp: a model switch changes the collection name, so every row goes stale for free. Self-review caught that vectorized_at would report full coverage against a new empty collection and silently skip the rebuild.
- Audit writes only the delta. First implementation re-marked all 323k rows every run — measured 13 minutes, which makes periodic auditing impossible, and periodic is the whole point.
- Audit gated on uncovered > 0 rather than a settings marker: it runs exactly when something needs explaining, and it is what stops the column's introduction from triggering a full re-embed.

**Code/Files Modified:**
- packages/core/src/catalog.ts (schema + markVectorized/clearVectorized/countUncovered/uncoveredEntriesAfter/entryCoverage, shared rowToEntry)
- packages/core/src/qdrant.ts (allEntryIds)
- packages/indexer/src/pipeline.ts (batchChunks, indexEntries, auditVectorCoverage, needsBackfill, backfillVectors)
- packages/indexer/src/main.ts (audit + reconcile on boot)
- test/indexer/{indexEntries,backfill,scanDocs}.test.ts

**Outcomes & Lessons Learned:**
- **What Worked:** Verified in production, not just in unit tests — manufactured a real orphan (deleted an entry's points, cleared its mark), restarted, and watched the audit compute a correct zero delta, needsBackfill(1) fire, and the reconciler re-embed exactly that entry. Migration on 323,364 live entries adopted every existing vector and triggered zero re-embedding.
- **What Failed:** (1) Backticks inside the SQL comment terminated the SCHEMA template literal. (2) A test using 'fetch failed' matched a transient pattern and burned 15s of retry backoff before timing out; a non-transient message tests the same path in 1s. (3) The first audit was O(all entries) in writes, not O(delta) — only visible because the migration took 13 minutes.
- **Lesson:** A safety net measured in the wrong unit is worse than none: needsBackfill compared chunks to entries and read as protection for months while 39 entries sat unsearchable.

**Status:**
- In-Progress
---
### [2026-07-26] - Phase 1 finish: continuous reconciliation + an honest health signal

**Objective:**
- Close Phase 1: make repair continuous rather than boot-only, and give status a field that can say "search cannot see this".

**Summary of Work:**
- Reconciliation now runs every scheduler tick as a QUEUED BullMQ job, not inline in the cron tick: the tick holds a 55s scheduler lock while a reconcile can take minutes, and as a job it gets lock renewal and competes for the worker slot like other embedding work. Fixed jobId collapses duplicates so a slow pass cannot pile up copies of itself.
- backfillVectors gained maxEntries (100/tick). At ~1.9s per embed on a contended local Ollama an uncapped pass after a model switch would monopolise the embedder for hours; large rebuilds stay the boot path's job where nothing competes.
- Deep audit on its own 24h schedule via coverage_audit_at, NOT gated on uncovered > 0 — it is the only thing that can see vectors lost on the Qdrant side, where the column still claims coverage is complete.
- IndexStats.unsearchableEntries: entries with no vectors in the active collection. Flows to /api/stats, /api/dashboard, atlas_status and the CLI. Shown only when non-zero so it never becomes a permanently-green line nobody reads. MCP description tells agents what non-zero means for result completeness.

**Key Decisions & Rationale:**
- A4 WITHDRAWN. The plan listed a float-mtimeMs-to-bigint bug from seeing 577 such rows in index_errors. All fall in 2026-07-08 23:14-23:19; Math.trunc landed in 87ccec6 at 2026-07-09 01:20, two hours later. Already fixed; the rows are residue.
- recentErrors left alone. The original finding claimed it read 0 while errors existed — it counts the last HOUR and its 0 was correct. Changing it would have been fixing a misdiagnosis; the real gap was having no field for "unsearchable right now".
- Dropped per-stage error counts / last-successful-embed from status: /api/errors already serves diagnostics, and unsearchableEntries carries the signal that matters.

**Code/Files Modified:**
- packages/indexer/src/main.ts (reconcile job, RECONCILE_MAX_ENTRIES, AUDIT_INTERVAL_MS)
- packages/indexer/src/pipeline.ts (backfillVectors maxEntries)
- packages/core/src/{catalog.ts,types.ts} (unsearchableEntries)
- packages/cli/src/main.ts, packages/mcp/src/tools.ts
- test/indexer/backfill.test.ts

**Outcomes & Lessons Learned:**
- **What Worked:** Verified the scheduled path specifically, not just boot — deleted a live entry's points, cleared its mark, and watched unsearchableEntries go 0 -> 1 -> 0 with the reconciler repairing it unaided in 45s and logging the count.
- **What Failed:** Nothing broke, but two plan items turned out to be misdiagnoses (A4, recentErrors). Both came from reading counts in an error table as present-tense state.
- **Lesson:** An error table is a log, not a state. Counting rows in index_errors says nothing about what is broken now — the same reasoning error (sample read as present) that produced the 07-15 incident this whole effort exists to fix.

**Status:**
- Completed
---
### [2026-07-26] - Phase 2: Ask states coverage only from measurement

**Objective:**
- Make it impossible for Ask to assert what the index contains based on its retrieved sample.

**Summary of Work:**
- questionDates.ts: conservative extraction of explicit dates/ranges from a question (ISO, "21 July 2026", "July 21, 2026", bare "July 2026"), rejecting version strings, entry ids and clock times. Used ONLY to add a measured count, never to filter retrieval — so a miss degrades to old behaviour rather than hiding results.
- Catalog.coverage(projects) and countInWindow(): per-project entry counts and occurred_at span.
- buildCoverageBlock(): an INDEX COVERAGE preamble, explicitly labelled uncitable so it cannot masquerade as evidence about the subject.
- SYSTEM_PROMPT rule 2 rescoped to "the retrieved sources don't say X"; new rule 2b forbids any claim about what the index as a whole holds except by quoting the coverage block, and names the distinction between "retrieval didn't surface it" and "it isn't indexed".
- AskService.retrieve() now carries mode/degraded out instead of discarding them; ask()/askStream() return a structured RetrievalReport { mode, degraded, coverage, window }.

**Key Decisions & Rationale:**
- Coverage per project, not index-wide: unscoped ask is the recommended default, and "the index is current to 07-25" says nothing about whether DeepCast is covered.
- Window counts always paired with a padded +/-3d neighbourhood: an incident on the 21st is usually written up on the 22nd, so a bare "0 entries on the 21st" is true and still a dead end.
- The coverage block is deliberately NOT a numbered [n] block: a model that could cite it would start attributing claims about the world to a row count.
- The measurement failure path now LOGS instead of swallowing — see below.

**Code/Files Modified:**
- packages/core/src/questionDates.ts (new), ask.ts, catalog.ts, types.ts
- test/core/{questionDates,askRetrievalReport}.test.ts (new), ask.test.ts, askStream.test.ts

**Outcomes & Lessons Learned:**
- **What Worked:** Verified against the live stack with the EXACT question from the incident. Before: "The indexed history for July 2026 concludes on 2026-07-15." After: "Based on the retrieved sources... while 11,227 entries were indexed in the surrounding period, exactly 0 entries carry a timestamp for July 21, 2026" — and it then produced a real hypothesis (the fail -> drain-revives -> re-queue-into-starved-lane ping-pong) instead of stopping.
- **What Failed:** A python edit to add the questionDates import silently did not match (the import block had been reformatted multi-line), so extractDateWindow was undefined at runtime. The try/catch around measurement swallowed the ReferenceError and coverage vanished from every answer while everything still looked healthy. Caught only because a test asserted the happy path.
- **Lesson:** That near-miss is the same shape as the bug being fixed — a silent failure presenting as health. The catch now warns rather than swallowing. A best-effort path still has to be an observable one.

**Status:**
- Completed
---
### [2026-07-26] - Phase 3: make retrieval aware of time and stop it wasting the window

**Objective:**
- Give a date-anchored question a way to reach its date, and stop duplicates and time-blind ranking from filling the context window.

**Summary of Work:**
- C1: since/until exposed on atlas_search and atlas_ask, and threaded through /api/ask + /api/ask/stream (the API already accepted them on /api/search; the ask routes dropped them silently). Tool descriptions frame the WHY — ranking is semantic and time-blind, and work is usually recorded after it happens, so scope a few days either side.
- C3: occurred_at added to the Qdrant payload index list as a `datetime` field. Range filtering already worked via full scan; it was just too slow to expose as a normal filter.
- C2: gentle recency multiplier in rerankForContext — exp decay, 180d half-life, 12% max boost. A tie-breaker, not a ranking axis.
- C4: near-duplicate collapse keyed on project|sourceType|title|occurredAt, applied AFTER sorting so the survivor is the best-scoring member of its group.
- C5: finalize() now measures ageMonths for every source type, not just docs; buildAskPrompt labels non-doc blocks older than 6 months as "[N mo old]".

**Key Decisions & Rationale:**
- Recency kept deliberately weak (12% spread). ADR 20260710 decided old-but-current docs must keep ranking well ("an old runbook that simply never needed edits must not be buried"); a strong boost would silently reverse an accepted decision.
- Undated entries get factor 1.0 — the floor of the curve, i.e. ranked as maximally old rather than penalised. Absence of a date says nothing about age and several source types routinely lack one.
- Dedupe keyed on title+timestamp, not body similarity: cheap, and it targets the actual duplication mechanism (one event distilled into several rows) without risking the collapse of two genuinely different entries about the same subject.
- Age LABEL stays doc-only (ARCHIVED/AGING); other types get a bare "N mo old". Calling a two-year-old commit "aging" is noise — commits are historical by nature, not stale.
- MAX_SESSION_FRACTION left at 0.5. The recency term addresses the real complaint (recent material is session-dense and was out-ranked) without weakening the structural guarantee. Changing both at once would make neither measurable.
- B4 DEFERRED, not dropped: RRF scores are rank-based and carry no absolute relevance. A calibrated confidence signal needs a dense-only cosine probe plus threshold calibration; shipping an uncalibrated number would be the exact unearned confidence this work removes. Logged to backlog for its own ADR.

**Code/Files Modified:**
- packages/core/src/{qdrant.ts,ask.ts,search.ts}
- packages/api/src/app.ts, packages/mcp/src/tools.ts
- test/core/{rerankForContext,ask}.test.ts

**Outcomes & Lessons Learned:**
- **What Worked:** occurred_at datetime index took the range filter from 3.11s to 0.004s warm — far past the 36x the plan aimed at. Re-running the incident question gave 14 distinct titles of 14 sources (was 11/14); the 2025-11-25 triplet collapsed to one and the freed slots went to genuinely different material.
- **What Failed:** My first recency test asserted an undated entry should beat a 400-day-old one scoring 1.25% lower. It does not — every dated entry gets a factor strictly above 1.0, so undated is the infimum, losing by 0.05%. The implementation was right and the test overclaimed; corrected the test to assert what is actually guaranteed rather than weakening the design to match a bad assertion.
- **Lesson:** When a test fails, decide which of the two is wrong before changing either. Here the honest fix was a weaker, true assertion — not a stronger, convenient implementation.

**Status:**
- Completed
---
### [2026-07-26] - Phase 4: moved checkouts are aliases, not duplicates

**Objective:**
- Stop scoped search silently excluding 27,300 entries, and stop telling agents to discard them.

**Summary of Work:**
- resolveProjectAlias(): a project whose slug ENDS WITH another's is an older location of it. Guards: '-' boundary (notdeepcast != deepcast), target must have a real rootPath (no ghost-to-ghost chaining), longest match wins (…-deepcast-lycos -> deepcast-lycos, not deepcast). No tie-break needed: projects.slug is UNIQUE.
- projects.alias_of column; refreshProjectAliases() runs every scheduler tick (order-independent, so a canonical project discovered later adopts an earlier ghost).
- SearchService.search() expands the scope before anything filters on it, so the vector path and the FTS fallback cannot disagree. AskService.measure() measures coverage over the same widened scope.
- aliasOf surfaced on atlas_projects; SERVER_INSTRUCTIONS corrected.
- ADR: docs/adr/20260726-moved-checkouts-are-aliases-not-duplicates.md

**Key Decisions & Rationale:**
- DID NOT re-attribute entries, which was the intuitive fix and is unsafe: Catalog.dedupKey hashes projectSlug, so migrated rows keep dedup keys computed from the ghost slug while the next scan computes canonical ones — ON CONFLICT DO NOTHING would then insert all 27,300 a second time. Doing it properly means re-hashing every body AND rewriting every vector payload. Aliasing is metadata-only, no re-embed, reversible by clearing one column.
- Did not bump PROJECT_GROUPING either: that path wipes and re-parses everything, hours of re-embed to fix a scoping bug metadata solves.
- Alias rows stay visible in atlas_projects rather than being folded away — the split is real and worth seeing; hiding it would repeat the original sin of pretending the data model is tidier than it is.

**Code/Files Modified:**
- packages/core/src/{discovery.ts,catalog.ts,search.ts,ask.ts,types.ts}
- packages/indexer/src/scheduler.ts, packages/mcp/src/tools.ts
- test/core/projectAliases.test.ts (new), askRetrievalReport.test.ts, test/indexer/scheduler.test.ts
- docs/adr/20260726-moved-checkouts-are-aliases-not-duplicates.md

**Outcomes & Lessons Learned:**
- **What Worked:** 8 aliases linked, 27,300 entries recovered. Verified live: a search scoped to deepcast now returns 2025-11-25 hits from volumes-cloudbox-coding-deepcast that it previously excluded in silence. Genuinely standalone projects (myllm, freerouting, paperclip workspaces, and the code root users-nasta-coding-new) correctly left alone.
- **What Failed:** Wrote a test asserting the matcher refuses an "ambiguous" tie between two projects with the same slug — an impossible state, since projects.slug is UNIQUE. Deleted the test and the dead tie-breaking branch rather than keeping defensive code for a state the schema forbids. Also put backticks inside a template literal in SERVER_INSTRUCTIONS again, same mistake as the SCHEMA one on 2026-07-25.
- **D2 WITHDRAWN:** kdb_report is not frozen-because-broken. The source indexes ad-hoc markdown in a project's kdb/ dir, occurredAt is the file mtime, and those DeepCast files genuinely have not been touched since 2025-11-18 (confirmed on disk).
- **Lesson:** D2 is the THIRD finding in this plan to dissolve under checking (with A4 and recentErrors), all the same shape — reading a max/count from a table as present-tense state rather than as a record of the past. That is a milder version of the incident this whole plan exists to fix, committed by me while fixing it.

**Status:**
- Completed
---
### [2026-07-26] - Retrieval evaluation harness (deliverable 0 for B4 + source mix)

**Objective:**
- Build the instrument that makes a retrieval change measurable, so B4 and the session-cap question stop being undecidable.

**Summary of Work:**
- New `packages/eval` workspace: `mine | generate | judge | run | signals | baseline`, run on the host against the live stack so a ranking variant is a config object rather than an image rebuild.
- Three query pools, reported separately and never averaged: A = 21 real mined queries (graded 0-3 by `cline-pass/kimi-k3`), B = corpus-derived known-item questions with leakage filtering, N = negatives whose absence is verified by retrieval + judge rather than assumed.
- Metrics at BOTH pipeline stages, because the deferred items live at different ones: `recall@30` over the retrieval pool, `nDCG@10`/`precision@12` over the reranked context. `MAX_SESSION_FRACTION` cannot touch the pool at all.
- Paired per-query deltas with a percentile bootstrap 95% CI, not two absolute means: at n=21 the pairing cancels most of the variance.
- `rerankForContext(pool, k, opts?)` now takes source weights, session fraction, an alternative slot floor, recency params and an injectable clock, all defaulting to the shipped constants and pinned by a golden test.
- `AskService.retrieve()` became public `retrieveForContext()` returning `{hits, pool, ...}` so the harness measures the product's exact path instead of a copy of it.
- `RetryOptions.isRetryable` added so a caller can declare its own transient shapes.

**Key Decisions & Rationale:**
- Unjudged candidates BOUND the metric (computed optimistically and pessimistically); a conclusion that flips prints INCONCLUSIVE. The alternative was an invented \"more than N% unjudged is invalid\" gate, which is the kind of number this whole effort exists to remove.
- An unlabelled candidate is never graded 0. Scoring it irrelevant fabricates a label, and every metric is a function of the labels.
- The baseline variant is re-measured in the same process as any candidate. The index gains entries every five minutes, so a diff against a stored number measures corpus growth and calls it a ranking win.
- Quadratic-weighted kappa over a GRADE-STRATIFIED subsample: the grades are ordinal, and a uniform sample would be nearly all grade 0 and flattered by easy consensus on obvious negatives.
- Judge sees no rank and no score, candidates shuffled under a committed seed — otherwise today's ranking blesses itself.
- Pooling is across retrieval MECHANISMS (hybrid, FTS, dense-only), not variants: variants only affect context selection, so their retrieval pools are identical and unioning them adds nothing.
- Query classes derived from reading real traffic: `incident` replaces the spec's proposed session-recap class, which no real query matches.

**Code/Files Modified:**
- packages/eval/** (new)
- packages/core/src/ask.ts, retry.ts, catalog.ts, llm.ts, qdrant.ts
- packages/api/src/app.ts
- test/eval/**, test/core/{rerankForContext,retrieveForContext,retry,ftsQuery,llmComplete}.test.ts, test/api/routes.test.ts
- Makefile, package.json, tsconfig.lint.json, vitest.config.ts
- docs/adr/20260726-retrieval-quality-is-measured-not-argued.md
- docs/superpowers/specs/2026-07-26-retrieval-eval-harness-design.md

**Outcomes & Lessons Learned:**
- **What Worked:** Building the instrument before the tuning found three real defects that no existing test could catch, because each rendered a failure as a plausible result. (1) `ftsSearch` returned 0 hits for ANY multi-word query — `websearch_to_tsquery` ANDs terms, so a 6-term query matched 0 entries while `worker pool resize` matched 31; this is the Qdrant-down fallback and it returned `{hits: [], mode: 'fts'}`, indistinguishable from an empty index. Fixed by OR-ing terms from the sparse branch's own tokeniser: 0 -> 30 relevant hits live. (2) `chatComplete` returned `''` when a reasoning model truncated mid-thought, reporting it as success — on the Ask path a blank answer marked healthy. (3) Every `atlas_ask` question was recorded as an empty query, so the most valuable class of real traffic was invisible.
- **What Failed:** Retrying a truncated LLM request unchanged — 45 consecutive empty completions before the cause was understood. A budget-starved call needs ESCALATION, not repetition; the retry classifier was right that the failure was transient and wrong to repeat the same request. Also: hand-predicting golden rank orders instead of computing them from the weights (four wrong test expectations), and an initial `precision@12` of 0.000 for never-judged queries, which read as \"nothing relevant retrieved\" when the truth was \"nobody has said\".
- The mineable query set is 21, not the 30-50 the parent spec assumed: 60 of 94 logged queries are `burst N` load tests, 20 are one `concurrency N` template, and every ask question was empty. Load-test noise is now excluded by SHAPE (many texts differing only by a number) rather than a hand-maintained blocklist.

**Status:**
- In-Progress
---
### [2026-07-26] - Eval harness: first measurements, and the source-mix answer

**Objective:**
- Run the harness on the question it was built for, and record what it says.

**Summary of Work:**
- Judged all 21 Pool A queries: 1,182 primary labels over 46-70 candidates each, **0 unjudged** (the repair loop recovered every timeout, 429 and truncated reply). Grade spread 0:486 1:328 2:214 3:154, so 31% relevant — discriminating, not a rubber stamp.
- Quadratic-weighted kappa **0.802** (67% exact) over a 270-label grade-stratified subsample re-judged by glm-5.2 -> stated resolution floor ~0.10.
- Baseline recorded with a corpus fingerprint. Pool A nDCG@10 0.665, precision@12 0.516, recall@30 0.748 overall.
- Measured both candidate fixes for the session cap, paired over pools A and B.

**Key Decisions & Rationale:**
- **Source mix: change nothing.** `relax-when-scoped` is a measured no-op (0W/0L/21T); `cap-as-floor` at floor=4 (a relaxation: 8 sessions allowed vs 6) trends slightly negative. The parent spec listed "leave it" as legitimate *given evidence*, and there is now evidence.
- The open question changed shape. floor=8 (a *tightening*: 4 sessions) trends POSITIVE, most on temporal (+0.045 nDCG, +0.028 precision) — opposite to the premise that the cap is a disguised recency penalty. Still inside the noise floor, so not actionable; but the next question is "is the cap too loose in general", not "should it be loosened for temporal questions".
- Judge concurrency separated from retrieval concurrency (2 vs 4). At 4 the gateway returned sustained 429s and timeouts, and every exhausted pass left candidates unjudged — going wider made the fixture thinner.

**Code/Files Modified:**
- packages/eval/src/{config,judgeAll}.ts
- test/fixtures/eval/{queries,judgements,baseline,signals}.json, arbitrate.md
- docs/adr/20260726-retrieval-quality-is-measured-not-argued.md

**Outcomes & Lessons Learned:**
- **What Worked:** Temporal questions have the worst context precision (0.361 vs 0.583 definitional) while their pool recall is high (0.781) — the relevant material is retrieved and then dropped before synthesis. That is the source-mix complaint made visible. Separately, `recall@30` came back +0.000 with 0W/0L in every class of every variant, which validates the two-stage design: RerankOptions provably cannot reach the retrieval pool, so a one-stage harness would have been blind to half of what it was measuring.
- **What Failed:** Setting judge concurrency to 4 — I had written the comment warning about saturating the shared gateway two commits earlier and then picked the number that did it. Also: `eval baseline` over 73 queries hit mode=fts once and correctly refused to record; the guard worked, but a baseline currently needs a retry to land, and why Qdrant/the embedder dropped under harness load is unresolved (backlog).
- The B4 signal panel found that RRF top-1 is not the flat non-signal it was documented as: all 12 verified negatives score exactly 0.500 (single-branch contribution — the branches agree on nothing), while 20 of 21 real queries score higher. It is still unusable alone, because 18 of 40 answerable Pool B questions also score exactly 0.500. Lexical overlap separates A from N perfectly and misclassifies 15% of Pool B; cosine@1 gets 94% and misclassifies 25%. Their errors fall on different queries, so B4's answer is probably a combination.

**Status:**
- Completed
---
### [2026-07-26] - Bugfix: askStream could report a blank answer as healthy

**Objective:**
- Close the streaming half of the empty-completion hole; chatComplete had just been fixed and askStream had not.

**Summary of Work:**
- `AskService.askStream` now tracks whether any content delta was yielded. If none, it emits an explanatory delta and `done` with `degraded: true` instead of falling through to `degraded: false`.
- `StreamMeta.finishReason` added, fed by a new optional `onFinish` callback on `createSseParser`, so the message names the cause rather than only reporting emptiness.
- Metrics are still reported on this path (unlike the throw path, which genuinely has none): the request succeeded and the completion-token count is the evidence.

**Key Decisions & Rationale:**
- Judged in Ask, not in `chatStream`. That generator is a transport whose contract is "yield content deltas"; zero deltas is a legitimate wire outcome it has no basis to interpret. Ask is the layer that knows an answer without text is not an answer. It is also the smaller blast radius — chatStream's only caller is askStream, but a future caller inherits no new contract.
- `onFinish` mirrors the existing `onUsage`: out-of-band, because a finish reason carries no content and cannot be expressed in the delta return type without changing what a delta means to every caller.

**Code/Files Modified:**
- packages/core/src/ask.ts
- packages/core/src/llm.ts
- test/core/askStream.test.ts, test/core/llmStream.test.ts
- docs/superpowers/plans/2026-07-26-post-harness-followups.md

**Outcomes & Lessons Learned:**
- **What Worked:** Test-first. The two new askStream tests failed on the old code and the "a normal answer stays healthy" guard passed, which confirmed the root-cause hypothesis (the `for await` body never runs, so nothing throws and nothing marks the answer degraded) before any fix was written.
- **What Failed:** Nothing in the fix, but the process is worth recording: I fixed `chatComplete` earlier the same day, wrote the streaming twin into the backlog, and shipped the asymmetry. Fixing one half of a defect and documenting the other half is worse than either fixing both or fixing neither — the codebase then looks guarded where it is not. The hole was on the UI path, i.e. the half a human actually sees.
- 719 tests green, lint clean.

**Status:**
- Completed
### [2026-07-29] - Bugfix: the sparse tokeniser shredded every literal in the corpus

**Objective:**
- A real `atlas_ask` question — "the deepcast frontend fetch a 6.8MB json ... I need the context and what was found" — was answered "the retrieved blocks do not contain" while five indexed entries answer it outright. Find why retrieval missed them and close the class, not the instance.

**Summary of Work:**
- Root cause: `tokenize()` split on `[^a-z0-9_]+` and dropped 1-char tokens, so `.` was a separator *inside a number*. `6.8MB` -> ["8mb"] (the 6 discarded, colliding with every other `*.8MB` size); `6.8 MB` -> ["mb"], a disjoint set. Measured per-token IDF on the live index: `quite` 17.48 > `json` 16.42 > `8mb` 16.35 > `large` 16.30. The filler word outranked the file size. Gold entries scored 16-21 against a winning irrelevant doc at 49; absent from the top 100 (94/100 were claude_session).
- Tokeniser rewritten to preserve literals: `.` kept inside runs; a dotted run is also split into parts only when every segment starts with a letter (compound identifiers yes, `6.8mb`/`v1.18.2`/`127.0.0.1` no); number+unit canonicalised both ways so `tokenize('6.8 MB')` === `tokenize('6.8MB')`.
- `SPARSE_VERSION` + a per-collection stamp, and a **sparse-only** rebuild via Qdrant updateVectors — no embedding calls, dense untouched. 366,005/366,559 points re-tokenised in 646s.
- Query-side `boostLiterals` (x3 on measurement/identifier/version/sha shapes). Verified against Qdrant that query values scale score exactly linearly (measured 3.000x).
- `withExplanatoryFloor`: tops the Ask pool up to ceil(k/2) non-session candidates. rerankForContext already weighted docs/kdb above transcripts and capped sessions at half the window, but it can only reorder what retrieval handed it.
- 1-entry query-embedding memo in SearchService, so the top-up does not put a second Ollama round-trip on the ask path.

**Key Decisions & Rationale:**
- Sparse-only rebuild over full re-index: a tokeniser change invalidates the sparse half and nothing else; re-embedding 326k entries through Ollama would recompute dense vectors that were never wrong.
- No legacy-token emission (which would have avoided the rebuild): `8mb` IS the collision bucket that caused the failure. Carrying it forward preserves the noise permanently to save a pass that costs minutes.
- The top-up runs strictly AFTER the empty-scope test. Running it first lets a second retrieval manufacture hits for a scope that matched nothing, suppressing the widening — caught by an existing test.

**Code/Files Modified:**
- packages/core/src/sparse.ts, search.ts, ask.ts, catalog.ts, config.ts, qdrant.ts
- packages/indexer/src/pipeline.ts, main.ts
- test/core/{sparse,search,retrieveForContext,updateSparse}.test.ts, test/indexer/sparseRebuildAction.test.ts
- test/fixtures/eval/queries.json (pool B 4a1d3705, gold = the 5 entries)
- docs/adr/20260729-literals-survive-tokenisation.md, docs/configuration.md, .env.example

**Outcomes & Lessons Learned:**
- **What Worked:** Measuring per-token IDF against the live index instead of reasoning about the ranking. "quite outranks 6.8MB" is a number that ends the argument; no amount of reading the fusion code would have produced it.
- **What Failed:** My own boot guard shipped the exact bug class it was written to prevent. It treated any backfill as proof the collection had been rewritten by the current tokeniser — but backfillVectors only touches *uncovered* entries, and on the 2026-07-29 boot that was 111 rows of 326,606. It stamped sparse_version over 326k stale vectors and skipped the pass. Caught only by reading the boot log. Now a pure function, `sparseRebuildAction`, with 7 tests. A version stamp that lies is worse than no stamp: nothing would ever run the pass again.
- **Also learned:** `updateVectors` rejects the WHOLE batch for one unknown id, so a stale id costs 64 good writes; slices are now counted and skipped rather than thrown. And `wait:false` means durable, not searchable — verification that reads immediately after a large pass reads the old data.
- 751 tests green, lint clean.

**Status:**
- Completed
### [2026-07-29] - Improvement: close the three follow-ups the tokeniser fix surfaced

**Objective:**
- Fix the three items logged to the backlog while fixing the sparse tokeniser, each of which was a way the same class of failure could recur unseen.

**Summary of Work:**
- **updateSparse bisects.** Qdrant rejects an update batch containing an unknown id and does not say which one, so a single stale point cost every good point beside it. The slice is now halved until the bad ids stand alone; they are returned as `failedIds` and logged by name. The happy path is still one round trip.
- **auditVectorCoverage reconciles per point id.** It compared `entry_id`s, so an entry holding 4 of its 5 chunk points read as fully covered — and was even adopted. Now it derives the expected point ids from the entry text (chunking is what decides how many there are) and an entry is covered only when every one is present. Partial losses are counted and reported separately from total ones, because total loss has innocent causes and a half-embedded entry does not.
- **Pool L.** Neither existing pool could produce a literal-bearing question: A is thin real traffic, and B's generator is told not to reuse identifiers or verbatim phrases. Pool L inverts exactly that one rule — one literal quoted as the entry spells it, everything else paraphrased, leakage still enforced on the remainder — with a new `literals.ts` (shape detection, priority, `spellingIn`) and separate reporting.

**Key Decisions & Rationale:**
- The literal extractor is deliberately NOT built on `isLiteralToken` from core, though it answers a similar question. That predicate is part of the retrieval code Pool L exists to hold to account; sharing it would let a ranking change quietly reshape its own exam.
- Chose to stream 158 MB of entry text in the audit rather than add a `chunk_count` column. The column would have been cheaper per run but only correct for rows written after it existed — useless for the 326k rows that predate it, which is the entire population the bug lives in. The audit is already gated behind 'the cheap count says something is missing', so it can afford the read.
- Deleted `Catalog.entryCoverage()` rather than keeping it beside the replacement. It could only ever answer 'does this entry have any points', which is precisely the question that let entry 7707 look covered.
- Priority order in the extractor puts measurements first: they are the shape that actually broke, while identifiers survived tokenisation intact.

**Code/Files Modified:**
- packages/core/src/qdrant.ts (bisection, allPointIds), catalog.ts (entriesWithCoverageAfter, entryCoverage removed)
- packages/indexer/src/pipeline.ts (audit rewrite, failedIds logging), main.ts (partial reporting)
- packages/eval/src/literals.ts (new), generate.ts (Pool L, goldFor extracted), pools.ts (leakage exemption), types.ts, report.ts, main.ts
- test/core/updateSparse.test.ts, test/eval/literals.test.ts (new), test/eval/pools.test.ts, test/indexer/auditVectorCoverage.test.ts (new)
- docs/adr/20260729-literals-survive-tokenisation.md, docs/adr/20260726-retrieval-quality-is-measured-not-argued.md (addendum)

**Outcomes & Lessons Learned:**
- **What Worked:** Test-first on each. The audit's zero-chunk test failed for a reason I had not predicted — a title alone still produces one chunk, so my 'empty entry' fixture was not empty — which turned one weak test into two precise ones. Writing the Pool L generator also exposed a real defect in the extractor I had just written and tested: `6.8` matched the version pattern, so a spaced '6.8 MB' would have yielded a useless literal. Neither would have surfaced from reading the code.
- **What Failed:** Nothing shipped broken, but the first RED for `literals.ts` was a module-not-found error, which is a weak red — it proves the module is missing, not that each assertion discriminates. The version defect found later is exactly what that weak red failed to catch.
- **Validated against the live corpus rather than assumed:** 200 sampled entries, 94% carry an extractable literal, mix 60 measurement / 65 identifier / 54 dotted / 5 version / 3 sha, each appearing in 1-41 entries out of ~327k.
- 784 tests green, lint clean.

**Status:**
- Completed
### [2026-07-29] - Improvement: make restart-build, because 'make restart' applies nothing

**Objective:**
- Answer 'is make restart enough to pick up changes, and what about settings baked into the image?' — then close whatever gap the answer exposed.

**Summary of Work:**
- Corrected the premise first: settings are baked into the **container**, not the image. `.env` is read at container-creation time (`env_file:` + `environment:` in compose), so a config change needs a *recreate*, not a rebuild. Code is different — `packages/*` is COPYed into the image and built there, so it does need `--build`.
- Measured the compose behaviour rather than assuming it. `docker compose config --hash=api` is **byte-identical** before and after appending `KDB_SPARSE_REBUILD=false` to .env, so `up -d` skips the recreate entirely: no error, no warning, setting silently not applied. The same test with `OLLAMA_URL` **does** move the hash. The difference is that compose interpolates `${OLLAMA_URL}` into `environment:` but records `env_file` as a path, not as resolved values.
- Added `make restart-build` = `up -d --build --force-recreate --no-deps indexer api ui`. Always rebuilds, always recreates, so the interpolated/env_file distinction stops being something anyone has to remember.
- Reworded `make restart`'s help from 'restart app services' to 'does NOT pick up code or .env (see restart-build)'.

**Key Decisions & Rationale:**
- `--force-recreate` rather than relying on `up -d`'s change detection: the detection is correct for interpolated vars and silently wrong for env_file ones, and a target that works for half the variables in a file is worse than no target.
- `--no-deps` so `--force-recreate` cannot bounce postgres/redis/qdrant, which are stateful and have no reason to restart. Cost: infra must already be up, which is `make up`'s job and matches `restart`'s existing contract.
- `mcp` stays excluded, same as `restart`. It is a thin stateless proxy to `api`, so core/api changes reach it without a restart, and recreating it drops the `atlas_*` tools from every live Claude Code session.
- Kept `restart` rather than removing it: a plain bounce is still legitimate, it is just not what 'apply my change' means.

**Code/Files Modified:**
- Makefile (restart-build added, restart help corrected)
- docs/operations.md (Applying a change section + revision history)

**Outcomes & Lessons Learned:**
- **What Worked:** Testing the claim with `compose config --hash` before writing the target, non-invasively (append to .env, hash, restore, diff to prove it was restored). The env_file result was the opposite of what I expected from `up -d`'s reputation, and it is the entire reason the target needs `--force-recreate`.
- **What Failed:** Nothing, but the user's framing ('settings baked in image') would have led to a rebuild-only target that still silently dropped env_file changes — the plausible fix would not have worked.
- Verified with `--dry-run`: recreates indexer/api/ui only, leaves mcp, postgres, redis and qdrant alone.

**Status:**
- Completed
### [2026-07-29] - Bugfix: a two-second probe could replace the entire index

**Objective:**
- Close the hazard found while testing `make restart-build`: the recreated indexer came up on the bundled CPU embedder while Ollama was running and reachable throughout.

**Summary of Work:**
- **Retry the probe.** `ollamaAvailable` was a single fetch with `AbortSignal.timeout(2000)` and no retry. Now 3 attempts with backoff, and a non-ok response counts as a failed attempt rather than a verdict (a 503 from an Ollama still loading its runner is exactly the case worth waiting for). A genuinely absent Ollama still answers in ~7s, once per boot.
- **Refuse the downgrade.** New pure function `embedderDowngrade`: when the configured provider is `auto`, it resolved to something else, and a *populated* collection exists under a different name, the indexer logs why and exits non-zero. `restart: unless-stopped` brings it back, by which time the provider is usually up. An explicit `EMBEDDINGS_PROVIDER` is always honoured — the test is not 'did the collection change' but 'did anyone ask for this'. `KDB_ALLOW_EMBEDDER_DOWNGRADE=true` is the escape hatch.
- **Surface it.** `embedderStatus()` parses the `active_embedder` setting (which was written and never read by anything) into `{name, model, dim, configured, fallback}`; `/api/dashboard` returns it as `embedderHealth` and the UI shows a dot beside the service list plus a sentence explaining what to do.

**Key Decisions & Rationale:**
- Exit rather than carry on. Continuing would mean either writing 384-dim vectors into a 768 collection (dimension errors) or proceeding with the rebuild, which is the thing being prevented. Exiting is the only option that leaves `active_collection` untouched, and that field is exactly what keeps search working while the indexer is down.
- Only `auto` can trigger the refusal. Asking for `bundled` and getting `bundled` is the system working; reporting that as degraded would train everyone to ignore the flag.
- `embedderHealth`, not `embedder`, on the dashboard: `Stats` already carries `embedder: string` and my object was spread *after* `deps.meta()`, so it would have silently overwritten the footer's value. The type checker caught it.
- Kept the fallback itself. A first boot with no Ollama should still work; what changed is that a fallback can no longer *migrate an existing index*.

**Code/Files Modified:**
- packages/core/src/embeddings/ollama.ts (retry), embeddings/index.ts (embedderStatus), config.ts (allowEmbedderDowngrade)
- packages/indexer/src/pipeline.ts (embedderDowngrade), main.ts (refusal at boot)
- packages/api/src/app.ts + main.ts (embedderHealth), packages/ui/src/types.ts + views/DashboardView.tsx
- test/core/embeddings.test.ts, test/core/embedderStatus.test.ts (new), test/indexer/embedderDowngrade.test.ts (new), test/api/routes.test.ts
- docs/configuration.md, .env.example

**Outcomes & Lessons Learned:**
- **What Worked:** The incident gave the tests their fixtures. Every one of them describes a real observed state rather than an invented one, and the probe test that matters ('survives a transient failure and accepts on a later attempt') failed before the fix in exactly the way the live system did.
- **What Failed:** I nearly shipped a silent API break. Adding `embedder` to the dashboard response would have clobbered `meta().embedder` because of spread order — caught by tsc, not by me, and no test covered the footer's field.
- **Also:** health-as-reachability was the deeper bug. Every service reported running throughout the incident, correctly. Degradation that looks healthy needs a field of its own.
- 805 tests green, lint clean, UI builds.

**Status:**
- Completed
### [2026-07-29] - Improvement: configuration sources — committed defaults, Doppler secrets, .env demoted to override

**Objective:**
- Bring Atlas in line with the operating rule that secrets come from Doppler and everything else from a committed configuration file, with .env only an optional override — and make the stack run with no .env at all.

**Summary of Work:**
- `.env.example` became `config/atlas.defaults.env` (git mv, so history follows), committed and authoritative.
- `docker-compose.yml` reads an ordered `env_file:` list — defaults, then `.env` with `required: false`. The Makefile passes the matching `--env-file` pair on the `COMPOSE` variable so no target can diverge.
- Doppler wraps every container-creating target (`up`, `restart-build`, `restart-mcp`); the two API keys are declared in `environment:` as `${VAR:-}` so the shell (Doppler) outranks the files, and absence is silent.
- `make env` removed; the repo's redundant `.env` retired after verifying every value matched the committed file.
- New `scripts/config-sources.sh` (`make config-check`) and `test/core/configDefaults.test.ts`.

**Key Decisions & Rationale:**
- **Chose the .env format over TOML/JSON/TS.** Compose consumes it natively on both paths it needs, so the design needs no generator and no dependency. Every alternative required a host-side step whose only job was flattening structure back into the flat KEY=VALUE both consumers actually take — and that step would have made `make up` depend on `npm install` on a fresh clone, which it does not today. Comments were the only real advantage TOML had over JSON, and this format has them.
- **Flags on the COMPOSE variable, not on individual targets.** Interpolation feeds the config hash compose uses to decide whether to recreate; a target that omitted them would compute a different service definition and recreate containers nothing had changed.
- **Lazy DOPPLER (`=` not `:=`)** so only the three recipes that use it pay for the probe; otherwise every `make ps` would make a Doppler API round-trip.
- **Did not move DATABASE_URL's credential to Doppler.** It is a fixed local pair for a container-internal database with no port beyond 127.0.0.1; treating it as a secret implies rotation machinery for something unreachable from off-box.

**Code/Files Modified:**
- config/atlas.defaults.env (from .env.example), docker-compose.yml, Makefile
- scripts/config-sources.sh (new), test/core/configDefaults.test.ts (new)
- docs/superpowers/specs/2026-07-29-configuration-sources-design.md, docs/configuration.md, docs/operations.md, docs/getting-started.md, README.md

**Outcomes & Lessons Learned:**
- **What Worked:** Measuring compose rather than trusting its reputation. Six behaviours were verified before the spec was written, and self-review caught two more I had asserted without testing — `--env-file` on a missing path is a hard error (and .env is absent by default, so the unconditional form would break every target on a clean checkout), and an explicit `--env-file` suppresses the implicit ./.env.
- **What Failed:** My Doppler probe was wrong and `make restart-build` died on the first real run. `doppler configure get project --plain` exits **0 with empty output** when no project is configured, so the detection claimed a working session. Fixed by probing the operation itself (`doppler run --command true`) rather than something correlated with it. The lesson generalises: a readiness check should run the thing it is gating.
- **The new coverage test paid for itself immediately** — QDRANT_STORAGE_PATH, KDB_DOCS_AGING_MONTHS and KDB_ARCHIVED_PENALTY are read by config.ts and were documented as configurable, but had never been in .env.example at all. They were reachable only as zod defaults.
- Verified live with no .env present: config reaches the containers, smoke passes 7/7, search unchanged.
- 809 tests green, lint clean, 12/12 compose checks.

**Status:**
- Completed
---
### [2026-07-29] - [Backlog review: derived status + evidence-based review (CLI/MCP/REST)]

**Objective:**
- Make the append-only backlogs readable as state: what is open, what got resolved/dropped, and let user+agents review pending items against the indexed history.

**Summary of Work:**
- parseBacklog v2: free-form undated lines indexed (were silently skipped), structured RESOLVED/DROPPED/REOPENED [L<n>#<hash6>] markers + legacy DONE:/RESOLVED: prefixes tagged, per-line SHA-256 hash stored; BACKLOG_PARSER_VERSION resync with in-place meta sync (dedup-keyed inserts never refresh existing rows).
- buildBacklogView (query-time, docs-staleness pattern): hash-verified ref linking with unique-match relocation, token-containment fuzzy linking for legacy markers (near-ties/low scores -> explicit unlinked bucket, never guessed), verdict overlay with latest-signal-wins, provenance (structured/reviewed/heuristic) + lints (stale-review, not-written-back, broken-link, superseded-marker, unstructured).
- backlog_review table (durable working state, usage_log precedent); REST GET /backlog + POST /backlog/review (evidence + optional Atlas-LLM judge) + POST /backlog/verdict; CLI 'atlas backlog' (+ --review/--item/--limit); MCP atlas_backlog / atlas_backlog_evidence / atlas_backlog_verdict.
- Global kdb-protocol.md: backlog + index.log formats defined (never were — the root cause of marker drift), marker convention, canonical-copy note.

**Key Decisions & Rationale:**
- File is truth: verdicts become durable only as appended marker lines; Atlas proposes the exact line (hash included) but never writes project files. DB loss loses only unapplied verdicts, which honestly revert to open.
- Judge split by caller: CLI -> Atlas LLM (human on the other end); MCP -> evidence bundle, the agent judges (it can read code, Atlas cannot).
- Last marker in file order wins; file order beats parsed dates in an append-only file.
- Design red-teamed by Assessor (session 9fff7d2a…): hash-in-ref, last-wins rule, provenance-labeled fuzzy links, not-written-back badge all trace to that review + self-review.
- ADR: docs/adr/20260729-backlog-status-derivation.md. Spec: docs/superpowers/specs/2026-07-29-backlog-review-design.md.

**Code/Files Modified:**
- packages/core/src/parsers/kdbLog.ts, packages/core/src/backlog.ts (new), packages/core/src/backlogReview.ts (new), packages/core/src/catalog.ts, packages/core/src/config.ts
- packages/indexer/src/pipeline.ts, packages/api/src/app.ts, packages/api/src/main.ts, packages/cli/src/main.ts, packages/mcp/src/tools.ts
- test/core/kdbLog.test.ts, test/core/backlog.test.ts (new), test/api/routes.test.ts, test/mcp/tools.test.ts
- config/atlas.defaults.env, docs/api.md, docs/cli.md, docs/mcp.md, ~/.claude/references/kdb-protocol.md

**Outcomes & Lessons Learned:**
- **What Worked:** TDD end-to-end (846 tests green); reusing the docs-staleness scan/query split and the DOCS_PARSER_VERSION backfill pattern made the indexer change small and safe.
- **What Failed:** first fuzzy-matching design used Jaccard similarity — a short DONE: summary vs a long original scores ~0.16 and misses; token containment (share of the summary's tokens found in the item, light suffix stemming) is the right asymmetric measure.

**Status:**
- Completed
---
### [2026-07-29] - Close the remaining embedder-downgrade paths; review the backlog feature against its own backlog

**Objective:**
- Establish whether `make restart-build` under host load can still downgrade the embedder and rebuild the index on the CPU model, and review the new backlog review feature.

**Summary of Work:**
- Root-caused the surviving downgrade path: `ollamaAvailable` retries since bdcc4f3, but `createOllamaProvider` still ended with ONE unretried `/api/embed` to learn the dimension, and `autoSelect` reads a throw from it as "no Ollama". It is the slowest boot call because it pays the model's cold load — measured 13.4s cold at load 18.8 vs 0.23s warm, with indexing batches logged at 45.2s that survive only because `pipeline.ts` wraps them in `withRetry`. Wrapped it, with its own longer ceiling (90s) and 4xx still fatal on the first attempt.
- A failed `ollamaPull` no longer decides anything: `ollamaHasModel` is one unretried 5s call that answers "absent" about installed models under load, so the dimension probe is now the judge.
- The API had NO guard and no log line. It resolves its own embedder in its own process, and `restart-build` recreates it alongside the indexer so both race the same loaded host. A 384-dim API against the 768-dim collection is silent: Qdrant rejects the dense query, `SearchService` catches it alongside "Qdrant is down", every search drops to the ~12s Postgres scan, and `/api/dashboard` still shows ollama/768 because `embedderHealth` reads what the INDEXER wrote about itself. Added `embedderServesCollection` (identity, not dimension — two models can share 768 and embed into unrelated spaces, which Qdrant answers with confident nonsense), refusal to sparse-only, a boot log line, five-minute self-heal, and `serving`/`searchDegraded` on the dashboard + UI.
- `make restart-build` was manufacturing its own failure: the build saturates the host, then compose starts containers at that peak. Split build from recreate and warm the model between them (`make embedder-warm`, never fatal).
- Found while verifying, unrelated to the above: 48 retained FAILED scan jobs were blocking every source from rescanning. `removeOnComplete: true` was already fixed for the same reason, with `removeOnFail: 500` on the next line reserving the identical deterministic id. A Postgres restart on 07-26 failed one job per source; every project except deepcast then stopped indexing for three days while the scheduler logged "140 scan jobs enqueued" a tick. Released on failure now, plus a boot clean that frees ids already held.
- Backlog parser-version stamp was written unconditionally after a scan that embeds, so a loaded boot could fail the backlog file and still record the resync done — and it gets one chance before `fileChanged` says "no" forever. Stamped only on a clean pass, like `sparse_version`.
- Reviewed the backlog feature by running it against this repo's own backlog. Fixed: `hydrate` returned one hit per Qdrant POINT so an entry with several matching chunks came back several times (live: 8 hits / 6 distinct, and the judge prompt renders one block per hit, so repetition read as corroboration); `proposeMarkerLine` emitted caller text verbatim into a file defined as one physical line per item (a newline would have split the marker and shifted every line below it) and cut mid-word; the confirmed-resolved path discarded the reviewer's note that the explicit `propose` path already preferred; and a same-day verdict outranked a same-day marker because markers are dated and verdicts timestamped, inverting the contract that the file is canonical.

**Key Decisions & Rationale:**
- The probe gets a LONGER timeout, against the rule `EMBED_TIMEOUT_MS` states. That rule is about steady state, where a long ceiling turns a fast retryable failure into a silent stall. The boot probe's alternative to waiting is not a fast retry, it is re-embedding the catalog on a worse model, so it is allowed to be patient once per boot.
- A mismatched API embedder becomes `null` rather than fatal. Exiting would take down search, MCP and the UI; `null` keeps the sparse branch, which queries the real collection and is honestly labelled `sparse-only` — strictly better than today's dense-rejection-to-FTS.
- Collection identity, not dimension, is the serving test. Equal dimensions from different models are the dangerous case: Qdrant returns 200.
- Verdict-vs-marker ties go to the FILE. The marker line is the canonical durable record and the verdict table is working state; a reviewer appending REOPENED must not be overruled by a verdict recorded earlier the same day.
- Deferred rather than fixed (backlogged): line-keyed view collapses two generations of rows after a rotation (verified unreachable today); evidence retrieval does not surface the commit that resolved an item even when indexed and vectorized; unlinked markers with zero candidates read as ambiguous when nothing exists to link.

**Code/Files Modified:**
- packages/core/src/embeddings/ollama.ts
- packages/core/src/embeddings/index.ts
- packages/core/src/search.ts
- packages/core/src/backlog.ts
- packages/api/src/main.ts
- packages/api/src/app.ts
- packages/indexer/src/main.ts
- packages/indexer/src/pipeline.ts
- packages/indexer/src/scheduler.ts
- packages/ui/src/types.ts
- packages/ui/src/views/DashboardView.tsx
- Makefile
- test/core/embeddings.test.ts, test/core/embedderServing.test.ts, test/core/search.test.ts, test/core/backlog.test.ts, test/api/routes.test.ts, test/indexer/scanBacklog.test.ts, test/indexer/scheduler.test.ts

**Outcomes & Lessons Learned:**
- **What Worked:** Two `make restart-build` runs at host load 17 and 6.7 both came up `ollama/nomic-embed-text dim=768` on indexer AND api, with `active_collection` unchanged. Boot released 48 stuck job ids and the blocked projects resumed indexing (kdb rescanned after three days; backlog entries 37 to 43 as the parser-version resync landed, all with lineHash, 8 markers detected). A Postgres restart at 19:36 UTC — the same event that caused the original outage — left ZERO stuck jobs, so the queue fix has been exercised by the real failure. Evidence bundles went 8 hits/6 distinct to 8/8, the two freed slots pulling in entries previously crowded out. The full write-back loop was dogfooded: derive to review to verdict to proposed line to blessed append to reindex, and L41 flipped to resolved via a hash-verified `ref` link, the hash matching an independent recomputation.
- **What Failed:** Assumed the `stale-review` lint degenerated to always-on; measuring it showed `latestActivityAt` is a content timestamp while a review is stamped at wall-clock now, so a fresh verdict is normally newer — the lint is correct as written and was left alone. First attempt at the resync test used an embed failure, which sat through five `withRetry` attempts and timed out; failing at the upsert exercises the same abort in milliseconds. The first changelog line was appended without brackets round the timestamp and does not parse — inert, and the log is append-only, so a correctly-formatted line was appended after it.
- **Not deployed:** the verdict-precedence fix (commit 0ec0027) is committed but NOT running. A concurrent session checked out `feature/usage-monitoring` mid-task and its in-progress refactor leaves the shared tree failing `tsc`, so rebuilding would have deployed someone else's broken code onto a working stack.

**Status:**
- Completed
---
### [2026-07-29 21:20 UTC] — Usage monitoring: log every call, keep the reply, show it

**What changed:**
- Every `/api/*` request is now recorded, polling included. The old rule (only `x-atlas-client` callers) kept `usage_log` clean by making the user's own use of Atlas invisible — a poor trade for a tool whose subject is what happened.
- New `usage_log.route_class` (`query|read|write|status|admin|other`) from a pure `routeClass(path)` in `core/src/usage.ts`. Classifies the ROUTE, never the intent: nothing can honestly say whether a timer or a human hit `/api/dashboard`. Noise is separated at READ time (UI hides `status`/`admin`).
- New 1:1 `usage_reply` table (`ON DELETE CASCADE`): full answer, result count, top 5 hits, served model, prompt/completion tokens, TTFT, degraded flag, real error message. Separate table because ~95% of rows (reads, polls, health) have no reply and a mostly-null TEXT column would be dragged through every aggregate on the hot table.
- `catalog.recordCall(call, reply?)` writes both rows in ONE data-modifying CTE — atomic by definition, one round trip, and it keeps the existing fake-pool test harness usable (an explicit transaction would need `pool.connect()`).
- `/api/ask/stream` records ITSELF (`usageDeferred` flag skips the middleware). It also records on **cancel**, so an aborted answer is kept with its partial prose at `status 499`.
- `chatCompleteWithUsage()` in `llm.ts`; `chatComplete` delegates to it, so all four existing call sites are untouched. `AskResult.metrics` now populated on the buffered path.
- Adoption moved from CLI-only to a `trigger:'adoption'` job on the existing scan queue, cached in `settings` under `adoption.report` (200-session cap), served by `GET /api/admin/adoption`.
- New Monitor view (rail item 6, hotkey 6) with Overview/Calls/Adoption tabs; `components/charts.tsx` primitives (`Bars`, `Sparkline`, `HourStrip`, `StatTile`, `ShareBar`, `LatencyPair`) built from SVG + CSS custom properties — zero new dependencies.
- `make usage-prune DAYS=n` and `make usage-resync`. Config SSoT: `KDB_USAGE_PAGE_SIZE`, `KDB_ADOPTION_REFRESH_MIN`, `KDB_USAGE_RETENTION_DAYS`.

**Why it is built this way:**
- **The middleware cannot see a streamed reply.** It measures around `await next()`, which for `/api/ask/stream` resolves the moment the ReadableStream is handed back — before a single token exists. Left to it, a 34-second answer logs ~10ms of time-to-headers and the text is unreachable. Verified: an aborted stream recorded 3998ms and 1097 chars of partial answer.
- **The API container cannot see the transcripts.** `docker-compose.yml:16` mounts `~/.claude/projects` into the indexer alone, so an adoption route served from the API would have found an empty tree and reported zero sessions — a confident, wrong answer. Measured scan: 121s over 4445 sessions; serving that per request would hang every page load for two minutes.
- **Token costs for agent asks were being discarded.** `chatComplete` receives the OpenAI-compatible `usage` object and types it away (declared only `{ choices }`), so MCP asks — most real asks — had no cost data while UI asks had full metrics. The data was always on the wire.
- **Storing a derived column is safe because it is resyncable.** `route_class` is a pure function of the stored `path`; `resyncRouteClasses()` reclassified all 189 pre-existing rows out of `other` on first run (verified: `other` went to 0). Same pattern as the backlog parser-version resync.
- **Percentiles, not just averages.** `atlas_search` averages 2245ms against a 1806ms median with one 31.9s call — the mean is what a single outlier eats.
- Rejected: `usage_reply.kind` (duplicates `usage_log.path`, free to disagree with it); an hour×weekday heatmap (168 cells over ~185 monthly calls averages ~1/cell — a chart the data cannot fill, replaced by a 24-cell hour strip); a charting library (the palette is semantic, so a library would be themed toward what hand-rolled marks already are); middleware-INSERT-then-UPDATE (races: the write is fire-and-forget and unordered).

**Code/Files Modified:**
- packages/core/src/usage.ts (new), packages/core/src/catalog.ts, packages/core/src/llm.ts, packages/core/src/ask.ts, packages/core/src/types.ts, packages/core/src/adoption.ts, packages/core/src/config.ts, packages/core/src/index.ts
- packages/api/src/app.ts, packages/api/src/main.ts, packages/indexer/src/main.ts
- packages/ui/src/views/MonitorView.tsx (new), packages/ui/src/components/charts.tsx (new), packages/ui/src/components/Sidebar.tsx, packages/ui/src/App.tsx, packages/ui/src/api.ts, packages/ui/src/types.ts, packages/ui/src/format.ts
- test/core/usageRouteClass.test.ts (new), test/core/llmUsage.test.ts (new), test/ui/charts.test.tsx (new), test/core/insertEntries.test.ts
- Makefile, config/atlas.defaults.env, docs/api.md
- Spec: docs/superpowers/specs/2026-07-29-atlas-usage-monitoring-design.md. ADR: docs/adr/20260729-usage-telemetry-and-reply-capture.md

**Outcomes & Lessons Learned:**
- **What Worked:** checking feasibility BEFORE writing the spec caught both structural constraints (no transcript mount; middleware blind to streams) while they were still cheap design decisions rather than late rewrites. The config-coverage test earned its keep again — it failed immediately on three env vars added to `config.ts` but not to `atlas.defaults.env`.
- **What Failed:** the first design claimed per-ask token costs came "free" from `AskMetrics`. True only for the UI's streaming path; the buffered route MCP actually uses had none. Caught in self-review by reading `chatComplete`'s return type rather than trusting the earlier claim.
- **Verified:** 923 tests / 70 files green; lint clean; live stack — schema applied, search reply captured (5 hits), buffered ask captured (gemini-3-flash-preview, 2739/425 tokens, 1704-char answer), stream abort captured (499, 3998ms, 1097 chars), resync reclassified 189 rows, adoption computed 4445 sessions. UI builds and the Monitor view is present in the served bundle; **not** visually inspected in a browser (extension unavailable).
- **Findings for the user:** Atlas fire rate is 0.119 — agents call it in only 12% of sessions where a documented trigger fired (top miss `why-after-lookup`, 158). Assessor is 0.431.

**Status:**
- Completed
---
### [2026-07-29 22:10 UTC] — Streamed asks: a failed answer was being recorded as a clean success

**What changed:**
- `/api/ask/stream` now handles the `error` event it was silently ignoring. Previously an errored stream fell through to `controller.close()` and recorded `status 200` with an empty answer — a successful-looking ask that returned nothing, and invisible in the error rate computed from `status >= 400`.
- Added a `try/catch` around `events.next()`. A throw out of the generator errors the stream, and `cancel` does NOT fire for an errored stream, so the single failure mode most worth recording previously wrote **no row at all**.
- New `STATUS_STREAM_FAILED = 500` beside `STATUS_CLIENT_ABORTED = 499`, both documented as outcome codes rather than wire statuses: the route flushes 200 headers before it knows whether the answer will succeed. `degraded` stays 200 — a success with a poor answer is not an error.
- A client that disconnects before any event now produces a call row with **no** reply row, instead of a reply row of all-nulls that renders as "answered with nothing".
- Six new tests covering every way a stream can end: completed (with served model + tokens), error event, generator throw, degraded, nothing-produced, and a deterministic cancel that asserts the partial answer is kept and the generator is torn down.

**Why it is built this way:**
- Found while verifying the earlier abort measurement was genuine and not masking an Atlas fault. Postgres was interrupted mid-test, Atlas correctly emitted `{"type":"error"}` — and that exposed that the telemetry would have filed it as a 200. The incident was the test.
- The abort path itself was **not** regressed: verified by a deterministic consumer-cancel test (partial answer kept, `resultCount` kept, `499`, generator torn down so no LLM tokens keep burning). Live 4s/9s kills captured nothing only because they landed during retrieval, before any `sources` event existed — answers here complete in ~5-7s. Racing a live LLM for that window produces a test that passes for the wrong reason.
- Postgres `"database system was interrupted"` is a pre-existing environmental pattern on this machine (2026-07-27 15:20, 07-29 14:33, 19:37, 21:50 — the first two predate this work). No PANIC, no OOM, no query error: it is abrupt container/VM termination, which no SQL in this change can cause. Data survived intact.

**Code/Files Modified:**
- packages/api/src/app.ts, packages/core/src/usage.ts
- test/api/routes.test.ts (six new cases)
- docs/api.md (outcome-code table), docs/adr/20260729-usage-telemetry-and-reply-capture.md

**Outcomes & Lessons Learned:**
- **What Worked:** being asked to prove a green result was genuine. The 499/3998ms/1097-chars measurement was correct, but the code path one branch away was not, and only re-reading the event handling with intent to disprove found it.
- **What Failed:** I verified the abort path live and the completed path only via unit tests, then reported the feature as verified. The completed path had never run end to end — the first real attempt hit the Postgres outage. Test the *ordinary* path live, not only the interesting one.
- **Verified:** 928 tests / 70 files green; lint clean; live — completed stream 200/5304ms/gemini-2.5-flash-lite/147 tok/TTFT 1880ms/340-char answer; a second completed stream 200/7221ms/12 sources; aborts recorded at 499 with accurate durations.

**Status:**
- Completed
---
### [2026-07-30 00:25 UTC] — Monitor: noise filter, decoded queries, filters, Stats tab, infinite scroll

**What changed:**
- **Noise filter**, default on: `hideNoise` drops `/api/projects` (the scope bar refetching its list) and any call with no query text. Measured on real data: 744 calls -> 118.
- **Decoded queries**: `describeQuery()` splits the `query` column's two shapes apart — a raw URL query string from GET routes, prose from POST ask — and renders the first as its search text plus filter chips. The raw string stays available in the drawer behind a disclosure.
- **Top stats** on Calls: counts by client and by type, computed server-side over the same WHERE clause as the rows.
- **New Stats tab**: outcome rates (searches returning nothing, asks with no sources, aborted, degraded/failed), per-mode latency and token figures, a log-scaled latency histogram, which models actually answered, weekday spread, and the most-repeated questions.
- **Filters**: relative range (24h/7d/4w/3m) or an absolute from/to pair, plus client, tool, status and free text — all server-side.
- **Infinite scroll** via IntersectionObserver with a 400px `rootMargin`, replacing pages.
- Split MonitorView into `views/monitor/{Filters,CallsTab,StatsTab,CallDrawer,useCallFeed}` — it had reached ~950 lines holding a table, a drawer, three charts and a control panel.

**Why it is built this way:**
- **Keyset cursor, not OFFSET.** This table gains rows continuously, so an offset page is measured from a top that has moved: page 2 re-serves rows already shown and skips others. Verified live — `total` grew 120 -> 121 mid-scroll (the monitor logging its own requests) and 120 rows across 5 pages came back with zero duplicates.
- **Noise filter and facets in SQL, not the browser.** Filtering after the fetch would make `total` and the facet counts describe a different population from the rows beneath them, and every scroll page would return an unpredictable number of visible rows — sometimes zero, which reads as "the end".
- **`looksLikeQueryString` requires a leading `identifier=`,** not merely a `=` anywhere: a real question can contain one ("what does k=12 do?"), and decoding prose would rewrite every `+` in it into a space.
- **Absolute range end is exclusive midnight of the day after `to`.** A naive `to` bound returns nothing for a same-day range, because every call that day happened after 00:00.
- **Stale responses lose**, via a generation counter checked on arrival: changing a filter mid-flight must not let the previous request's rows land on the new list. Append also de-duplicates by id rather than trusting the cursor.
- **Latency buckets are reordered client-side** from `LATENCY_BUCKETS`: SQL groups by bucket and returns them arbitrarily (observed: `10-30s` first), and a distribution with a shuffled x-axis is not a distribution. Buckets are log-ish because latency spans 1ms to 95s — equal-width buckets put everything in one.
- **Stats leads with rates, not volume.** A busy week of searches that all returned nothing charts identically to a week that answered everything; `zeroResult` and `zeroSource` are the difference.
- `Rate`'s `tone` is the caller's judgment, not the component's: the same 40% is bad for zero-results and good for completions.

**Code/Files Modified:**
- packages/core/src/catalog.ts (cursor paging, facets, `usageInsights`), packages/core/src/usage.ts (query/page/insight types, `LATENCY_BUCKETS`)
- packages/api/src/app.ts (`hideNoise`, cursor params, insights route, `usagePageSize` dep), packages/api/src/main.ts
- packages/ui/src/describeQuery.ts (new), packages/ui/src/dateRange.ts (new)
- packages/ui/src/views/monitor/{Filters,CallsTab,StatsTab,CallDrawer,useCallFeed} (new), packages/ui/src/views/MonitorView.tsx, packages/ui/src/components/charts.tsx (`BarList`, `Histogram`, `Rate`), packages/ui/src/{api,types}.ts
- test/ui/describeQuery.test.ts (new, 13), test/ui/dateRange.test.ts (new, 15), test/api/routes.test.ts
- docs/api.md

**Outcomes & Lessons Learned:**
- **What Worked:** putting the two decision-heavy pieces (query decoding, date ranges) in pure modules and testing them first. Every interesting case — an encoded `+`, a question containing `=`, a single-day range — is a one-line test rather than something to click through.
- **What Failed:** my first live check of cursor paging asserted ids descend, which failed. The ORDER BY is `at DESC, id DESC`, and `now()` is transaction-start while `nextval()` is assigned during execution, so under concurrency the two can disagree (2 disagreements in 120 rows). The assertion was wrong, not the query — verified separately that `at` is strictly descending.
- **Found while verifying:** three different models served answers in the same window (`gemini-2.5-flash`, `google/gemini-2.5-flash-lite`, `gemini-3-flash-preview`). The gateway substitutes by routing policy; the Stats tab now says so rather than letting it read as a misconfiguration.
- **Verified:** 957 tests / 72 files green; lint clean; live — noise filter 744->118, 5-page cursor walk with no duplicates under concurrent insertion, insights endpoint returning real rates (ask p50 17.5s, 3 aborted, 1 degraded, 0 searches with zero results), every new string present in the served bundle. **Not** visually inspected in a browser (extension unavailable).

**Status:**
- Completed
---
### [2026-07-30 00:40 UTC] — The buffered ask path recorded the model we asked for, not the one that answered

**What changed:**
- `chatCompleteWithUsage` now reads the gateway's `x-g2p-reply-model` **response header** instead of `model` from the response body. It also captures `x-g2p-reply-attempts` and `x-request-id`.
- New `readGatewayMeta(headers)` in `llm.ts`, shared by the buffered and streaming paths. `chatStream` was rewritten to use it, replacing its own inline header reads.
- New `isSubstitution(served, requested)` + exported `bareModel`, now the single implementation. `toMetrics` (streaming) and `ask()` (buffered) both call it; `ask()` previously compared raw strings and `bareModel` was private to ask.ts.
- New nullable `usage_reply.attempts` and `usage_reply.request_id`. The drawer shows the served model with an "N attempts" badge when the gateway failed over, and the request id as selectable text.
- `LlmUsage` deliberately carries no `substituted` flag: judging it needs the *configured* model as the baseline, which only the caller has.

**Why it is built this way:**
- **The body's `model` is not authoritative.** A routing gateway picks the model by policy and the upstream echoes back whatever name it was given, so the body frequently reports the requested model. Only `x-g2p-reply-model` names what actually ran, provider-qualified. Reading the body attributes an answer to a model that may never have seen the question — exactly the substitution the record exists to expose.
- **The two paths had drifted, and only one was right.** The streaming path read the header from the start (documented in api.md on 2026-07-12); the buffered path — which MCP uses, and therefore most real asks — was added later reading the body. One shared helper now makes the drift impossible.
- **Substitution must be compared on the bare name.** The gateway answers `google/gemma-4-31b-it` for a configured `gemma-4-31b-it`: same model, provider-qualified route, not a swap. My first version compared raw strings against the body model — wrong baseline AND wrong comparison, which would have flagged a routing event on essentially every call.
- Header reads happen *before* the body is parsed, so telemetry does not depend on the JSON succeeding, and `readGatewayMeta` never throws — a provider or stub without headers costs the metrics, not the answer.

**Code/Files Modified:**
- packages/core/src/llm.ts (`readGatewayMeta`, `bareModel`, `isSubstitution`, header-first read), packages/core/src/ask.ts, packages/core/src/catalog.ts (two columns + write/read), packages/core/src/usage.ts
- packages/api/src/app.ts (both ask paths pass attempts/requestId), packages/ui/src/views/monitor/CallDrawer.tsx, packages/ui/src/types.ts
- test/core/llmUsage.test.ts (+6: header wins over body, fallback when absent, attempts/request id, NaN attempts, no-headers response), test/core/insertEntries.test.ts

**Outcomes & Lessons Learned:**
- **What Worked:** the user caught this from a single observation in the Stats tab — three model names in one window, one of them lacking the vendor prefix the others had. The inconsistency in the *data* was the tell that the two code paths disagreed.
- **What Failed:** twice in this change, and the same way each time. First I read the model from the body because the OpenAI response shape has a `model` field and it looked authoritative. Then, fixing it, I computed `substituted` locally against that same body field with a raw string compare — reproducing the bug I was fixing, one field over. The existing test named "does not flag a vendor-prefixed name as a substitution" is what exposed it; the repo had already learned this lesson and written it down.
- **Also failed:** positional param assertions in the write-path tests broke twice as columns were appended. Rewritten to locate values by content, and the guard param is now documented as always-last.
- **Verified:** 962 tests / 72 files green; lint clean; live — same `/api/ask` route recorded `gemini-3-flash-preview` (id 443, before) and `google/gemini-3-flash-preview` (id 875, after) with attempts=1 and request_id `345d0f40-…`.

**Status:**
- Completed

### [2026-07-30] - Qdrant memory: the on_disk half of the 2026-07-15 quantization work

**Objective:**
- User reported Qdrant peaking over 2.5GB in OrbStack and asked for lowest memory first, then speed, with an absolute constraint of no data loss or corruption.

**Summary of Work:**
- Root cause: `always_ram: true` on the quantization config was read as "originals go to disk". It never meant that — it pins only the *quantized* copy. Where the fp32 originals live is `vectors.dense.on_disk`, which was never set and defaults to RAM. So the 2026-07-15 change added a ~290MB int8 copy *alongside* the ~1.1GB of fp32 vectors instead of replacing it, and the collection carried both for two weeks. Confirmed on disk: every segment reported `storage_type: InRamChunkedMmap`, and `smaps_rollup` showed 707MB of Qdrant's 730MB RSS as `Anonymous`/`Private_Dirty` — unreclaimable RAM, not page cache.
- Set `vectors.dense.on_disk: true` and `sparse_vectors.sparse.index.on_disk: true`; both converted in place, no re-embed (dense ~40s, sparse ~60s, point count unchanged throughout).
- Found a second, silent defect the first change would have introduced: Qdrant's default for quantization `rescore` flips to OFF once the originals are on disk, trading recall for a saved disk read without saying so. Added explicit `SEARCH_PARAMS = {quantization: {rescore: true}}` to both the fused and raw-cosine query paths.
- `ensureQuantized()` -> `ensureStorageLayout()`, and the indexer's one-shot marker went from a `!== 'v1'` boolean to a versioned `!== 'v2'` check, so collections already stamped by the quantization-only pass still get converted.
- `max_optimization_threads: 2` to bound the optimizer spike, and `QDRANT__STORAGE__ASYNC_SCORER=true` on the container for io_uring on the new on-disk read path.
- Snapshot taken and checksum-verified on the host before any change (`/Users/nasta/atlas-backups/`, 2,005,958,144 bytes, sha256 matched Qdrant's own).

**Key Decisions & Rationale:**
- HNSW graph deliberately stays in RAM (`hnsw_config.on_disk: false`). It is ~31MB and every query walks it — it is the wrong thing to put on disk. The vectors are the right thing, because only rescoring reads them.
- Kept `rescore: true` despite a measured cost, because the alternative is losing recall silently. Interleaved A/B put the cost at +224ms/query before async_scorer and +85ms after; the recall it buys is 0.956 -> 0.992.
- `max_optimization_threads: 2` rather than 1: the second job costs ~60MB, noise against the 1.1GB saved, while a single thread would halve throughput on the multi-hour re-embed/re-tokenise passes — and this repo has already been bitten by an optimizer that could not keep up (see `setIndexingThreshold`).
- Left the payload indexes alone. Arithmetic said they were already off-heap (364MB anon ~= 290MB int8 + 31MB HNSW + runtime), so the delete/recreate churn would have bought nothing and risked a window where `occurred_at` range filters fell back to a 3.11s full scan.

**Code/Files Modified:**
- packages/core/src/qdrant.ts (VECTORS, SPARSE_VECTORS, SEARCH_PARAMS, OPTIMIZERS, ensure, ensureStorageLayout, query, queryDense)
- packages/indexer/src/main.ts (versioned storage-layout marker)
- docker-compose.yml (QDRANT__STORAGE__ASYNC_SCORER)
- docs/configuration.md (Qdrant memory layout section + both traps)
- test/core/qdrantStorage.test.ts (new, 8 tests)

**Outcomes & Lessons Learned:**
- **What Worked:** container peak 2,275 MiB -> 747 MiB (-67%) measured across a clean restart, steady resident ~600MB allocator-held. Points grew 376,455 -> 377,691 across the whole operation with zero loss. recall@10 against an exact full-precision scan is 0.992, reproduced in two runs hours apart. async_scorer cut the rescore cost 2.6x (+224ms -> +85ms paired median). 970/970 tests, lint clean, 12/12 config checks, 7/7 smoke.
- **What Failed:** my first regression check was a before/after diff of live search results, which was worthless — the index is a moving target and this very session was being indexed into it mid-comparison (one of the shifted hits was my own prompt). Replaced with recall@10 against Qdrant's own exact scan, which is an absolute measure and does not care that the corpus grew. Also mis-measured latency twice: first by interleaving brute-force scans that evicted the page cache the ANN path had just warmed, then by reading `docker logs` after a restart without realising it still contains the pre-restart lines.
- **Lesson:** a config flag whose default *changes based on another flag* is the dangerous kind. `rescore` defaulting to off once vectors are on disk means the obvious memory fix silently degrades quality, and nothing logs it. Both traps are now pinned by tests asserting on the request, because the symptom is unobservable without ground truth.

**Status:**
- Completed
---
### [2026-08-01] - Search & Ask composer goes multi-line, and Atlas stops landing on the Overview

**Objective:**
- User reported the Search & Ask field is a one-line input, which is bad UX for the long questions Ask exists to answer, and asked for a larger multi-line textarea. Second ask in the same session: land on Search & Ask instead of the Overview, "which is slow", with a settings menu in the rail to change that back.

**Summary of Work:**
- The composer at the top of Search & Ask is now a `<textarea>` in BOTH modes rather than an `<input>`. Only the floor changes with mode: Ask opens at `min-h-[4.5rem]` (three lines), Search stays at its natural one line. `field-sizing-content` does the growing in CSS — no scrollHeight measurement — and it stops at `max-h-60` and scrolls.
- Enter sends / Shift+Enter newlines, via a new shared `submitOnEnter` in components/ui.tsx that the follow-up `AskComposer` also adopts. The two fields had different submit code; they now cannot drift.
- Landing view is Search & Ask, persisted as `atlas.startView` and changeable from a new SettingsMenu in the rail's footer (radio group, writes on click, opens upward).
- The VIEWS list moved out of Sidebar.tsx into a new nav.ts, now that the rail, the settings menu and the start-view validator all need it.
- Click-away/Escape popover logic extracted from MultiSelect into a `useClickAway` hook, shared with the new menu.

**Key Decisions & Rationale:**
- ONE textarea for both modes, never an input swapped for a textarea: changing element type remounts the node, which drops focus and caret position for anyone who flips mode mid-sentence. Pinned by a test asserting the node identity across the switch.
- The persisted start view is read ONCE at mount (`useState(() => …)`), not synced. Rewriting `view` whenever the preference changes would teleport the user out of whatever they were reading at the moment they set it.
- The stored value is validated against the known view keys. App renders views as six independent `view === '…'` checks with no fallback arm, so an unrecognised value — a renamed view, a hand-edited localStorage entry — would paint a blank page with no error rather than fail loudly.
- `useClickAway` consumes Escape with `stopPropagation`. App has a window-level Escape that backs out of an open session; document listeners run before window ones, so an open popover takes the key and the view underneath stays put. Without this, one keystroke would have closed two layers.
- Search collapses whitespace in the query (`\s+` -> ' '), Ask does not. Paragraph structure is meaning to an LLM; to a tsquery it is noise.
- `isComposing` guard on the submit handler: with an IME, Enter commits the candidate being composed, and sending on that keystroke fires the question mid-word. The pre-existing AskComposer handler lacked this and inherits the fix.
- Settings live in the rail footer, not as a seventh view — they are not a way of looking at your projects.

**Code/Files Modified:**
- packages/ui/src/nav.ts (new: View, VIEWS, isView)
- packages/ui/src/useClickAway.ts (new)
- packages/ui/src/components/SettingsMenu.tsx (new)
- packages/ui/src/components/ui.tsx (submitOnEnter; MultiSelect uses useClickAway)
- packages/ui/src/components/Sidebar.tsx (VIEWS moved out; startView props; menu in footer)
- packages/ui/src/App.tsx (atlas.startView preference, validated; searchRef -> HTMLTextAreaElement)
- packages/ui/src/views/SearchView.tsx (textarea composer, whitespace collapse, items-end row)
- packages/ui/src/views/AskConversation.tsx (AskComposer uses submitOnEnter)
- test/ui/searchComposer.test.tsx (new, 7), test/ui/settingsMenu.test.tsx (new, 5), test/ui/app.test.tsx (3 new + 3 rewritten)

**Outcomes & Lessons Learned:**
- **What Worked:** 985/985 tests, lint clean. Verified against the deployed bundle rather than the source: the JS carries the new code and, more to the point, the CSS actually contains `field-sizing:content` and `.min-h-\[4\.5rem\]{min-height:4.5rem}` — an arbitrary Tailwind value that failed to generate would have left the field silently one line tall with every test still green.
- **What Failed:** could not confirm the rendered layout visually. The Chrome extension is not connected in this session and headless Chrome is blocked by the sandbox (hung, then exit 127), so the pixel result — how the growing box sits against the Search/Ask button — is unverified by me and left to the user.
- **Lesson:** the tests worth writing here were the ones about the *keystroke*, not the markup. `fireEvent.keyDown` returns false when a handler called preventDefault, which is exactly the question "did the field swallow the newline?" — so Enter-sends and Shift+Enter-inserts are both directly assertable in jsdom without simulating text entry.
- **Lesson:** three tests in app.test.tsx encoded the OLD landing view, one of them by name ("lands on the overview, not on an empty search box") with the reasoning in its docstring. A test that states an intent is the thing you rewrite deliberately, not delete — the replacement now carries why the intent changed (the overview blocks on /api/dashboard introspecting storage and the vector collection).

**Status:**
- Completed
---
---
### [2026-08-14] - qdrant max_segment_size was in the wrong unit, and 64% of the payload index was empty padding

**Objective:**
- Review the (stopped) Atlas qdrant container for lowest memory usage, as part of a three-stack Qdrant memory pass (DeepCast, Lycos, Atlas).

**Summary of Work:**
- Measured the live store read-only from the OrbStack volume: 560,694 points across **23 segments**, 1.41 GB on disk, ~642 MB of load-time-resident structures (payload indexes 600.2 MB, id trackers 16.3 MB, payload-storage trackers 25.9 MB).
- **FOUND A UNITS BUG.** `OPTIMIZERS.max_segment_size` read `64_000` with the comment "~64k vectors per segment". Qdrant measures that field in KILOBYTES against a 256-dimension reference vector ("1Kb = 1 vector of size 256"), so the vector count is `max_segment_size / (dim / 256)`. At 768 dimensions each vector bills 3 KB, so it bought ~21,333 vectors per segment — a THIRD of the intent. Predicted 21.3k vs measured 24,378 points/segment, which is the confirmation.
- **WHY THAT IS EXPENSIVE, which is the non-obvious half:** several per-segment structures are FIXED SIZE regardless of how few points a segment holds. Each indexed field's null-index allocates two 1 MiB `flags_a.dat` mmaps (`has_values` and `is_null`) — verified byte-exact at 1,048,576 each — i.e. 2 MiB per field per segment whether the segment holds 24k points or 200k. With 8 indexed fields over 23 segments that is **385.9 MB of padding against 214.3 MB of real index data: 64% of the entire payload index**. The real bitset for 24k points is ~3 KB, so those files are >99% empty.
- Fixed to `192_000` (= 64_000 x 768/256, the number the comment always described). Expected ~8 segments and ~134 MB of null padding, i.e. roughly 250 MB off a 642 MB resident footprint, with no data rewritten.
- Added the resource limits and flush budget the container never had: `mem_limit: 4g`, `memswap_limit: 6g` (2g swap cushion), `stop_grace_period: 60s`.

**Key Decisions & Rationale:**
- **Explicitly did NOT add `QDRANT__STORAGE__LOW_MEMORY_MODE` here**, and left a comment saying why. It is the right lever on DeepCast and Lycos (both had every payload index pinned and nothing deliberate about it) and the WRONG one here: `no_resident` loads quantization "as if always_ram = false", and this collection sets `always_ram: true` on purpose — the int8 copy in RAM plus fp32 originals on disk IS the 2026-07-30 design. The mode would have silently undone the half of that work the stack depends on. Segment count is the equivalent lever here.
- The memory limit is a SAFETY BOUND, not a target, and the comment says so: a cgroup limit is not a reservation and does not reduce usage on its own. 4g is generous against a measured sub-1 GB steady state because the 2026-07-30 mass storage conversion peaked at 5.65 GiB; `max_optimization_threads: 2` bounds that now, but a future bulk re-embed or `ensureStorageLayout` conversion is the one thing that could press it. Better to raise it for that pass than to live high.
- An unbounded container was the actual hazard, not the size of the number: it cannot be OOM-killed for its own overrun, so the VM-wide killer picks a different victim and the real offender stays invisible. This box is shared with the DeepCast stack.
- `stop_grace_period` was absent, so docker's 10s default applied — the condition that cost Lycos ~1,085 points on 2026-08-01 when a SIGKILL landed mid-flush. 1.4 GB is small enough that 60s is generous rather than marginal, and it costs a healthy stop nothing.
- The guard asserts the DERIVATION (`64_000 * (dim / 256)`), not the literal `192_000`, so it fails if the embedding dimension ever moves and the constant is carried over unchanged. That is the bug class, not the value.

**Code/Files Modified:**
- packages/core/src/qdrant.ts
- docker-compose.yml
- test/core/qdrantStorage.test.ts

**Outcomes & Lessons Learned:**
- **What Worked:** measuring the volume before reading the config. The 23-segment count was the visible symptom and it is what made the units comment testable — "~64k vectors" and 24,378 points/segment cannot both be true.
- **What Worked:** the existing comments in qdrant.ts were unusually precise about `always_ram` vs `on_disk` and about rescore defaults, and that is exactly what stopped the DeepCast/Lycos fix being copied here by reflex. Precise prose earned its keep.
- **Lesson:** a fixed-size per-segment allocation turns "more segments" from a mild trade into a multiplier. It is invisible on a large collection (DeepCast: 29 segments x 1 field x 2 MiB = 60.8 MB against 3.34 GB, noise) and dominates a small one. Points-per-segment, not segment count alone, is the number to look at.
- **NOT MEASURED:** the container is stopped, so the ~8-segment / ~134 MB prediction is a model. Re-measure the volume after the optimizer settles.
- **PRE-EXISTING, NOT MINE:** `npx tsc --noEmit -p tsconfig.base.json` reports 1,349 errors across packages/api and packages/core consumers; ZERO in qdrant.ts. Untouched, but worth someone's attention.

**Status:**
- Completed (config + guard). Not applied: the container is stopped at the operator's request. `max_segment_size` reaches an EXISTING collection only through `ensureStorageLayout()` (version-guarded) or `setIndexingThreshold()`, both of which send the full OPTIMIZERS object — so the next bulk-write pass carries it, or bump the storage-layout marker to force it.
---
### [2026-08-14] - The max_segment_size fix was INERT, and a full parameter sweep found an unused index

**Objective:**
- Answer "did you actually reduce memory in Atlas?" honestly, then do the systematic parameter review the first pass skipped.

**Summary of Work:**
- **THE ANSWER WAS NO, AND THE EARLIER ENTRY OVERSTATED IT.** The `max_segment_size: 64_000 -> 192_000` fix could never have reached the live collection: `createCollection` only runs for a collection that does not exist, and `ensureStorageLayout()` is gated on a marker this collection is already stamped `v2` for. A restart would have changed nothing, and the previous entry's "Status: Completed" implied more than was true.
- Fixed by bumping the layout marker to **v3** — the versioning mechanism the file already documents for exactly this ("v1 meant quantization applied; v2 adds the on_disk conversion"). v3 = the corrected segment size. Extracted the literal into `LAYOUT_VERSION`.
- **VERIFIED THE SEGMENT MATH AGAINST THE SOURCE rather than assuming.** I had worried `default_segment_number` being unset would hold the collection near the CPU count and undercut the fix. It does not: `default_segment_number()` resolves to `clamp(get_num_cpus() / 2, 2, 8)` (lib/shard/src/optimizers/config.rs), so the merge target was already **8** and `max_segment_size` was the thing blocking it. 1,682,082 KB of vectors / 192,000 = ~8.8 segments, which meets that target. No extra setting needed.
- **PARAMETER SWEEP** over every memory-relevant knob, comparing set-vs-default: `on_disk_payload` true (inherited, verified on the collection), `async_scorer` true, `mmap_advice` already defaults to Random, `hnsw_index.on_disk` false and `quantization.always_ram` true both deliberate, `vectors.dense.on_disk` / `sparse.index.on_disk` true, `default_segment_number` auto-8 (correct), `max_optimization_threads` 2. All sound. Two gaps found.
- **GAP 1 — `session_id` was indexed and never filtered on.** Same defect class as Lycos MS6, found by asking the same question. Its only occurrence in the entire repo was the line creating it. Measured 79.7 MB: 31.5 MB real index + 48.2 MB fixed null padding, 13% of the 600.2 MB payload index. Removed.
- Hoisted the field list to a module-level `PAYLOAD_INDEXES` (one source of truth for creating AND reaping) and added `dropUnusedPayloadIndexes()`, called from `ensureStorageLayout()` so the v3 bump reaps the live index rather than merely stopping its re-creation.
- **GAP 2 — considered and REJECTED `max_concurrent_segment_loads`.** Default 8, and post-fix the collection has ~9 segments, so it would bound almost nothing on a 1.4 GB store. Adding a knob that reads as tuning and does nothing is the DeepCast `MMAP_ADVICE` mistake; not repeating it here.

**Key Decisions & Rationale:**
- The reaper lives in `ensureStorageLayout()`, not `ensure()`. `ensure()` runs on every boot and a delete does not belong on an unguarded hot path; the retrofit is already the marker-gated one-shot.
- An EMPTY payload_schema read reaps NOTHING, and that is a deliberate branch with its own test: "collection has no indexes" and "we failed to understand the response shape" look identical, and deleting on a misread is the one outcome worth engineering against. A failed read is likewise distinct from an empty one.
- Dropping an INDEX is not dropping the FIELD — every point keeps its session_id, readers are unaffected, and a filter would still work via full scan. That is what makes this reversible.

**Code/Files Modified:**
- packages/core/src/qdrant.ts, packages/indexer/src/main.ts, test/core/qdrantStorage.test.ts

**Outcomes & Lessons Learned:**
- **What Failed (mine):** claiming a config change was done without tracing whether anything would ever apply it. The constant was right and unreachable. "Changed the setting" and "changed the system" are different claims and I made the second one.
- **What Failed (mine, second):** the first run of the reaper tests PASSED VACUOUSLY. The fake client had no `getCollection`, so the new code hit its catch and returned `[]` while the suite went green. Fixed by extending the fake — including modelling `deletePayloadIndex`'s positional third argument, which differs from every other method's shape.
- **What Worked:** re-asking Lycos's question here. The payload-index sweep was not in the first Atlas pass at all, and it found 13% of the payload index serving nothing.
- Mutation-verified: re-adding session_id fails three tests (the binding guard plus both reaper tests); removing the reaper call from the retrofit fails the retrofit test; reverting max_segment_size to 64_000 fails the units test.
- **STILL NOT MEASURED.** The container is stopped. 23 -> ~9 segments and 600.2 -> ~180 MB payload index are MODELS. Re-measure the volume after the indexer next boots and the optimizer settles.

**Status:**
- Completed (config + reaper + guards + the marker that makes them reach live data). Applies on the next indexer boot, which the operator controls.
---
### [2026-08-19] - Task 5: /api/machines + project locations (multi-machine spec)

**Objective:**
- Expose the machine fleet and per-project machine locations over the API, in the exact shapes later tasks (CLI table, UI Machines page) will consume.

**Summary of Work:**
- Added `GET /api/machines`: joins `deps.machines()` (fleet config + self, resolved once at boot from config/machines.yaml + ATLAS_SELF) with `deps.listMachineSync()` (live sync health) by machine name; legacy mode (no machines file) returns `{ self: 'local', machines: [] }` rather than 404ing.
- `GET /api/projects` rows now carry `locations: [{ machine, hostPath, hasKdb }]` from `deps.listProjectLocations()`, keyed by project id; empty array when a project has no recorded locations.
- Extended `ApiDeps` with `machines`, `listMachineSync`, `listProjectLocations`; wired real deps in `packages/api/src/main.ts`, resolving self the same way the indexer scheduler's `resolveSelfName` does.

**Key Decisions & Rationale:**
- A location's `hostPath` is passed through unchanged, not re-translated via `toHostPath` — it is already host-side at discovery time (indexer scanners.ts `toHost`), unlike `rootPath` which is a container path.
- `/api/machines` machine fields are an explicit allowlist (name/address/user/codeRoots/claudeProjects/enabled/sync), deliberately dropping `remoteRsyncPath`/`slugOverrides` from the wire shape, since later tasks consume this response verbatim.
- Fleet/self resolved once at boot (closure in main.ts) rather than re-read per request: config/machines.yaml is a committed SSoT that needs a restart to change anyway, matching the scheduler's existing precedent (resolveSelfName).

**Code/Files Modified:**
- packages/api/src/app.ts
- packages/api/src/main.ts
- test/api/routes.test.ts

**Outcomes & Lessons Learned:**
- **What Worked:** TDD from the brief's own test snippets caught the route/shape contract early; the existing `makeDeps` idiom made the new deps a one-line addition with harmless legacy defaults, so all 73 pre-existing route tests kept passing unedited.
- **What Failed:** N/A — no dead ends on this task.

**Status:**
- Completed
---
### [2026-08-19] - Task 27: Multi-machine feature closure — runbooks, ADR, docs, help-audit guard

**Objective:**
- Close out the multi-machine feature (Tasks 1-26): ops runbooks, ADR, doc updates, a help-audit guard, and the feature-level KDB record.

**Summary of Work:**
- Feature-level summary of what shipped across Tasks 1-26, closed out here: machine model (`config/machines.yaml` SSoT + `ATLAS_SELF`, frozen names, `slugOverrides`); SSH-pull sync engine (`sync:<machine>` BullMQ job, `remote_mirror` volume, destination-prefix + `--partial-dir` safety rails, git-transient-state excludes, the `scanGit` watermark-wedge fix); cross-machine projects (`project_locations`, machine-aware `upsertProject`, origin-URL/root-sha divergence check, machine-aware Claude-dir matching); dedup key v3 — machine-independent normalized identity (project-relative paths; `claude`-scoped, slug-dropped transcript keys so Migration-Assistant copies dedup instead of re-embedding), migrated in place under its own advisory lock (732016), resumable, rehearsal-gated (`make db-dump` + `make dedup-rehearsal` against a throwaway copy of the live catalog — real run cleared: 474,736 rows before/after, 0 collisions, 17 ordinal groups, ~17 min wall clock); provenance UX (`machine` on entries/sessions, search/CLI/MCP filter, editor deep links, Machines page); LAN auth (`ATLAS_BIND`/`ATLAS_TOKEN`, fail-closed boot, UI token prompt, `~/.atlas/credentials`); verified resolution (`/api/instance` nonce-HMAC challenge/proof, `bootId` self-recognition, continuous single-active guard, host-side resolver with cached+re-probe-on-conflict, `atlas-connect` MCP shim, `atlas which`/`open`/`connect`/`machines`). This task's own additions: `docs/multi-machine.md` (add-machine, moving-the-stack, migration-rollout+wedge-recovery, LAN-access runbooks, known limitations), the ADR, `docs/architecture.md`/`configuration.md`/`api.md`/`README.md`/`index.md` updates (including the stale no-auth prose deferred from Task 21), and a new `make help-audit` guard (`test/makefile_help.test.ts`) so an undescribed Make target can no longer silently vanish from `make help`.

**Key Decisions & Rationale:**
- One active instance (not a full stack per machine, not federated per-machine indexes) — avoids double-embedding shared content and divergent answers depending which machine you ask.
- Dedup v3 drops the project slug from the Claude-transcript key scope specifically so a Migration-Assistant-copied `~/.claude/projects` corpus collapses onto the first-recorded entry instead of re-embedding under new attribution (days of Ollama avoided).
- The resolver's nonce-HMAC proof means the shared bearer token is only ever sent to an endpoint that has already proved it holds it — never handed to a rogue listener or reassigned-DHCP peer.
- `bootId` (per-process, random) alongside `installId` distinguishes a genuine peer with a cloned volume (same `installId`, different `bootId` — real conflict) from a hairpin probe reaching yourself (same `bootId` — not a conflict).
- `help-audit` respects a `## @internal` marker (not just a description) so a helper nobody runs directly (`print-compose`) is declared rather than silently exempted or forced into user-facing `make help` output.

**Code/Files Modified:**
- packages/core/src/{machines,dedupMigration,identity,resolve,instanceProof,atlasHome}.ts (Tasks 1-26)
- packages/indexer/src/sync.ts, packages/api/src/{app,guard,instance}.ts, packages/atlas-connect/src/*, packages/cli/src/main.ts (Tasks 1-26)
- docker-compose.yml, config/{atlas.defaults.env,machines.yaml} (Tasks 1-26)
- docs/multi-machine.md (new), docs/adr/20260819-multi-machine-one-active-instance.md (new) — Task 27
- docs/architecture.md, docs/configuration.md, docs/api.md, docs/index.md, README.md — Task 27
- Makefile (help grep excludes `@internal`, new `help-audit` target, `print-compose` marked `## @internal`), test/makefile_help.test.ts (new) — Task 27

**Outcomes & Lessons Learned:**
- **What Worked:** the rehearsal gate (Task 10) caught a real `pg_isready`-vs-two-phase-Postgres-startup race before it could hit the live migration; measuring the real catalog (474,720 entries / 16,473 files) rather than trusting the spec's stale ~323k estimate kept the runtime math honest. The `help-audit` guard was mutation-verified twice (a stripped `## ` description, and a stripped `## @internal` marker) — both turned it RED before the fix was restored.
- **What Failed:** n/a for this closure task; carried-forward, accepted-for-v1 gaps (not failures): presence-based ("exists on machine X") filtering, fleet-wide non-default `API_PORT`, UI machine editing, TLS/Tailscale hardening — all documented in `docs/multi-machine.md#known-limitations` and the ADR's Consequences.

**Status:**
- Completed

Reference: docs/adr/20260819-multi-machine-one-active-instance.md; docs/superpowers/specs/2026-08-19-multi-machine-design.md.
---
### [2026-08-24] - M4 Max migration: restore Atlas/Assessor MCP + machine-local roots

**Objective:**
- Get Claude Code on the new M4 Max (user serge, projects in ~/_CODING) using the Atlas and Assessor MCP servers again, with the stacks running in OrbStack.

**Summary of Work:**
- Root cause 1: user-scope MCP registrations are stored in ~/.claude.json, a SIBLING of the ~/.claude folder, so copying the folder from the M3 Max lost them (claude mcp list: none configured). Root cause 2: Atlas was not running, and make start failed at the indexer because config/atlas.defaults.env bakes the old machine's roots (/Users/nasta/__CODING NEW, /Users/nasta/.claude/projects), which OrbStack cannot mount here.
- Fix: created the gitignored .env override with this machine's CODE_ROOT_HOST / CLAUDE_PROJECTS_HOST, ran make start, re-registered atlas (HTTP :8711, user scope) and Assessor (make claude-docker, HTTP :8770). Corrected the repo path in ~/.claude/CLAUDE.md section 6.

**Key Decisions & Rationale:**
- .env override rather than editing the committed defaults: that is what the Makefile's two-file design is for, and the defaults still describe the M3 Max should it come back as a second machine (see the 2026-08-19 multi-machine work).
- Assessor in docker/HTTP mode (the documented default): the container was already up in OrbStack and one shared container beats one uv process per session.

**Code/Files Modified:**
- .env (new, gitignored, machine-local)
- ~/.claude/CLAUDE.md (repo path ~/__CODING NEW/kdb -> ~/_CODING/kdb; make up -> make start)

**Outcomes & Lessons Learned:**
- **What Worked:** claude mcp list shows both servers Connected; indexer boot: 8 project(s) linked as older locations, 157 scan jobs enqueued, so discovery's lossy transcript-dir matching survived the /Users/nasta -> /Users/serge rename without intervention.
- **What Failed:** nothing after diagnosis. Trap for next migration: copy ~/.claude.json alongside ~/.claude, or re-run the two claude mcp add commands (docs/getting-started.md, Assessor make claude-docker).

**Status:**
- Completed
---
### [2026-08-24] - Host portability: derived roots + host-independent transcript identity

**Objective:**
- Make Atlas work unchanged from any host, user or checkout path, and make the nasta -> serge / __CODING NEW -> _CODING migration keep one identity per project and per transcript.

**Summary of Work:**
- Config: `config/atlas.defaults.env` no longer states any absolute path. `CODE_ROOT_HOST=${ATLAS_REPO_PARENT:?...}` (the Makefile exports `abspath $(CURDIR)/..` — Atlas indexes the tree it lives in) and `CLAUDE_PROJECTS_HOST=${HOME:?}/.claude/projects`; compose interpolates `${...}` inside env files, so the derivation reaches both the bind mounts and the container environment. `docker-compose.yml` fallbacks became `:?` so a bare `docker compose` fails loud instead of mounting a guessed machine's path. `scripts/config-sources.sh` exports the derived value via a new `print-repo-parent` accessor. Guard test (`test/core/configDefaults.test.ts`) fails on any `/Users|/home|/Volumes` in an active value or compose line, and asserts the two roots are interpolations; mutation-verified. The `.env` written earlier today was deleted: the stack now starts with none.
- Identity review (delegated agent, read-only, evidence in the session log): project identity is the slug from the directory basename with `root_path=/data/code/<Name>` — same on both hosts, verified in the projects table; `refreshProjectAliases` linked 8 old-path ghost slugs (`users-nasta-coding-new-deepcast` ...) as older locations; `matchClaudeDirToProject` maps both `-Users-nasta---CODING-NEW-AskAll` and `-Users-serge--CODING-AskAll` to `askall`. The one broken piece: `Catalog.dedupKey` hashed the full container path of a transcript, and the migration RENAMED every transcript directory (the old names are gone from disk), so the new-name scans were inserting every old entry again (10,068 duplicate groups when stopped; 347k pending) and re-embedding each through Ollama.
- Fix: `transcriptIdentityPath()` + `TRANSCRIPT_KEY_SCOPE='claude'` / `TRANSCRIPT_KEY_SCHEME='v3'` in `core/ids.ts`; `Catalog.dedupKey` uses (claude, path inside the encoded dir, ref, title, contentHash) for `claude_session`, unchanged (slug, container path, ...) for project-file sources. `packages/indexer/src/rekeyTranscripts.ts` runs at boot before any scan under advisory lock 732016 (never 732015 — the API takes that one): streams transcript rows in id order, recomputes keys, merges collisions into the lowest id, deletes the losers' Qdrant points (new `VectorStore.deleteByEntryIds`, filter on `entry_id`) BEFORE their rows (one transaction: `Catalog.applyRekey`), stamps `settings.transcript_key_scheme`. Resumable; no vector moves (point ids hash the stored path under the frozen v2 namespace).
- Live run on the real catalog: 358,059 rows moved, 10,068 duplicates merged in ~4 min; afterwards 0 duplicate (session_id,title,body) groups, deleted ids have 0 points, kept old-era ids still have theirs. Key map `(id, dedup_key, source_path)` dumped to the session scratchpad before the run.
- Environment: Node 26 exposes a `localStorage` global (getter returning undefined without --localstorage-file) that vitest's jsdom environment will not overwrite, so all 43 `@vitest-environment jsdom` UI tests failed on this machine. `execArgv: ['--no-experimental-webstorage']` in vitest.config.ts.

**Key Decisions & Rationale:**
- Derive the roots rather than document "edit these two lines": the user's rule is that nothing committed may depend on a host, and the Makefile is the single entry point anyway. `.env` keeps working as the per-machine override (compose: later env-file wins, shell wins over both).
- Transcript scope is the literal `claude`, not the project slug: attribution is derived from the directory name and differs per machine for byte-identical files (spec §6 argument). The path component is the path INSIDE the encoded directory, not `<dirName>/<fileName>` as the multi-machine spec proposes — this migration proved dirName is precisely what a host move renames. Logged in backlog for the feature/multi-machine owner.
- Own marker + in-place re-key instead of bumping ID_SCHEME: ID_SCHEME is hashed into every point id; bumping it truncates and re-embeds 485k entries (days of Ollama). The migration touches keys and losers only.
- Lowest id wins a merge: deterministic across resumed runs, and the old-era row is the one whose vectors have been in Qdrant longest. Its `source_path` stays the vanished old name (rewriting it would move point ids and make the coverage audit re-embed everything) — deep links for those rows are stale; backlog item.

**Code/Files Modified:**
- Makefile, config/atlas.defaults.env, docker-compose.yml, scripts/config-sources.sh
- packages/core/src/ids.ts, packages/core/src/catalog.ts, packages/core/src/qdrant.ts
- packages/indexer/src/rekeyTranscripts.ts (new), packages/indexer/src/main.ts
- test/core/configDefaults.test.ts, test/core/dedupKey.test.ts, test/indexer/rekeyTranscripts.test.ts (new), vitest.config.ts
- README.md, docs/configuration.md, docs/getting-started.md, docs/architecture.md

**Outcomes & Lessons Learned:**
- **What Worked:** compose env-file interpolation (`${VAR:?msg}` inside `--env-file` values) resolves from the Makefile export with no generator or copy step; `make config-check` 12/12; 1010/1010 tests; the re-key on 368k rows completed with the exact duplicate count predicted by the read-only review.
- **What Failed:** first verification of the resolved compose config ran `docker compose` outside make and printed nothing — the `:?` guard had fired exactly as designed, and the grep swallowed it. Verify through the Makefile (or export the variable) and grep for the error text too.

**Status:**
- Completed
---
### [2026-08-24] - Merge feature/multi-machine into main, reconciled with host portability

**Objective:**
- Bring the multi-machine branch (42 commits, 121 files, +12k lines: machines.yaml fleet model, SSH-pull mirror sync, dedup v3 identity, LAN auth, instance guard, atlas-connect shim, machines UI) into main so main is the only branch, working on this host.

**Summary of Work:**
- Reviewed the branch against the new rules. It was built for the old host: committed `/Users/nasta/...` roots (compose fallbacks, defaults env, `config/machines.yaml`), `make up/down` (main had already renamed to `start/stop`), and a transcript identity of `<encodedDir>/<file>` — the exact shape the 2026-08-24 migration renamed. Its dedup v3 framework (project-relative paths, content-occurrence ordinals, in-place migration under lock 732016, rehearsal harness) is sound and subsumes the interim transcript re-key shipped earlier today.
- Plain `git merge` (never rebase). Conflicts: Makefile (kept `start/stop` + derived-root export, added preflight/sync-now/connect-link/db-dump/dedup-rehearsal/help-audit), docker-compose.yml (fail-loud roots + the branch's config/mirror/keys mounts), docs/configuration.md (both revision lines), the four append-only KDB logs (both sides were pure tail appends — union, line counts verified), and catalog.ts/qdrant.ts/main.ts (branch versions; my primitives dropped).
- Reconciliation in the same merge commit: `transcriptIdentityPath` moved into identity.ts and used by both `applyIdentity` (pipeline passes `claudeRoot: dirname(dir)`) and `identityFromStored`; rekeyTranscripts.ts + its test deleted; `config/machines.yaml` -> gitignored, `config/machines.example.yaml` committed as a neutral template (the guard test now sweeps every committed file under config/); wording in defaults env, preflight and runbook updated; `make up/down` -> `start/stop` in docs, resolver/guard messages and their tests; `yaml` dependency installed.
- Verification: 1325/1325 (4 tests that pinned `<dir>/<file>` and the committed inventory were updated), lint clean, `make help-audit` and `make config-check` green. Rehearsal (`make db-dump` + `make dedup-rehearsal`, scratch Postgres): 485,639 rows before/after, 127,101 rekeyed, 0 collisions, 24 ordinal groups, 0 points to delete. Real run at indexer boot: machine backfilled on 490,683 rows, dedup v3 485,683 scanned / 127,121 rekeyed / 0 collisions in 288s; transcript duplicate groups 0; `/api/machines` = single-machine mode; atlas + assessor MCP still Connected.

**Key Decisions & Rationale:**
- Transcript identity = path inside the encoded directory, scope `claude`: the directory name is a host path and a rename is the common migration move; the session UUID alone is globally unique. The spec's `<dir>/<file>` was written for Migration-Assistant copies and would have re-embedded the corpus on this very migration.
- `machines.yaml` per deployment, not committed: a fleet inventory names real hosts, logins and absolute paths — the user's rule is that nothing committed depends on a host. Absent file = single-machine mode, so a fresh checkout works with zero config; the template documents the shape. Trade-off: the inventory must be distributed out of band (like .env / Doppler).
- One merge commit carrying the reconciliation rather than merge + fix-up: the merge point itself is deployable and no commit on main ever encodes the `<dir>/<file>` rule.
- Kept `start/stop` (the user's rename on main) and updated the branch's docs and error messages rather than adding aliases.

**Code/Files Modified:**
- Merge of feature/multi-machine (121 files) plus: packages/core/src/identity.ts, packages/core/src/ids.ts, packages/indexer/src/pipeline.ts, Makefile, docker-compose.yml, config/atlas.defaults.env, config/machines.example.yaml (new), .gitignore, scripts/preflight.sh, docs/{configuration,multi-machine,operations,getting-started}.md, README.md, packages/core/src/resolve.ts, packages/api/src/guard.ts, packages/mcp/src/tools.ts, packages/atlas-connect/{README.md,src/main.ts}, test/core/{identity,dedupMigration,machines,configDefaults,dedupKey,resolve}.test.ts, test/api/guard.test.ts, test/connect/bridge.test.ts; deleted packages/indexer/src/rekeyTranscripts.ts + test.

**Outcomes & Lessons Learned:**
- **What Worked:** the rehearsal harness predicted the real run exactly (0 collisions both); union-merging append-only logs is safe when both sides only appended — verify with a deletion count before trusting it.
- **What Failed:** first test run after the merge failed 20+ files on `Cannot find module 'yaml'` — a merged package.json needs `npm install` before anything else is diagnosed. zsh does not word-split `$VAR` in `git add $FILES`; use an array.

**Status:**
- Completed
### [2026-08-27] - [atlas-4: web PWA, UI image repair, public access over a dedicated Cloudflare tunnel]

**Objective:**
- Pull the other machine's work onto this Mac without losing anything, give the web UI real PWA support (installable, offline, animated boot splash), and make both clients reachable from outside the LAN behind Cloudflare authentication — without touching another project's tunnel or nginx.

**Summary of Work:**
- **UI image was unbuildable on main** (found by running the build, not by reading): packages/ui gained a dependency on the new @atlas/shared, whose package.json points at ./dist, but docker/ui.Dockerfile never copied or built packages/shared, so `vite build` died on the first import. The running kdb-ui container was therefore a stale pre-refactor bundle and nothing looked wrong. Fixed the Dockerfile (copy + install + build shared first, plus tsconfig.base.json) and added test/docker/dockerfileWorkspaceDeps.test.ts, which derives each image's required workspace closure from package.json and asserts every member is copied, installed, built, and built BEFORE its dependents.
- **PWA**: vite-plugin-pwa 1.3.0 (injectManifest) + a hand-written src/sw.ts; manifest generated from the shared PALETTE and the VIEWS registry (shortcuts), so colours and destinations cannot drift; icons/maskable/apple-touch/favicons and nine iOS startup images generated by scripts/app_assets.py (renamed from mobile_assets.py, now the single source for native AND web art); inline animated boot splash in index.html mirroring the native SplashOverlay (same orbit, dwell and fade), retired from React via performance.now() so a slow first load does not over-wait; update-ready and install prompts; standalone safe-area CSS; ?view= deep link so manifest shortcuts land on a real view.
- **Public access**: Atlas got its OWN cloudflared (compose service behind a `public` profile) dialling `ui:80` inside the compose network — DeepCast's tunnel and nginx were left completely untouched. scripts/cloudflare_tunnel.py (status/setup/teardown, find-or-create throughout) provisions tunnel, ingress, proxied DNS and the Access application with two policies: an owner e-mail policy and a non_identity service-token policy for the native app, with service_auth_401_redirect so a non-browser client gets 401 instead of a login redirect.

**Key Decisions & Rationale:**
- Own tunnel rather than a route on DeepCast's: dc-nginx serves twelve live hostnames from one 50KB template, and a syntax slip there takes all of them down on reload. Isolation was worth one more container.
- The repository is PUBLIC, so hostname and operator e-mail are empty slots in config/atlas.defaults.env and live in the gitignored .env, exactly like the API keys; a new guard test fails on an e-mail address or a non-empty deployment slot in committed config.
- Manifest link carries crossorigin="use-credentials" instead of an Access bypass rule on /manifest.webmanifest: a manifest is fetched with credentials omitted, so behind Access it returns the login page and the app is silently not installable. Fixing the request mode is strictly safer than punching a hole in the perimeter.
- The service worker stores nothing it cannot prove came from Atlas (res.ok && type === 'basic' && !redirected), so an expired Access session cannot pin Cloudflare's login HTML in the cache; SSE and non-GET are never intercepted at all.

**Code/Files Modified:**
- docker/ui.Dockerfile, docker/nginx.conf, docker-compose.yml, config/atlas.defaults.env, Makefile, scripts/app_assets.py (renamed), scripts/cloudflare_tunnel.py (new), packages/ui/{index.html,vite.config.ts,src/pwa.ts,src/sw.ts,src/App.tsx,src/styles.css,public/**}, packages/ui/src/views/monitor/useCallFeed.ts, test/{docker/dockerfileWorkspaceDeps,ui/pwaManifest,ui/pwaShell,ui/useCallFeed,core/configDefaults}.test.*, docs/public-access.md (new), docs/{index,mobile}.md, README.md.

**Outcomes & Lessons Learned:**
- **What Worked:** both auth layers verified independently through the real hostname — no credentials 302s to the Access login, a service token alone reaches the shell but gets 401 from /api, and only service token + bearer returns 200. 1352 tests, lint, help-audit and all 11 config checks green.
- **What Failed:** (1) An `nginx types { application/manifest+json webmanifest; }` block REPLACES the inherited mime map rather than extending it — measured: html, js, css and png all went out as application/octet-stream, i.e. no stylesheet and no ES module. mime.types cannot be re-included inside a types block because it is itself one; the fix is default_type on a single `location = /manifest.webmanifest`. (2) `${VAR:?msg}` in a compose service is evaluated before profiles are applied, so a required-variable form on the profile-gated cloudflared broke every `make ps` on an install that never wanted a tunnel. (3) The deployed kdb-mcp image had NO bearer-token code compiled in at all despite a build timestamp days after the commit that added it — setting ATLAS_TOKEN therefore 401'd every MCP tool call until the image was rebuilt. A container's age is not evidence about its contents; grep the artefact.

**Status:**
- Completed
---
### [2026-08-28 22:35 UTC] Session intelligence — search, insights, related

**Objective:**
- Make the 8,395 indexed Claude Code sessions findable, summarisable and traceable: find a session by what you remember, get a customisable report of what it did/decided/left open, and see what else worked on the same thing before and after — on web/PWA, the native app, MCP and the CLI.

**Summary of Work:**
- Five new core modules: sessionFiles (path normalisation + IDF/cosine), sessionRanking (substance, kind weights, decayed aggregation, recency tilt), sessionSearch, sessionRelated, sessionInsights (facts + LLM layer + cache + single-flight).
- Two derived tables: session_files (normalised inverted index, maintained by upsertSession, backfilled from sessions.files_touched with no transcript re-read) and session_insights (report cache).
- Three API routes, three MCP tools, an `atlas sessions` command group (list/find/insights/related) with `list` as default so `atlas sessions <project>` is unchanged.
- @atlas/shared gained sessionView (wording, section registry, colours) and sessionTimeline (pure layout), consumed identically by web and native.
- SearchHit now carries `kind`, so aggregation can weight an insight above an action without a second round trip.

**Key Decisions & Rationale:**
- Substance is a ranking PRIOR (0.55 + 0.45s), never a filter: the corpus median session is 3 messages and 1.6 minutes, so relevance alone buries real work — but the ninety-second session that holds the answer must stay findable.
- File comparison happens only on NORMALISED repo-relative keys. The corpus's most-touched paths are under /Users/nasta/__CODING NEW/, a user and machine that no longer exist here; raw string equality scores ZERO against today's paths for the same file of the same repo.
- Relatedness renormalises over AVAILABLE legs. 72% of sessions record no files, and a fixed denominator would bury them for missing data rather than for being unrelated. The response always reports its `basis`, and a timestamps-only list says so in words.
- Insights are two layers with the split as the contract: the deterministic half is complete alone and free; the LLM half is marked AI everywhere and degrades to the facts. Cache key folds in sections, model, extraction scheme, PROMPT_VERSION and the session's own size.
- Sessions is no longer gated on picking one project — that gate is what made "find the session about X" impossible.

**Code/Files Modified:**
- packages/core/src/{sessionFiles,sessionRanking,sessionSearch,sessionRelated,sessionInsights,catalog,search,types,usage}.ts; packages/api/src/{app,main}.ts; packages/mcp/src/tools.ts; packages/cli/src/main.ts; packages/indexer/src/main.ts; packages/shared/src/{sessionView,sessionTimeline}.ts; packages/ui/src/views/sessions/*, components/SessionRefActions.tsx, views/{SessionsView,SearchView,TimelineView}.tsx, App.tsx, api.ts; mobile/src/screens/sessions/*, screens/SessionsScreen.tsx, navigation/RootNavigator.tsx, api/endpoints.ts; docs/adr/20260828-session-intelligence.md; docs/{api,cli,mcp,mobile}.md; README.md.

**Outcomes & Lessons Learned:**
- **What Worked:** measuring the corpus BEFORE designing. Every ranking constant traces to a measured fact rather than to intuition, and three of them (substance prior, path normalisation, leg renormalisation) exist only because the measurement contradicted the obvious design. 1517 tests, all typechecks green; verified live against the real 8,395-session index.
- **What Failed:** (1) A correlated EXISTS over session_files re-scanned that table once per session row — 3.8 s for one metadata query on a HALF-populated table, growing with both tables; resolving the file match once in a CTE and joining it took the same query to 247 ms. (2) commandName reported the top command of a 303-action session as `DeepCast;` 145 times: it split only on `&&` and skipped the word `cd` but not `cd`'s path argument, so the histogram named a directory instead of a tool. (3) Context events were computed only on the populated path, so "no related session, but here are the commits that touched the same files" — the most useful answer that feature gives — was suppressed exactly when it applied. (4) log1p gap compression alone still gave three sessions in one afternoon only 4.9% of an axis spanning three months, narrower than the nodes drawn on it; a MIN_STEP floor per adjacent pair was needed on top.
- **Measured, not assumed:** end-to-end session-search latency is UNCORRELATED with the retrieval pool size (3.6 s at pool 80 vs 1.6 s at pool 250 for the same query). The cost is cold vector reads, consistent with this deployment's known rescore-bound profile — so the pool is sized for evidence, not for speed, and that reasoning is recorded in the constant's own comment.

**Status:**
- Completed
---
### [2026-08-28 23:05 UTC] Session intelligence — live-verification corrections

**Objective:**
- Verify the shipped feature against the real index rather than against its tests, and fix what only real data could show.

**Summary of Work:**
- Related-session scoring changed from a weighted mean over "available" legs to a soft OR (1 - product of (1 - w*leg)).
- Split the substance floor: 0.55 when the user searched for a session, 0.25 when one is merely proposed as related.
- entriesInWindow no longer selects `body`; neither caller read it, and a git commit's body is its whole changed-file list.

**Key Decisions & Rationale:**
- A weighted mean treats a missing leg and a weak leg differently in the wrong direction. Measured live: a 3-message session with no files ranked ABOVE a 502-message session sharing two files, because the heavy one's weak file score was averaged in while the trivial one had no file term to dilute. Under a soft OR every leg can only add evidence, so being measurable can never cost a candidate rank.
- Search and related ask different questions of the same substance number. You can search for a ninety-second session on purpose; a ninety-second session is rarely the WORK on something you did not ask about.

**Code/Files Modified:**
- packages/core/src/{sessionRelated,sessionRanking,catalog}.ts; test/core/{sessionRelated,sessionRanking}.test.ts; packages/ui/src/App.tsx (session URL state); test/ui/app.test.tsx; docs/adr/20260828-session-intelligence.md.

**Outcomes & Lessons Learned:**
- **What Worked:** looking at the actual ranked output. Both defects were invisible to the test suite because the tests asserted the behaviour I had designed, not the behaviour the corpus produces. After the fix the 502-message file-sharing session ranks first and the 3-message security review falls from 1st to 4th and then out of the top three.
- **What Failed:** a first attempt at session URL state wrote `view` into the address bar alongside `session`/`tab`. That made a leftover `?view=` beat the user's saved start-view preference on every ordinary reload — the setting appeared to stop working. Only the session and its tab get an address now; the view stays a preference, and the existing start-view test pins it.
- **Measured:** related sessions 19 s cold / 1.7 s warm before, 8.8 s cold / 0.55 s warm after; the metadata leg of session search 3.8 s before the CTE, 247 ms after.

**Status:**
- Completed
