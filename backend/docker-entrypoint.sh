#!/usr/bin/env sh
set -eu

required_vars="MYSQL_HOST MYSQL_PORT MYSQL_USER MYSQL_PASSWORD MYSQL_DATABASE MONGODB_URI MONGODB_DATABASE"
missing=""

for var in $required_vars; do
  eval value="\${$var:-}"
  if [ -z "$value" ]; then
    missing="$missing $var"
  fi
done

if [ -n "$missing" ]; then
  echo "[backend] Missing required env vars:$missing" >&2
  echo "[backend] Provide them via docker compose --env-file .env.docker up -d" >&2
  exit 1
fi

exec "$@"
