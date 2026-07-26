# Judge disagreements awaiting arbitration

Generated 2026-07-26T11:06:21.411Z from the 25% double-judged subsample.

Quadratic-weighted κ 0.802 over 270 labels; 67% exact agreement.

98 disagreement(s).

## entry 538982 — query 0220b73c (temporal)
> Lycos postgres videos table autovacuum: when were the per-table autovacuum storage parameters (autovacuum_vacuum_scale_factor=0.01, analyze_scale_factor=0.005, cost_delay=0, vacuum_threshold=5000) set

- **cline-pass/glm-5.2**: grade 2 — Confirms parameters exist but not when they were set
- **cline-pass/kimi-k3**: grade 3 — Names exact asked parameters already set, contradicting prior finding

Human grade: _(add a label with judge: "human" to settle)_

## entry 546148 — query 0220b73c (temporal)
> Lycos postgres videos table autovacuum: when were the per-table autovacuum storage parameters (autovacuum_vacuum_scale_factor=0.01, analyze_scale_factor=0.005, cost_delay=0, vacuum_threshold=5000) set

- **cline-pass/glm-5.2**: grade 3 — Names migrations 028/030 as source; quotes 925 vs 5.48M finding
- **cline-pass/kimi-k3**: grade 2 — User prompt quoting stale finding and 028/030 settings origin

Human grade: _(add a label with judge: "human" to settle)_

## entry 16430 — query 0ca5960d (incident)
> videoinsight_low starvation fix queue workers

- **cline-pass/glm-5.2**: grade 1 — General troubleshooting, mentions videoinsight queue generically
- **cline-pass/kimi-k3**: grade 0 — Troubleshooting worker attrition, different issue

Human grade: _(add a label with judge: "human" to settle)_

## entry 311477 — query 0ca5960d (incident)
> videoinsight_low starvation fix queue workers

- **cline-pass/glm-5.2**: grade 1 — Mentions queue draining after fix, not videoinsight_low specifically
- **cline-pass/kimi-k3**: grade 0 — Unrelated 2025 queue-drain check, different incident

Human grade: _(add a label with judge: "human" to settle)_

## entry 325234 — query 0ca5960d (incident)
> videoinsight_low starvation fix queue workers

- **cline-pass/glm-5.2**: grade 0 — Too vague, not about videoinsight_low starvation
- **cline-pass/kimi-k3**: grade 1 — Mentions queued video jobs vaguely, no starvation answer

Human grade: _(add a label with judge: "human" to settle)_

## entry 469118 — query 0ca5960d (incident)
> videoinsight_low starvation fix queue workers

- **cline-pass/glm-5.2**: grade 3 — Directly describes fix for videoinsight_low zombie requeue loop
- **cline-pass/kimi-k3**: grade 2 — Fixes LOW-lane zombie requeue loop, part of same starvation hazard

Human grade: _(add a label with judge: "human" to settle)_

## entry 637606 — query 0ca5960d (incident)
> videoinsight_low starvation fix queue workers

- **cline-pass/glm-5.2**: grade 2 — Shows video-low-pool has only 1 worker, explains starvation mechanism
- **cline-pass/kimi-k3**: grade 3 — States worker pool layout including dedicated video-low pool consuming low lane

Human grade: _(add a label with judge: "human" to settle)_

## entry 640693 — query 0ca5960d (incident)
> videoinsight_low starvation fix queue workers

- **cline-pass/glm-5.2**: grade 2 — Discusses fixing video-low mismatch and worker pool control
- **cline-pass/kimi-k3**: grade 1 — User requesting video-low fix refinement; contains no answer

Human grade: _(add a label with judge: "human" to settle)_

## entry 14317 — query 2f8b6bea (procedural)
> worker pool resize procedure supervisorctl stopwaitsecs

- **cline-pass/kimi-k3**: grade 1 — Pool architecture decision, not the resize procedure
- **cline-pass/glm-5.2**: grade 0 — Architecture decision, not resize procedure or stopwaitsecs

Human grade: _(add a label with judge: "human" to settle)_

## entry 637704 — query 2f8b6bea (procedural)
> worker pool resize procedure supervisorctl stopwaitsecs

- **cline-pass/kimi-k3**: grade 3 — Gives actual resize procedure steps with sed commands
- **cline-pass/glm-5.2**: grade 2 — Describes resize procedure steps but omits stopwaitsecs

Human grade: _(add a label with judge: "human" to settle)_

## entry 637703 — query 2f8b6bea (procedural)
> worker pool resize procedure supervisorctl stopwaitsecs

- **cline-pass/kimi-k3**: grade 2 — Explains stopwaitsecs kill behaviour during resize, safety warning
- **cline-pass/glm-5.2**: grade 3 — Directly explains stopwaitsecs mechanism in resize procedure

Human grade: _(add a label with judge: "human" to settle)_

## entry 472370 — query 1b799c65 (definitional)
> ltree extension postgres partition white label multi-tenant experiment

- **cline-pass/kimi-k3**: grade 2 — Documents the actual isolation model chosen across Postgres and Qdrant
- **cline-pass/glm-5.2**: grade 1 — Isolation model described but no ltree or partition

Human grade: _(add a label with judge: "human" to settle)_

## entry 461083 — query 1b799c65 (definitional)
> ltree extension postgres partition white label multi-tenant experiment

- **cline-pass/kimi-k3**: grade 2 — Details implemented tenancy core, the approach chosen over ltree
- **cline-pass/glm-5.2**: grade 1 — Multi-tenant core but no ltree or partition mention

Human grade: _(add a label with judge: "human" to settle)_

## entry 460734 — query 1b799c65 (definitional)
> ltree extension postgres partition white label multi-tenant experiment

- **cline-pass/kimi-k3**: grade 1 — Testing plan mentions leak suite, no ltree/partition rationale
- **cline-pass/glm-5.2**: grade 0 — Testing docs; no ltree or partition mention

Human grade: _(add a label with judge: "human" to settle)_

## entry 472359 — query 1b799c65 (definitional)
> ltree extension postgres partition white label multi-tenant experiment

- **cline-pass/kimi-k3**: grade 2 — Shows partitioning done via Qdrant payloads, not postgres/ltree
- **cline-pass/glm-5.2**: grade 0 — Phase 4 Qdrant partitioning; no postgres ltree

Human grade: _(add a label with judge: "human" to settle)_

## entry 460838 — query 1b799c65 (definitional)
> ltree extension postgres partition white label multi-tenant experiment

- **cline-pass/kimi-k3**: grade 2 — States row-level tenancy via users.tenant_id, not ltree/partition
- **cline-pass/glm-5.2**: grade 1 — Row-level tenancy plan but no ltree or partition

Human grade: _(add a label with judge: "human" to settle)_

## entry 473430 — query 1b799c65 (definitional)
> ltree extension postgres partition white label multi-tenant experiment

- **cline-pass/kimi-k3**: grade 1 — White-label demo testing, nothing on postgres design
- **cline-pass/glm-5.2**: grade 0 — Browser testing guide; no ltree or partition

Human grade: _(add a label with judge: "human" to settle)_

## entry 469295 — query 1b799c65 (definitional)
> ltree extension postgres partition white label multi-tenant experiment

- **cline-pass/kimi-k3**: grade 1 — Qdrant tenant search scope, not postgres ltree/partition
- **cline-pass/glm-5.2**: grade 0 — Qdrant tenant scope; no ltree or partition

Human grade: _(add a label with judge: "human" to settle)_

## entry 467737 — query 1b799c65 (definitional)
> ltree extension postgres partition white label multi-tenant experiment

- **cline-pass/kimi-k3**: grade 1 — White-label frontend review, no storage mechanism
- **cline-pass/glm-5.2**: grade 0 — Frontend security review; no ltree or partition

Human grade: _(add a label with judge: "human" to settle)_

## entry 473427 — query 1b799c65 (definitional)
> ltree extension postgres partition white label multi-tenant experiment

- **cline-pass/kimi-k3**: grade 1 — Test tenants doc, no ltree/partition mention
- **cline-pass/glm-5.2**: grade 0 — Test tenant seeding; no ltree or partition

Human grade: _(add a label with judge: "human" to settle)_

## entry 641961 — query 2f8b6bea (procedural)
> worker pool resize procedure supervisorctl stopwaitsecs

- **cline-pass/kimi-k3**: grade 1 — Security review of resize UI code, not the procedure
- **cline-pass/glm-5.2**: grade 0 — Security review of worker pool code, irrelevant

Human grade: _(add a label with judge: "human" to settle)_

## entry 640113 — query 2f8b6bea (procedural)
> worker pool resize procedure supervisorctl stopwaitsecs

- **cline-pass/kimi-k3**: grade 2 — Resize verified live with timings, points to runbook
- **cline-pass/glm-5.2**: grade 1 — Mentions resize tested but no procedure or stopwaitsecs detail

Human grade: _(add a label with judge: "human" to settle)_

## entry 643983 — query 2f8b6bea (procedural)
> worker pool resize procedure supervisorctl stopwaitsecs

- **cline-pass/kimi-k3**: grade 1 — Handoff prompt mentioning resize exists, no procedure
- **cline-pass/glm-5.2**: grade 0 — UI scaling handoff prompt, not about stopwaitsecs

Human grade: _(add a label with judge: "human" to settle)_

## entry 16375 — query 2f8b6bea (procedural)
> worker pool resize procedure supervisorctl stopwaitsecs

- **cline-pass/kimi-k3**: grade 1 — Count change via config and recreate, different older method
- **cline-pass/glm-5.2**: grade 0 — About worker count change, not resize procedure

Human grade: _(add a label with judge: "human" to settle)_

## entry 467853 — query 1b799c65 (definitional)
> ltree extension postgres partition white label multi-tenant experiment

- **cline-pass/kimi-k3**: grade 1 — White-label routing commit, but nothing about ltree or postgres partitioning
- **cline-pass/glm-5.2**: grade 0 — Domain routing commit; no ltree or partition

Human grade: _(add a label with judge: "human" to settle)_

## entry 476485 — query 2f8b6bea (procedural)
> worker pool resize procedure supervisorctl stopwaitsecs

- **cline-pass/kimi-k3**: grade 1 — Explores pool sizing code location, no procedure or stopwaitsecs answer
- **cline-pass/glm-5.2**: grade 0 — About finding service code, irrelevant

Human grade: _(add a label with judge: "human" to settle)_

## entry 382025 — query 2f8b6bea (procedural)
> worker pool resize procedure supervisorctl stopwaitsecs

- **cline-pass/kimi-k3**: grade 0 — Different system's (lycos) pool scaling, not the asked procedure
- **cline-pass/glm-5.2**: grade 1 — Mentions pool scaling but not stopwaitsecs or supervisorctl

Human grade: _(add a label with judge: "human" to settle)_

## entry 480194 — query 3fea368b (intent)
> why the Atlas triggers were rewritten to observable moments instead of capability description

- **cline-pass/kimi-k3**: grade 2 — Table shows state-based declarations repeatedly failed to fire
- **cline-pass/glm-5.2**: grade 1 — Discusses trigger effectiveness evaluation but not rewrite rationale

Human grade: _(add a label with judge: "human" to settle)_

## entry 355983 — query 40e5f0a8 (intent)
> On July 19-20 2026 the backfill service chain in G2P config.json was changed: nvidia/openai/gpt-oss-120b was removed from the backfill chain and cerebras/gpt-oss-120b was moved to the head. Why was nv

- **cline-pass/kimi-k3**: grade 1 — Shows gpt-oss-120b backfill latency problems, but different session/date
- **cline-pass/glm-5.2**: grade 0 — Different date (Jul 11) and different issue about latency timeouts.

Human grade: _(add a label with judge: "human" to settle)_

## entry 552037 — query 40e5f0a8 (intent)
> On July 19-20 2026 the backfill service chain in G2P config.json was changed: nvidia/openai/gpt-oss-120b was removed from the backfill chain and cerebras/gpt-oss-120b was moved to the head. Why was nv

- **cline-pass/kimi-k3**: grade 0 — Jul 23 session about reload bug and different chain order
- **cline-pass/glm-5.2**: grade 1 — Mentions new chain order but does not explain why nvidia was removed.

Human grade: _(add a label with judge: "human" to settle)_

## entry 390936 — query 4bd407c3 (definitional)
> qdrant int8 quantization footprint reduction

- **cline-pass/kimi-k3**: grade 1 — Security review of related change; diff shows PG batching only
- **cline-pass/glm-5.2**: grade 0 — Unrelated kdb catalog bulk insert changes

Human grade: _(add a label with judge: "human" to settle)_

## entry 481696 — query 3fea368b (intent)
> why the Atlas triggers were rewritten to observable moments instead of capability description

- **cline-pass/kimi-k3**: grade 2 — Duplicate diff showing capability-description text being replaced
- **cline-pass/glm-5.2**: grade 1 — Shows capability-description trigger style but not why it was changed

Human grade: _(add a label with judge: "human" to settle)_

## entry 17012 — query 4bd407c3 (definitional)
> qdrant int8 quantization footprint reduction

- **cline-pass/kimi-k3**: grade 0 — Runbook mentions verifying INT8 active; no footprint reduction information
- **cline-pass/glm-5.2**: grade 1 — Mentions INT8 active but no footprint reduction info

Human grade: _(add a label with judge: "human" to settle)_

## entry 485003 — query 3fea368b (intent)
> why the Atlas triggers were rewritten to observable moments instead of capability description

- **cline-pass/kimi-k3**: grade 3 — States rationale: observable triggers enable measuring missed calls
- **cline-pass/glm-5.2**: grade 1 — About adoption measurement, mentions triggers but not rewrite rationale

Human grade: _(add a label with judge: "human" to settle)_

## entry 483681 — query 3fea368b (intent)
> why the Atlas triggers were rewritten to observable moments instead of capability description

- **cline-pass/kimi-k3**: grade 3 — States rationale: observable triggers enable measuring missed calls
- **cline-pass/glm-5.2**: grade 1 — About measuring adoption, mentions triggers but not rewrite rationale

Human grade: _(add a label with judge: "human" to settle)_

## entry 483526 — query 3fea368b (intent)
> why the Atlas triggers were rewritten to observable moments instead of capability description

- **cline-pass/kimi-k3**: grade 1 — Rewrite-era measurement work, no rationale stated
- **cline-pass/glm-5.2**: grade 0 — About KDB entries for Atlas and Assessor, not trigger rewriting

Human grade: _(add a label with judge: "human" to settle)_

## entry 552009 — query 5d7d4120 (definitional)
> Has there ever been any work, discussion, or design around a NEXUS egress node that does NOT route through an expressvpn gateway container — e.g. a "direct" exit, a bare/host-network egress, egressing

- **cline-pass/kimi-k3**: grade 1 — Security review prompt; file list hints feature, no approach content
- **cline-pass/glm-5.2**: grade 2 — Security review includes direct_egress_test.go changes

Human grade: _(add a label with judge: "human" to settle)_

## entry 551450 — query 5d7d4120 (definitional)
> Has there ever been any work, discussion, or design around a NEXUS egress node that does NOT route through an expressvpn gateway container — e.g. a "direct" exit, a bare/host-network egress, egressing

- **cline-pass/kimi-k3**: grade 2 — Testing plan reveals approach details: egress_dns, --node flag, fail-fast
- **cline-pass/glm-5.2**: grade 3 — Design doc testing plan for direct Mac-IP egress node

Human grade: _(add a label with judge: "human" to settle)_

## entry 325354 — query 74340b30 (temporal)
> What happened on 2026-07-21 that would cause a large spike of failed RQ jobs on the videoinsight_low queue in DeepCast? Around 413 video analysis jobs failed on that single day. Was there an incident,

- **cline-pass/kimi-k3**: grade 1 — Generic troubleshooting table, not tied to 07-21
- **cline-pass/glm-5.2**: grade 0 — General troubleshooting doc dated 07-10, no 07-21 event

Human grade: _(add a label with judge: "human" to settle)_

## entry 18062 — query 4cdc5bb7 (definitional)
> dashboard card thumbnail quality high maxres bandwidth videoCard Phase 2a

- **cline-pass/kimi-k3**: grade 0 — Task ordering notes only; unrelated
- **cline-pass/glm-5.2**: grade 1 — Mentions Phase 2a VideoCard but not thumbnail quality

Human grade: _(add a label with judge: "human" to settle)_

## entry 347244 — query 74340b30 (temporal)
> What happened on 2026-07-21 that would cause a large spike of failed RQ jobs on the videoinsight_low queue in DeepCast? Around 413 video analysis jobs failed on that single day. Was there an incident,

- **cline-pass/kimi-k3**: grade 2 — Documents 07-11 deploy auto-requeuing failed jobs into videoinsight_low, plausible cause
- **cline-pass/glm-5.2**: grade 1 — Describes videoinsight_low retry design on 07-11, not 07-21 spike

Human grade: _(add a label with judge: "human" to settle)_

## entry 518220 — query 4899585a (incident)
> safari youtube content process crash problem repeatedly occurred bisect video-inject

- **cline-pass/kimi-k3**: grade 2 — Docs commit for the crash-loop root cause; title only, no details
- **cline-pass/glm-5.2**: grade 1 — Docs commit about crash, no bisect of video-inject

Human grade: _(add a label with judge: "human" to settle)_

## entry 566998 — query 4899585a (incident)
> safari youtube content process crash problem repeatedly occurred bisect video-inject

- **cline-pass/kimi-k3**: grade 1 — Chrome CSS button fix; only tangential video-inject mention
- **cline-pass/glm-5.2**: grade 0 — Chrome button fixes, unrelated to Safari crash bisect

Human grade: _(add a label with judge: "human" to settle)_

## entry 524168 — query 4899585a (incident)
> safari youtube content process crash problem repeatedly occurred bisect video-inject

- **cline-pass/kimi-k3**: grade 3 — Details the bisect method and result isolating side-panel-host.js
- **cline-pass/glm-5.2**: grade 2 — Earlier bisect round found side-panel-host as cause, related

Human grade: _(add a label with judge: "human" to settle)_

## entry 518219 — query 4899585a (incident)
> safari youtube content process crash problem repeatedly occurred bisect video-inject

- **cline-pass/kimi-k3**: grade 2 — Changelog entry naming the crash-loop fix, minimal detail
- **cline-pass/glm-5.2**: grade 1 — Changelog entry about crash fix, no bisect information

Human grade: _(add a label with judge: "human" to settle)_

## entry 617804 — query 74340b30 (temporal)
> What happened on 2026-07-21 that would cause a large spike of failed RQ jobs on the videoinsight_low queue in DeepCast? Around 413 video analysis jobs failed on that single day. Was there an incident,

- **cline-pass/kimi-k3**: grade 0 — July 24 queue-stall incident, different event, no failures
- **cline-pass/glm-5.2**: grade 1 — Mentions videoinsight_low queue but 07-24 g2p incident, not 07-21

Human grade: _(add a label with judge: "human" to settle)_

## entry 359634 — query 776f42f7 (definitional)
> nexus weighted egress rate limit

- **cline-pass/kimi-k3**: grade 3 — Full definition: acceptance ok/(ok+429), EMA, min_weight, push, WRR
- **cline-pass/glm-5.2**: grade 2 — Same implementation details as #8, substantially helps define

Human grade: _(add a label with judge: "human" to settle)_

## entry 458987 — query 754bfd92 (definitional)
> Assessor MCP server modes and assessment workflow

- **cline-pass/kimi-k3**: grade 2 — Defines Assessor purpose and MCP tools, lacks modes detail
- **cline-pass/glm-5.2**: grade 3 — Describes MCP tools and structured assessment output workflow

Human grade: _(add a label with judge: "human" to settle)_

## entry 481278 — query 754bfd92 (definitional)
> Assessor MCP server modes and assessment workflow

- **cline-pass/kimi-k3**: grade 1 — Security-review transcript; only embeds consult-when instructions fragment
- **cline-pass/glm-5.2**: grade 0 — Duplicate security review, not modes or workflow

Human grade: _(add a label with judge: "human" to settle)_

## entry 455931 — query 754bfd92 (definitional)
> Assessor MCP server modes and assessment workflow

- **cline-pass/kimi-k3**: grade 2 — Live test battery demonstrates assess/red-team modes and verdicts
- **cline-pass/glm-5.2**: grade 1 — Shows modes used in testing, doesn't define them or workflow

Human grade: _(add a label with judge: "human" to settle)_

## entry 381474 — query 754bfd92 (definitional)
> Assessor MCP server modes and assessment workflow

- **cline-pass/kimi-k3**: grade 2 — Same README overview; partial definitional help
- **cline-pass/glm-5.2**: grade 3 — Describes MCP tools and structured assessment output workflow

Human grade: _(add a label with judge: "human" to settle)_

## entry 381545 — query 754bfd92 (definitional)
> Assessor MCP server modes and assessment workflow

- **cline-pass/kimi-k3**: grade 1 — Vulnerability prompt; only mentions tool registration and hosts
- **cline-pass/glm-5.2**: grade 0 — Security vulnerability discussion, not modes or workflow

Human grade: _(add a label with judge: "human" to settle)_

## entry 481696 — query 754bfd92 (definitional)
> Assessor MCP server modes and assessment workflow

- **cline-pass/kimi-k3**: grade 1 — Duplicate security-review prompt with instructions fragment only
- **cline-pass/glm-5.2**: grade 0 — Security review of mcp_server.py, not modes or workflow

Human grade: _(add a label with judge: "human" to settle)_

## entry 359531 — query 776f42f7 (definitional)
> nexus weighted egress rate limit

- **cline-pass/kimi-k3**: grade 2 — Diff comment defines yield-aware egress weights from outcome table
- **cline-pass/glm-5.2**: grade 1 — Security review mentions feature, no definition of rate limit

Human grade: _(add a label with judge: "human" to settle)_

## entry 364766 — query 776f42f7 (definitional)
> nexus weighted egress rate limit

- **cline-pass/kimi-k3**: grade 2 — Explains weight = clamp(EMA of acceptance) mechanism
- **cline-pass/glm-5.2**: grade 1 — Discusses data exposure internals, marginal to definition

Human grade: _(add a label with judge: "human" to settle)_

## entry 339260 — query 776f42f7 (definitional)
> nexus weighted egress rate limit

- **cline-pass/kimi-k3**: grade 1 — Defines NEXUS load balancer, not the weighted egress loop
- **cline-pass/glm-5.2**: grade 0 — NEXUS load balancing decision, not weighted egress rate limit

Human grade: _(add a label with judge: "human" to settle)_

## entry 359158 — query 776f42f7 (definitional)
> nexus weighted egress rate limit

- **cline-pass/kimi-k3**: grade 2 — Explains egress-outcomes table and 429-per-exit signal behind weighting
- **cline-pass/glm-5.2**: grade 1 — Explains egress-outcomes table, mentions throttling marginally

Human grade: _(add a label with judge: "human" to settle)_

## entry 365722 — query 776f42f7 (definitional)
> nexus weighted egress rate limit

- **cline-pass/kimi-k3**: grade 2 — Defines weighted_routing as exit-selection axis vs other loops
- **cline-pass/glm-5.2**: grade 1 — Discusses weighted_routing axis, marginal to rate limit definition

Human grade: _(add a label with judge: "human" to settle)_

## entry 359530 — query 776f42f7 (definitional)
> nexus weighted egress rate limit

- **cline-pass/kimi-k3**: grade 3 — Full definition: acceptance ok/(ok+429), EMA, min_weight, weight push
- **cline-pass/glm-5.2**: grade 2 — Describes weighted egress implementation using 429 acceptance rates

Human grade: _(add a label with judge: "human" to settle)_

## entry 455913 — query 754bfd92 (definitional)
> Assessor MCP server modes and assessment workflow

- **cline-pass/kimi-k3**: grade 1 — Bare edit actions on mcp_server.py, no content
- **cline-pass/glm-5.2**: grade 0 — Edit action only, no content about modes or workflow

Human grade: _(add a label with judge: "human" to settle)_

## entry 381544 — query 754bfd92 (definitional)
> Assessor MCP server modes and assessment workflow

- **cline-pass/kimi-k3**: grade 2 — Summarizes design: 6 modes, MCP+CLI, structured output
- **cline-pass/glm-5.2**: grade 1 — Brief mention of 6 modes, no definition or workflow detail

Human grade: _(add a label with judge: "human" to settle)_

## entry 481268 — query 754bfd92 (definitional)
> Assessor MCP server modes and assessment workflow

- **cline-pass/kimi-k3**: grade 2 — Describes assess trigger workflow in MCP instructions rewrite
- **cline-pass/glm-5.2**: grade 1 — Mentions MCP instructions rewrite, not mode definitions

Human grade: _(add a label with judge: "human" to settle)_

## entry 339822 — query 776f42f7 (definitional)
> nexus weighted egress rate limit

- **cline-pass/kimi-k3**: grade 1 — NEXUS overview only, no weighted-egress content
- **cline-pass/glm-5.2**: grade 0 — NEXUS overview, not about weighted egress rate limit

Human grade: _(add a label with judge: "human" to settle)_

## entry 341479 — query 776f42f7 (definitional)
> nexus weighted egress rate limit

- **cline-pass/kimi-k3**: grade 1 — Metrics reference, unrelated to weight computation
- **cline-pass/glm-5.2**: grade 0 — Metrics reference, unrelated to weighted egress rate limit

Human grade: _(add a label with judge: "human" to settle)_

## entry 368833 — query 776f42f7 (definitional)
> nexus weighted egress rate limit

- **cline-pass/kimi-k3**: grade 2 — Commit names per-provider egress weights decision
- **cline-pass/glm-5.2**: grade 1 — Commit message names feature, no definition of rate limit

Human grade: _(add a label with judge: "human" to settle)_

## entry 606261 — query 776f42f7 (definitional)
> nexus weighted egress rate limit

- **cline-pass/kimi-k3**: grade 1 — Rate-limit review tiering, doesn't define weighted egress
- **cline-pass/glm-5.2**: grade 0 — Different rate-limit context (R-series vertex/nvidia 401/403)

Human grade: _(add a label with judge: "human" to settle)_

## entry 566998 — query 8dbed327 (incident)
> Safari extension YouTube content process crash "a problem repeatedly occurred with www.youtube.com" — what root causes were found, what fixes were tried, and what bisect results or open leads remain? 

- **cline-pass/kimi-k3**: grade 2 — Status on both issues but visible content is Chrome button
- **cline-pass/glm-5.2**: grade 1 — Primarily Chrome button fixes, mentions both issues

Human grade: _(add a label with judge: "human" to settle)_

## entry 558754 — query 93d08b4e (incident)
> Atlas disconnected mid-session attribution unverified root cause Claude Code transcripts

- **cline-pass/kimi-k3**: grade 2 — Mid-session tool abort root-caused via Claude Code MCP logs; assessor, not Atlas
- **cline-pass/glm-5.2**: grade 0 — MCP idle timeout, not Atlas disconnection

Human grade: _(add a label with judge: "human" to settle)_

## entry 573736 — query 4899585a (incident)
> safari youtube content process crash problem repeatedly occurred bisect video-inject

- **cline-pass/kimi-k3**: grade 2 — Commit shipping flight-recorder diagnostics for this exact crash, touches video-inject
- **cline-pass/glm-5.2**: grade 1 — Diagnostics commit lists video-inject file, no bisect answer

Human grade: _(add a label with judge: "human" to settle)_

## entry 567494 — query 4899585a (incident)
> safari youtube content process crash problem repeatedly occurred bisect video-inject

- **cline-pass/kimi-k3**: grade 1 — Review including video-inject diff but no crash discussion visible
- **cline-pass/glm-5.2**: grade 0 — Security review of v1.13.3, unrelated to bisect

Human grade: _(add a label with judge: "human" to settle)_

## entry 577135 — query 4899585a (incident)
> safari youtube content process crash problem repeatedly occurred bisect video-inject

- **cline-pass/kimi-k3**: grade 3 — States root cause: runtime.sendMessage from panel iframe kills WebContent process
- **cline-pass/glm-5.2**: grade 1 — Different root cause (sendMessage), not about video-inject bisect

Human grade: _(add a label with judge: "human" to settle)_

## entry 521667 — query 4899585a (incident)
> safari youtube content process crash problem repeatedly occurred bisect video-inject

- **cline-pass/kimi-k3**: grade 2 — Bisect progress: duplicate-var fix ruled out, log dies after video-inject loads
- **cline-pass/glm-5.2**: grade 1 — Pre-bisect investigation mentions video-inject but no bisect result

Human grade: _(add a label with judge: "human" to settle)_

## entry 488104 — query c6da40b1 (intent)
> In the DeepCast frontend dashboard redesign (Phase 2a dashboard card system, components/videoCard/ with PosterCard, RichCard, MagazineCard), why was the thumbnail quality hardcoded to 'high' in useThu

- **cline-pass/kimi-k3**: grade 2 — States 4K blur problem post-redesign, no cause given
- **cline-pass/glm-5.2**: grade 3 — States problem: 4K blur after redesign lost viewport-based resolution

Human grade: _(add a label with judge: "human" to settle)_

## entry 271732 — query c6da40b1 (intent)
> In the DeepCast frontend dashboard redesign (Phase 2a dashboard card system, components/videoCard/ with PosterCard, RichCard, MagazineCard), why was the thumbnail quality hardcoded to 'high' in useThu

- **cline-pass/kimi-k3**: grade 1 — Earlier maxres-trap analysis of old VideoThumbnailSection, pre-redesign
- **cline-pass/glm-5.2**: grade 2 — Names pre-redesign viewport-based maxres selection mechanism that was lost

Human grade: _(add a label with judge: "human" to settle)_

## entry 97511 — query 93d08b4e (incident)
> Atlas disconnected mid-session attribution unverified root cause Claude Code transcripts

- **cline-pass/kimi-k3**: grade 3 — Directly: mid-session disconnect, tentative attribution, watchdog-death root cause
- **cline-pass/glm-5.2**: grade 0 — Different service (expressvpn), not Atlas disconnection

Human grade: _(add a label with judge: "human" to settle)_

## entry 585411 — query 4899585a (incident)
> safari youtube content process crash problem repeatedly occurred bisect video-inject

- **cline-pass/kimi-k3**: grade 3 — Controlled experiment pinpointing resource-pressure kill during panel/YouTube co-boot
- **cline-pass/glm-5.2**: grade 1 — Resource-pressure kill theory, not about video-inject bisect

Human grade: _(add a label with judge: "human" to settle)_

## entry 586418 — query 4899585a (incident)
> safari youtube content process crash problem repeatedly occurred bisect video-inject

- **cline-pass/kimi-k3**: grade 3 — Final verdict: WebKit stability budget kills report-carrying panel
- **cline-pass/glm-5.2**: grade 1 — Final WebKit budget verdict, not about video-inject bisect

Human grade: _(add a label with judge: "human" to settle)_

## entry 6746 — query c6da40b1 (intent)
> In the DeepCast frontend dashboard redesign (Phase 2a dashboard card system, components/videoCard/ with PosterCard, RichCard, MagazineCard), why was the thumbnail quality hardcoded to 'high' in useThu

- **cline-pass/kimi-k3**: grade 2 — States pixelation root cause (skipped sd tier) in redesign
- **cline-pass/glm-5.2**: grade 1 — Phase 2d hero thumbnail tier fix, different instance

Human grade: _(add a label with judge: "human" to settle)_

## entry 10525 — query c6da40b1 (intent)
> In the DeepCast frontend dashboard redesign (Phase 2a dashboard card system, components/videoCard/ with PosterCard, RichCard, MagazineCard), why was the thumbnail quality hardcoded to 'high' in useThu

- **cline-pass/kimi-k3**: grade 1 — Tier-chain review, excerpt shows no thumbnail reasoning
- **cline-pass/glm-5.2**: grade 0 — Security review of dashboard files, not thumbnail quality

Human grade: _(add a label with judge: "human" to settle)_

## entry 8646 — query c6da40b1 (intent)
> In the DeepCast frontend dashboard redesign (Phase 2a dashboard card system, components/videoCard/ with PosterCard, RichCard, MagazineCard), why was the thumbnail quality hardcoded to 'high' in useThu

- **cline-pass/kimi-k3**: grade 1 — Phase 2a design discussion, no thumbnail resolution content
- **cline-pass/glm-5.2**: grade 0 — Phase 2a layout design, no thumbnail quality discussion

Human grade: _(add a label with judge: "human" to settle)_

## entry 488135 — query c6da40b1 (intent)
> In the DeepCast frontend dashboard redesign (Phase 2a dashboard card system, components/videoCard/ with PosterCard, RichCard, MagazineCard), why was the thumbnail quality hardcoded to 'high' in useThu

- **cline-pass/kimi-k3**: grade 2 — Self-review notes history check overturned framing of hardcoding fix
- **cline-pass/glm-5.2**: grade 1 — Self-review of the fix design, not why high was hardcoded

Human grade: _(add a label with judge: "human" to settle)_

## entry 488096 — query c6da40b1 (intent)
> In the DeepCast frontend dashboard redesign (Phase 2a dashboard card system, components/videoCard/ with PosterCard, RichCard, MagazineCard), why was the thumbnail quality hardcoded to 'high' in useThu

- **cline-pass/kimi-k3**: grade 2 — Explains useThumbnailWithFallback wiring structure in card components
- **cline-pass/glm-5.2**: grade 1 — Self-review of fix design, not about why high was hardcoded

Human grade: _(add a label with judge: "human" to settle)_

## entry 516374 — query ea34a7f1 (definitional)
> nexus dynamic weight

- **cline-pass/kimi-k3**: grade 1 — Display-bug fixes; dynamic weighting only mentioned
- **cline-pass/glm-5.2**: grade 2 — Describes dynamic weighting EMA and provider weight snapshots

Human grade: _(add a label with judge: "human" to settle)_

## entry 366284 — query ea34a7f1 (definitional)
> nexus dynamic weight

- **cline-pass/kimi-k3**: grade 1 — About static weight wiring; dynamic only mentioned
- **cline-pass/glm-5.2**: grade 2 — Names dynamic weighted_routing as the live system contrasted with static

Human grade: _(add a label with judge: "human" to settle)_

## entry 614684 — query ea34a7f1 (definitional)
> nexus dynamic weight

- **cline-pass/kimi-k3**: grade 1 — Lists dynamic among modes without defining it
- **cline-pass/glm-5.2**: grade 2 — Names dynamic as a selectable weighting mode in tenant controls

Human grade: _(add a label with judge: "human" to settle)_

## entry 6851 — query c6da40b1 (intent)
> In the DeepCast frontend dashboard redesign (Phase 2a dashboard card system, components/videoCard/ with PosterCard, RichCard, MagazineCard), why was the thumbnail quality hardcoded to 'high' in useThu

- **cline-pass/kimi-k3**: grade 1 — VideoBackdrop maxres->hqdefault fallback; marginal to card hardcoding question
- **cline-pass/glm-5.2**: grade 0 — Defining quote and backdrop, not thumbnail quality hardcoding

Human grade: _(add a label with judge: "human" to settle)_

## entry 18138 — query c6da40b1 (intent)
> In the DeepCast frontend dashboard redesign (Phase 2a dashboard card system, components/videoCard/ with PosterCard, RichCard, MagazineCard), why was the thumbnail quality hardcoded to 'high' in useThu

- **cline-pass/kimi-k3**: grade 1 — Blurred-backdrop feature overview; aesthetic blur, not resolution/bandwidth decision
- **cline-pass/glm-5.2**: grade 0 — About defining quote and backdrops, not thumbnail quality

Human grade: _(add a label with judge: "human" to settle)_

## entry 488109 — query c6da40b1 (intent)
> In the DeepCast frontend dashboard redesign (Phase 2a dashboard card system, components/videoCard/ with PosterCard, RichCard, MagazineCard), why was the thumbnail quality hardcoded to 'high' in useThu

- **cline-pass/kimi-k3**: grade 2 — Documents DPR/resolution-tier deliberation during the redesign
- **cline-pass/glm-5.2**: grade 1 — Fix limitation, not about why high was hardcoded

Human grade: _(add a label with judge: "human" to settle)_

## entry 390936 — query f43f998d (temporal)
> When was int8 quantization added to Atlas's Qdrant collection and did it require a re-embed?

- **cline-pass/kimi-k3**: grade 1 — Security review of same change; nothing on quantization/re-embed
- **cline-pass/glm-5.2**: grade 0 — Security review, unrelated to int8

Human grade: _(add a label with judge: "human" to settle)_

## entry 614458 — query ea34a7f1 (definitional)
> nexus dynamic weight

- **cline-pass/kimi-k3**: grade 1 — Truncated mention of dynamic weighting in UI redesign summary
- **cline-pass/glm-5.2**: grade 0 — Different project (deepcast), not nexus dynamic weight

Human grade: _(add a label with judge: "human" to settle)_

## entry 367789 — query ea34a7f1 (definitional)
> nexus dynamic weight

- **cline-pass/kimi-k3**: grade 3 — Explains dynamic weight computation: sample window, cadence, min_samples
- **cline-pass/glm-5.2**: grade 2 — Explains dynamic weight sampling window and publish cadence mechanism

Human grade: _(add a label with judge: "human" to settle)_

## entry 364848 — query ea34a7f1 (definitional)
> nexus dynamic weight

- **cline-pass/kimi-k3**: grade 2 — Explains EMA weight decay math and half-life
- **cline-pass/glm-5.2**: grade 1 — Discusses EMA alpha UI math, not dynamic weight definition itself

Human grade: _(add a label with judge: "human" to settle)_

## entry 364766 — query ea34a7f1 (definitional)
> nexus dynamic weight

- **cline-pass/kimi-k3**: grade 3 — States definition: published weight = clamp(ema, min_weight, 1)
- **cline-pass/glm-5.2**: grade 2 — Explains EMA mechanism: published weight = clamp(ema, min_weight, 1)

Human grade: _(add a label with judge: "human" to settle)_

## entry 254743 — query f230e713 (intent)
> Why does the G2P hstats "Available keys — live gauge (last 24h)" (providersKeysChart, pool-health ring) fill lazily one sample per poll while the tab is open, with no background sampler? Was the lazy-

- **cline-pass/kimi-k3**: grade 2 — Diff shows gauge ring null-semantics design comment in stats.html
- **cline-pass/glm-5.2**: grade 1 — Mentions availability sparkline but is a security review, no answer

Human grade: _(add a label with judge: "human" to settle)_

## entry 482681 — query e7da72be (incident)
> What bug fixes were made to the Atlas search hydration, and what was the root cause?

- **cline-pass/kimi-k3**: grade 1 — Atlas investigation but about unused tools, not hydration
- **cline-pass/glm-5.2**: grade 0 — Atlas tools not called, not search hydration bugs

Human grade: _(add a label with judge: "human" to settle)_

## entry 251227 — query f230e713 (intent)
> Why does the G2P hstats "Available keys — live gauge (last 24h)" (providersKeysChart, pool-health ring) fill lazily one sample per poll while the tab is open, with no background sampler? Was the lazy-

- **cline-pass/kimi-k3**: grade 2 — Design doc for pool availability charting; shows deliberate design, omits lazy-fill specifics
- **cline-pass/glm-5.2**: grade 1 — Design doc mentions availability sparkline but not lazy-fill or fix

Human grade: _(add a label with judge: "human" to settle)_

## entry 483675 — query e7da72be (incident)
> What bug fixes were made to the Atlas search hydration, and what was the root cause?

- **cline-pass/kimi-k3**: grade 1 — Atlas tool loss after deploy; different incident, not hydration
- **cline-pass/glm-5.2**: grade 0 — Atlas tools loss in agent sessions, not search hydration

Human grade: _(add a label with judge: "human" to settle)_

## entry 313716 — query e7da72be (incident)
> What bug fixes were made to the Atlas search hydration, and what was the root cause?

- **cline-pass/kimi-k3**: grade 1 — Claims root cause found re mapping, but gives no details
- **cline-pass/glm-5.2**: grade 0 — Root cause about mapping, not Atlas search hydration

Human grade: _(add a label with judge: "human" to settle)_
