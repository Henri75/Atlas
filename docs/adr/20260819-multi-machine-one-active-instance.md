# ADR: Multi-Machine — One Active Instance, SSH-Pull Mirror, Dedup Key v3
Date: 2026-08-19

## Status
Accepted

## Context

Atlas indexed exactly one machine: every identity in the system was an
absolute local path behind a Docker bind mount, with no machine concept
anywhere — no column, no config key, no payload field, no SSH code. A second
Mac (`m4max`) entered service, and Atlas needed to index both, transparently,
including uncommitted/unpushed work, with the same project sometimes living
on both machines at different paths with divergent local state. Requirements
(full detail:
[`superpowers/specs/2026-08-19-multi-machine-design.md`](../superpowers/specs/2026-08-19-multi-machine-design.md)):

- Index all configured machines, including work never pushed to git.
- Adding a machine must be easy (config file + CLI) and its config visible.
- Claude Code on any machine must be able to use Atlas (MCP + UI) over the LAN.
- 100% safe: an asleep machine, an interrupted sync, or two stacks started by
  accident must never corrupt data or produce a silently-wrong answer.

## Decision

- **One active instance holds THE index**, pulling from every configured
  machine — not a full stack per machine (which would double-embed and
  double-store, and produce divergent answers depending which machine you
  asked) and not federated per-machine stacks (cross-Qdrant fusion degrades
  the moment a peer sleeps).
- **Acquisition is an SSH-pull rsync mirror** into a local Docker volume; the
  four scanners stay entirely machine-blind and read the mirror exactly like
  a local checkout. Rejected: push agents (parser version skew, a write API,
  breaks the rebuildable-cache invariant) and sshfs mounts (FUSE fragility,
  network-FS semantics break incremental byte-offset reads).
- **Remote access binds on the LAN** with a mandatory bearer token, fail
  closed (a non-loopback bind with no token refuses to boot). Qdrant, Redis
  and Postgres never leave loopback regardless.
- **Finding the active instance is verified, never guessed**: a nonce-HMAC
  challenge/proof protocol (`/api/instance`) lets a resolver probe every
  configured machine and demand exactly one proof-valid, non-conflicted
  responder. Zero or two-plus is a loud, named error — never a silent pick
  (the same principle as Ask's `scopeFallback`). A continuous single-active
  guard re-probes while running, so a peer that wakes up mid-session is
  caught within one tick.
- **Cross-machine identity is dedup key v3**: entry identity moves from
  hashing the absolute container `sourcePath` to hashing a machine-independent
  normalized path (project-relative for kdb/docs, `.`  + commit sha for git,
  `dirName/fileName` scoped to the literal `claude` namespace for
  transcripts — deliberately dropping the project slug there so a
  Migration-Assistant-copied `~/.claude/projects` corpus dedups instead of
  re-embedding under new attribution). Migrated in place, one time,
  resumable, rehearsed against a throwaway copy of the live catalog before
  ever touching it for real (`make db-dump` + `make dedup-rehearsal`). No
  vector moves and no re-embed: Qdrant point ids still hash the *stored*
  `source_path` under the frozen v2 id namespace.

## Consequences

**Positive:**
- A single index, one place to ask, correct regardless of which machine's
  files answer a question.
- New machines enrol with a config-file entry + CLI command; no code change,
  no re-embed of existing content, and — for the Migration-Assistant case —
  no re-embed of the copied transcripts either.
- Every ambiguous state (asleep peer, interrupted sync, two stacks started at
  once, a stale mirror `.git`) resolves to a documented, loud failure mode
  rather than a silent wrong answer (spec §10's failure-semantics table).

**Negative / operational impacts:**
- **Security**: the threat model is deliberately "trusted home LAN over
  cleartext HTTP," not a hostile network. The instance-proof protocol stops
  accidental cross-talk and rogue listeners, not an active MITM; Tailscale or
  TLS is the documented upgrade path, not shipped.
- **Reliability**: the active instance is a single point of index
  availability (not of source data — the mirror is a rebuildable cache, and
  moving the stack is a first-class, documented operation). No index
  replication in v1.
- **Cost/perf**: a large corpus's first sync pays a real embedding bill
  (hours, not minutes, at local-Ollama throughput) — mitigated for the common
  case (git-synced content, Migration-Assistant-copied transcripts) by v3
  dedup absorbing it without a single extra embed call.
- **Known gaps, accepted for v1** (documented in
  [`multi-machine.md`](../multi-machine.md#known-limitations)): the fleet
  cannot mix non-default `API_PORT`s (resolver/guard probe `8710` by
  convention); the `machine` filter is ingestion provenance, not presence
  ("exists on machine X" needs `project_locations` instead); a project
  deleted on a remote keeps its indexed history by design.

## Alternatives Considered

- **Full stack per machine** — rejected: double embeds/stores everything
  shared via git, and two machines could answer the same question
  differently depending which one you happened to ask.
- **Federated per-machine stacks with cross-Qdrant fusion** — rejected:
  degrades the moment any one peer is asleep, and fusion ranking across
  independently-scored collections is its own unsolved problem.
- **Push agents** (each machine pushes its own index data to the active
  instance) — rejected: introduces parser version skew between machines and
  a write API, breaking the "index is a rebuildable cache" invariant the
  rest of the system leans on.
- **sshfs mounts** instead of an rsync mirror — rejected: FUSE fragility and
  network-filesystem semantics (partial reads, unstable inode behavior on
  reconnect) break the incremental byte-offset tail-read strategy transcripts
  and kdb logs depend on.
- **mDNS auto-discovery** for finding the active instance — rejected:
  containers cannot do mDNS, and an unauthenticated "first responder wins"
  discovery is exactly the silent-guess failure mode this design exists to
  avoid.
- **"First one up wins" for the single-active question** — rejected: silent
  split-brain, no way to tell which instance is authoritative after the
  fact.
- **Keeping path-based dedup keys** — rejected: every git-synced file
  (kdb logs, docs, commits) would double-index the instant a second machine
  entered service, and the error compounds forever since nothing prunes
  entries.
- **Full truncate + re-embed** for the identity change instead of an
  in-place migration — rejected: hours of downtime re-embedding ~475k
  entries for no benefit an in-place key recompute doesn't already deliver.

## References

- Spec: [`superpowers/specs/2026-08-19-multi-machine-design.md`](../superpowers/specs/2026-08-19-multi-machine-design.md)
- Runbook: [`multi-machine.md`](../multi-machine.md)
- KDB: `kdb/components/atlas.log` (multi-machine feature entry, Task 27)
- Precedent this design extends without triggering its revisit clause:
  [`20260726-moved-checkouts-are-aliases-not-duplicates.md`](20260726-moved-checkouts-are-aliases-not-duplicates.md)
- Loud-degradation principles this design continues:
  [`20260725-vector-catalog-reconciliation.md`](20260725-vector-catalog-reconciliation.md),
  [`20260725-ask-answer-trust-contract.md`](20260725-ask-answer-trust-contract.md)
