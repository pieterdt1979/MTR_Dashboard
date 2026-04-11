#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.docker"
TEMP_DOCKER_CONFIG=""

resolve_compose_cmd() {
  if command -v docker >/dev/null 2>&1; then
    if docker compose version >/dev/null 2>&1; then
      COMPOSE_CMD=(docker compose)
      return
    fi
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
    return
  fi

  echo "Docker Compose not found. Install Docker CE with Compose plugin, or docker-compose." >&2
  exit 1
}

ensure_docker_ce() {
  local docker_os
  docker_os="$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || true)"

  if [[ -z "$docker_os" ]]; then
    echo "Unable to detect Docker engine details. Ensure Docker CE is installed and daemon is running." >&2
    exit 1
  fi

  if [[ "$docker_os" == *"Docker Desktop"* ]]; then
    echo "Unsupported runtime detected: $docker_os" >&2
    echo "This project requires native Docker CE on Linux for accurate host-network MTR diagnostics." >&2
    echo "Please install Docker CE and rerun this script." >&2
    exit 1
  fi
}

setup_docker_auth_fallback() {
  local docker_cfg_dir docker_cfg_file
  docker_cfg_dir="${DOCKER_CONFIG:-$HOME/.docker}"
  docker_cfg_file="$docker_cfg_dir/config.json"

  if [[ ! -f "$docker_cfg_file" ]]; then
    return
  fi

  if command -v docker-credential-desktop >/dev/null 2>&1; then
    return
  fi

  if grep -q '"desktop"' "$docker_cfg_file"; then
    TEMP_DOCKER_CONFIG="$(mktemp -d)"
    cat > "$TEMP_DOCKER_CONFIG/config.json" <<'EOF'
{}
EOF
    export DOCKER_CONFIG="$TEMP_DOCKER_CONFIG"

    echo "Detected stale Docker Desktop credential helper in $docker_cfg_file" >&2
    echo "Using temporary Docker auth config for this run to avoid docker-credential-desktop failures." >&2
    echo "Tip: remove credsStore/credHelpers entries referencing 'desktop' from $docker_cfg_file for a permanent fix." >&2
  fi
}

cleanup_temp_docker_config() {
  if [[ -n "$TEMP_DOCKER_CONFIG" && -d "$TEMP_DOCKER_CONFIG" ]]; then
    rm -rf "$TEMP_DOCKER_CONFIG"
  fi
}

get_env_value() {
  local key="$1"
  local value=""

  if [[ -f "$ENV_FILE" ]]; then
    value="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d '=' -f2- || true)"
  fi

  printf '%s' "$value"
}

append_env_if_missing() {
  local key="$1"
  local default_value="$2"

  if grep -qE "^${key}=" "$ENV_FILE"; then
    return
  fi

  echo "${key}=${default_value}" >> "$ENV_FILE"
  echo "Added missing ${key} to $ENV_FILE"
}

prompt_default() {
  local var_name="$1"
  local prompt_text="$2"
  local default_value="$3"
  local current_value="${!var_name:-}"
  if [[ -n "$current_value" ]]; then
    return
  fi
  if [[ -t 0 ]]; then
    read -r -p "$prompt_text [$default_value]: " input
    if [[ -z "$input" ]]; then
      input="$default_value"
    fi
    printf -v "$var_name" '%s' "$input"
  else
    printf -v "$var_name" '%s' "$default_value"
  fi
}

prompt_secret() {
  local var_name="$1"
  local prompt_text="$2"
  local default_value="$3"
  local current_value="${!var_name:-}"
  if [[ -n "$current_value" ]]; then
    return
  fi
  if [[ -t 0 ]]; then
    read -r -s -p "$prompt_text [$default_value]: " input
    echo
    if [[ -z "$input" ]]; then
      input="$default_value"
    fi
    printf -v "$var_name" '%s' "$input"
  else
    printf -v "$var_name" '%s' "$default_value"
  fi
}

generate_secret() {
  local bytes="${1:-18}"
  od -An -N"$bytes" -tx1 /dev/urandom | tr -d ' \n'
}

if [[ -f "$ENV_FILE" ]]; then
  echo "Using existing $ENV_FILE"
  echo "Tip: remove it if you want to re-run interactive setup."
else
  echo "Creating $ENV_FILE (first-run Docker setup)"

  prompt_default FRONTEND_PORT "Frontend exposed port" "3000"
  prompt_default MYSQL_PORT "MySQL exposed port" "3306"
  prompt_default MONGODB_PORT "MongoDB exposed port" "27017"
  prompt_default POSTGRES_PORT "PostgreSQL exposed port" "5432"
  prompt_default RABBITMQ_PORT "RabbitMQ AMQP exposed port" "5672"
  prompt_default RABBITMQ_MANAGEMENT_PORT "RabbitMQ management exposed port" "15672"

  prompt_default MYSQL_DATABASE "MySQL database name" "mtr_dashboard"
  prompt_default MYSQL_USER "MySQL app username" "mtr_app"
  prompt_secret MYSQL_PASSWORD "MySQL app password" "$(generate_secret 12)"
  prompt_secret MYSQL_ROOT_PASSWORD "MySQL root password" "$(generate_secret 12)"

  prompt_default MONGODB_DATABASE "MongoDB database name" "mtr_metrics"
  prompt_default MONGODB_COLLECTION "MongoDB collection" "mtr_results"

  prompt_default POSTGRES_DB "PostgreSQL state database name" "mtr_state"
  prompt_default POSTGRES_USER "PostgreSQL state username" "mtr_state_user"
  prompt_secret POSTGRES_PASSWORD "PostgreSQL state password" "$(generate_secret 12)"
  prompt_default POSTGRES_STATE_TABLE "PostgreSQL state table" "device_probe_state"

  prompt_default POLLING_INTERVAL_MINUTES "Polling interval (minutes)" "5"
  prompt_default CLEANUP_INTERVAL_HOURS "Cleanup interval (hours)" "1"
  prompt_default MTR_COUNT "MTR packet count" "10"
  prompt_default MTR_PROBE_MODE "MTR probe mode (icmp/tcp/udp)" "icmp"
  prompt_default MTR_TCP_PORT "MTR TCP probe port" "443"
  prompt_default MTR_UDP_PORT "MTR UDP probe port" "33434"
  prompt_default FPING_COUNT "fping sample count" "3"
  prompt_default FPING_INTERVAL_MS "fping inter-target interval ms" "10"
  prompt_default FPING_PERIOD_MS "fping period per target ms" "500"
  prompt_default FPING_TIMEOUT_SECONDS "fping timeout seconds" "40"
  prompt_default MTR_FORCE_INTERVAL_MINUTES "Forced MTR interval minutes" "60"
  prompt_default MTR_JITTER_THRESHOLD_MS "Jitter trigger threshold ms" "5"
  prompt_default MTR_CONSECUTIVE_BREACHES "Consecutive jitter breaches to trigger" "2"
  prompt_default MTR_TRIGGER_COOLDOWN_MINUTES "Trigger cooldown minutes" "15"
  prompt_default MTR_BASELINE_ALPHA "Latency baseline alpha" "0.2"
  prompt_default MTR_MAX_WORKERS "Max MTR workers" "10"
  prompt_default MTR_DISPATCH_MODE "Dispatch mode (direct/rabbitmq-producer/rabbitmq-worker)" "direct"
  prompt_default MTR_JOB_QUEUE "RabbitMQ queue name" "mtr_jobs"
  prompt_default RABBITMQ_URL "RabbitMQ URL (only needed for rabbitmq-* modes)" "amqp://set-rabbitmq-user:set-rabbitmq-password@127.0.0.1:${RABBITMQ_PORT}/%2f"

  prompt_default LOG_LEVEL "Log level" "INFO"
  prompt_default LOG_FILE "Log file" "mtr_poller.log"

  prompt_default SECURITY_ENFORCE_AUTH "Enable frontend auth enforcement (true/false)" "true"
  prompt_secret SESSION_SECRET "Frontend session secret" "$(generate_secret 32)"
  prompt_default SESSION_DURATION_HOURS "Frontend session duration hours" "12"

  prompt_default AUTH_ADMIN_USERNAME "Initial admin username" "admin"
  prompt_secret AUTH_ADMIN_PASSWORD "Initial admin password" "$(generate_secret 12)"
  prompt_default AUTH_OPERATOR_USERNAME "Initial operator username" "operator"
  prompt_secret AUTH_OPERATOR_PASSWORD "Initial operator password" "$(generate_secret 12)"
  prompt_default AUTH_VIEWER_USERNAME "Initial viewer username" "viewer"
  prompt_secret AUTH_VIEWER_PASSWORD "Initial viewer password" "$(generate_secret 12)"

  cat > "$ENV_FILE" <<EOF
FRONTEND_PORT=$FRONTEND_PORT
MYSQL_PORT=$MYSQL_PORT
MONGODB_PORT=$MONGODB_PORT
POSTGRES_PORT=$POSTGRES_PORT
RABBITMQ_PORT=$RABBITMQ_PORT
RABBITMQ_MANAGEMENT_PORT=$RABBITMQ_MANAGEMENT_PORT

MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
MYSQL_DATABASE=$MYSQL_DATABASE
MYSQL_USER=$MYSQL_USER
MYSQL_PASSWORD=$MYSQL_PASSWORD

MONGODB_DATABASE=$MONGODB_DATABASE
MONGODB_COLLECTION=$MONGODB_COLLECTION
POSTGRES_DB=$POSTGRES_DB
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_STATE_TABLE=$POSTGRES_STATE_TABLE

POLLING_INTERVAL_MINUTES=$POLLING_INTERVAL_MINUTES
CLEANUP_INTERVAL_HOURS=$CLEANUP_INTERVAL_HOURS
MTR_COUNT=$MTR_COUNT
MTR_PROBE_MODE=$MTR_PROBE_MODE
MTR_TCP_PORT=$MTR_TCP_PORT
MTR_UDP_PORT=$MTR_UDP_PORT
FPING_COUNT=$FPING_COUNT
FPING_INTERVAL_MS=$FPING_INTERVAL_MS
FPING_PERIOD_MS=$FPING_PERIOD_MS
FPING_TIMEOUT_SECONDS=$FPING_TIMEOUT_SECONDS
MTR_FORCE_INTERVAL_MINUTES=$MTR_FORCE_INTERVAL_MINUTES
MTR_JITTER_THRESHOLD_MS=$MTR_JITTER_THRESHOLD_MS
MTR_CONSECUTIVE_BREACHES=$MTR_CONSECUTIVE_BREACHES
MTR_TRIGGER_COOLDOWN_MINUTES=$MTR_TRIGGER_COOLDOWN_MINUTES
MTR_BASELINE_ALPHA=$MTR_BASELINE_ALPHA
MTR_MAX_WORKERS=$MTR_MAX_WORKERS
MTR_DISPATCH_MODE=$MTR_DISPATCH_MODE
MTR_JOB_QUEUE=$MTR_JOB_QUEUE
RABBITMQ_URL=$RABBITMQ_URL

LOG_LEVEL=$LOG_LEVEL
LOG_FILE=$LOG_FILE

SECURITY_ENFORCE_AUTH=$SECURITY_ENFORCE_AUTH
SESSION_SECRET=$SESSION_SECRET
SESSION_DURATION_HOURS=$SESSION_DURATION_HOURS

AUTH_ADMIN_USERNAME=$AUTH_ADMIN_USERNAME
AUTH_ADMIN_PASSWORD=$AUTH_ADMIN_PASSWORD
AUTH_OPERATOR_USERNAME=$AUTH_OPERATOR_USERNAME
AUTH_OPERATOR_PASSWORD=$AUTH_OPERATOR_PASSWORD
AUTH_VIEWER_USERNAME=$AUTH_VIEWER_USERNAME
AUTH_VIEWER_PASSWORD=$AUTH_VIEWER_PASSWORD
EOF

  echo "Created $ENV_FILE"
fi

# Backfill auth/session keys for existing env files.
append_env_if_missing SECURITY_ENFORCE_AUTH true
append_env_if_missing SESSION_SECRET "$(generate_secret 32)"
append_env_if_missing SESSION_DURATION_HOURS 12
append_env_if_missing AUTH_ADMIN_USERNAME admin
append_env_if_missing AUTH_ADMIN_PASSWORD "$(generate_secret 12)"
append_env_if_missing AUTH_OPERATOR_USERNAME operator
append_env_if_missing AUTH_OPERATOR_PASSWORD "$(generate_secret 12)"
append_env_if_missing AUTH_VIEWER_USERNAME viewer
append_env_if_missing AUTH_VIEWER_PASSWORD "$(generate_secret 12)"

resolve_compose_cmd
ensure_docker_ce
setup_docker_auth_fallback
trap cleanup_temp_docker_config EXIT

echo "Starting Docker stack..."
"${COMPOSE_CMD[@]}" --env-file "$ENV_FILE" up -d --build

frontend_port="${FRONTEND_PORT:-}"
if [[ -z "$frontend_port" ]]; then
  frontend_port="$(get_env_value FRONTEND_PORT)"
fi
if [[ -z "$frontend_port" ]]; then
  frontend_port="3000"
fi

echo "Done. Frontend: http://localhost:${frontend_port}"
