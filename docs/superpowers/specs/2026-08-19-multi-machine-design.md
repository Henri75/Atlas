2026-08-19 00:30 UTC

# Atlas Multi-Machine Indexing — Design

## Revision History
- 2026-08-19 01:00 UTC — Hardened after two independent reviews. Assessor
  (confirmed): git transient-lock excludes + `GIT_OPTIONAL_LOCKS=0`, jsonl
  include-filter for the Claude mirror; its "git key omits projectSlug"
  blocker was a misreading (overruled with evidence — the slug is the first
  key component for every source) and the key statement was made explicit.
  Adversarial code-verified review (21 findings, 19 adopted as written, 2
  adjusted): new `dedup_scheme` marker (never `id_scheme` — `NAMESPACE`
  bakes in `ID_SCHEME`, `ids.ts:12-20`, so reusing that marker truncates or
  re-embeds everything); git watermark-wedge fix mandated
  (`pipeline.ts:337-345` silently swallows `unknown revision` forever);
  `--partial-dir` replaces `--partial`; probe protocol no longer sends the
  token to unverified endpoints; per-boot `bootId` self-recognition
  (hairpin + cloned-volume cases); precise occurrence-ordinal migration
  rule; claude transcript keys drop the slug (Migration-Assistant copies
  dedup instead of double-embedding); same-slug false-merge acknowledged +
  divergence detection + per-machine slug override; `upsertProject` made
  machine-aware (was last-writer clobber, `catalog.ts:334`);
  `PROJECT_GROUPING` stays v2 with the argument recorded; remote rsync must
  not be openrsync (verified: stock macOS `/usr/bin/rsync` is openrsync
  protocol 29); excludes derived from `IGNORED_DIRS` + `.env*` never
  mirrored; `machine` not Qdrant-indexed in v1 (low selectivity; recent
  payload-index cost work respected); mcp `/health` in the auth exemption;
  loopback check socket-address-only; Qdrant-before-Postgres collision
  deletion; index-retention-on-remote-delete documented; ingest cost +
  staged rollout; token-mismatch error taxonomy; `ATLAS_API_URL` unifies
  with legacy `KDBSCOPE_API_URL`.
- 2026-08-19 00:30 UTC — Initial version (brainstormed and approved in
  session; topology, resolution model, and LAN+auth decided with the user).

## 1. Problem

Atlas indexes exactly one machine. Every identity in the system is an absolute
local path behind a Docker bind mount; there is no machine concept anywhere —
no column, no config key, no payload field, no SSH code. A second Mac
(`serge@m4max`, passwordless SSH key) is entering service. Requirements, as
given and refined:

- Atlas may run on this host **or** m4max (and more machines later).
- It must index **all** configured machines transparently — including
  uncommitted and unpushed work: rsync reads the remote **working tree**, so
  new material is ingested before any git push (git sync is welcome but never
  relied on).
- Adding/configuring machines must be easy (config file + CLI; UI shows the
  config) and the config must be visible.
- The same project can live on several machines, at **different paths**, with
  divergent uncommitted/unpushed work on each.
- Claude Code on the second machine must be able to *use* Atlas (MCP + UI),
  reached over the LAN.
- 100% safe and reliable: a machine being asleep, a sync being interrupted, or
  two stacks being started by accident must never corrupt data or produce
  silently-wrong answers.

## 2. Decisions (settled with the user)

| Decision | Choice | Rejected alternatives |
|---|---|---|
| Topology | **One active instance** holding THE index, pulling from all machines | Full stack per machine (double embed/storage, divergent answers); federated per-machine stacks (cross-Qdrant fusion, degrades when a peer sleeps) |
| Acquisition | **SSH-pull rsync mirror** into a local volume; scanners stay machine-blind | Push agents (parser version skew, write API, breaks the rebuildable-cache invariant); sshfs mounts (FUSE fragility, network-FS semantics break incremental logic) |
| Remote access | **Bind on LAN** with mandatory bearer token (fail closed) | SSH tunnel (kept the localhost posture but user chose LAN); no remote access |
| Finding the active instance | **Verified resolution**: probe the closed candidate set, demand exactly one authenticated instance; continuous single-active guard | mDNS auto-discovery (containers can't mDNS; unauthenticated magic); "first one up wins" (silent split-brain) |
| Cross-machine identity | **dedup key v3**: machine-independent normalized source paths; one-time in-place migration | Keeping path-based keys (double-indexes everything git syncs); full truncate+re-embed (hours of downtime for no extra benefit) |

The invariant that drives all five: **the index stays a rebuildable cache**
(README), all four scanners stay ignorant of machines, and every ambiguous
state resolves to a *loud, named error* rather than a quiet guess — the same
principle as Ask's `scopeFallback`.

## 3. Machine model & configuration (S1)

`config/machines.yaml` — committed, the SSoT, travels with the repo via git so
every machine has the same picture:

```yaml
machines:
  - name: nasta-mbp            # FROZEN identity once data exists (see below)
    address: 192.168.1.20      # IP or DNS name resolvable from peers.
                               # NOT *.local — mDNS does not resolve in containers.
    user: nasta
    codeRoots:
      - "/Users/nasta/__CODING NEW"
    claudeProjects: "/Users/nasta/.claude/projects"
    enabled: true              # false = configured but not synced (staged rollout)
    # remoteRsyncPath: /opt/homebrew/bin/rsync   # default; see openrsync note
    # slugOverrides: { notes: serge-notes }      # per-machine dir-basename → slug
  - name: m4max
    address: 192.168.1.30
    user: serge
    codeRoots:
      - "/Users/serge/CODING"
    claudeProjects: "/Users/serge/.claude/projects"
    enabled: true
sync:
  intervalMin: 10
  excludes: []                 # ADDITIONS to the built-in list, which is derived
                               # from the scanners' IGNORED_DIRS (single source)
                               # + data, coverage, vendor + ".env*" (secrets are
                               # never mirrored; no scanner reads them)
```

- **Self-identification is explicit**: `ATLAS_SELF=<name>` in the running
  machine's gitignored `.env` (exactly what `.env` exists for — one line per
  machine). Boot fails if `ATLAS_SELF` is unset or names no entry. No hostname
  guessing. Runbook warning: Migration Assistant copies `.env` along with a
  checkout — set `ATLAS_SELF` correctly on the new machine *first*; the
  single-active guard (S8) catches the double-active consequence if this is
  missed, loudly.
- **`name` is frozen** once entries exist for it: it appears in
  `entries.machine`, session rows, and mirror paths. Renaming a machine that
  has indexed data is a boot error with guidance; a rename/alias migration is
  out of scope for v1.
- **`slugOverrides`** (per machine) renames a directory basename to a distinct
  slug before discovery, for the deliberate case of two *unrelated*
  same-named projects on different machines (see S5 false-merge note).
- Zod schema in `packages/core` (`machines.ts`); loaded by the config module
  and by the host-side resolver (`ATLAS_MACHINES_FILE` overrides the default
  repo-relative path). `config/` is mounted ro into `indexer` and `api`.
- Config surfaces: edit the YAML; `atlas machines add|remove|list` (the CLI
  runs on the host and owns the checkout, so it may edit the file); the UI
  Machines page is **read-only in v1**. `make config-check` and
  `test/core/configDefaults.test.ts` extend to the new file and env vars.
- `config/known_hosts` — committed, pinned SSH host public keys of every
  machine (host keys are public material; committing them gives TOFU pinning
  that survives moving the stack). Populated via `ssh-keyscan` in the
  add-machine runbook.
- **SSH key**: dedicated `atlas_sync` keypair at `~/.atlas/keys/` on the
  running host (never the personal key). Compose bind-mounts the *directory*
  (`~/.atlas/keys:/keys:ro`) — a directory mount sidesteps Docker's
  missing-file-becomes-directory trap; `make up` preflight creates the
  directory (and warns when the key is absent but remotes are enabled).

## 4. Sync engine — SSH-pull mirror (S2)

New BullMQ job type `sync:<machine>` in the **indexer** (already the only
service with filesystem access and the only one running a subprocess).
Deterministic job id per machine (the existing collision-free idiom,
`scheduler.ts:17-20`), scheduled on its own cadence (`sync.intervalMin`,
default 10), only for machines with `enabled: true`.

Per non-self machine, per source:

```
rsync -a --delete --partial-dir=.rsync-partial --timeout=120 \
      --rsync-path=<remoteRsyncPath, default /opt/homebrew/bin/rsync> \
      --exclude-from=<generated: scanners' IGNORED_DIRS + data, coverage,
                      vendor + ".env*" + git transient state + sync.excludes> \
      -e "ssh -i /keys/atlas_sync -o UserKnownHostsFile=/config/known_hosts -o BatchMode=yes" \
      <user>@<address>:<codeRoot>/   /data/remote/<machine>/code<i>/
      <user>@<address>:<claudeProjects>/  /data/remote/<machine>/claude/
```

The Claude mirror is include-filtered to directories plus `*.jsonl` — the only
thing `listSessionFiles` reads — so stray assets under `~/.claude/projects`
never inflate the volume. Exclude/include lists are **derived from the scanner
constants** (one source of truth, a comment tying them together).

- Mirror lives in a named volume `remote_mirror` mounted at `/data/remote`
  (indexer rw; nothing else mounts it). **Full trees including `.git`** minus
  excludes — one code path: after sync, parsers, byte-offset tail reads and
  local `git log` run against a local filesystem exactly as today.
- **openrsync guard**: stock macOS `/usr/bin/rsync` is openrsync (protocol
  29, verified) and a non-interactive sshd PATH won't find Homebrew's rsync —
  hence the explicit `--rsync-path` (configurable per machine) and an
  add-machine preflight that runs `ssh <host> <remoteRsyncPath> --version`
  and **refuses openrsync**. Runbook: `brew install rsync` on each remote.
- **Safety rails**:
  - `--delete` refuses to run unless the destination matches
    `^/data/remote/<validated machine name>/`; names validated `[a-z0-9-]+`.
  - `--partial-dir=.rsync-partial` (never bare `--partial`, which leaves a
    truncated file under the **final** name — whole-file parsers would index
    truncated bodies that persist forever since entries are never deleted).
    The partial dir is in the scanner ignore list and protected from
    `--delete`.
  - Pre-flight reachability probe (TCP + `ssh BatchMode=yes true`, short
    timeout). Unreachable ⇒ `machine_sync.status='unreachable'`, clean skip —
    an asleep Mac is expected, never error spam.
  - Git transient state is excluded from the sync (`.git/*.lock`,
    `.git/index.lock`, `.git/objects/tmp_*`, `.git/gc.pid`); mirror `git log`
    runs with `GIT_OPTIONAL_LOCKS=0`. A still-transiently-inconsistent
    mirrored `.git` (partial packfile mid-sync) makes that `git log` fail
    into `index_errors`; the `lastSha` watermark does not advance; it
    self-heals next pass. Mirror repos are covered by the existing
    `-c safe.directory=*` invocation (`pipeline.ts:334`).
  - **Watermark-wedge fix (required code change, latent single-machine bug
    made live by mirrors)**: `scanGit` currently swallows
    `unknown revision`/`bad revision` silently and never resets
    `scan_state.ref` (`pipeline.ts:337-345`) — after a remote force-push or
    rebase plus gc, `git log <lastSha>..HEAD` fails **forever** and new
    commits are silently never indexed. v1: when the range fails with
    unknown/bad revision *and* a ref was set, log it, retry as a bounded
    full log (`git log HEAD -n 5000` — dedup keys absorb the overlap), and
    advance the watermark. Mutation-verified test.
  - Append-only tail reads survive rsync's rename (path+offset, not inode).
    The shrink guard **already exists** (`scanClaude` resets the offset when
    `stat.size < state.byteOffset`, `pipeline.ts:278`; `readTailLines`
    guards again at `pipeline.ts:166-170`) — v1 adds test coverage for the
    rsync-shrink case, not new code.
  - A project deleted on a remote is pruned from the mirror by `--delete`
    but its history **stays in the index by design** (rebuildable-cache
    invariant; nothing deletes entries today either). Visible via its
    missing `project_locations` row. Documented, not a defect.
- New table `machine_sync (machine TEXT PK, last_attempt_at,
  last_success_at, status, bytes, duration_ms, error)` feeding CLI/UI
  status. Manual trigger: `make sync-now MACHINE=<name>` →
  `POST /api/admin/sync`.
- `openssh-client` + `rsync` added to `docker/node.Dockerfile` (indexer
  target only).
- **Capacity note**: code trees minus derived-data excludes are small; the
  dominant payload is the remote transcript corpus (11 GB-class here), paid
  once then incremental. The dashboard's mirror-size card (S9) is the
  ongoing check.

## 5. Projects across machines (S3)

- Discovery runs over the self machine's bind-mounted roots (unchanged) and
  over each mirror's roots, every discovered project tagged with its machine.
- **Rule: same slug across machines = same project** — matching the
  git-synced reality of same-named checkouts. **Acknowledged risk** (same
  class the alias ADR accepted and documented): two *unrelated* projects
  sharing a basename (`notes`, `api`, …) on different machines would merge
  silently. Mitigations: (a) a cheap **divergence check** — when a project
  has locations on 2+ machines, compare `git remote get-url origin` (falling
  back to the root-commit sha) across locations and surface a loud warning
  in the dashboard, `atlas machines`, and `index_errors` on mismatch;
  (b) `slugOverrides` in machines.yaml for the deliberate split. Neither
  deletes or re-attributes anything.
- New table `project_locations (project_id INT REFERENCES projects,
  machine TEXT, root_path TEXT, host_path TEXT, has_kdb BOOL,
  UNIQUE (project_id, machine))`.
- **`upsertProject` becomes machine-aware** — today it is last-writer-wins on
  `root_path`/`has_kdb` (`catalog.ts:326-339`) and is called every tick and
  every scan job; left alone, self and mirror discovery would flip-flop the
  scalar. v1: discovery for the **self** machine writes `projects.root_path`
  (+ its `project_locations` row); **remote** discovery writes only
  `project_locations`. Remote-only projects keep `root_path=''` and API/CLI
  render their locations (never a raw mirror container path); the alias
  resolver's non-empty-`rootPath` guard consequently keeps treating
  remote-only projects as non-targets — acceptable for v1 and noted.
- `/api/projects` (and CLI/UI) gain a `locations` array (machine + host
  path); `ScopeBar` tooltip and `atlas projects` render locations.
- **Claude-dir matching becomes machine-aware**: transcript dirs under
  `/data/remote/<machine>/claude/` are matched against *that machine's*
  project locations (encoded host paths), so the second Mac's sessions land
  in the real project instead of path-shaped ghost slugs. The
  fallback-slug + alias machinery stays as the safety net.
- **`PROJECT_GROUPING` stays `v2`, deliberately** (the documented idiom says
  bump on any attribution-rule change, and a bump means
  `resetDerivedData()` + full re-embed): remote dirs have never been
  attributed before, so no existing rows can be mis-hung by the new rule,
  and self-machine attribution is byte-for-byte unchanged. **Ordering
  constraint**: machine-aware matching MUST land before the first
  `sync:<machine>` run, else remote dirs transiently become ghost projects
  that persist (nothing prunes projects). This is a phase-3-internal
  ordering rule.
- `sessions` gains `machine TEXT NOT NULL` (backfilled to the self machine
  name); the value is **set on insert and never overwritten** — both
  machines can hold byte-identical copies of a transcript (see S6), and the
  first recorder keeps attribution rather than flip-flopping with scan
  order.

## 6. Identity — dedup key v3 and migration (S4)

**This is the load-bearing section.** Today `Catalog.dedupKey`
(`catalog.ts:994-1002`) hashes the absolute container `sourcePath`. kdb logs,
git commits, and docs are in git, so both machines hold identical content at
different paths — path-based keys would index and embed all of it twice, and
the error compounds forever.

**v3 key**: `deterministicUuid(<scope>, normalizedSourcePath,
normalizedRef, title, contentHash(body))`:

| Source | scope | normalizedSourcePath | normalizedRef |
|---|---|---|---|
| kdb logs | projectSlug | path relative to project root (`kdb/changelog.log`) | `occ:<k>` — content-occurrence ordinal (below) |
| docs | projectSlug | project-relative path | section anchor (content-derived, stable) |
| git commits | projectSlug | `.` (repo root) | commit sha (globally unique) |
| Claude transcripts | **the literal `claude`** | `<dirName>/<fileName>` | (none) |

- **`projectSlug` remains the first component for every project-file source**
  — normalization changes only the path component, so identical content in
  two *different* projects can never collide across projects; v3 merges
  identity across *machines*, never across projects.
- **Claude transcripts drop the slug from the key, deliberately.** A
  transcript file's identity (`dirName/fileName`, session UUIDs globally
  unique) is stronger than its attribution, and attribution *differs* per
  machine for byte-identical files: the normal way a new Mac enters service
  is Migration Assistant, which copies `~/.claude/projects` wholesale — dirs
  encoding the *old* machine's paths match nothing on the new machine and
  fall to ghost slugs. With the slug in the key, the entire copied corpus
  would re-embed (days of Ollama) and then surface twice through the alias
  view. With `claude` as the scope, byte-identical copies dedup to the
  first-recorded entry regardless of attribution — no re-embed, no
  duplicates. Two different projects cannot share `dirName/fileName/content`,
  so cross-project safety is preserved. The add-machine preflight
  additionally warns when a remote claude dir encodes another machine's
  known root.
- **`sourceRef` participates in identity only where it is content-derived**
  (shas, anchors). kdb lines carry `sourceRef: line:<n>` (`kdbLog.ts:43`) —
  line numbers are NOT stable: git merges of append-only logs interleave
  both machines' tails and shift them; even single-machine, an insertion
  above existing lines re-keys everything below (a latent duplication bug v3
  stops from growing). Identity uses a **content-occurrence ordinal**: the
  k-th occurrence of identical `(title, contentHash)` within the file, in
  file order — deterministic under any reordering. The stored `source_ref`
  column keeps the line number for deep links; a deduped entry keeps the
  first writer's line, which may be off by a few lines on the other machine
  — cosmetic and documented.

**Migration — in place, no truncate, no re-embed**:

1. **New marker `settings.dedup_scheme = 'v3'`, checked and stamped by the
   migration itself.** NEVER `settings.id_scheme`: that marker is compared
   against the `ID_SCHEME` constant at every boot and a mismatch calls
   `resetDerivedData()` (TRUNCATE + collection drop, `main.ts:77-98`); and
   the constant itself is baked into `NAMESPACE` (`ids.ts:12-20`), which is
   hashed into **every** dedup key *and* Qdrant point id — bumping it moves
   every vector. `ID_SCHEME`/`NAMESPACE` stay frozen at v2; v3 changes only
   the *inputs* to `Catalog.dedupKey`.
2. Runs at **indexer boot, before the worker and cron start**, under its
   **own advisory lock (732016)** — never `732015`, which the API also takes
   at boot for schema DDL (`api/src/main.ts:32`); holding that one for a
   multi-minute migration would wedge API restarts and the mcp healthcheck
   chain.
3. Stream all entries in batches; recompute keys from stored columns
   (`source_path` → normalized via the project's known roots; ghost projects
   with `root_path=''` hold only Claude paths → the claude rule). Ordinals
   at migration time: rank among rows sharing
   `(project, normalized path, title, contentHash)` ordered by parsed
   `line:` number, id as tiebreak. Pre-existing line-shift duplicates
   therefore **survive** with distinct ordinals — conservative, zero data
   loss; a *future* genuine occurrence colliding with a stale ordinal row is
   absorbed harmlessly (collision requires identical title+content; only
   the stale line ref differs, same as the documented first-writer rule).
   The rehearsal report lists every ordinal group > 1 for eyeballing; a
   one-time cleanup is a possible follow-up, not v1. A path matching **no**
   known root keeps its full stored path as the normalized form —
   conservative: no false collision possible, no dedup benefit, the
   migration can never fail on an unexpected path. Resumable cursor,
   transactional per batch on the Postgres side.
4. Collisions among *existing* rows (essentially none expected while
   single-machine): keep the lowest id; delete the duplicates' **Qdrant
   points first, Postgres rows second** — a crash between the two leaves
   rows that the resumed migration re-processes, whereas the reverse order
   leaves permanently orphaned points nothing ever reclaims
   (`auditVectorCoverage` walks entries only).
5. Qdrant point ids hash the **stored** `source_path` under the frozen v2
   namespace and are not touched — no vector moves, no re-embed.
6. **Rehearsal is mandatory**: `make db-dump` (new target), restore into a
   scratch container, run the migration there, emit a verification report
   (row counts before/after, collision list, ordinal groups, point-delete
   counts, key samples). The real run only proceeds after a clean rehearsal.

**Provenance**: `entries.machine TEXT NOT NULL` — the machine of **first
ingestion**. For git-shared content this is "whichever synced first":
ingestion provenance, not presence. Backfill existing rows to the self
machine name; plain btree index in Postgres. **The Qdrant payload gains
`machine` but NOT a payload index in v1**: a two-valued low-selectivity
field is exactly the padding-cost case the 2026-08-14 payload-index work
paid down, and unindexed payload filtering is legitimate
(`qdrant.ts:236-242`); revisit only on measured slowness. The Qdrant filter
and the Postgres FTS fallback gain `machine` **together** (the two search
paths must never disagree; the `indexed ⊆ filtered` guard keeps allowing
filter-without-index). Every surface that exposes the filter (CLI `--help`,
MCP tool descriptions, SERVER_INSTRUCTIONS, UI label) states the semantics:
*"first ingested from — shared git-synced content belongs to whichever
machine synced first; for 'exists on machine X' use project locations"*.
Presence-based filtering is a documented follow-up, not v1.

**ADR cross-check**: the alias design (2026-07-26) survives v3 — ghost
entries keep the ghost slug as the key's scope, so normalization cannot
merge them into canonical projects; `alias_of` keeps doing the
presentation-time merge, and that ADR's rejection of re-attribution still
stands (v3 is a key recompute, not a re-index, so its "revisit if a future
re-index happens" clause is not triggered).

## 7. LAN serving + authentication (S5)

- `ATLAS_BIND` (default `127.0.0.1`) parameterizes the compose host-port
  bindings; `0.0.0.0` opts into LAN for api/mcp/ui. Qdrant/Redis/Postgres
  **stay** localhost-only regardless.
- `ATLAS_TOKEN` — secret, via Doppler or `.env`, never committed. Middleware
  in api and mcp requires `Authorization: Bearer <token>` on every route
  except the liveness pair — `/api/health` (api) **and `/health` (mcp,
  `docker-compose.yml:107-111`)** — and `/api/instance` (S8, which carries
  its own proof). The loopback exemption for in-container healthchecks is
  decided by **socket peer address only, never headers** (nginx sets no
  `X-Forwarded-For`; a header-trusting check would be a spoofable bypass).
  **Fail closed**: `ATLAS_BIND` ≠ localhost with no token set refuses to
  boot.
- UI: one-time token prompt stored in `localStorage`, sent on every API
  call.
- Host-side clients read the token from `~/.atlas/credentials` (chmod 600),
  written once per machine by `atlas connect --token …`.
- Threat model, documented: trusted home LAN over cleartext HTTP. The
  instance proof (S8) protects against accidental cross-talk and rogue
  listeners, not an active MITM; Tailscale/TLS is the documented upgrade
  path, not v1. Tokens are never logged (`usage_log` records path/query
  only — kept that way by a test).

## 8. Resolution & single-active guard (S6)

Three clients must find the active instance: the CLI (both machines), MCP
(registered in Claude Code), and the browser.

- **`/api/instance` — unauthenticated challenge, authenticated response.**
  The client sends a random nonce; the response is
  `{machine, installId, bootId, state, entries, proof}` with
  `proof = HMAC-SHA256(token, nonce ‖ canonical-payload)` — the server
  proves it holds the shared token *and* that the payload is untampered,
  **without the client ever sending the token**. This closes the leak in
  the naive design: a bearer-authenticated probe would hand the real token
  to whatever bound the port first (rogue listener, reassigned DHCP lease).
  The resolver sends the token only to the endpoint whose proof validated.
  Replay is inert (fresh client nonce per probe). The endpoint discloses
  machine name/state/counts to unauthenticated LAN callers — accepted and
  documented.
- **Self-recognition via per-boot `bootId`** (random UUID per process
  start), because two failure modes defeat `installId` alone: (a)
  *hairpin* — a stale DNS name or reassigned lease makes the peer's address
  reach **this** instance; matching `bootId` ⇒ "that's me", ignore, never
  self-conflict; (b) *cloned volumes* — the runbook's volume-copy path
  duplicates `installId`, but `bootId` still differs, so a genuine peer
  with a cloned `installId` is correctly detected as a peer. The restore
  runbook also re-mints `installId`; `bootId` is the load-bearing check.
- **Resolver** (in `@atlas/core`, host-side, used by CLI and shim): read
  machines.yaml → probe all candidates in parallel (~800 ms timeout) →
  **demand exactly one** proof-valid, non-conflicted instance. Zero ⇒ error
  naming every host checked. Two, or any `conflicted` ⇒ error listing
  machines, boot epochs, entry counts, and the exact `make down` to run —
  never a silent pick. **Error taxonomy**: a proof *failure* from a machine
  listed in machines.yaml is reported as *"token mismatch on <name> —
  check Doppler/.env"*, distinct from an unknown/rogue responder (otherwise
  a stale `.env` token on one machine masquerades as an attack). Winner
  cached in `~/.atlas/active.json` (TTL ~5 min); connection failure, TTL
  expiry, **or a response carrying `X-Atlas-State: conflicted`** re-probes
  immediately (bounding the stale-conflicted window to one request instead
  of one TTL). `ATLAS_API_URL` is the override env var; the CLI's legacy
  `KDBSCOPE_API_URL` keeps working with a deprecation note (one variable,
  one migration).
- **Continuous single-active guard** (api service): at boot, probe peers —
  a live peer ⇒ refuse to start (clear message; `ATLAS_FORCE_ACTIVE=1`
  escape hatch). While running, re-probe every tick; detecting a live peer
  (a proof-valid responder whose `bootId` ≠ mine) flips **both** instances
  to `state: conflicted` (dashboard banner, resolver refusal). No auto-kill
  — an automated winner could stop the instance with the fresher index
  mid-write; loud refusal is the safe degradation. Closes the asleep-peer
  hole: a peer invisible at boot is caught within one tick of either side
  waking.
- **MCP**: new tiny package `atlas-connect` — a stdio MCP shim registered
  once per machine (`claude mcp add atlas -- atlas-connect`). Always
  starts; resolves lazily on first tool call; bridges stdio ⇄ the active
  instance's streamable-HTTP endpoint with the token; failures returned
  **in-band** as tool results ("no active Atlas instance; checked
  nasta-mbp, m4max"); re-resolves and retries once on mid-session
  connection failure. Registration never changes again, on any machine,
  wherever Atlas runs.
- **CLI** resolves natively; `atlas open` opens the browser at the resolved
  instance; `atlas which` prints the probe table.
- Moving the stack is a first-class operation: `make down` here, `make up`
  there; clients re-resolve on next TTL/failure. Data volumes stay behind
  by design — the new instance re-pulls and re-indexes (rebuildable cache),
  or the operator copies volumes per the runbook (which re-mints
  `installId`).

## 9. Provenance UX & deep links (S7)

- Every search hit / entry / session carries `machine`.
- Path mapping: mirror container paths map to the **remote machine's real
  host path** via machines.yaml; self paths map exactly as today
  (`paths.ts`).
- Editor links: self ⇒ `vscode://file/<path>`; remote ⇒
  `vscode://vscode-remote/ssh-remote+<user>@<address><path>`.
- UI: machine badge on hits and in `EntryDrawer`; `machine` filter in
  search/CLI/MCP (semantics per S6); Dashboard gains per-machine cards
  (last sync, staleness, mirror size) and the divergence warning (S5); new
  **Machines** page (config read-only + sync history). The rail/nav change
  follows the `nav.ts` SSoT idiom.
- MCP: `atlas_search`/`atlas_ask` accept `machine`; `atlas_status` reports
  per-machine sync state; SERVER_INSTRUCTIONS updated (including the
  provenance-vs-presence caveat).

## 10. Failure semantics (the reliability contract)

| Condition | Behaviour |
|---|---|
| Machine asleep during sync | `machine_sync.status='unreachable'`, clean skip, staleness visible — never an error row |
| Machine asleep during resolution | Loud error naming every host probed |
| Both stacks started | Boot refusal; if raced past boot, `conflicted` within one tick on both + resolver refusal with exact remedy |
| Hairpin probe (peer address reaches self) | `bootId` match ⇒ recognized as self, ignored — no false conflict |
| Cloned volumes left running on both machines | `bootId` differs ⇒ genuine conflict detected despite shared `installId` |
| rsync interrupted | Per-file atomic; partials quarantined in `.rsync-partial`, never scanned; converges next pass |
| Mirrored `.git` transiently broken | `git log` fails into `index_errors`, watermark unchanged, self-heals |
| Remote force-push/rebase + gc invalidates `lastSha` | Logged, bounded full-log fallback, watermark advances (dedup absorbs overlap) — never a silent permanent wedge |
| Session/kdb file shrinks below stored offset | Existing shrink guard re-reads from 0; dedup absorbs |
| Project deleted on a remote | Mirror pruned; index retains history by design (visible via missing `project_locations` row) |
| Migration-Assistant-copied `~/.claude/projects` | Byte-identical transcripts dedup under the claude scope — no re-embed, no duplicate hits; preflight warns |
| Same-basename unrelated projects | Divergence check warns loudly (origin URL / root-commit sha mismatch); `slugOverrides` for deliberate splits |
| LAN bind without token | Refuses to boot (fail closed) |
| Token mismatch between machines | Named as such by the resolver ("check Doppler/.env"), distinct from rogue-responder |
| Invalid machines.yaml / unknown `ATLAS_SELF` | Boot error naming the problem |
| Machine renamed with data present | Boot error with guidance |
| Rogue listener on an Atlas port | Cannot produce a valid proof; is **never sent the token**; resolver ignores it |

## 11. Testing (S10)

House idiom throughout: temp trees + stub catalog + `parseConfig`, no live
services (template: `test/indexer/scheduler.test.ts`).

- machines.yaml schema: valid/invalid/rename-frozen/`.local` warning/
  `slugOverrides`/`enabled`.
- Resolver matrix: 0 / 1 / 2 healthy, conflicted, bad proof (known machine ⇒
  token-mismatch message vs unknown responder), hairpin (`bootId` match),
  cloned `installId` + distinct `bootId`, cache expiry,
  revalidate-on-failure, conflicted-header re-probe, `ATLAS_API_URL` +
  legacy var.
- dedup v3 normalization per source type; cross-machine same-content
  collapse; divergent-tail non-collapse; **line-shift stability** (re-scan
  of a reordered/interleaved kdb log produces zero new entries; ordinals
  disambiguate identical lines); claude-scope dedup of byte-identical
  transcripts under different attributions.
- Migration on fixture rows: recompute, ordinal assignment order, collision
  collapse with Qdrant-before-Postgres deletion, resumable cursor, ghost
  paths, no-known-root passthrough.
- `scanGit` watermark wedge: unknown-revision with a set ref ⇒ logged +
  full-log fallback + watermark advance (mutation-verified).
- Discovery: cross-machine merge, per-machine first-wins warning,
  `project_locations` rows, `upsertProject` non-clobber (self vs remote),
  divergence warning.
- Per-machine Claude-dir matching (m4max paths → real project, unknown →
  fallback+alias); `PROJECT_GROUPING` untouched asserted.
- Path mapping + editor URLs (self vs remote).
- Auth middleware: loopback-by-socket-address exempt, both liveness routes
  exempt, bad/missing token 401, fail-closed boot, tokens absent from
  `usage_log`.
- Qdrant `machine` filter + FTS parity (extends the `indexed ⊆ filtered`
  guard; asserts machine is *not* payload-indexed in v1).
- Shim: lazy resolve, in-band error text, re-resolve-once on failure.
- Sync job: destination-prefix guard refuses bad paths; unreachable
  pre-flight → clean skip; exclude list derived from scanner constants
  (guard test ties them); openrsync preflight refusal (ssh/rsync stubbed at
  the exec boundary).
- The migration **rehearsal script is the integration test** for S4.
- Every new guard test is mutation-verified (watch it fail first).

## 12. Out of scope (v1)

- Editing machines from the UI (view-only; file+CLI edit).
- Machine rename/alias migration.
- TLS / hostile-network hardening (documented Tailscale path instead).
- Wake-on-LAN before sync (backlog).
- Multi-active instances / index replication.
- Presence-based (`exists on machine X`) filtering for shared content —
  provenance filter + `project_locations` cover v1; documented follow-up.
- One-time cleanup of pre-existing line-shift duplicate entries (rehearsal
  report will quantify them first).

## 13. Implementation phasing

1. Machine model: machines.yaml + schema + `ATLAS_SELF` +
   `project_locations` + `machine` columns + machine-aware `upsertProject`
   (self-only; no behaviour change).
2. dedup v3 + rehearsed migration + the `scanGit` watermark fix +
   `make db-dump` (riskiest step, done while nothing else is new).
3. Sync engine + mirror discovery + machine-aware Claude matching —
   **matching must be live before the first sync runs** (S5 ordering
   constraint). Staged rollout via `enabled`; initial-ingest expectation
   set in the runbook: a genuinely new Mac is small, a
   Migration-Assistant-provisioned one dedups its copied corpus without
   re-embedding; what remains is embedded at local-Ollama speed
   (~32 entries/s here — hours, not minutes, for a large unique corpus).
4. Provenance UX: filters, badges, deep links, Machines page, MCP surface.
5. LAN bind + token auth + UI token prompt.
6. `/api/instance` + resolver + guard + `atlas-connect` + `atlas
   which`/`open`.
7. Ops: runbooks (add-machine with openrsync/keyscan/token preflight;
   moving the stack; volume copy + `installId` re-mint), remaining Make
   targets (generated help + audit), docs.

Each phase leaves the stack fully working; 5–6 are independent of 3–4 and
could swap order if m4max access is needed sooner.

## References

- Exploration map (this session): chokepoints at `scanners.ts:52-55`,
  `discovery.ts:32-37,71-122`, `catalog.ts:41,43,48-59,326-339,994-1002`,
  `pipeline.ts:125,166-170,278,328-345`, `scheduler.ts:40-62`,
  `qdrant.ts:32-43,236-263`, `config.ts:20-23,127-141`, `ids.ts:12-20`,
  `main.ts:77-98`, `docker-compose.yml:59-67,107-111`.
- ADR `20260726-moved-checkouts-are-aliases-not-duplicates.md` (identity
  precedent; §6 records why v3 does not trigger its revisit clause).
- ADR `20260725-vector-catalog-reconciliation.md`,
  `20260725-ask-answer-trust-contract.md` (loud-degradation principles this
  design extends).
- `docs/superpowers/specs/2026-07-29-configuration-sources-design.md`
  (config precedence the machine model builds on).
- Review trail: Assessor session `356419c424484fc9969c06c5f1451f62`
  (needs-work → addressed/overruled as recorded in the revision history);
  adversarial code-verified review, 21 findings, this revision.
