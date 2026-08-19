#!/usr/bin/env bash
# `make up` preflight (spec: docs/superpowers/specs/2026-08-19-multi-machine-design.md §3).
#
# 1. Guarantees ~/.atlas/keys exists. Docker turns a missing bind-mount *file*
#    into a directory, which would hand ssh a directory as an identity file —
#    this mount is a directory on purpose (docker-compose.yml), so it must
#    exist before compose ever creates the container.
# 2. Warns — never fails — when config/machines.yaml enables sync to another
#    machine but the dedicated atlas_sync key isn't there yet. Legacy
#    single-machine mode (no machines.yaml) and a fleet with only `self`
#    print nothing.
#
# Run: bash scripts/preflight.sh   (wired into `make up`)
set -euo pipefail
cd "$(dirname "$0")/.."

KEYS_DIR="${ATLAS_KEYS_DIR:-$HOME/.atlas/keys}"
mkdir -p "$KEYS_DIR"

MACHINES_FILE="config/machines.yaml"
[[ -f "$MACHINES_FILE" ]] || exit 0

SELF=""
[[ -f .env ]] && SELF=$(grep -E '^ATLAS_SELF=' .env | tail -1 | cut -d= -f2- || true)

# Minimal YAML walk over `machines:` — not a general parser, just this file's
# shape (2-space `- name:` list items, 4-space fields). `enabled` defaults to
# true (packages/core/src/machines.ts) when the key is absent from a block.
#
# A fleet of exactly one machine has nobody to sync with, so it is exempt
# regardless of whether ATLAS_SELF matches (a fresh checkout with
# machines.yaml but no .env yet — the common local case). With 2+ machines
# and ATLAS_SELF unset, "self" can't be told apart here (fine: boot itself
# already fails loudly on that per selfMachine() in machines.ts — this is
# only a warning).
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
