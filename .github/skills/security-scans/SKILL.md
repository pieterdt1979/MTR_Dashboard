---
name: security-scans
description: 'Run Trivy, pip-audit, and npm audit for the MTR Dashboard repo and fix common dependency, container, secrets, and default-credential vulnerabilities. Use when auditing `backend/`, `frontend/`, Dockerfiles, or `docker-compose.yml` before release or after dependency changes.'
argument-hint: '[full-repo|backend|frontend|docker] [scan-only|fix]'
user-invocable: true
---

# Security Scans for MTR Dashboard

Use this skill when the task is to **scan for vulnerabilities**, **triage findings**, and **apply safe remediations** in this repository.

## When to Use

- Run a repo-wide or targeted security audit
- Fix reported CVEs or dependency vulnerabilities
- Review `Dockerfile` / `docker-compose.yml` hardening issues
- Check for leaked secrets, default credentials, or risky container settings
- Validate that security fixes actually removed the finding

## Project-Specific Risk Areas

- `docker-compose.yml` includes development-style defaults for auth and broker credentials; deployed environments must override them
- `backend/Dockerfile` runs with elevated network capabilities for MTR (`NET_RAW`, `NET_ADMIN`), so keep only the minimum privileges required
- `frontend/Dockerfile` currently copies full `node_modules` into runtime; reduce runtime surface where practical
- `frontend/` is a Next.js 16 app, so avoid blind major-version upgrades and always verify with build + lint
- `backend/requirements.txt` is fully pinned, so Python fixes usually require explicit version bumps and a re-audit

## Workflow

### 1. Scope the audit

Start by confirming the target:
- **`full-repo`**: filesystem, secrets, config, Python, Node, and Docker artifacts
- **`backend`**: Python dependencies and backend container hardening
- **`frontend`**: npm advisories and Next.js runtime risk
- **`docker`**: Dockerfiles, compose config, container image vulnerabilities

Default to **HIGH/CRITICAL** findings first unless the user requests a full report.

### 2. Run the baseline scans

From the repo root:

```bash
cd /path/to/MTR_Dashboard

# Filesystem, config, and secret scanning
trivy fs --scanners vuln,secret,config --severity HIGH,CRITICAL .
```

Backend scan:

```bash
cd backend
python -m pip install --upgrade pip pip-audit
pip-audit -r requirements.txt
```

Frontend scan:

```bash
cd ../frontend
npm install
npm audit --omit=dev
```

Optional image scan after a local build:

```bash
cd /path/to/MTR_Dashboard
docker compose build frontend backend
docker images | grep -E 'mtr|frontend|backend'
trivy image <image-name>
```

### 3. Triage before changing anything

For each finding, classify:

| Finding type | Usual root cause | Preferred fix |
| --- | --- | --- |
| Python advisory | outdated pinned package | bump the specific package in `backend/requirements.txt` |
| npm advisory | vulnerable transitive or direct dependency | `npm audit fix` for safe non-breaking updates, otherwise targeted dependency bump |
| Container CVE | stale base image or OS package | update the base image tag and rebuild |
| Secret/default credential | example password or exposed token | move to `.env`, rotate, and remove default from deployed config |
| Misconfiguration | excessive privileges, host networking, root user | reduce privilege only after verifying MTR still works |

Do **not** apply multiple unrelated fixes at once. Fix one root cause, then re-run the relevant scan.

### 4. Apply common remediations

#### Python (`backend/`)

- Prefer targeted updates in `backend/requirements.txt`
- Reinstall and re-run `pip-audit` after each change
- If no patched version exists, document the exposure and compensating control

Example loop:

```bash
cd backend
pip-audit -r requirements.txt
# edit requirements.txt to bump the affected package
python -m pip install --upgrade -r requirements.txt
pip-audit -r requirements.txt
```

#### Node / Next.js (`frontend/`)

- Use `npm audit fix` only for safe, compatible updates
- Avoid `npm audit fix --force` unless the user explicitly accepts breaking changes
- Prefer explicit version updates in `package.json` for `next`, `react`, `mongodb`, and `mysql2`

Example loop:

```bash
cd frontend
npm audit --omit=dev
npm audit fix
npm run build
npm run lint
npm audit --omit=dev
```

#### Docker / Compose

- Rebuild after base image changes and re-scan with Trivy
- Prefer slim/current base images
- Reduce runtime surface area and unnecessary packages
- Where possible, run as a non-root user and keep only required capabilities
- Treat `host` networking and `NET_RAW`/`NET_ADMIN` as exceptions that require justification

Also review the repo-specific checklist in [common fixes](./references/common-fixes.md).

### 5. Verify before claiming success

Never state that a vulnerability is fixed unless the proving command has been re-run and the output shows the finding is gone.

Use the relevant verification commands:

```bash
cd /path/to/MTR_Dashboard
trivy fs --scanners vuln,secret,config --severity HIGH,CRITICAL .

cd backend
pip-audit -r requirements.txt
python -m compileall .

cd ../frontend
npm audit --omit=dev
npm run build
npm run lint
```

### 6. Report the result clearly

Summarize:
- files changed
- commands run
- findings fixed
- remaining HIGH/CRITICAL items and why they remain
- follow-up actions if a package or image has no patch yet

## Guardrails

- Do not claim “secure” or “fixed” without fresh scan output
- Do not use `npm audit fix --force` by default on this Next.js app
- Do not remove `NET_RAW` / `NET_ADMIN` blindly; verify MTR behavior first
- Do not leave weak demo passwords or default broker credentials in deployed configs
- Prefer smallest safe change over bulk dependency churn
