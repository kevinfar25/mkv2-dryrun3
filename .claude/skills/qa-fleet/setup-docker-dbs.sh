#!/usr/bin/env bash
#
# qa-fleet: stand up ONE local Postgres container holding N isolated per-group
# databases, each a full clone of the PRODUCTION dump. One container, many DBs =
# write-isolation per group without the resource cost of N containers.
#
# Usage:
#   ./setup-docker-dbs.sh <N> [CONTAINER] [HOST_PORT]
#     N          number of per-group DBs to create (goose_g1..goose_gN)
#     CONTAINER  docker container name        (default: goose-qa-pg)
#     HOST_PORT  host port -> 5432 in container (default: 55432)
#
# Reads DATABASE_URL from ./.env.local (run from the repo root). NEVER prints the
# secret. Prod is the transaction pooler :6543 which pg_dump cannot use, so it
# swaps to the session pooler :5432 and adds sslmode=require. Prod is PG17, so the
# dump client + local server are both postgres:17-alpine (pg_dump must be >= server).
#
# After it runs, each group's DB is reachable at:
#   postgresql://postgres:localqa@127.0.0.1:<HOST_PORT>/goose_g<i>
#
# Teardown:  docker rm -f <CONTAINER>
set -euo pipefail

N="${1:?usage: setup-docker-dbs.sh <N> [container] [host_port]}"
CTR="${2:-goose-qa-pg}"
HOST_PORT="${3:-55432}"
ROOT="$(pwd)"
[[ -f "$ROOT/.env.local" ]] || { echo "No .env.local in $ROOT — run from the repo root." >&2; exit 1; }

echo "[qa-fleet] pulling postgres:17-alpine…"
docker pull postgres:17-alpine >/dev/null

echo "[qa-fleet] starting container $CTR on host port $HOST_PORT…"
docker rm -f "$CTR" >/dev/null 2>&1 || true
docker run -d --name "$CTR" -e POSTGRES_PASSWORD=localqa -p "${HOST_PORT}:5432" postgres:17-alpine >/dev/null
# wait for readiness
for _ in $(seq 1 30); do docker exec "$CTR" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$CTR" pg_isready -U postgres >/dev/null 2>&1 || { echo "container never became ready" >&2; exit 1; }

# Build the session-pooler URL from .env.local without echoing it.
url=$(grep -E '^DATABASE_URL=' "$ROOT/.env.local" | head -1 | sed 's/^DATABASE_URL=//; s/^"//; s/"$//')
session_url=$(echo "$url" | sed -E 's#:6543/#:5432/#')
case "$session_url" in
  *sslmode=*) ;;
  *\?*) session_url="${session_url}&sslmode=require";;
  *)    session_url="${session_url}?sslmode=require";;
esac

echo "[qa-fleet] dumping prod public schema (read-only)…"
docker run --rm postgres:17-alpine pg_dump "$session_url" \
  --schema=public --no-owner --no-privileges --no-publications --no-subscriptions \
  > /tmp/qa-fleet-dump.sql
echo "[qa-fleet] dump size: $(du -h /tmp/qa-fleet-dump.sql | cut -f1)"

echo "[qa-fleet] restoring into goose_base…"
docker exec "$CTR" psql -U postgres -c "DROP DATABASE IF EXISTS goose_base;" >/dev/null
docker exec "$CTR" psql -U postgres -c "CREATE DATABASE goose_base;" >/dev/null
docker exec -i "$CTR" psql -U postgres -d goose_base -v ON_ERROR_STOP=0 < /tmp/qa-fleet-dump.sql > /tmp/qa-fleet-restore.log 2>&1
# only benign error expected: schema "public" already exists
if grep -iE 'ERROR' /tmp/qa-fleet-restore.log | grep -viE 'already exists' | head -1 | grep -q .; then
  echo "[qa-fleet] WARNING — non-benign restore errors:" >&2
  grep -iE 'ERROR' /tmp/qa-fleet-restore.log | grep -viE 'already exists' | head -5 >&2
fi
echo "[qa-fleet] base sanity: $(docker exec "$CTR" psql -U postgres -d goose_base -tA -c "SELECT 'users='||count(*) FROM users;")"

echo "[qa-fleet] cloning $N per-group databases via TEMPLATE…"
for i in $(seq 1 "$N"); do
  docker exec "$CTR" psql -U postgres -c "DROP DATABASE IF EXISTS goose_g$i;" >/dev/null
  docker exec "$CTR" psql -U postgres -c "CREATE DATABASE goose_g$i TEMPLATE goose_base;" >/dev/null
  echo "  goose_g$i ready"
done

echo "[qa-fleet] DONE. Per-group DSN: postgresql://postgres:localqa@127.0.0.1:${HOST_PORT}/goose_g<i>"
docker exec "$CTR" psql -U postgres -tA -c "SELECT datname FROM pg_database WHERE datname LIKE 'goose_%' ORDER BY datname;"
