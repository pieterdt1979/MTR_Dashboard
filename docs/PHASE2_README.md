# MTR NetMon — Phase 2: FastAPI backend, SNMP poller, and dashboard pages

Phase 2 sits on top of the Phase 1 infrastructure (PostgreSQL 16, ClickHouse, Redis, Vector,
goflow2; see `docs/PHASE1_README.md`). It adds two things:

* **`backend_v2/`**: a Python 3.11 FastAPI service (`mtr-api`) that serves `/api/v2/*` and runs an
  asyncio SNMP v2c/v3 IF-MIB poller and a burst-session manager.
* **`frontend_additions/`**: new Next.js App Router pages and a proxy route, to be copied into the
  existing `frontend/`. No existing file is modified, and the auth files (`lib/auth.ts`,
  `lib/auth-db.ts`, `app/auth-provider.tsx`) are untouched.

```
 Browser ── session cookie (mtr_session) ──► Next.js :3000
                                              │  app/api/v2/[...path]/route.ts
                                              │   1. enforceSecurity(): viewer for GET, operator for POST/DELETE
                                              │   2. forwards X-MTR-Internal-Token (shared secret), X-MTR-User, X-MTR-Role
                                              ▼
                                         FastAPI :8000 (mtr-api, 4 uvicorn workers)
                       ┌──────────────────────┼─────────────────────────┐
                 asyncpg pool          clickhouse-connect (HTTP 8123)   redis.asyncio
                 PostgreSQL 16         ClickHouse                       Redis
                 devices/interfaces    syslog_events / netflow_records  SNMP counter state,
                 burst_sessions        interface_metrics(+5m view)      poller leader lock
                 incidents
                       ▲                      ▲                          ▲
                       └──── SNMP poller + burst manager (leader worker only) ─┘ ◄── UDP 161 ── devices
```

## 1. Layout

```
backend_v2/                     (installed in the image as the Python package `backend`)
  config.py                     env-driven Settings (python-dotenv; MTR_ENV_FILE, default .env)
  db/postgres.py                asyncpg pool: init_pool/close_pool/get_pool, execute/fetch/fetchrow/fetchval, apply_migrations
  db/clickhouse.py              clickhouse-connect async HTTP client: init_client/close_client, query() -> list[dict], execute_insert(table, rows)
  db/redis.py                   redis.asyncio client + LeaderLock (SET NX PX + Lua renew/release)
  poller/snmp_worker.py         SNMP v2c/v3 IF-MIB/ifXTable poller
  poller/burst_manager.py       30 s burst loop + auto-expiry
  api/deps.py                   auth headers, time ranges, shared helpers
  api/main.py                   FastAPI app, lifespan, CORS, /health, background supervisor
  api/routers/{devices,syslog,flows,burst,incidents}.py
  migrations/002_burst_expiry_trigger_fix.sql
  requirements.txt  Containerfile
frontend_additions/             (copy into frontend/)
  lib/api-client.ts             typed client + formatters
  app/api/v2/[...path]/route.ts catch-all proxy to FastAPI
  app/(dashboard)/layout.tsx    sidebar + active-burst badge (dark theme)
  app/(dashboard)/{devices,devices/[id],syslog,flows,incidents}/page.tsx
  components/{ui.tsx,SyslogTable.tsx,IncidentsTable.tsx}
```

## 2. Backend

### 2.1 SNMP poller (`poller/snmp_worker.py`)
* Uses pysnmp 7 (`pysnmp.hlapi.v3arch.asyncio`), with one `bulk_walk_cmd` per IF-MIB column.
  Concurrency is bounded by `SNMP_CONCURRENCY`, and a per-device lock stops polls of the same
  device from overlapping.
* **SNMPv2c and SNMPv3.**
  * v3 auth: MD5, SHA, SHA-224/256/384/512.
  * v3 privacy: DES, 3DES, AES-128/192/256.
  * Credentials come from `snmp_credentials` through `device_credentials` (lowest priority value
    wins).
  * `*_enc` columns are AES-256-GCM with `MTR_CREDENTIAL_KEY`, in the same format the Phase 1
    mock generator writes.
* **Counters.**
  * `ifHCInOctets`/`ifHCOutOctets` (64-bit) are used when available, otherwise 32-bit `ifInOctets`
    and so on.
  * Error and discard counters are collected too.
  * The previous sample is kept in Redis (`HSET device:{id}:counters ifindex:{n}:in …`, plus
    sysUpTime and a timestamp).
  * Deltas are wrap-corrected for 32-bit counters. A decrease in a 64-bit counter is treated as a
    reset.
  * If sysUpTime goes backwards (a reboot), the poller takes a new baseline and writes no delta.
  * A rate above 1.5× ifSpeed is discarded as bogus.
* **Writes.**
  * Rows are inserted into ClickHouse `interface_metrics` as per-interval deltas plus
    `poll_interval_sec`, matching the Phase 1 design.
  * `interfaces` is upserted with name, descr, alias, speed, admin/oper status and
    `last_metric_at`.
  * `devices.status` and `last_polled_at` are updated. Status values:
    * `up`;
    * `down` when SNMP is unreachable;
    * `degraded` when an admin-up interface that has an alias is oper-down;
    * `unknown` when there are no credentials.
* **One poller per host.** All 4 uvicorn workers start a supervisor, but only the one holding the
  Redis lock `mtr:poller:leader` (TTL 60 s, renewed) runs the poll and burst loops. If that worker
  dies, another takes over within about 20 s.

### 2.2 Burst manager (`poller/burst_manager.py`)
* Every `MTR_BURST_INTERVAL` seconds (default 30), it reads `active_burst_sessions` and polls
  those devices. A session scoped to one interface polls only that ifIndex; the other interfaces
  keep their Redis baseline.
* Expired sessions get `ended_at`. Each one is logged once as a WARNING, for example:
  `Burst session 5 on lab-v2c auto-expired (started by alice at …, expired at …)`. A Redis key
  deduplicates the log line across ticks.
* An 8 h cap applies (`MTR_BURST_MAX_HOURS`). The API rejects requests over 480 minutes with 422,
  and the Phase 1 CHECK constraint also enforces it.

### 2.3 REST API (all under `/api/v2`, JSON)

| Method / path | Query / body | Returns |
|---|---|---|
| `GET /devices` | `q`, `site_id`, `status`, `vendor` | `{items[Device], total}`. Device includes `site_name`, `interface_count`, `open_incidents`, `burst_active` |
| `GET /devices/{id}` | — | Device plus `interfaces[]` (with current `in_bps`/`out_bps` from the latest sample) and `active_burst` (with `remaining_seconds`) |
| `GET /devices/{id}/metrics` | `from`, `to` (ISO or epoch; default 6 h), `ifindex`, `resolution=auto\|raw\|5m` | `{device_id, resolution, interfaces[], points[{ts, interface_id, ifindex, in_bps, out_bps, *_errors, *_discards, oper_status}]}`. `auto` uses raw data for ranges ≤ 6 h and the 5 m view otherwise |
| `GET /syslog` | `device_id`, `severity` (comma list of 0–7 or names), `mnemonic_pattern` (RE2 regex on mnemonic or raw message), `from`, `to` (default 24 h), `limit` (≤ 1000, default 100), `offset` | `{items[SyslogEvent], total, limit, offset, has_more}`. `device_id` also matches unenriched rows (`device_id=0`) by the device's mgmt IP. An invalid regex returns 400 |
| `GET /flows/toptalkers` | `device_id`, `from`, `to` (default 1 h), `top_n` (1–100, default 10), `group_by=src_ip\|dst_ip\|protocol\|port` | `{group_by, from, to, total_bytes, total_packets, total_flows, items[{rank, key, bytes, packets, flows, protocol, pct}]}` |
| `GET /flows/bandwidth` | `device_id` (required), `ifindex`, `from`, `to` (default 24 h), `bucket_minutes` (1–1440, default 5), `source=snmp\|netflow` | `{…, interface, speed_bps, points[{ts, in_bps, out_bps, in_mbps, out_mbps, peak_in_bps, peak_out_bps}]}`. Uses `interface_metrics_5m` when the bucket is a multiple of 5 |
| `POST /burst` | `{device_id, interface_id?, duration_minutes ≤ 480}` (operator) | 201 with the session. 409 if one is already active (the active session is in `detail`); 404 for an unknown device or interface; 422 if too long |
| `DELETE /burst/{id}` | operator | 200 with the ended session; 409 if already ended; 404 if missing |
| `GET /burst/active` | `device_id` | `{items[{…, hostname, ifindex, ifname, remaining_seconds}], total}` |
| `GET /burst` | `device_id`, `limit` | History, in the same shape |
| `GET /incidents` | `state` (comma list), `device_id`, `limit`, `offset` | `{items[{…, hostname, mgmt_ip, ifname, duration_seconds}], total, limit, offset}` |
| `GET /health` | — | `{status, postgres, clickhouse, redis, poller_running, this_worker_is_leader}`. Returns 503 if PostgreSQL or ClickHouse is down |

### 2.4 Auth between Next.js and FastAPI
The browser never talks to FastAPI directly. The Next.js proxy:
1. calls the existing `enforceSecurity()` (session cookie, API tokens and rate limits, unchanged);
2. reads the user with `getSessionFromRequest()`;
3. forwards `X-MTR-Internal-Token: $MTR_API_SHARED_SECRET`, `X-MTR-User` and `X-MTR-Role`.

FastAPI rejects a missing or wrong token with 401, and returns 403 when a viewer tries a write.
The username becomes `burst_sessions.initiated_by`.

If `MTR_API_SHARED_SECRET` is unset, FastAPI accepts every caller as admin. This is meant only for
local development, and a warning is logged at startup. The compose file makes the variable
mandatory.

### 2.5 Environment variables (`mtr-api`)
| Variable | Default | |
|---|---|---|
| `POSTGRES_HOST/PORT/DB/USER/PASSWORD` | localhost/5432/mtr_dashboard/mtr_app/— | |
| `POSTGRES_POOL_MIN/MAX` | 2/10 | Per uvicorn worker |
| `MTR_APPLY_MIGRATIONS` | true | Runs `migrations/*.sql` under an advisory lock |
| `CLICKHOUSE_HOST/HTTP_PORT/DB/USER/PASSWORD` | localhost/8123/mtr/default/— | HTTP interface (see deviations) |
| `REDIS_HOST/PORT/PASSWORD/DB` | localhost/6379/—/0 | |
| `SNMP_POLLER_ENABLED` | true | |
| `MTR_POLL_INTERVAL` / `MTR_BURST_INTERVAL` / `MTR_BURST_MAX_HOURS` | 300 / 30 / 8 | |
| `SNMP_TIMEOUT` / `SNMP_RETRIES` / `SNMP_PORT` / `SNMP_CONCURRENCY` | 3 / 1 / 161 / 50 | |
| `MTR_CREDENTIAL_KEY` | — | base64 32-byte AES key (same as Phase 1) |
| `MTR_API_SHARED_SECRET` | — | Required in compose |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | CORS; comma list allowed |
| `MTR_API_HOST/PORT/WORKERS` | 0.0.0.0/8000/4 | Containerfile CMD |
| `LOG_LEVEL` | INFO | |

Frontend (`mtr-frontend`): `BACKEND_URL` (default `http://localhost:8000`) and
`MTR_API_SHARED_SECRET`. Optionally `BACKEND_TIMEOUT_MS` (default 30000).

### 2.6 Container
`backend_v2/Containerfile` (build context = repository root):
* Base image `registry.access.redhat.com/ubi9/python-311`.
* Installs `requirements.txt` and copies only the Phase 2 package.
* `chown 1001:0`, then `USER 1001`.
* No `EXPOSE`, because the container uses host networking.
* `CMD uvicorn backend.api.main:app --host 0.0.0.0 --port 8000 --workers 4`.
* The health check is defined in `podman-compose.yml`.

## 3. Frontend

| Route | What it does |
|---|---|
| `(dashboard)/layout.tsx` | Dark sidebar with Overview (`/`), Devices, Syslog Explorer, Flow Analytics and Incidents. Shows a burst-session badge (polls `/api/v2/burst/active` every 15 s), the user and role, and sign-out. Waits for `useAuth()`; the existing AuthProvider handles redirects to `/login` |
| `/syslog` | Filters: device dropdown, 8-level severity multi-select, mnemonic/regex, from/to. Table: Timestamp, Device, Severity badge, Mnemonic, Raw Message. 100 rows per page with Prev/Next. Clicking a row opens a right drawer with all fields and a **Go to Device** button. Optional 10 s auto-refresh. `?device_id=` pre-filters |
| `/flows` | **Top Talkers** tab: device, range (1h/6h/24h/7d), group-by, top N (10/25/50); horizontal Recharts bar chart and a table (Rank, key, Protocol, Bytes in human units, Packets, % of total). **Bandwidth** tab: device, interface, range, bucket (5m/1h/1d); In/Out Mbps line chart with a crosshair tooltip and a red dashed threshold line at interface speed (shown when a single interface is selected) |
| `/devices` | Hostname (with mgmt IP, BURST and incident tags), Site, Vendor icon, Status pill (up/down/degraded/unknown), Last Polled, Interfaces. Search box, status filter and a "burst active only" filter (`?burst=1`, linked from the sidebar badge). Clicking a row opens `/devices/[id]` |
| `/devices/[id]` | Header: hostname, status, mgmt IP, vendor, model, site, SNMP version, last polled. **Burst panel**: live countdown, scope, who started it; Start (interface + duration) and Stop, operator only. Tabs: Interfaces (ifName, ifDescr, Admin/Oper, Speed, In/Out Mbps), Syslog (last 50 via the shared `SyslogTable`, refreshed every 30 s), Flows (top 10 source IPs, last hour), Incidents (open and acknowledged) |
| `/incidents` | Severity, Title, Device, State, Opened At, Duration. State filter, default active. Clicking a row opens the device |

### Integrating into the repository
```bash
cp -r frontend_additions/app frontend_additions/components frontend_additions/lib frontend/
cd frontend && npm install recharts@^3      # updates package.json + package-lock.json
```
All frontend files are new. There are no name clashes with the existing `app/page.tsx`
(Overview), `/hosts`, `/path-diversity` or `/api/*` routes. The existing pages keep their own
layout; the sidebar appears only on the five Phase 2 routes.

## 4. Running

**With podman-compose**, from the repository root, using `podman-compose.yml`:
```bash
echo "MTR_API_SHARED_SECRET=$(openssl rand -base64 32)" >> .env
sudo podman-compose up -d --build mtr-api mtr-frontend
curl -s localhost:8000/health
```

**Locally, without containers:**
```bash
python3.11 -m venv .venv && . .venv/bin/activate && pip install -r backend_v2/requirements.txt
set -a; . ./.env; set +a
# The code imports itself as `backend`; expose backend_v2/ under that name (as the image does):
mkdir -p .run && ln -sfn ../backend_v2 .run/backend && cd .run
uvicorn backend.api.main:app --host 0.0.0.0 --port 8000 --workers 4
```

## 5. Deviations from the brief, and why

1. **ClickHouse over HTTP (`clickhouse-connect`, port 8123), not native 9000.** The brief allowed
   either. HTTP needs no extra native driver, works with the async client, and is the interface
   Phase 1 already exposes to Vector. `CLICKHOUSE_HTTP_PORT` is used. `CLICKHOUSE_PORT` (9000) is
   left for the legacy poller.
2. **`pysnmp==7.1.x` instead of `pysnmp-lextudio`.** The lextudio fork has been folded back into
   `pysnmp` 7 and the old package name is deprecated.
3. **The proxy uses a shared-secret header model** rather than having FastAPI parse the Next.js
   session cookie, so the auth code stays untouched and in one place.
4. **Migration 002** fixes a Phase 1 trigger bug: a BEFORE INSERT OR UPDATE statement trigger
   that broke `UPDATE … SET ended_at` with `TriggeredDataChangeViolation`. It is applied on
   startup.
5. **A Redis leader lock** ensures that only one poller runs, even though uvicorn runs 4 workers.
6. **Extra endpoint `GET /api/v2/burst`** (history) and extra filters (`resolution`, `source`,
   device `q`/`status`) were added. All existing parameters behave as specified.
7. **Repository layout.** The FastAPI service lives in `backend_v2/` so the legacy `backend/`
   (`mtr_poller.py`) is untouched, and frontend pages ship in `frontend_additions/` for a manual
   merge. The new variables are in `.env.example` and in `docs/PHASE1_README.md` §7.

## 6. What was verified, and what was not

**Verified in the authoring sandbox** (PostgreSQL 16, ClickHouse 26, Redis 7 and net-snmp snmpd,
all run natively; Phase 1 schema and mock data with 100 devices):
* **SNMP polling.**
  * v2c and v3 (SHA + AES) against snmpd. The second cycle writes deltas to ClickHouse, upserts
    interfaces, sets status `up`, and stores Redis counters.
  * An unreachable device becomes `down`, and a wrong v3 key is reported as an error.
  * A sysUpTime reset causes a re-baseline.
  * Unit tests cover counter wrap and reset.
* **API.** Every endpoint returns 200 with real data, including the raw and 5m metric paths and
  the snmp and netflow bandwidth sources. The error paths behave as documented:
  * 401 with no token, 403 when a viewer tries a write;
  * on burst requests: 409 for a duplicate, 422 for too long, 404 for a bad interface;
  * on DELETE: 200, then 409, and 404 for a missing ID;
  * 400 for an invalid regex.
* **Burst.** An interface-scoped burst polls about every burst interval. Auto-expiry logs exactly
  one WARNING per session.
* **Frontend.**
  * The files were overlaid on a copy of the repository frontend (Next 16.2.3, React 19.2.4) with
    `recharts@3`. `tsc --noEmit` and `next build` both pass.
  * `next start` was run against the live API:
    * **Proxy:** unauthenticated request → 401; viewer POST → 403; operator POST → 201 with
      `initiated_by` taken from the session.
    * **Pages:** all five render real data in the browser, including the bar and line charts with
      the speed threshold line, the syslog drawer, and burst Start/Stop with the countdown.
  * Login used a session cookie signed with `SESSION_SECRET`, because the legacy MySQL auth DB was
    not available in the sandbox.
* `podman-compose config` renders the updated compose file.

**Not verified:**
* `podman build` and `podman-compose up`: the sandbox cannot create overlay mounts.
* Polling real Cisco, Huawei, Adva or Radware devices; only net-snmp was tested.
* Load at 100+ devices with real SNMP latency.
* The real login flow through the MySQL-backed auth DB.
