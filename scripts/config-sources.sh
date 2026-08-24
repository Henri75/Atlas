#!/usr/bin/env bash
# Assertions about how Docker Compose resolves this repo's configuration.
#
# Separate from the vitest suite on purpose: these test *compose*, not our
# TypeScript. The design in docs/superpowers/specs/2026-07-29-configuration-sources-design.md
# rests on six measured compose behaviours — layering order for `--env-file` and
# for `env_file:`, `required: false`, shell-beats-file, a missing `--env-file`
# being fatal, and an explicit `--env-file` suppressing the implicit ./.env. A
# compose release could change any of them, and every one fails silently: the
# stack still starts, with the wrong values.
#
# Run: bash scripts/config-sources.sh   (or `make config-check`)
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0; fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n     %s\n' "$1" "$2"; fail=$((fail+1)); }
check() { # check <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected '$2', got '$3'"; fi
}

# The Makefile owns the flags; ask it rather than restating them, or this tests a
# command line nothing actually runs.
COMPOSE_CMD=$(make -s print-compose)
# The env file derives CODE_ROOT_HOST from this; make exports it to its own
# recipes, but we run compose directly, so export it here too.
export ATLAS_REPO_PARENT="$(make -s print-repo-parent)"
echo "compose invocation under test: $COMPOSE_CMD"

cfg() { $COMPOSE_CMD config "$@" 2>&1; }

echo
echo "Resolution with the committed defaults:"

# Whether .env exists is the developer's business; these assertions must hold
# either way, so they read the resolved value rather than a hardcoded expectation
# where an override is legitimate.
api_port=$(cfg | grep -oE 'published: "[0-9]+"' | head -1 | grep -oE '[0-9]+')
[[ -n "$api_port" ]] && ok "port bindings resolve (published: $api_port)" \
  || bad "port bindings resolve" "no published port in the rendered config"

mounts=$(cfg | grep -c 'source: /' || true)
[[ "$mounts" -gt 0 ]] && ok "volume mounts resolve ($mounts source paths)" \
  || bad "volume mounts resolve" "no absolute source paths in the rendered config"

# Every var the app needs must reach the container, not merely interpolate.
for v in DATABASE_URL QDRANT_URL EMBEDDINGS_PROVIDER LLM_PROVIDER SCAN_INTERVAL_MIN; do
  cfg | grep -q "$v:" && ok "$v reaches the container environment" \
    || bad "$v reaches the container environment" "absent from the rendered config"
done

# Secrets are declared so Doppler can fill them; empty is the correct resting state.
cfg | grep -q 'EMBEDDINGS_API_KEY:' && ok "secret slots are declared for Doppler to fill" \
  || bad "secret slots are declared" "EMBEDDINGS_API_KEY missing from environment:"

echo
echo "Precedence:"

# Shell beats both files — this is the whole mechanism by which `doppler run --`
# wins without any Atlas-specific wiring.
shell_wins=$(LLM_API_KEY=from-shell cfg | grep -oE 'LLM_API_KEY: .*' | head -1)
check "shell environment beats the config files (the Doppler path)" \
  "LLM_API_KEY: from-shell" "$shell_wins"

# .env overrides the committed defaults. Uses a var with no compose-level
# interpolation default, so the value can only have come from the file.
if [[ -e .env ]]; then
  ok "SKIP .env-override check (a real .env is present; not touching it)"
else
  printf 'SCAN_INTERVAL_MIN=99\n' > .env
  override=$($(make -s print-compose) config 2>&1 \
    | grep -oE 'SCAN_INTERVAL_MIN: "?[0-9]+"?' | head -1 | grep -oE '[0-9]+')
  rm -f .env
  check ".env overrides the committed defaults" "99" "$override"
fi

# A missing .env must not break anything — it is the default state.
if [[ ! -e .env ]]; then
  cfg >/dev/null && ok "no .env present is not an error" \
    || bad "no .env present is not an error" "compose config failed without a .env"
fi

echo
echo "Doppler:"

# Absence must be silent. The first version of the detection used
# `doppler configure get project --plain`, which exits 0 with empty output when
# nothing is configured — so it claimed a working session and `make restart-build`
# died with "You must specify a project". Probe the operation, not a correlate.
if doppler run --command 'true' >/dev/null 2>&1; then
  ok "doppler session works; secrets will be injected"
else
  # The stack must be fully operable in this state, which is today's state.
  if $COMPOSE_CMD config >/dev/null 2>&1; then
    ok "no usable doppler session, and the stack still resolves (secrets stay empty)"
  else
    bad "no usable doppler session is tolerated" "compose config failed without doppler"
  fi
fi

echo
if (( fail )); then
  printf '\033[31m%d failed\033[0m, %d passed\n' "$fail" "$pass"; exit 1
fi
printf '\033[32mall %d checks passed\033[0m\n' "$pass"
