# Atlas — single entry point (§3.5).

SHELL := /bin/bash

# Configuration reaches compose from two ordered files: the committed defaults,
# then an optional .env that overrides them. Both are passed on EVERY compose
# invocation, which is why the flags live on this variable rather than on the
# targets that obviously need them — interpolation feeds the config hash compose
# uses to decide whether to recreate a container, so a target that omitted them
# would compute a different service definition and recreate containers nothing
# had changed.
#
# `.env` is included only when it exists: `--env-file` on a missing path is a
# hard error ("couldn't find env file"), there is no `required: false` for the
# CLI flag, and .env is absent by default.
#
# Note that passing these suppresses compose's implicit ./.env — which is the
# point, but it does mean a bare `docker compose ...` is no longer equivalent to
# going through make. §3.5: the Makefile is the entry point.
DOTENV := $(wildcard .env)
COMPOSE := docker compose --env-file config/atlas.defaults.env $(if $(DOTENV),--env-file .env,)

# Secrets come from Doppler when a session actually works, and from the files
# otherwise. Any failure — not installed, not logged in, no project selected —
# leaves this empty and the stack runs exactly as before: the only secrets are
# two API keys that are empty unless you point Atlas at a keyed endpoint.
#
# The probe runs the real command rather than something correlated with it.
# `doppler configure get project --plain` looked like the obvious check and is
# useless: with no project configured it exits **0** with empty output, so the
# first version of this detected a working session that immediately failed with
# "You must specify a project". `doppler run --command true` fails exactly when
# the thing we are about to do would fail.
#
# Lazy (`=`, not `:=`) so only the three recipes that reference it pay for the
# probe — otherwise every `make ps` would make a Doppler API round-trip.
DOPPLER = $(shell doppler run --command 'true' >/dev/null 2>&1 && echo 'doppler run --')

.PHONY: help install build test lint up down restart logs ps reindex reindex-full smoke config-check print-compose cli-link kdb-rebuild clean eval eval-mine eval-generate eval-judge eval-baseline eval-signals

# The harness runs on the host, not in a container: a variant has to be a config
# object rather than an image rebuild for an A/B to be possible at all. Ports come
# from .env so they are still defined in exactly one place.
EVAL_ENV := DATABASE_URL=postgres://kdbscope:kdbscope@127.0.0.1:$${POSTGRES_PORT:-5460}/kdbscope \
	QDRANT_URL=http://127.0.0.1:$${QDRANT_PORT:-6363} \
	OLLAMA_URL=http://127.0.0.1:11434 \
	LLM_BASE_URL=http://127.0.0.1:8181/v1
EVAL := npm run --silent build -w packages/core -w packages/eval >/dev/null && $(EVAL_ENV) node packages/eval/dist/main.js

help: ## list targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## install workspace dependencies
	npm install

build: ## typescript builds for all services + ui
	npm run build && npm run build:ui

test: ## unit test suite
	npx vitest run

lint: ## typecheck all packages
	npm run lint

up: ## build images and start the full stack
	$(DOPPLER) $(COMPOSE) up -d --build
	@echo "UI    → http://127.0.0.1:$${UI_PORT:-8712}"
	@echo "API   → http://127.0.0.1:$${API_PORT:-8710}/api/health"
	@echo "MCP   → http://127.0.0.1:$${MCP_PORT:-8711}/mcp"

down: ## stop the stack (data volumes are kept)
	$(COMPOSE) down

# `mcp` is deliberately NOT here. Restarting it drops the atlas_* tools from
# every running Claude Code session and they never come back (the server is
# stateless, so it cannot push tools/list_changed — see packages/mcp/src/main.ts).
# The mcp service is a thin stateless proxy to `api`, so it only needs a restart
# when packages/mcp itself changes: use `make restart-mcp` for that.
restart: ## bounce app services only — does NOT pick up code or .env (see restart-build)
	$(COMPOSE) restart indexer api ui

# The target to reach for after editing anything. `restart` reuses the running
# container exactly as it is — same image, same environment — so it applies
# neither of the two ways this stack changes:
#
#   code    packages/* is COPYed into the image and built there (docker/node.Dockerfile),
#           so a source edit needs --build. A restart re-runs the old bundle.
#   config  .env is read when the CONTAINER is created, not baked into the image,
#           so it needs a recreate rather than a rebuild.
#
# --force-recreate is the part that is easy to get wrong. Compose records
# `env_file` as a *path*, not as resolved values, so editing a variable only read
# that way (KDB_SPARSE_REBUILD, LLM_MODEL, EMBEDDINGS_*) leaves the config hash
# byte-identical and a plain `up -d` decides there is nothing to do — no error,
# no warning, setting silently not applied. Measured 2026-07-29: identical
# `compose config --hash=api` before and after. Variables compose interpolates
# into `environment:` (OLLAMA_URL, API_PORT, CODE_ROOT_HOST) *do* move the hash,
# so the same file behaves two different ways. Forcing the recreate removes the
# distinction rather than asking anyone to remember it.
#
# --no-deps keeps --force-recreate off postgres/redis/qdrant, which are stateful
# and have no reason to bounce. They must already be running: `make up` is the
# cold start. `mcp` is excluded for the reason `restart` excludes it — use
# `make restart-mcp` when packages/mcp itself changed.
restart-build: ## rebuild + recreate app services — the one that applies config AND code
	$(DOPPLER) $(COMPOSE) up -d --build --force-recreate --no-deps indexer api ui

restart-mcp: ## restart the MCP server (WARNING: drops atlas_* tools from live agent sessions)
	@echo "⚠️  This drops the atlas_* tools from every running Claude Code session."
	@echo "   They do NOT return without restarting the session. Ctrl-C to abort."
	@sleep 3
	$(DOPPLER) $(COMPOSE) up -d --no-deps --force-recreate mcp

logs: ## follow service logs
	$(COMPOSE) logs -f --tail 100 indexer api mcp

ps: ## stack status
	$(COMPOSE) ps

reindex: ## trigger an incremental reindex now
	curl -s -X POST http://127.0.0.1:$${API_PORT:-8710}/api/admin/reindex -H 'content-type: application/json' -d '{}' && echo

reindex-full: ## reprocess everything from scratch
	curl -s -X POST http://127.0.0.1:$${API_PORT:-8710}/api/admin/reindex -H 'content-type: application/json' -d '{"full":true}' && echo

smoke: ## poke health + search endpoints of a running stack
	bash scripts/smoke.sh

config-check: ## assert compose resolves configuration the way the design assumes
	bash scripts/config-sources.sh

# Not in help: an accessor so scripts can test the *real* compose invocation
# rather than restating its flags and drifting from it.
print-compose:
	@echo '$(COMPOSE)'

cli-link: ## make the `atlas` command available on this machine
	npm run build -w packages/cli && npm link --workspace packages/cli
	@echo "try: atlas status"

kdb-rebuild: ## regenerate kdb/*.md views from kdb/*.log (never touches logs)
	node bin/kdb_rebuild.mjs

# --- retrieval evaluation (docs/superpowers/specs/2026-07-26-retrieval-eval-harness-design.md)
# `eval` makes no LLM calls: it is retrieval + rerank + metrics, so it is free,
# deterministic and safe to run constantly. The two steps that cost money
# (generate, judge) are separate commands, run rarely and explicitly — bundling
# them in would silently relabel the fixture every committed baseline is pinned to.

eval: ## measure retrieval quality; VARIANT=<name> to A/B, POOL=A CLASS=temporal to focus
	@$(EVAL) run $${VARIANT:+--variant $$VARIANT} $${FLOOR:+--floor $$FLOOR} $${POOL:+--pool $$POOL} $${CLASS:+--class $$CLASS}

eval-mine: ## refresh Pool A from usage_log + Claude transcripts (merges, never overwrites)
	@$(EVAL) mine $${DRY_RUN:+--dry-run}

eval-generate: ## build Pool B (known-item) and Pool N (verified negatives) — costs LLM calls
	@$(EVAL) generate $${POOL_B:+--pool-b $$POOL_B} $${POOL_N:+--pool-n $$POOL_N}

eval-judge: ## grade Pool A candidates — costs LLM calls; TOP_UP=1 for only unlabelled ones
	@$(EVAL) judge $${TOP_UP:+--top-up} $${LIMIT:+--limit $$LIMIT}

eval-baseline: ## record the committed baseline (refuses if retrieval is degraded)
	@$(EVAL) baseline

eval-signals: ## record relevance signals for B4 calibration (no bands, no thresholds)
	@$(EVAL) signals

clean: ## remove build artifacts
	rm -rf packages/*/dist packages/ui/dist
