# MTR Dashboard — Phase 1 infrastructure (Podman + UBI9 + host networking)

Phase 1 replaces the Docker / MySQL / MongoDB / RabbitMQ stack in
`pieterdt1979/MTR_Dashboard@ConnectedInsight` with a Podman stack built only on Red Hat UBI9:
**PostgreSQL 16** for inventory and state, **ClickHouse** for telemetry, **Vector** for syslog,
**goflow2** for NetFlow/IPFIX/NetStream, and **Redis**. The existing Python poller and Next.js
frontend are repackaged on UBI9.

> These files live at the repository root (`podman-compose.yml`, `.env.example`,
> `infrastructure/`), next to `backend/` and `frontend/`. All build contexts point at the
> repository root.

---

## 1. Architecture

```
            UDP/TCP 514                      UDP 2055 / 6343
 routers ───────────────► vector-syslog      goflow2 ◄─────────────── routers
 (Cisco/Huawei/           │  parse RFC3164/   │  NetFlow v5/v9, IPFIX,
  Adva/Radware)           │  5424 + mnemonics │  NetStream, sFlow
                          │                   │  JSON → /var/spool/goflow2 (shared volume)
                          │◄──────────────────┘  rotated every 15 s, tailed + deleted by Vector
                          ▼ HTTP :8123 (batch 5000 / 2 s, on-disk buffer)
                   ┌──────────────┐        ┌───────────────┐       ┌────────┐
 mtr-backend ────► │  ClickHouse  │        │ PostgreSQL 16 │ ◄──── │ Redis  │
 (fping/mtr/SNMP)  │ syslog_events│        │ sites/devices │       │ cache  │
        │          │ netflow_recs │        │ interfaces    │       └────────┘
        │          │ iface_metrics│        │ burst_sessions│
        │          │ + 5-min MV   │        │ incidents ... │
        │          └──────▲───────┘        └──────▲────────┘
        └─────────────────┴────────────┬──────────┘
                                       │
                               mtr-frontend (Next.js :3000)
```

| Service | Image base | Host listeners (all `--network=host`) | Data volume |
|---|---|---|---|
| `postgres16` | `ubi9/ubi` + PGDG `postgresql16-server` | `0.0.0.0:5432` | `postgres_data` |
| `clickhouse` | `ubi9/ubi` + ClickHouse RPM repo | `0.0.0.0:8123` HTTP, `0.0.0.0:9000` native | `clickhouse_data` |
| `redis` | `ubi9/ubi` + AppStream `redis:7` | `0.0.0.0:6379` | `redis_data` |
| `vector-syslog` | `ubi9/ubi-minimal` + Vector RPM repo | `0.0.0.0:514` udp+tcp, `127.0.0.1:8686` API | `vector_data`, `flow_spool` |
| `goflow2` | build `ubi9/go-toolset`, run `ubi9/ubi-minimal` | `0.0.0.0:2055/udp`, `0.0.0.0:6343/udp`, `127.0.0.1:8081` metrics | `flow_spool` |
| `mtr-backend` | `ubi9/python-311` (+ `mtr`, EPEL `fping`) | none (outbound only) | — |
| `mtr-frontend` | build `ubi9/nodejs-22`, run `ubi9/nodejs-22-minimal` | `0.0.0.0:3000` | — |

Every container runs as **UID 1001**, and none of them use `ports:` mappings or bridge networks.

### Layout

```
podman-compose.yml
.env.example
infrastructure/
  Containerfile.{postgres,clickhouse,redis,vector,goflow2,backend,frontend}
  postgres/001_schema.sql   postgres/entrypoint.sh
  clickhouse/001_schema.sql clickhouse/entrypoint.sh clickhouse/config.d/mtr.xml clickhouse/users.d/mtr.xml
  vector/vector.toml
  goflow2/entrypoint.sh
  redis/entrypoint.sh
  backend/entrypoint.sh backend/requirements-phase1.txt
  frontend/entrypoint.sh
  mock/mock_generator.py mock/requirements.txt
```

---

## 2. Starting the stack

Prerequisites: RHEL 9 or another Podman host with **podman ≥ 4.4** and **podman-compose ≥ 1.2**
(`dnf install podman podman-compose`, or `pip install podman-compose`).

```bash
cp .env.example .env
# Replace every CHANGEME, e.g. with: openssl rand -base64 32
chmod 600 .env

sudo podman-compose up -d --build   # first build takes a while (ClickHouse and Next.js are large)
sudo podman-compose ps              # each service should become "healthy"
sudo podman-compose logs -f vector-syslog
```

**Why rootful (`sudo`)?** The containers still run as UID 1001. Two features need privileges
that rootless Podman cannot provide in the *host* network namespace:

* Syslog on UDP/TCP **514** is below 1024. The Vector binary has `cap_net_bind_service`.
* `fping` / `mtr` need raw ICMP. The binaries have `cap_net_raw`, and the compose file adds `NET_RAW`.

To run rootless instead:
1. Set `SYSLOG_PORT=1514` and redirect 514→1514 with firewalld, or run
   `sysctl net.ipv4.ip_unprivileged_port_start=514`.
2. Run `sysctl net.ipv4.ping_group_range="0 2147483647"` for the ICMP sweeps.

Firewall: open only what is needed, for example:

```bash
firewall-cmd --permanent --add-port={514/udp,514/tcp,2055/udp,6343/udp,3000/tcp}
firewall-cmd --reload
```

With host networking, PostgreSQL, ClickHouse and Redis listen on every host interface. Restrict
5432, 8123, 9000 and 6379 to localhost or the management network at the host firewall.

Quick checks:

```bash
logger -n 127.0.0.1 -P 514 -d "%LINK-3-UPDOWN: Interface Gi0/0/1, changed state to down"
sudo podman exec mtr-clickhouse clickhouse-client -d mtr -q "SELECT event_time, mnemonic, raw_message FROM syslog_events ORDER BY event_time DESC LIMIT 5"
sudo podman exec mtr-postgres16 psql -U mtr_app -d mtr_dashboard -c '\dt'
```

---

## 3. Seeding mock data

`infrastructure/mock/mock_generator.py` creates:
* 10 sites and 100 devices: Cisco ISR4451/ASR9001, Huawei NE40E-X3/AR6140, Adva FSP3000 and Radware DefensePro 1006, with management IPs in `10.x.x.x`.
* 4–8 interfaces per device.
* Sample incidents, including a parent/child suppression chain.
* Encrypted demo SNMP credentials, only if `MTR_CREDENTIAL_KEY` is set.

In ClickHouse it adds:
* 500 syslog events per device (BGP, OSPF, link flaps, ACL and security events, in each vendor's syslog format).
* 24 h of 5-minute interface metrics.
* 1000 NetFlow records per device.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r infrastructure/mock/requirements.txt
set -a; . ./.env; set +a              # loads POSTGRES_* / CLICKHOUSE_* (nothing hard-coded)
python infrastructure/mock/mock_generator.py --reset          # about 4 s on a modern host
python infrastructure/mock/mock_generator.py --help           # --devices, --sites, --seed, ...
```

Without `--reset`, inventory rows are upserted and new telemetry is appended.

---

## 4. Key design decisions

1. **UBI9 everywhere, including build stages.** The goflow2 builder is `ubi9/go-toolset`, not
   `golang:1.22`. goflow2 v2.2.7 needs Go ≥ 1.23, so `GOTOOLCHAIN=auto` fetches the exact
   toolchain. Third-party software comes from vendor RPM repos on top of UBI9: PGDG, ClickHouse
   and Vector. `fping` comes from EPEL 9 because UBI does not ship it.
2. **ClickHouse on UBI9 (option 1 that you approved).** The official RPM repo is used, and the
   service account is pinned to UID 1001. Listeners and the `default` user's password come from
   the environment (`from_env`). The schema is applied idempotently on every start into
   `${CLICKHOUSE_DB}`.
3. **Node 22 instead of 20 for the frontend.** `frontend/package.json` requires Node ≥ 22.
   `NODE_STREAM` is a build argument if you need to change it. The repo's `next.config.ts` lacks
   `output: "standalone"`, so the Containerfile adds it at build time. The build fails if the
   standalone bundle is missing.
4. **Image `ubi9/python-311`.** This is the actual registry name; `ubi9/python-3.11` does not exist.
5. **NetFlow path.** goflow2 writes JSON lines to a shared volume, which survives restarts and
   needs no extra broker. Every 15 s the file is rotated with a `SIGHUP` reopen. Vector reads only
   the rotated files, maps the fields to `netflow_records`, and deletes each file once consumed:
   * protocol names become numbers;
   * byte and packet counts are multiplied by the sampling rate;
   * IPv6 flows are dropped because the table is IPv4-only.
6. **Syslog parsing.** The PRI header gives numeric facility and severity. `parse_syslog` covers
   RFC3164 and RFC5424. Regexes extract mnemonics:
   * Cisco `%FAC-SEV-MNEMONIC`, including IOS-XR `%ROUTING-BGP-5-ADJCHANGE`, stored as `BGP-5-ADJCHANGE`;
   * Huawei `%%01MODULE/SEV/MNEMONIC(l)`, stored as `BGP/3/STATE_CHG_UPDOWN`.

   Device timestamps are trusted only within ±24 h of now. `device_id=0` until async enrichment
   maps the source IP to `devices.id`.
7. **Vector env interpolation.** Vector 0.5x and later turns off `${VAR}` interpolation by default.
   The compose file passes `--dangerously-allow-env-var-interpolation`, so the password stays in
   `.env` and never in `vector.toml`.
8. **`interface_metrics` stores per-interval deltas** (corrected for counter wraps and reboots by
   the poller), not raw counters. This keeps the 5-minute rollup a simple sum that works for both
   300 s polling and 30 s burst polling.
   * The rollup runs from `interface_metrics_5m_mv` into `interface_metrics_5m_agg` (AggregatingMergeTree).
   * Dashboards query the `interface_metrics_5m` view: `avg_in_bps`, `peak_in_bps`, errors, discards, down samples, last oper status.
9. **Retention:** syslog 30 d, flows 90 d, raw metrics 90 d, 5-minute rollups 365 d. All use
   `ttl_only_drop_parts` so whole partitions are dropped cheaply.
10. **8-hour burst sessions** are enforced three ways:
    * `expires_at DEFAULT now() + 8 h`;
    * `CHECK (expires_at <= started_at + 8 h)`;
    * `auto_expire_bursts()`. A BEFORE statement trigger runs it on every write to `burst_sessions`, and the backend scheduler should call `SELECT auto_expire_bursts();`.

    A partial unique index allows one active burst per device and interface. Expired sessions are
    cleared before that check, so a new burst can replace a stale one. The `active_burst_sessions`
    view is correct even between sweeps.
11. **Incident suppression** uses a self-reference, `suppressed_by_incident_id`. A CHECK
    constraint requires a parent whenever `state = 'suppressed'`.
12. **Secrets:**
    * There are no secrets in images or the repo; `.env` is the only source.
    * PostgreSQL's bootstrap password goes through an `initdb --pwfile` temp file, not argv.
    * ClickHouse and Redis read passwords from the environment or a 0600 runtime config.
    * `*_enc` columns hold **application-layer AES-256-GCM** ciphertext, formatted as
      `base64(nonce‖ciphertext‖tag)`, with the key taken from `MTR_CREDENTIAL_KEY`. This is not
      database-level encryption.
13. **Authentication.** PostgreSQL uses `pg_hba` with `local trust` (container socket only) and
    `host md5`, with `password_encryption = scram-sha-256`. md5 rules also accept SCRAM verifiers.

---

## 5. Known gaps (planned for Phase 2)

* **The current `backend/mtr_poller.py` and the frontend API routes still use MySQL and MongoDB.**
  * The UBI9 backend image validates the new Phase 1 variables and maps `MTR_POLL_INTERVAL` (seconds) to `POLLING_INTERVAL_MINUTES`.
  * The poller's own preflight still needs `MYSQL_*` / `MONGODB_*` (optional legacy block in `.env`). Until it is ported to PostgreSQL and ClickHouse, `mtr-backend` restarts in a loop if those are absent.
  * The frontend skips legacy MySQL auth seeding when `MYSQL_HOST` is unset. Its healthcheck uses `/login` because `/api/health` probes MySQL and MongoDB.
* Async enrichment of `device_id` for syslog and flows (source IP to `devices.id`) is a Phase 2
  backend job.
* SNMP polling and burst scheduling code (writing `interface_metrics` deltas) is Phase 2.

## 6. What was verified, and how

**Tested locally without containers (ClickHouse 26.x, PostgreSQL 16.2, Vector 0.60.0, goflow2 v2.2.7):**
* Both schemas apply cleanly and are idempotent.
* The PostgreSQL entrypoint (initdb, pg_hba, role and database bootstrap) works.
* Burst auto-expiry and the 8 h cap behave as described.
* The ClickHouse `config.d`/`users.d` files load: listeners on 0.0.0.0, environment password, unused ports removed.
* `vector validate` passes. End-to-end, syslog over UDP/TCP and goflow2 flows (including file rotation) reach ClickHouse.
* The mock seeder loads the full dataset (50 k syslog, 179 k metrics, 100 k flows).
* `podman-compose.yml` passes Compose-spec validation (`docker compose config`) and `podman-compose 1.6.0 config`.

**Not tested:** building the images and running the stack under Podman. The authoring sandbox (podman 4.3.1) blocks
the overlay/vfs storage mounts that `podman build` needs, so the first `podman-compose up --build` on a RHEL9 host is the real
integration test.


---

## 7. Phase 2 — FastAPI API, SNMP poller and new dashboard pages

Phase 2 lives in `backend_v2/` and `frontend_additions/`. Its full documentation is in
`docs/PHASE2_README.md`. This compose file now includes it:

| Service | Image base | Host listener | Notes |
|---|---|---|---|
| `mtr-api` | `ubi9/python-311` | `0.0.0.0:${MTR_API_PORT:-8000}` | FastAPI `/api/v2/*` with 4 uvicorn workers, plus the async SNMP v2c/v3 poller and burst manager (one leader per host, chosen through a Redis lock) |

* **Build context.** The repository root, with `backend_v2/Containerfile`. The source is kept
  in `backend_v2/`, apart from the legacy `backend/`, so the two `requirements.txt` files do not
  collide; the image installs it as the Python package `backend`.
* **Frontend.** Copy `frontend_additions/{app,components,lib}` into `frontend/`. These
  are new files only; no existing file is overwritten. Then, in `frontend/`, run
  `npm install recharts@^3` so that `package.json` and `package-lock.json` pick up Recharts.
  `mtr-frontend` now receives `BACKEND_URL` (default `http://localhost:8000`) and
  `MTR_API_SHARED_SECRET`.
* **New `.env` variables.** These are also in `.env.example`.

  | Variable | Required | Default | Purpose |
  |---|---|---|---|
  | `MTR_API_SHARED_SECRET` | yes | — | Shared secret for the Next.js `/api/v2` proxy to FastAPI (`openssl rand -base64 32`) |
  | `MTR_API_PORT` | no | 8000 | uvicorn listen port |
  | `MTR_API_WORKERS` | no | 4 | uvicorn worker count |
  | `BACKEND_URL` | no | `http://localhost:8000` | Where the frontend proxy reaches the API |
  | `FRONTEND_ORIGIN` | no | `http://localhost:3000` | CORS allow-list (comma-separated) |
  | `SNMP_POLLER_ENABLED` | no | true | Set false to run the API without the poller |
  | `SNMP_TIMEOUT`, `SNMP_RETRIES`, `SNMP_CONCURRENCY` | no | 3, 1, 50 | SNMP tuning |
  | `MTR_APPLY_MIGRATIONS` | no | true | Apply `backend_v2/migrations/*.sql` on startup |

* **Firewall.** Port 8000 only needs to be reachable from the frontend host. Keep it on localhost
  or the management network. Requests without the correct `X-MTR-Internal-Token` are rejected,
  but whoever holds that secret can assert any user or role, so treat the secret like a password.
* **Schema fix.** Phase 2 migration `002_burst_expiry_trigger_fix.sql` (applied automatically by
  `mtr-api`) changes the Phase 1 `burst_sessions` statement trigger from BEFORE INSERT OR UPDATE
  to BEFORE INSERT only. With the original trigger, an UPDATE on a row that had just expired
  failed with `TriggeredDataChangeViolation`, so a burst session could not be stopped. Section 4,
  item 10 above describes the original Phase 1 behaviour.
* **SNMP vs. MTR polling.** `mtr-backend` remains the legacy MTR/ICMP poller. SNMP IF-MIB polling
  and burst polling now live in `mtr-api`.
* **Not tested:** as with Phase 1, building and running the images under Podman was not possible
  in the authoring sandbox. The rendered compose file was checked with `podman-compose config`.
