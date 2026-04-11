# Common Security Fixes for MTR Dashboard

Use this checklist while applying or reviewing remediations.

## 1. Default credentials and secrets

Watch for weak or placeholder defaults in `docker-compose.yml` and `.env*` files:

- demo `AUTH_*_PASSWORD` values
- placeholder `SESSION_SECRET` values
- placeholder broker URLs such as `RABBITMQ_URL=amqp://<user>:<password>@...`
- placeholder database passwords

**Preferred fix**
- override all secrets in deployment-specific `.env` files
- rotate any credential that may have been used outside local development
- keep examples only in `.env.example`-style files

## 2. Docker hardening

Current repo notes:

- `backend/Dockerfile` installs `fping`, `mtr`, and `iputils-ping`; keep only what the app actually uses
- both Dockerfiles currently run as the default container user unless changed later
- `frontend/Dockerfile` copies full `node_modules` from build output into runtime
- `docker-compose.yml` grants the backend `NET_RAW` and `NET_ADMIN`, and uses `network_mode: host`

**Preferred fix**
- update to current patched base images
- add a non-root runtime user when compatible
- copy only production assets into the runtime image when possible
- document why elevated network privileges are required for traceroute behavior

## 3. Python dependency fixes

Usual workflow:

```bash
cd backend
python -m pip install --upgrade pip pip-audit
pip-audit -r requirements.txt
```

Then:
- bump the vulnerable package in `requirements.txt`
- reinstall with `python -m pip install --upgrade -r requirements.txt`
- rerun `pip-audit -r requirements.txt`

## 4. npm dependency fixes

Usual workflow:

```bash
cd frontend
npm audit --omit=dev
npm audit fix
npm run build
npm run lint
```

If the advisory requires a major version:
- prefer targeted package updates over `--force`
- confirm Next.js 16 compatibility before upgrading related packages
- rerun both `npm audit --omit=dev` and the frontend build

## 5. Trivy findings

Useful commands:

```bash
cd /path/to/MTR_Dashboard
trivy fs --scanners vuln,secret,config --severity HIGH,CRITICAL .
docker compose build frontend backend
trivy image <image-name>
```

Interpret findings as follows:
- **`secret`**: remove or rotate the exposed credential
- **`config`**: harden Docker/compose configuration if operationally safe
- **`vuln`**: update the vulnerable package or base image, then rebuild and rescan

## 6. Reporting standard

A good remediation summary includes:
- the original finding and severity
- root cause
- exact files updated
- verification command and output status
- any accepted residual risk and why it remains
