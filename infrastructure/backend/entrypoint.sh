#!/bin/bash
# Phase 1 backend entrypoint (replaces backend/docker-entrypoint.sh inside the UBI9 image).
#  * Validates the new Phase 1 environment (PostgreSQL / ClickHouse / Redis).
#  * Maps the new MTR_* variables onto the names mtr_poller.py currently reads.
#  * Warns (does not fail) when the legacy MySQL/MongoDB variables are absent: the current
#    mtr_poller.py still preflights MySQL + MongoDB until it is ported in Phase 2.
set -euo pipefail

missing=""
for v in POSTGRES_HOST POSTGRES_PORT POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD \
         CLICKHOUSE_HOST CLICKHOUSE_PORT CLICKHOUSE_DB CLICKHOUSE_USER CLICKHOUSE_PASSWORD \
         REDIS_HOST REDIS_PORT; do
  [ -n "${!v:-}" ] || missing="$missing $v"
done
if [ -n "$missing" ]; then
  echo "[backend] Missing required env vars:$missing" >&2
  echo "[backend] Copy .env.example to .env and fill it in (podman-compose reads it automatically)." >&2
  exit 1
fi

# MTR_POLL_INTERVAL is in seconds; the existing poller schedules in whole minutes.
poll="${MTR_POLL_INTERVAL:-300}"
mins=$(( poll / 60 )); [ "$mins" -ge 1 ] || mins=1
export POLLING_INTERVAL_MINUTES="${POLLING_INTERVAL_MINUTES:-$mins}"
export MTR_BURST_INTERVAL="${MTR_BURST_INTERVAL:-30}"
export MTR_BURST_MAX_HOURS="${MTR_BURST_MAX_HOURS:-8}"
export LOG_FILE="${LOG_FILE:-/opt/app-root/src/mtr_poller.log}"

for v in MYSQL_HOST MYSQL_USER MYSQL_PASSWORD MYSQL_DATABASE MONGODB_URI MONGODB_DATABASE; do
  if [ -z "${!v:-}" ]; then
    echo "[backend] WARNING: legacy $v not set — current mtr_poller.py preflight requires MySQL/MongoDB" \
         "until the Phase 2 PostgreSQL/ClickHouse port lands." >&2
    break
  fi
done

exec "$@"
