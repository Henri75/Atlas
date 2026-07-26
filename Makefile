# Atlas — single entry point (§3.5).

SHELL := /bin/bash
COMPOSE := docker compose

.PHONY: help env install build test lint up down restart logs ps reindex reindex-full smoke cli-link kdb-rebuild clean eval eval-mine eval-generate eval-judge eval-baseline eval-signals

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

env: ## create .env from the example if missing
	@test -f .env || (cp .env.example .env && echo "created .env — review paths/providers")

install: ## install workspace dependencies
	npm install

build: ## typescript builds for all services + ui
	npm run build && npm run build:ui

test: ## unit test suite
	npx vitest run

lint: ## typecheck all packages
	npm run lint

up: env ## build images and start the full stack
	$(COMPOSE) up -d --build
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
restart: ## restart app services (keeps infra running; leaves mcp connected)
	$(COMPOSE) restart indexer api ui

restart-mcp: ## restart the MCP server (WARNING: drops atlas_* tools from live agent sessions)
	@echo "⚠️  This drops the atlas_* tools from every running Claude Code session."
	@echo "   They do NOT return without restarting the session. Ctrl-C to abort."
	@sleep 3
	$(COMPOSE) up -d --no-deps --force-recreate mcp

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
