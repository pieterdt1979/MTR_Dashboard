#!/bin/bash
# Start clickhouse-server, apply idempotent schema files into ${CLICKHOUSE_DB}, then
# stay attached to the server process (signals are forwarded for clean shutdown).
set -euo pipefail

: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD must be set}"
CLICKHOUSE_DB="${CLICKHOUSE_DB:-mtr}"
CLICKHOUSE_USER="${CLICKHOUSE_USER:-default}"
CLICKHOUSE_PORT="${CLICKHOUSE_PORT:-9000}"
export CLICKHOUSE_HTTP_PORT="${CLICKHOUSE_HTTP_PORT:-8123}" CLICKHOUSE_PORT

/usr/bin/clickhouse-server --config-file=/etc/clickhouse-server/config.xml &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid"' TERM INT

# clickhouse-client reads CLICKHOUSE_USER / CLICKHOUSE_PASSWORD from the environment,
# so the secret never appears on a command line.
ch() { clickhouse-client --host 127.0.0.1 --port "${CLICKHOUSE_PORT}" "$@"; }

for _ in $(seq 1 60); do
  if ch --query "SELECT 1" >/dev/null 2>&1; then break; fi
  kill -0 "$pid" 2>/dev/null || { echo "[clickhouse] server exited during startup" >&2; wait "$pid"; exit 1; }
  sleep 1
done

ch --query "CREATE DATABASE IF NOT EXISTS \`${CLICKHOUSE_DB}\`"
for f in /docker-entrypoint-initdb.d/*.sql; do
  [ -e "$f" ] || continue
  echo "[clickhouse] Applying $f to ${CLICKHOUSE_DB}"
  ch --database "${CLICKHOUSE_DB}" --multiquery < "$f"
done
echo "[clickhouse] Schema ready"

wait "$pid"
