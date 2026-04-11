# Docker Deployment Guide

## Prerequisite

Use native Docker CE on Linux. Docker Desktop is not supported for this project because host-network diagnostics for MTR/ping will not behave as intended.

This project now supports a first-run Docker workflow with two configuration methods:

1. Interactive setup prompts (recommended first run)
2. Non-interactive env injection (CLI / env-file)

## Files Added

- `docker-compose.yml`
- `.env.docker.example`
- `.dockerignore`
- `backend/Dockerfile`
- `backend/docker-entrypoint.sh`
- `frontend/Dockerfile`
- `frontend/docker-entrypoint.sh`
- `scripts/docker-first-run.sh`

## Option A: First Run With Prompts

Run:

```bash
./scripts/docker-first-run.sh
```

What it does:

- Prompts for required values (DB creds, ports, poll settings)
- Writes `.env.docker` in project root
- Starts the full stack with build:

```bash
docker compose --env-file .env.docker up -d --build
```

## Option B: Pass Values Via CLI / Env

You can skip prompts by pre-setting env vars:

```bash
MYSQL_ROOT_PASSWORD=secret-root \
MYSQL_PASSWORD=secret-app \
MYSQL_USER=mtr_app \
MYSQL_DATABASE=mtr_dashboard \
./scripts/docker-first-run.sh
```

Or create `.env.docker` directly from template and launch:

```bash
cp .env.docker.example .env.docker
# edit .env.docker

docker compose --env-file .env.docker up -d --build
```

## Services

- `frontend` (Next.js): `http://localhost:${FRONTEND_PORT}`
- `backend` (Python poller)
- `mysql` (with schema bootstrap via `backend/db_schema.sql`)
- `mongodb`

## Useful Commands

Start:

```bash
docker compose --env-file .env.docker up -d --build
```

Stop:

```bash
docker compose down
```

Stop + remove data volumes:

```bash
docker compose down -v
```

View logs:

```bash
docker compose logs -f frontend
docker compose logs -f backend
docker compose logs -f mysql
docker compose logs -f mongodb
```

## Notes

- Containers validate required env vars at startup (`docker-entrypoint.sh`) and fail fast with guidance if missing.
- MySQL schema is initialized automatically on first MySQL volume creation via `backend/db_schema.sql`.
- If you need to rerun setup prompts, delete `.env.docker` and run `./scripts/docker-first-run.sh` again.

## Troubleshooting

- If you see `docker-credential-desktop: executable file not found`, your Docker config still references Docker Desktop credential helpers.
- The first-run script now applies a temporary auth fallback automatically for that run.
- For a permanent fix, edit `~/.docker/config.json` and remove `credsStore` / `credHelpers` entries that point to `desktop`.
