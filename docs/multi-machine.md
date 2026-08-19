2026-08-19 21:59 UTC

# Multi-Machine Operations

## Revision History
- 2026-08-19 21:59 UTC — Initial version (Task 27, multi-machine feature closure).

Atlas runs as **one active instance** that holds THE index and pulls every
other configured machine's code + Claude transcripts over SSH into a local
mirror — it never runs a full stack per machine. Design and rationale:
[`superpowers/specs/2026-08-19-multi-machine-design.md`](superpowers/specs/2026-08-19-multi-machine-design.md);
decision record: [`adr/20260819-multi-machine-one-active-instance.md`](adr/20260819-multi-machine-one-active-instance.md).
This doc is the day-2 operator's runbook: enrolling a machine, moving the
active instance, rolling out the identity migration, opening LAN access, and
the limitations that are load-bearing, not bugs.

## Add-machine runbook

Adding a machine to the fleet means: it becomes a source Atlas mirrors code
and transcripts from (or, if it is where you run the stack, the active
instance's own bind-mounted host). Run these on the **active instance's**
host unless stated otherwise.

1. **Generate a dedicated sync key** — never the operator's personal key —
   on the active instance's host:
   ```bash
   ssh-keygen -t ed25519 -f ~/.atlas/keys/atlas_sync -N ''
   ```
   `~/.atlas/keys` is the default (`ATLAS_KEYS_DIR` overrides it); `make up`'s
   preflight (`scripts/preflight.sh`) creates the directory automatically and
   warns if this key is missing while a remote is enabled.

2. **Install the public key on the new machine**, restricted — it is used for
   nothing but `rsync -e ssh`, so it should be able to do nothing but that.
   Append to `~/.ssh/authorized_keys` on the remote:
   ```
   restrict ssh-ed25519 AAAA...<contents of atlas_sync.pub> atlas_sync@<active-host>
   ```
   `restrict` (OpenSSH ≥ 7.2) disables port/agent/X11 forwarding, PTY
   allocation and `~/.ssh/rc` — a login shell is never needed for rsync.
   Pin the source too if the active instance has a stable LAN IP
   (`restrict,from="192.168.1.20" ssh-ed25519 ...`).

3. **Pin the remote's host key** (TOFU, survives the stack moving later
   because it is committed):
   ```bash
   ssh-keyscan <addr> >> config/known_hosts
   ```

4. **openrsync preflight.** Stock macOS `/usr/bin/rsync` is openrsync
   (protocol 29) and will not work as the sync target — verify Homebrew's
   rsync is what a non-interactive SSH session actually finds:
   ```bash
   ssh <user>@<addr> /opt/homebrew/bin/rsync --version
   ```
   If that fails (missing) or the output says `openrsync` instead of a
   version line naming `protocol version 3x`, install the real thing on the
   remote: `brew install rsync`. (`remoteRsyncPath` in machines.yaml is
   configurable per machine if Homebrew lives somewhere else, e.g. Intel Macs
   at `/usr/local/bin/rsync`.)

5. **Add the machines.yaml entry** — with the machine's REAL paths, never
   invented ones:
   ```bash
   atlas machines add --name m4max --address 192.168.1.30 --user serge \
     --code-root "/Users/serge/CODING" --claude-projects "/Users/serge/.claude/projects"
   ```
   (`--code-root` repeats for more than one tree.) This edits
   `config/machines.yaml` on the checkout — commit and push it (and
   `config/known_hosts` from step 3) so every machine sees the same fleet.
   `enabled` defaults to `true`; for a staged rollout, hand-edit it to
   `false` first and flip it once you've watched the first sync succeed.

6. **Migration-Assistant warning.** If the new machine's `~/.claude/projects`
   was copied wholesale by Migration Assistant (or any full-disk clone) from
   an existing Mac:
   - **Set `ATLAS_SELF=<name>` in the NEW machine's own gitignored `.env`
     FIRST**, before it ever runs the stack — Migration Assistant copies
     `.env` right along with the checkout, so a stale `ATLAS_SELF` pointing
     at the machine it was cloned from is exactly the double-active
     condition the single-active guard (spec §8) exists to catch, loudly,
     if this step is missed.
   - The copied transcripts are **expected to dedup, not re-embed**: dedup
     key v3 scopes Claude transcripts by `claude`/`dirName/fileName` rather
     than by project slug (spec §6), specifically so a byte-identical copy
     of an already-indexed transcript collapses onto the first-recorded
     entry instead of re-embedding the whole corpus under new attribution.
     A genuinely new machine's *unique* content still embeds at local-Ollama
     speed (hours, not minutes, for a large corpus — spec §13).

7. **Distribute the token.** On the new machine (or any host that needs to
   reach the fleet as a client — CLI, `atlas-connect`):
   ```bash
   atlas connect --token <the fleet ATLAS_TOKEN>
   ```
   Writes `~/.atlas/credentials` (mode 0600), then probes the fleet and
   reports the resolved active instance. The token must match `ATLAS_TOKEN`
   on the active instance (Doppler or its `.env` — never committed).

8. **Activate.** On the active instance:
   ```bash
   make restart-build
   ```
   `restart` will not pick this up — `config/machines.yaml` is read at
   container start, not baked into the image (see `docs/operations.md`).
   Watch it come up: `atlas machines` (or `atlas which` to force an
   immediate re-probe, bypassing the resolver's ~5 min cache) should show
   the new machine's sync status move from absent/`unreachable` to `ok`.

## Moving the stack

Moving the active instance to a different host is first-class: data volumes
intentionally stay behind (the index is a rebuildable cache), so the default
is a clean re-pull and re-index on the new host.

```bash
make down     # on the old host — data volumes are kept, not wiped
make up       # on the new host — cold start
```

Clients (CLI, `atlas-connect`, the browser) re-resolve automatically on the
next cache TTL (~5 min) or the next connection failure — nothing to
re-register. `atlas which` forces an immediate re-probe if you don't want to
wait.

**Volume-copy path** (skips the re-pull/re-index, for a large corpus where
that would be expensive): copy the `postgres`, `qdrant`, `redis` and
`remote_mirror` named volumes to the new host, then, before starting the
stack there, re-mint the install identity on the copy:
```sql
DELETE FROM settings WHERE key = 'install_id';
```
A moved stack should carry a fresh identity forward rather than the one it
was copied from — the resolver's `bootId`-based hairpin/clone detection
(spec §8) already tolerates a duplicated `installId` transiently (a fresh
`bootId` per process start still tells a genuine peer apart from "that's
just me"), but this is a permanent move, not a transient double-boot, so the
copy should not go on masquerading as its origin in logs and dashboards.

## Migration rollout ritual (dedup key v3)

The one-time in-place identity migration (spec §6) runs at indexer boot,
under its own advisory lock, recomputing every entry's dedup key from
machine-independent normalized paths instead of absolute container paths —
required before any second machine's mirror can dedup correctly against
this one's content. **Rehearsal is mandatory before the real run:**

```bash
make db-dump          # dumps the live catalog to backups/ — read-only, non-disruptive
make dedup-rehearsal  # restores the dump into a throwaway container, runs the
                       # real migration driver against it, prints a report, always
                       # tears the container down — the live stack is never touched
```

Eyeball the report before proceeding:
- **collisions ≈ 0 expected** — essentially none, single-machine (existing
  content colliding on a v3 key means two rows already share
  project+relative-path+title+content, which pre-migration duplication would
  have to have produced).
- **ordinal groups** are listed and expected in normal use — a `kdb` log's
  line numbers are not stable identity (merges/insertions shift them), so
  identical `(title, contentHash)` rows in the same file get a
  content-occurrence ordinal instead; more than a handful is fine, a huge
  spike is worth a second look before proceeding.

Only after a clean rehearsal:
```bash
make restart-build     # the real migration runs against the live catalog at indexer boot
```

### Wedge recovery

Two things can turn the real migration into a boot restart loop — the
rehearsal's whole purpose is to rule the data-shaped one out beforehand, but
both are possible in the field:

1. **Qdrant unreachable during a collision's point delete.** The migration
   deletes a colliding row's Qdrant points *before* its Postgres row (spec
   §6.4 — points must be confirmed gone first), and it does not retry a
   Qdrant failure on that path by design. An unreachable Qdrant plus a real
   collision therefore wedges the indexer until Qdrant is back — this is the
   ordinary cause. **Fix:** get Qdrant healthy again (`docker compose ps
   qdrant`, `make logs`) and just let the indexer restart; the migration
   resumes from its `settings.dedup_cursor`, so nothing already processed is
   redone.
2. **Collision-refusal guard.** The migration will not delete a row whose
   content does not actually match the one holding its computed key — this
   should be unreachable by construction, so hitting it is a bug report, not
   routine. The indexer log names exactly what to look at, e.g.:
   ```
   dedup migration: entry 4821's v3 key is already held by entry 4790,
   whose title/body differ — refusing to delete content that is not a
   duplicate (processing project 12, kdb/changelog.log)
   ```
   **Inspect the two named rows** before doing anything else:
   ```bash
   docker compose exec -T postgres psql -U kdbscope -d kdbscope -c \
     "SELECT id, project_id, source_path, title, left(body,200) FROM entries WHERE id IN (4821, 4790)"
   ```
   If they are genuinely different content, this is a bug — stop and
   investigate; do not delete rows by hand.

**Only as a last resort**, and only after independently verifying the
catalog is actually complete (every affected row already carries a v3-shaped
key, and `settings.dedup_cursor` covers every `(project_id, source_path)`
pair), stamp the marker manually to unwedge boot:
```sql
UPDATE settings SET value = 'v3' WHERE key = 'dedup_scheme';
```
This is checked *before* the cursor on every future boot, so stamping it
prematurely permanently strands whatever was still unmigrated on old-style
keys — silently breaking cross-machine dedup for exactly that content, for
good. When in doubt, leave the indexer wedged and go fix the actual cause.

## LAN access setup

Off by default: every port binds `127.0.0.1` only until you opt in.

1. Set in the active instance's `.env` (gitignored, per machine):
   ```
   ATLAS_BIND=0.0.0.0
   ATLAS_TOKEN=<a real secret — Doppler is preferred>
   ```
   `api`/`mcp`/`ui` bind to `ATLAS_BIND`; `qdrant`/`redis`/`postgres` always
   stay `127.0.0.1` regardless. Boot **fails closed**: a non-loopback
   `ATLAS_BIND` with no `ATLAS_TOKEN` refuses to start rather than serve the
   LAN unauthenticated.
2. `make restart-build` to apply it.
3. **UI**: shows a one-time token prompt (`TokenGate`) the moment any API
   call comes back 401 — in practice, the first visit with no token stored.
   Saves to `localStorage` and reloads; every API call after that sends it.
4. **Host clients** (CLI, the MCP shim) read the token from
   `~/.atlas/credentials`, written once per machine by `atlas connect
   --token <token>` (step 7 of the add-machine runbook, above).
5. **Claude Code / MCP**: install the shim once per machine —
   ```bash
   make connect-link                    # npm-links atlas-connect onto PATH
   claude mcp add atlas -- atlas-connect
   ```
   This registration never changes again, on any machine, no matter which
   host is currently the active instance — the shim resolves the active
   instance lazily on first tool call and re-resolves once on a mid-session
   failure.

**Threat model, by design:** trusted home LAN over cleartext HTTP, not a
hostile network. The instance-proof protocol (spec §8) guards against
accidental cross-talk and rogue listeners, not an active MITM. Tailscale or
TLS termination is the documented upgrade path for a hostile network, not
shipped in v1.

## Known limitations

- **Fleet-wide non-default `API_PORT` is unsupported.** The resolver
  (`RESOLVER_API_PORT` in `packages/core/src/resolve.ts`) and the continuous
  single-active guard both probe peers on port `8710` by convention, not
  each machine's configured `API_PORT`. Every fleet machine must run `api`
  on the default port or resolution/guarding silently stops seeing it.
- **The `machine` filter is "first ingested from" provenance, not
  presence.** Shared git-synced content (kdb logs, docs, git commits)
  belongs to whichever machine synced it first — filtering by machine does
  **not** mean "exists on machine X". For that, read `project_locations`
  (the `locations` array on `/api/projects`, or `atlas projects`), which
  lists every machine a project actually has a checkout on. Presence-based
  filtering is a documented v2 follow-up (spec §12).
- **A project deleted on a remote keeps its indexed history, by design.**
  `--delete` prunes the mirror, but nothing prunes entries — the
  rebuildable-cache invariant means a vanished source never causes Atlas to
  discard content it already indexed. Visible via the project's missing
  `project_locations` row for that machine, not an error anywhere.
