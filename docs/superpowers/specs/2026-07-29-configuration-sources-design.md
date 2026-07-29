2026-07-29 18:20 UTC

# Configuration sources: committed defaults, Doppler secrets, `.env` as override

## Status
Accepted — implementing.

## Context

Atlas has one configuration mechanism today: a gitignored `.env`, created by
`make env` from `.env.example`, consumed by compose through `env_file:` and
`${...}` interpolation. It holds host paths, ports, infrastructure URLs, provider
selection, and two API-key slots.

That violates the operating rule that secrets come from Doppler and everything
else from a committed configuration file, with `.env` reserved for optional
overrides. It also produced a concrete bug (2026-07-29): because compose records
`env_file` as a *path* rather than as resolved values, editing a variable read
only that way leaves the config hash byte-identical and `docker compose up -d`
skips the recreate — silently. Variables compose *interpolates* into
`environment:` do move the hash. One file, two behaviours, depending on which
line you edit.

Two facts bound the work:

- **Atlas has no secrets today.** `EMBEDDINGS_API_KEY` and `LLM_API_KEY` are both
  empty: the LLM is the local G2P proxy and the embedder is local Ollama. The
  only credential is `postgres://kdbscope:kdbscope@…`, a fixed pair for a
  container-internal database bound to 127.0.0.1. Doppler therefore buys
  structure now and security later, not security now.
- **Compose needs some values before any Node runs.** Ports and host mount paths
  are interpolated at parse time to build port bindings and volume mounts. No
  file that application code reads can supply them.

## Decision

Three sources, in ascending precedence:

| # | source | holds | committed |
|---|---|---|---|
| 1 | `config/atlas.defaults.env` | everything non-secret: host paths, ports, providers, models, intervals, thresholds | yes |
| 2 | Doppler → shell environment | secrets only (`*_API_KEY`) | n/a |
| 3 | `.env` | anything, for debugging one machine | no (gitignored) |

**The stack must run correctly with no `.env` at all.** That is the default state
after this change; `.env` is absent, not empty-but-present.

### The committed file is in `.env` format, not TOML/JSON/TS

Docker Compose consumes this format natively on both paths it needs:

```yaml
env_file:                    # → container environment
  - config/atlas.defaults.env
  - path: .env
    required: false
```
```bash
docker compose --env-file config/atlas.defaults.env --env-file .env …   # → ${...} interpolation
```

Measured, not assumed (2026-07-29):

- multiple `--env-file`: **later wins**;
- `env_file:` as a list: **later wins**, per key (`BAR` from base, `FOO` from the override);
- `required: false` in `env_file:`: a missing file is tolerated;
- shell environment beats `--env-file` for interpolation — which is exactly how
  Doppler gets to win without any extra wiring;
- **`--env-file` on a missing path is a hard error** (`couldn't find env file`).
  There is no `required: false` for the CLI flag, so the Makefile adds
  `--env-file .env` only when `.env` exists. `.env` is absent by default, so the
  unconditional form would break every target on a clean checkout;
- **an explicit `--env-file` suppresses compose's implicit `./.env`.** Passing
  the defaults file alone makes compose ignore a `.env` that is sitting right
  there.

Every other format (TOML, JSON, a TS module) needs a host-side generator whose
only job is to flatten structure back into the flat `KEY=VALUE` that compose and
`process.env` actually consume. That generator would be a new moving part, and —
because it must run before compose — would make `make up` depend on
`npm install` succeeding on a fresh clone, which it does not today. TOML also
buys structure the config surface does not have: every value here is a scalar
env var.

Comments were the only real advantage TOML had over JSON, and this format has
them.

### Doppler is wired but never required

`make` targets that start the stack run under `doppler run --` **when a Doppler
session is available**, and plainly otherwise. Detection is
`doppler configure get project --plain` succeeding; anything else (not
installed, not logged in, no project configured) falls through silently.

Secrets reach containers through explicit `environment:` entries:

```yaml
environment:
  EMBEDDINGS_API_KEY: ${EMBEDDINGS_API_KEY:-}
  LLM_API_KEY: ${LLM_API_KEY:-}
```

`environment:` outranks `env_file:`, and `${...}` reads the shell first, so a
Doppler-supplied key wins; with no Doppler the same expression resolves from
`--env-file` (defaults, then `.env`); with neither it is empty, which is the
current working state.

Requiring Doppler was rejected: it would take a working local tool offline
whenever a session lapsed, in exchange for protecting two variables that are
empty.

### Implementation notes

**Every compose invocation carries the same flags.** They go on the `COMPOSE`
Make variable, not on individual targets. Interpolation feeds the config hash
compose uses to decide whether to recreate a container, so a target that omits
the flags would compute a *different* service definition and recreate containers
that nothing changed. One definition of `COMPOSE`, used by every target:

```make
DOTENV := $(wildcard .env)
COMPOSE := docker compose --env-file config/atlas.defaults.env \
             $(if $(DOTENV),--env-file .env,)
```

**Doppler wraps every target that creates a container** — `up`, `restart-build`,
`restart-mcp` — because secrets enter a container only at creation. `restart`,
`logs`, `ps`, `down` do not need it. Detection is a `DOPPLER := $(shell …)`
variable that resolves to `doppler run --` or the empty string, evaluated once.

**`make env` is removed.** It creates `.env`, and a present-but-stale `.env` is
exactly the override this design wants absent by default. Targets that declared
`env` as a prerequisite (`up`, `restart-build`) drop it. `.env.example` is
deleted rather than kept: its content is now `config/atlas.defaults.env`, which
is committed and carries the same comments, and an `.example` for a file whose
only correct content is "the one line you want to change" is misleading.

**Running `docker compose` directly is no longer equivalent to `make`.** Without
the flags, compose falls back to the implicit `./.env` — usually absent — and
interpolation then resolves from the inline `${VAR:-default}` values in
`docker-compose.yml`. Those defaults are kept aligned with
`config/atlas.defaults.env` so a direct invocation degrades to something sane
rather than something wrong, but the Makefile stays the supported entry point
(§3.5) and `docs/operations.md` says so explicitly.

## Consequences

- **One delivery path.** Both compose mechanisms read the same ordered pair of
  files, so the `env_file`-vs-interpolation split that hid a silent no-op cannot
  produce two behaviours again. `make restart-build` (added 2026-07-29) remains
  the way to apply a change, because container environment is still fixed at
  creation time.
- **Host paths become committed.** `config/atlas.defaults.env` carries
  `/Users/nasta/__CODING NEW` and `/Users/nasta/.claude/projects`. Consistent
  with `docker-compose.yml`, which already hardcodes both as interpolation
  defaults, and `.env` remains the escape hatch for a second machine. Noted
  because it does bake one machine's layout into the repository.
- **`.env` keeps working exactly as before** for anyone who has one — it is
  simply no longer required, and no longer the only source.
- **Code defaults stay.** `packages/core/src/config.ts` keeps its zod defaults as
  the floor, so the app still boots with no environment at all (tests, the eval
  harness on the host, a bare `node dist/main.js`). The committed file is the
  deployment's answer; zod is the "works out of the box" answer. They are allowed
  to agree; the committed file is what a human edits.

## Non-goals

- Moving `DATABASE_URL`'s credential into Doppler. It is a fixed local pair for a
  container-internal database with no published port beyond 127.0.0.1; treating
  it as a secret would imply rotation machinery for something that cannot be
  reached from off-box.
- Restructuring `config.ts`. Its zod schema and env-var names are unchanged; this
  is about where the values come from, not how they are parsed.

## Test plan

| what | how |
|---|---|
| every var `config.ts` reads has a key in the committed file | unit test: scrape `env.X` from `config.ts` source, diff against the file's keys, minus a declared allow-list of intentionally-unset slots (`CODE_ROOT_HOST_2..5`, the API keys, `EMBEDDINGS_BASE_URL`) |
| the committed file has no key the app ignores | same test, other direction — a stale key is a lie about what is configurable |
| the stack resolves with **no** `.env` | `docker compose config` with only the defaults file; assert ports and mounts are populated |
| `.env` overrides the defaults | compose config with a temp `.env`; assert the override wins for both interpolation and container env |
| a missing `.env` breaks nothing | run the Makefile's own `COMPOSE` expansion on a checkout with no `.env` |
| secrets resolve from shell over files | compose config with the var set in the environment; assert it beats the file |
| Doppler absence is not an error | assert the `DOPPLER` variable is empty and targets still run when `doppler` is missing or unconfigured |

The first two are vitest (they read TypeScript). The compose-level ones are a
shell script under `scripts/`, run by `make smoke`-style invocation, because they
assert compose's behaviour rather than ours — and this design rests on four
measured compose behaviours that a future compose release could change.
