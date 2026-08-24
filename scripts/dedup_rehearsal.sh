#!/usr/bin/env bash
# Rehearse the dedup-v3 migration (spec §6.6) against a throwaway copy of the
# live catalog: restores the newest backups/*.dump into a disposable Postgres
# container, runs the real migration driver against it, prints the
# verification report, and ALWAYS tears the container down (trap on EXIT).
#
# Never touches the live stack: the container name, host port and volume are
# all scoped to this run, and the live `postgres` service is never addressed.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=kdb-dedup-rehearsal
HOST_PORT=5499
PGUSER=kdbscope
PGPASS=kdbscope
PGDB=kdbscope

# SSoT: the same digest-pinned image the live stack runs, read out of
# docker-compose.yml rather than restated here, so the rehearsal is always
# against the version it will actually run against in production.
PG_IMAGE=$(grep -oE 'postgres:[0-9.]+@sha256:[0-9a-f]+' docker-compose.yml | head -1)
if [[ -z "$PG_IMAGE" ]]; then
  echo "could not find the pinned postgres image in docker-compose.yml" >&2
  exit 1
fi

dump=$(ls -t backups/*.dump 2>/dev/null | head -1 || true)
if [[ -z "$dump" ]]; then
  echo "no backups/*.dump found — run 'make db-dump' first" >&2
  exit 1
fi
echo "→ rehearsing against $dump ($PG_IMAGE)"

cleanup() {
  echo "→ tearing down $CONTAINER"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# In case a previous run was killed before its trap fired.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER="$PGUSER" -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB="$PGDB" \
  -p "127.0.0.1:${HOST_PORT}:5432" \
  "$PG_IMAGE" >/dev/null

echo "→ waiting for the scratch database to accept connections"
# pg_isready alone is not enough: the official postgres image's entrypoint runs
# a TWO-PHASE startup — a temp instance (socket-only) that runs `CREATE
# DATABASE $PGDB`, then a restart into the real instance. pg_isready succeeds
# against the temp instance too, before that CREATE DATABASE has necessarily
# run, so it can report "ready" while $PGDB genuinely does not exist yet.
# Measured on this host (shared, load average ~12 from unrelated projects):
# that race window widened enough for pg_restore to lose it outright. Loop on
# an actual query against the target database instead — the only check that
# is honest about what "ready" needs to mean here.
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" psql -U "$PGUSER" -d "$PGDB" -c 'SELECT 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then
  echo "scratch postgres never became ready (database $PGDB never became queryable)" >&2
  exit 1
fi

echo "→ restoring the dump"
docker exec -i "$CONTAINER" pg_restore -U "$PGUSER" -d "$PGDB" --no-owner --no-privileges < "$dump"

echo "→ building @atlas/core"
npm run --silent build -w packages/core

echo "→ running the dedup-v3 migration driver against the scratch database"
DATABASE_URL="postgres://${PGUSER}:${PGPASS}@127.0.0.1:${HOST_PORT}/${PGDB}" \
  node scripts/dedup_rehearsal_driver.mjs
