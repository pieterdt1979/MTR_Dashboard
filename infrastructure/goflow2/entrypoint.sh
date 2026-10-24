#!/bin/bash
# Runs goflow2 writing JSON (one flow per line) to a spool file on a volume shared with Vector.
# Every GOFLOW2_ROTATE_SECS the active file is renamed to flows-<epoch>.json and goflow2 is sent
# SIGHUP (it re-opens its output). Vector only tails the rotated files and deletes them once
# fully read, so the spool never grows unbounded.
#   GOFLOW2_OUTPUT=stdout  -> plain JSON to stdout instead (debugging).
set -euo pipefail

SPOOL="${GOFLOW2_SPOOL_DIR:-/var/spool/goflow2}"
NETFLOW_PORT="${GOFLOW2_NETFLOW_PORT:-2055}"
SFLOW_PORT="${GOFLOW2_SFLOW_PORT:-6343}"
METRICS_ADDR="${GOFLOW2_METRICS_ADDR:-127.0.0.1:8081}"
ROTATE="${GOFLOW2_ROTATE_SECS:-15}"
LISTEN="netflow://0.0.0.0:${NETFLOW_PORT},sflow://0.0.0.0:${SFLOW_PORT}"

if [ "${GOFLOW2_OUTPUT:-spool}" = "stdout" ]; then
  exec /usr/local/bin/goflow2 -listen "${LISTEN}" -addr "${METRICS_ADDR}" -format json "$@"
fi

mkdir -p "${SPOOL}"
/usr/local/bin/goflow2 -listen "${LISTEN}" -addr "${METRICS_ADDR}" -format json \
  -transport file -transport.file "${SPOOL}/flows.json" "$@" &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid"; exit 0' TERM INT

while kill -0 "$pid" 2>/dev/null; do
  sleep "${ROTATE}" &
  wait $! || true
  if [ -s "${SPOOL}/flows.json" ]; then
    mv "${SPOOL}/flows.json" "${SPOOL}/flows-$(date +%s%N).json"
    kill -HUP "$pid" 2>/dev/null || true
  fi
done
wait "$pid"
