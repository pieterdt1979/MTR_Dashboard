#!/bin/bash
# Redis bound on host networking. If REDIS_PASSWORD is set it is passed via a generated
# config file in the data dir (mode 0600) so it never shows up in the process list.
set -euo pipefail

REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_BIND="${REDIS_BIND:-0.0.0.0}"
conf=/var/lib/redis/runtime.conf
umask 077
{
  echo "bind ${REDIS_BIND}"
  echo "port ${REDIS_PORT}"
  echo "protected-mode yes"
  echo "dir /var/lib/redis"
  echo "appendonly yes"
  echo "save 300 10"
  echo "maxmemory ${REDIS_MAXMEMORY:-512mb}"
  echo "maxmemory-policy allkeys-lru"
  if [ -n "${REDIS_PASSWORD:-}" ]; then echo "requirepass ${REDIS_PASSWORD}"; fi
} > "${conf}"
exec redis-server "${conf}" "$@"
