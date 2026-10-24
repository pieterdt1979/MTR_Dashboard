#!/bin/sh
# Phase 1 frontend entrypoint. SESSION_SECRET is mandatory; the legacy auth-user seeder
# (scripts/seed-auth-users.mjs, MySQL-backed) only runs when MySQL settings are supplied.
set -eu

if [ -z "${SESSION_SECRET:-}" ]; then
  echo "[frontend] SESSION_SECRET must be set (min 32 chars) in .env" >&2
  exit 1
fi

if [ -n "${MYSQL_HOST:-}" ] && [ -f ./scripts/seed-auth-users.mjs ]; then
  node ./scripts/seed-auth-users.mjs || echo "[frontend] WARNING: auth-user seeding failed" >&2
else
  echo "[frontend] Legacy MySQL auth seeding skipped (MYSQL_HOST not set; Phase 2 moves auth to PostgreSQL)." >&2
fi

exec "$@"
