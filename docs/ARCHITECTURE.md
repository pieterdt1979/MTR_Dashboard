# MTR Dashboard (ConnectedInsight) — Architecture

> **Note for Grok/Kiro users:** This repo uses Podman + UBI9 images + host networking. See
> `podman-compose.yml`. The new FastAPI backend is in `backend_v2/`. Frontend additions are in
> `frontend_additions/` and need to be copied into `frontend/`.

Standing rules for every container:
* Podman only.
* Red Hat UBI9 base images.
* `network_mode: host`, with no `ports:` mappings and no `EXPOSE`.
* Runs as UID 1001.
* No secrets in images or the repo; all secrets come from `.env`. Copy `.env.example` to create it.

## 1. Overview

```
   routers / firewalls / optical (Cisco, Huawei, Adva, Radware)
     │ syslog 514/udp+tcp     │ NetFlow/IPFIX 2055, sFlow 6343     ▲ SNMP 161 (v2c/v3)   ▲ ICMP / MTR
     ▼                        ▼                                    │                     │
 ┌───────────────┐   JSON spool   ┌─────────┐                ┌─────┴───────────────┐ ┌───┴─────────┐
 │ vector-syslog │◄───────────────│ goflow2 │                │ mtr-api  :8000      │ │ mtr-backend │
 │ parse+enrich  │  (flow_spool)  └─────────┘                │ FastAPI /api/v2     │ │ legacy MTR  │
 └──────┬────────┘                                           │ SNMP poller (leader)│ │ poller      │
        │ HTTP :8123 batched                                 │ burst manager       │ └─────────────┘
        ▼                                                    └──┬────────┬─────┬───┘
 ┌──────────────────────────┐  queries / metric inserts         │        │     │
 │ ClickHouse  :8123/:9000  │◄──────────────────────────────────┘        │     │
 │ syslog_events            │                                            │     │
 │ netflow_records          │        ┌───────────────────────┐           │     │
 │ interface_metrics + 5m MV│        │ PostgreSQL 16  :5432  │◄──────────┘     │
 └──────────────────────────┘        │ sites, devices,       │                 │
                                     │ interfaces, creds,    │   ┌───────────┐ │
                                     │ burst_sessions,       │   │ Redis     │◄┘
                                     │ incidents             │   │ :6379     │ counters,
                                     └───────────────────────┘   └───────────┘ leader lock
                                                ▲
 Browser ──cookie──► mtr-frontend :3000 (Next.js) ── /api/v2/* proxy ──► mtr-api
                     (session auth + RBAC; forwards X-MTR-Internal-Token / X-MTR-User / X-MTR-Role)
```

## 2. Service inventory

| Service | Image base | Host port(s) | Role |
|---|---|---|---|
| `postgres16` | `ubi9/ubi` + PGDG PostgreSQL 16 | 5432 | Inventory, credentials (AES-GCM), burst sessions, incidents |
| `clickhouse` | `ubi9/ubi` + ClickHouse RPM | 8123 HTTP, 9000 native | Telemetry: syslog, flows, interface metrics; 5-minute rollups; TTL retention |
| `redis` | `ubi9/ubi` + AppStream Redis 7 | 6379 | SNMP counter state, poller leader lock, cache |
| `vector-syslog` | `ubi9/ubi-minimal` + Vector | 514 udp/tcp, 127.0.0.1:8686 | Syslog ingest (RFC3164/5424, Cisco/Huawei mnemonics); ships flow spool to ClickHouse |
| `goflow2` | build `ubi9/go-toolset`, run `ubi9/ubi-minimal` | 2055/udp, 6343/udp, 127.0.0.1:8081 | NetFlow v5/v9, IPFIX, NetStream and sFlow collector |
| `mtr-backend` | `ubi9/python-311` (+ fping, mtr) | none | Legacy MTR/ICMP poller (`backend/mtr_poller.py`) |
| `mtr-api` | `ubi9/python-311` | 8000 | **Phase 2** FastAPI `/api/v2`, SNMP v2c/v3 poller, burst manager (`backend_v2/`) |
| `mtr-frontend` | build `ubi9/nodejs-22`, run `ubi9/nodejs-22-minimal` | 3000 | Next.js dashboard, auth/RBAC, `/api/v2` proxy |

Firewall: expose only 514, 2055, 6343 and 3000 to the network. Keep 5432, 6379, 8000, 8123 and
9000 on localhost or the management network.

## 3. Key environment variables (`.env`)

| Variable | Used by | Default | Notes |
|---|---|---|---|
| `POSTGRES_HOST/PORT/DB/USER` | all DB clients | localhost/5432/mtr_dashboard/mtr_app | |
| `POSTGRES_PASSWORD` | postgres16, backends, frontend | **required** | |
| `CLICKHOUSE_HOST/HTTP_PORT/PORT/DB/USER` | vector, mtr-api, mtr-backend | localhost/8123/9000/mtr/default | mtr-api uses HTTP 8123 |
| `CLICKHOUSE_PASSWORD` | clickhouse, vector, backends | **required** | |
| `REDIS_HOST/PORT/PASSWORD` | redis, backends | localhost/6379/(empty) | |
| `MTR_CREDENTIAL_KEY` | mtr-api, mock seeder | (empty) | base64 32-byte AES-256-GCM key for SNMP secrets |
| `MTR_POLL_INTERVAL` / `MTR_BURST_INTERVAL` / `MTR_BURST_MAX_HOURS` | mtr-api | 300 / 30 / 8 | Seconds / seconds / hours |
| `SNMP_POLLER_ENABLED`, `SNMP_TIMEOUT`, `SNMP_RETRIES`, `SNMP_CONCURRENCY` | mtr-api | true, 3, 1, 50 | |
| `MTR_API_SHARED_SECRET` | mtr-api, mtr-frontend | **required** | Proxy-to-API trust; `openssl rand -base64 32` |
| `MTR_API_PORT` / `MTR_API_WORKERS` | mtr-api | 8000 / 4 | |
| `BACKEND_URL` | mtr-frontend | `http://localhost:8000` | |
| `FRONTEND_ORIGIN` | mtr-api | `http://localhost:3000` | CORS; comma-separated list allowed |
| `SESSION_SECRET` | mtr-frontend | **required** | ≥ 32 characters |
| `SYSLOG_PORT`, `GOFLOW2_NETFLOW_PORT`, `GOFLOW2_SFLOW_PORT` | vector, goflow2 | 514, 2055, 6343 | |

## 4. Scope by phase

| | Phase 1 (done) | Phase 2 (done) |
|---|---|---|
| Runtime | Podman/UBI9 compose stack, host networking, UID 1001 | `mtr-api` service added to the same stack |
| Storage | PostgreSQL 16 schema (inventory, burst sessions with 8 h cap, incidents with suppression); ClickHouse schema (syslog, flows, metrics, 5 m MV, TTLs) | Migration 002 (burst trigger fix), applied automatically |
| Ingest | Vector syslog parsing; goflow2 to spool to ClickHouse | SNMP v2c/v3 IF-MIB polling (HC counters, wrap/reboot handling); 30 s burst polling with auto-expiry |
| API | — | FastAPI `/api/v2`: devices, metrics, syslog, flows (top talkers, bandwidth), burst, incidents, health |
| UI | Existing pages repackaged on UBI9 | Syslog Explorer, Flow Analytics, Devices, Device detail (burst panel), Incidents; `/api/v2` proxy (`frontend_additions/`) |
| Tooling | Mock seeder: 100 devices, syslog, flows, metrics | — |

Code repository layout:

```
podman-compose.yml   .env.example   infrastructure/   (Phase 1)
backend/             legacy poller (unchanged)
backend_v2/          Phase 2 FastAPI service (installed in the image as package `backend`)
frontend/            existing Next.js app (unchanged)
frontend_additions/  Phase 2 pages, components, lib, API proxy — merge into frontend/
docs/                PHASE1_README.md  PHASE2_README.md  ARCHITECTURE.md
```

## 5. What remains

* **Phase 3: SNMP discovery engine and topology alerting.**
  * Discover devices by subnet sweep and sysObjectID-based vendor/model classification.
  * Build topology from LLDP/CDP neighbours and store links in PostgreSQL.
  * Alert on interface and link state (oper-down on critical links, error/discard thresholds,
    utilisation against `ifSpeed`).
  * Enrich syslog and flow `device_id` from source IP, run asynchronously.
* **Phase 4: dependency-aware alerting.**
  * Root-cause incidents over the topology graph. When an upstream device or link fails, child
    alerts are suppressed using `incidents.suppressed_by_incident_id`.
  * Correlate syslog, SNMP and ICMP/MTR signals into one incident.
  * Notification routing and maintenance windows.
* **Carried over.**
  * The legacy `mtr_poller.py` and existing frontend API routes still depend on MySQL/MongoDB.
  * Container images have not yet been built or run under Podman; the first
    `podman-compose up --build` on a RHEL 9 host is the integration test.

## 6. Integrating `frontend_additions/`

All files are new; no existing frontend file is overwritten. The auth files (`lib/auth.ts`,
`lib/auth-db.ts`, `app/auth-provider.tsx`) are untouched.

```bash
cp -r frontend_additions/app frontend_additions/components frontend_additions/lib frontend/
cd frontend && npm install recharts@^3     # adds Recharts to package.json / package-lock.json
npx tsc --noEmit && npm run build          # verified clean against Next 16.2.3 / React 19.2.4
```

This adds:
* `app/(dashboard)/` with `/devices`, `/devices/[id]`, `/syslog`, `/flows` and `/incidents`, plus
  a sidebar layout;
* `app/api/v2/[...path]/route.ts`, the proxy;
* `components/` and `lib/api-client.ts`.

Then set `BACKEND_URL` and `MTR_API_SHARED_SECRET` for `mtr-frontend`; `podman-compose.yml`
already passes both.

## 7. Running

```bash
cp .env.example .env && $EDITOR .env        # replace every CHANGEME; chmod 600 .env
sudo podman-compose up -d --build           # rootful: syslog on 514 and raw ICMP (see docs/PHASE1_README.md)
sudo podman-compose ps                      # wait for "healthy"
curl -s localhost:8000/health               # mtr-api
python3 infrastructure/mock/mock_generator.py --reset   # optional demo data (needs .env loaded)
```
