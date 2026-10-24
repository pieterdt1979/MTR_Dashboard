#!/bin/bash
# First-boot initdb + role/database bootstrap from environment, then exec postgres.
# Secrets come exclusively from the environment (.env); nothing is baked into the image.
set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
PGDATA="${PGDATA:-/var/lib/pgsql/data}"
export PGDATA

if [ ! -s "${PGDATA}/PG_VERSION" ]; then
  echo "[postgres] Initialising new cluster in ${PGDATA}"
  pwfile="$(mktemp)"
  printf '%s' "${POSTGRES_PASSWORD}" > "${pwfile}"
  # Bootstrap superuser is the application owner; password via file (never argv).
  initdb -D "${PGDATA}" -U "${POSTGRES_USER}" --pwfile="${pwfile}" \
         --encoding=UTF8 --locale=C.UTF-8 --auth-local=trust --auth-host=md5
  rm -f "${pwfile}"

  # local trust (unix socket inside the container only) + host md5.
  # password_encryption=scram-sha-256: md5 hba entries transparently accept SCRAM verifiers.
  cat > "${PGDATA}/pg_hba.conf" <<'EOF'
# TYPE  DATABASE  USER  ADDRESS        METHOD
local   all       all                  trust
host    all       all   127.0.0.1/32   md5
host    all       all   ::1/128        md5
host    all       all   0.0.0.0/0      md5
host    all       all   ::/0           md5
EOF

  cat >> "${PGDATA}/postgresql.conf" <<EOF
# --- MTR Phase 1 overrides ---
listen_addresses = '0.0.0.0'
port = ${POSTGRES_PORT}
password_encryption = 'scram-sha-256'
unix_socket_directories = '/var/run/postgresql'
logging_collector = off
log_destination = 'stderr'
shared_preload_libraries = 'pg_stat_statements'
max_connections = 200
shared_buffers = 512MB
EOF

  # Temporary socket-only server to create the DB and run init scripts.
  pg_ctl -D "${PGDATA}" -o "-c listen_addresses='' -p ${POSTGRES_PORT}" -w start
  psql -v ON_ERROR_STOP=1 -h /var/run/postgresql -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" -d postgres \
       -c "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";"
  for f in /docker-entrypoint-initdb.d/*.sql; do
    [ -e "$f" ] || continue
    echo "[postgres] Applying $f"
    psql -v ON_ERROR_STOP=1 -h /var/run/postgresql -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -f "$f"
  done
  pg_ctl -D "${PGDATA}" -m fast -w stop
  echo "[postgres] Initialisation complete"
fi

if [ "${1:-}" = "postgres" ]; then
  shift
  exec postgres -D "${PGDATA}" -p "${POSTGRES_PORT}" "$@"
fi
exec "$@"
