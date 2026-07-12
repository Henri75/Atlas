# ADR: Microservices split with Postgres catalog for Atlas
Date: 2026-07-09

## Status
Accepted

## Context
Atlas indexes ~11 GB of Claude Code transcripts, 20 kdb/ folders, 28 git
repos and project docs, and serves search/ask through UI, CLI, REST and MCP.
The owner explicitly chose an everything-in-Docker deployment and a
microservices topology (scalability was a stated requirement), over a
single-service hybrid alternative. A catalog store was needed alongside Qdrant;
SQLite and PostgreSQL were evaluated.

## Decision
- Seven compose services: indexer (BullMQ workers + cron scheduler), api
  (Hono), mcp (streamable HTTP), ui (nginx+React), qdrant, redis, postgres.
- Catalog on **PostgreSQL 18** (org baseline §10). SQLite rejected: multiple
  containers write concurrently (indexer replicas + api), SQLite's WAL locking
  is unsafe across container mounts, and Postgres brings JSONB, tsvector
  fallback search, window functions and LISTEN/NOTIFY headroom.
- All domain logic in `packages/core`; services stay thin wrappers.
- Host folders mounted **read-only**; the index is a disposable cache.
- Indexer publishes the active Qdrant collection through a `settings` table so
  api/mcp always query the same embedding space.

## Consequences
- Positive: indexer can scale to replicas (scheduler behind a Redis lock);
  clean failure isolation; every surface independently restartable; org
  baseline satisfied.
- Negative: 7 containers for a single-user tool (accepted by owner); Postgres
  migration needs an advisory lock because several services migrate on boot
  (implemented after a real pg_type race on first deployment).
- Operational: first full index is embedding-bound; bundled CPU model is the
  always-works floor, Ollama the recommended accelerator.

## Alternatives Considered
- Single service + Qdrant (+SQLite): simplest ops, fewer moving parts —
  rejected by owner in favor of scalability.
- Python/FastAPI core: strong NLP ecosystem, but splits the stack and loses
  TS-native MCP/CLI maturity.

## References
- Design spec: docs/superpowers/specs/2026-07-09-kdbscope-design.md
- kdb component log: kdb/components/atlas.log (§2.2 entries; the component was named `kdbscope` until the 2026-07-12 rename to Atlas)
