# Judge disagreements awaiting arbitration

Generated 2026-07-26T05:33:08.154Z from the 25% double-judged subsample.

Quadratic-weighted κ 0.863 over 29 labels; 72% exact agreement.

8 disagreement(s).

## entry 311477 — query 0ca5960d (incident)
> videoinsight_low starvation fix queue workers

- **cline-pass/kimi-k3**: grade 0 — Unrelated 2025 queue-drain check, different incident
- **cline-pass/glm-5.2**: grade 1 — Mentions queue draining after fix, not videoinsight_low specifically

Human grade: _(add a label with judge: "human" to settle)_

## entry 640693 — query 0ca5960d (incident)
> videoinsight_low starvation fix queue workers

- **cline-pass/kimi-k3**: grade 1 — User requesting video-low fix refinement; contains no answer
- **cline-pass/glm-5.2**: grade 2 — Discusses fixing video-low mismatch and worker pool control

Human grade: _(add a label with judge: "human" to settle)_

## entry 637606 — query 0ca5960d (incident)
> videoinsight_low starvation fix queue workers

- **cline-pass/kimi-k3**: grade 3 — States worker pool layout including dedicated video-low pool consuming low lane
- **cline-pass/glm-5.2**: grade 2 — Shows video-low-pool has only 1 worker, explains starvation mechanism

Human grade: _(add a label with judge: "human" to settle)_

## entry 16430 — query 0ca5960d (incident)
> videoinsight_low starvation fix queue workers

- **cline-pass/kimi-k3**: grade 0 — Troubleshooting worker attrition, different issue
- **cline-pass/glm-5.2**: grade 1 — General troubleshooting, mentions videoinsight queue generically

Human grade: _(add a label with judge: "human" to settle)_

## entry 469118 — query 0ca5960d (incident)
> videoinsight_low starvation fix queue workers

- **cline-pass/kimi-k3**: grade 2 — Fixes LOW-lane zombie requeue loop, part of same starvation hazard
- **cline-pass/glm-5.2**: grade 3 — Directly describes fix for videoinsight_low zombie requeue loop

Human grade: _(add a label with judge: "human" to settle)_

## entry 325234 — query 0ca5960d (incident)
> videoinsight_low starvation fix queue workers

- **cline-pass/kimi-k3**: grade 1 — Mentions queued video jobs vaguely, no starvation answer
- **cline-pass/glm-5.2**: grade 0 — Too vague, not about videoinsight_low starvation

Human grade: _(add a label with judge: "human" to settle)_

## entry 546148 — query 0220b73c (temporal)
> Lycos postgres videos table autovacuum: when were the per-table autovacuum storage parameters (autovacuum_vacuum_scale_factor=0.01, analyze_scale_factor=0.005, cost_delay=0, vacuum_threshold=5000) set

- **cline-pass/kimi-k3**: grade 2 — User prompt quoting stale finding and 028/030 settings origin
- **cline-pass/glm-5.2**: grade 3 — Names migrations 028/030 as source; quotes 925 vs 5.48M finding

Human grade: _(add a label with judge: "human" to settle)_

## entry 538982 — query 0220b73c (temporal)
> Lycos postgres videos table autovacuum: when were the per-table autovacuum storage parameters (autovacuum_vacuum_scale_factor=0.01, analyze_scale_factor=0.005, cost_delay=0, vacuum_threshold=5000) set

- **cline-pass/kimi-k3**: grade 3 — Names exact asked parameters already set, contradicting prior finding
- **cline-pass/glm-5.2**: grade 2 — Confirms parameters exist but not when they were set

Human grade: _(add a label with judge: "human" to settle)_
