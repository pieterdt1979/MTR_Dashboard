# Security Notes (POC Backlog)

_Last reviewed: 2026-04-11_

This project is currently a **proof-of-concept** and is being prepared for public GitHub upload. The items below are **documented for follow-up remediation** rather than being treated as production-accepted risk.

## Verified findings from the latest scan

1. **Python dependency advisory**
   - `backend/requirements.txt`
   - `aiomysql==0.2.0`
   - `CVE-2025-62611` (`HIGH`)
   - planned follow-up: upgrade to `0.3.0` and re-run `pip-audit`

2. **Container hardening**
   - `backend/Dockerfile`: no explicit non-root `USER`
   - `frontend/Dockerfile`: no explicit non-root `USER`
   - planned follow-up: harden both images and verify traceroute/fping behavior still works

3. **Local/demo credentials**
   - example credentials exist in `.env.docker.example` for local demos only
   - actual local secrets belong in `.env.docker`, `backend/.env`, and `frontend/.env.local`
   - these local files are intentionally ignored by Git and should never be committed

## Public repo guidance

- treat this repository as a **demo / showcase**, not a production deployment template
- rotate any local secrets before sharing derived environments
- use the example env files only as templates
