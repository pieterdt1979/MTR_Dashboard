-- =============================================================================
-- MTR Dashboard / ConnectedInsight — Phase 1 consolidated PostgreSQL 16 schema
-- Replaces backend/db_schema.sql (MySQL) and the MongoDB device documents.
-- Idempotent: safe to re-run.
--
-- SECURITY: columns suffixed *_enc hold ciphertext produced by the APPLICATION using
-- AES-256-GCM (key supplied via the MTR_CREDENTIAL_KEY environment variable, never stored
-- in the database). Format: base64(nonce(12) || ciphertext || tag(16)). PostgreSQL never
-- sees plaintext secrets — this is NOT database-level encryption.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE snmp_version_t   AS ENUM ('v2c', 'v3');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE device_vendor_t  AS ENUM ('cisco', 'huawei', 'adva', 'radware', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE device_status_t  AS ENUM ('up', 'down', 'degraded', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE severity_t       AS ENUM ('critical', 'major', 'minor', 'warning', 'info');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE incident_state_t AS ENUM ('open', 'acknowledged', 'suppressed', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE alert_metric_t   AS ENUM ('packet_loss', 'latency', 'ifOperStatus', 'syslog_pattern', 'flow_threshold');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Generic updated_at maintenance
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- sites
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sites (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(128) NOT NULL UNIQUE,
    city        VARCHAR(128),
    country     VARCHAR(64),
    timezone    VARCHAR(64)  NOT NULL DEFAULT 'UTC',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- devices  (SERIAL ids fit ClickHouse UInt32 device_id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
    id              SERIAL PRIMARY KEY,
    site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
    hostname        VARCHAR(255) NOT NULL,
    mgmt_ip         INET NOT NULL,
    snmp_version    snmp_version_t  NOT NULL DEFAULT 'v2c',
    vendor          device_vendor_t NOT NULL DEFAULT 'other',
    model           VARCHAR(128),
    sys_oid         VARCHAR(255),
    sys_descr       TEXT,
    status          device_status_t NOT NULL DEFAULT 'unknown',
    last_polled_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_devices_mgmt_ip  UNIQUE (mgmt_ip),
    CONSTRAINT uq_devices_hostname UNIQUE (hostname)
);
-- uq_devices_mgmt_ip already provides the btree index on mgmt_ip.
CREATE INDEX IF NOT EXISTS idx_devices_site    ON devices (site_id);
CREATE INDEX IF NOT EXISTS idx_devices_vendor  ON devices (vendor);
CREATE INDEX IF NOT EXISTS idx_devices_status  ON devices (status);

DROP TRIGGER IF EXISTS trg_devices_updated_at ON devices;
CREATE TRIGGER trg_devices_updated_at BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- interfaces
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interfaces (
    id              SERIAL PRIMARY KEY,
    device_id       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ifindex         INTEGER NOT NULL,
    ifname          VARCHAR(128) NOT NULL,
    ifalias         VARCHAR(255),
    ifdescr         VARCHAR(255),
    ifspeed_bps     BIGINT,
    ifadmin_status  SMALLINT NOT NULL DEFAULT 1 CHECK (ifadmin_status BETWEEN 1 AND 3),   -- IF-MIB: 1 up, 2 down, 3 testing
    ifoper_status   SMALLINT NOT NULL DEFAULT 4 CHECK (ifoper_status  BETWEEN 1 AND 7),   -- IF-MIB: 1 up .. 7 lowerLayerDown
    last_metric_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_interfaces_device_ifindex UNIQUE (device_id, ifindex)
);
-- uq_interfaces_device_ifindex provides the (device_id, ifindex) index.
CREATE INDEX IF NOT EXISTS idx_interfaces_oper ON interfaces (ifoper_status) WHERE ifoper_status <> 1;

-- ---------------------------------------------------------------------------
-- snmp_credentials  (*_enc = application-layer AES-256-GCM ciphertext)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snmp_credentials (
    id                    SERIAL PRIMARY KEY,
    label                 VARCHAR(128) NOT NULL UNIQUE,
    version               snmp_version_t NOT NULL,
    community_string_enc  TEXT,
    v3_username           VARCHAR(128),
    v3_auth_proto         VARCHAR(16) CHECK (v3_auth_proto IS NULL OR v3_auth_proto IN ('MD5','SHA','SHA224','SHA256','SHA384','SHA512')),
    v3_auth_key_enc       TEXT,
    v3_priv_proto         VARCHAR(16) CHECK (v3_priv_proto IS NULL OR v3_priv_proto IN ('DES','3DES','AES','AES192','AES256')),
    v3_priv_key_enc       TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_snmp_v2c CHECK (version <> 'v2c' OR community_string_enc IS NOT NULL),
    CONSTRAINT chk_snmp_v3  CHECK (version <> 'v3'  OR v3_username IS NOT NULL)
);
COMMENT ON COLUMN snmp_credentials.community_string_enc IS 'AES-256-GCM ciphertext (application layer, key from MTR_CREDENTIAL_KEY env var)';
COMMENT ON COLUMN snmp_credentials.v3_auth_key_enc      IS 'AES-256-GCM ciphertext (application layer, key from MTR_CREDENTIAL_KEY env var)';
COMMENT ON COLUMN snmp_credentials.v3_priv_key_enc      IS 'AES-256-GCM ciphertext (application layer, key from MTR_CREDENTIAL_KEY env var)';

CREATE TABLE IF NOT EXISTS device_credentials (
    device_id      INTEGER NOT NULL REFERENCES devices(id)          ON DELETE CASCADE,
    credential_id  INTEGER NOT NULL REFERENCES snmp_credentials(id) ON DELETE RESTRICT,
    PRIMARY KEY (device_id, credential_id)
);
CREATE INDEX IF NOT EXISTS idx_device_credentials_cred ON device_credentials (credential_id);

-- ---------------------------------------------------------------------------
-- burst_sessions — on-demand high-frequency polling, hard-capped at 8 hours
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS burst_sessions (
    id            SERIAL PRIMARY KEY,
    device_id     INTEGER NOT NULL REFERENCES devices(id)    ON DELETE CASCADE,
    interface_id  INTEGER NULL     REFERENCES interfaces(id) ON DELETE CASCADE,
    initiated_by  VARCHAR(128) NOT NULL,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '8 hours'),
    ended_at      TIMESTAMPTZ NULL,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT chk_burst_max_8h CHECK (expires_at <= started_at + INTERVAL '8 hours'),
    CONSTRAINT chk_burst_order  CHECK (expires_at >  started_at)
);
CREATE INDEX IF NOT EXISTS idx_burst_active_expires ON burst_sessions (is_active, expires_at);
CREATE INDEX IF NOT EXISTS idx_burst_device         ON burst_sessions (device_id);
-- At most one active burst per (device, interface); NULL interface = whole device.
CREATE UNIQUE INDEX IF NOT EXISTS uq_burst_active_target
    ON burst_sessions (device_id, COALESCE(interface_id, 0)) WHERE is_active;

-- auto_expire_bursts(): deactivates every session past its expiry. Returns rows expired.
-- Called (a) by the BEFORE statement trigger below on any write to burst_sessions, and
-- (b) periodically by the backend scheduler:  SELECT auto_expire_bursts();
CREATE OR REPLACE FUNCTION auto_expire_bursts() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    n integer;
BEGIN
    UPDATE burst_sessions
       SET is_active = false,
           ended_at  = COALESCE(ended_at, expires_at)
     WHERE is_active
       AND expires_at < now();
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION trg_auto_expire_bursts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Guard against recursion: the UPDATE inside auto_expire_bursts() fires this trigger again.
    IF pg_trigger_depth() = 1 THEN
        PERFORM auto_expire_bursts();
    END IF;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_burst_sessions_expire ON burst_sessions;
CREATE TRIGGER trg_burst_sessions_expire
    BEFORE INSERT OR UPDATE ON burst_sessions   -- BEFORE: stale sessions are cleared before the
                                                -- uq_burst_active_target check on the new row
    FOR EACH STATEMENT EXECUTE FUNCTION trg_auto_expire_bursts();

-- Row trigger: ending a session (is_active -> false) stamps ended_at.
CREATE OR REPLACE FUNCTION trg_burst_stamp_end() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.is_active = false AND OLD.is_active = true AND NEW.ended_at IS NULL THEN
        NEW.ended_at := LEAST(now(), NEW.expires_at);
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_burst_sessions_stamp_end ON burst_sessions;
CREATE TRIGGER trg_burst_sessions_stamp_end
    BEFORE UPDATE OF is_active ON burst_sessions
    FOR EACH ROW EXECUTE FUNCTION trg_burst_stamp_end();

-- Read path that is always correct even between expiry sweeps.
CREATE OR REPLACE VIEW active_burst_sessions AS
    SELECT * FROM burst_sessions WHERE is_active AND expires_at > now();

-- ---------------------------------------------------------------------------
-- incidents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
    id                         SERIAL PRIMARY KEY,
    device_id                  INTEGER NOT NULL REFERENCES devices(id)    ON DELETE CASCADE,
    interface_id               INTEGER NULL     REFERENCES interfaces(id) ON DELETE SET NULL,
    severity                   severity_t       NOT NULL,
    title                      VARCHAR(255)     NOT NULL,
    description                TEXT,
    state                      incident_state_t NOT NULL DEFAULT 'open',
    suppressed_by_incident_id  INTEGER NULL REFERENCES incidents(id) ON DELETE SET NULL,
    opened_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at            TIMESTAMPTZ,
    resolved_at                TIMESTAMPTZ,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_incident_not_self_suppressed CHECK (suppressed_by_incident_id IS NULL OR suppressed_by_incident_id <> id),
    CONSTRAINT chk_incident_suppressed_parent   CHECK (state <> 'suppressed' OR suppressed_by_incident_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_incidents_state_device ON incidents (state, device_id);
CREATE INDEX IF NOT EXISTS idx_incidents_opened       ON incidents (opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_parent       ON incidents (suppressed_by_incident_id) WHERE suppressed_by_incident_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- alert_rules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_rules (
    id               SERIAL PRIMARY KEY,
    name             VARCHAR(128) NOT NULL UNIQUE,
    metric           alert_metric_t NOT NULL,
    threshold_value  NUMERIC,
    severity         severity_t NOT NULL DEFAULT 'warning',
    device_selector  JSONB NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"vendor":["cisco"],"site_id":[1,2]}
    is_active        BOOLEAN NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_active   ON alert_rules (is_active, metric);
CREATE INDEX IF NOT EXISTS idx_alert_rules_selector ON alert_rules USING GIN (device_selector);

-- ---------------------------------------------------------------------------
-- Legacy carry-over: probe state used by mtr_poller.py (PostgresStateClient)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_probe_state (
    device_id                  INTEGER PRIMARY KEY,
    baseline_latency_ms        DOUBLE PRECISION,
    last_latency_ms            DOUBLE PRECISION,
    last_jitter_ms             DOUBLE PRECISION,
    last_fping_at              TIMESTAMPTZ,
    last_mtr_at                TIMESTAMPTZ,
    consecutive_jitter_breach  INTEGER NOT NULL DEFAULT 0,
    cooldown_until             TIMESTAMPTZ,
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Default alert rules (no secrets)
INSERT INTO alert_rules (name, metric, threshold_value, severity, device_selector) VALUES
    ('High packet loss',        'packet_loss',    5,    'major',    '{}'),
    ('High latency',            'latency',        150,  'minor',    '{}'),
    ('Interface down',          'ifOperStatus',   2,    'critical', '{}'),
    ('BGP neighbour down',      'syslog_pattern', NULL, 'critical', '{"pattern":"BGP-5-ADJCHANGE.*Down|BGP/2/BACKWARD"}'),
    ('Flow volume > 1 Gbps',    'flow_threshold', 1000000000, 'warning', '{}')
ON CONFLICT (name) DO NOTHING;

COMMIT;
