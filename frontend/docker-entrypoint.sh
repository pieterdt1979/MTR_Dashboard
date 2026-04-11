#!/usr/bin/env sh
set -eu

required_vars="MYSQL_HOST MYSQL_PORT MYSQL_USER MYSQL_PASSWORD MYSQL_DATABASE MONGODB_URI SESSION_SECRET"
missing=""

for var in $required_vars; do
  eval value="\${$var:-}"
  if [ -z "$value" ]; then
    missing="$missing $var"
  fi
done

if [ -n "$missing" ]; then
  echo "[frontend] Missing required env vars:$missing" >&2
  echo "[frontend] Provide them via docker compose --env-file .env.docker up -d" >&2
  exit 1
fi

node /app/scripts/seed-auth-users.mjs

exec "$@"
