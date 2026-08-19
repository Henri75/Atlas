#!/usr/bin/env bash
# `make up` / `make restart-build` preflight (spec:
# docs/superpowers/specs/2026-08-19-multi-machine-design.md §3).
#
# 1. Guarantees ~/.atlas/keys exists. Docker turns a missing bind-mount *file*
#    into a directory, which would hand ssh a directory as an identity file —
#    this mount is a directory on purpose (docker-compose.yml), so it must
#    exist before compose ever creates the container.
# 2. FAILS when config/machines.yaml exists but ATLAS_SELF does not name an
#    entry in it. This is the one hard check, because it is the one condition
#    that takes the whole stack down: machines.yaml is COMMITTED and travels
#    with the checkout, while self-identification is per-machine and lives in
#    a gitignored .env — so the moment the fleet file lands, every machine
#    that has not set ATLAS_SELF boots api into a throw before serve() and
#    the indexer into a crash loop (selfMachine(), packages/core/src/
#    machines.ts). Refusing to start the compose command is strictly better
#    than a half-dead stack with a healthy-looking `up` exit code.
# 3. Warns — never fails — when config/machines.yaml enables sync to another
#    machine but the dedicated atlas_sync key isn't there yet. A fleet with
#    only `self` has nobody to sync with and prints nothing.
#
# Run: bash scripts/preflight.sh   (wired into `make up` and `make restart-build`)
set -euo pipefail
cd "$(dirname "$0")/.."

KEYS_DIR="${ATLAS_KEYS_DIR:-$HOME/.atlas/keys}"
mkdir -p "$KEYS_DIR"

MACHINES_FILE="config/machines.yaml"
[[ -f "$MACHINES_FILE" ]] || exit 0

# Same precedence compose itself uses for `${ATLAS_SELF:-}`: the shell
# environment wins, the project's .env is the fallback. Surrounding quotes
# and stray whitespace/CR are stripped so `ATLAS_SELF="nasta-mbp"` and a
# CRLF .env both resolve to the bare name.
SELF="${ATLAS_SELF:-}"
if [[ -z "$SELF" && -f .env ]]; then
  SELF=$(grep -E '^[[:space:]]*ATLAS_SELF=' .env | tail -1 | cut -d= -f2- || true)
  SELF=$(printf '%s' "$SELF" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
fi

# Minimal YAML walk over `machines:` — not a general parser, just this file's
# shape (2-space `- name:` list items, 4-space fields).
NAMES=$(awk '/^  - name:/ { print $3 }' "$MACHINES_FILE")
FIRST_NAME=$(printf '%s\n' "$NAMES" | head -1)

if [[ -z "$SELF" ]]; then
  {
    echo "❌ $MACHINES_FILE exists but ATLAS_SELF is not set — this machine cannot identify itself."
    echo "   The fleet file is committed and shared; naming yourself is per-machine (gitignored .env)."
    echo "   Fix, then re-run:"
    echo "     echo 'ATLAS_SELF=$FIRST_NAME' >> .env"
    echo "   Known machines: $(printf '%s' "$NAMES" | tr '\n' ' ')"
  } >&2
  exit 1
fi

if ! printf '%s\n' "$NAMES" | grep -qxF -- "$SELF"; then
  {
    echo "❌ ATLAS_SELF=$SELF names no machine in $MACHINES_FILE."
    echo "   Fix, then re-run:"
    echo "     sed -i '' 's/^ATLAS_SELF=.*/ATLAS_SELF=$FIRST_NAME/' .env"
    echo "   Known machines: $(printf '%s' "$NAMES" | tr '\n' ' ')"
  } >&2
  exit 1
fi

# `enabled` defaults to true (packages/core/src/machines.ts) when the key is
# absent from a block. A fleet of exactly one machine has nobody to sync
# with, so it prints nothing regardless of the key's presence.
other_enabled=$(awk -v self="$SELF" '
  /^  - name:/ {
    if (name != "") seen[name] = enabled
    name = $3; enabled = "true"; next
  }
  /^    enabled:/ { enabled = $2; next }
  END {
    if (name != "") seen[name] = enabled
    total = 0
    for (k in seen) total++
    if (total <= 1) exit
    for (k in seen) if (k != self && seen[k] == "true") print k
  }
' "$MACHINES_FILE")

if [[ -n "$other_enabled" && ! -f "$KEYS_DIR/atlas_sync" ]]; then
  {
    echo "⚠️  config/machines.yaml enables sync to: $(echo "$other_enabled" | tr '\n' ' ')"
    echo "   but $KEYS_DIR/atlas_sync is missing — sync jobs will fail until you run:"
    echo "     ssh-keygen -t ed25519 -f $KEYS_DIR/atlas_sync -N ''"
    echo "   (see docs/multi-machine.md for the full add-machine runbook)"
  } >&2
fi

exit 0
