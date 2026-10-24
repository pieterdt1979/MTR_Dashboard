-- =============================================================================
-- MTR Dashboard / ConnectedInsight — Phase 1 ClickHouse schema
-- Applied by the container entrypoint with `--database ${CLICKHOUSE_DB}` (default: mtr),
-- so table names are intentionally unqualified. Idempotent (IF NOT EXISTS).
-- device_id / interface_id map to PostgreSQL devices.id / interfaces.id (0 = not yet enriched).
-- =============================================================================

-- Syslog (Vector -> HTTP 8123). 30-day retention.
CREATE TABLE IF NOT EXISTS syslog_events
(
    event_time      DateTime CODEC(DoubleDelta, ZSTD(1)),
    device_id       UInt32,
    source_ip       IPv4,
    facility        UInt8,
    severity        UInt8,
    mnemonic        LowCardinality(String),
    raw_message     String CODEC(ZSTD(3)),
    parsed_host     LowCardinality(String),
    parsed_program  LowCardinality(String),
    INDEX idx_mnemonic mnemonic   TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_source   source_ip  TYPE minmax           GRANULARITY 4,
    INDEX idx_raw      raw_message TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_time)
ORDER BY (device_id, event_time)
TTL event_time + INTERVAL 30 DAY
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

-- NetFlow v5/v9 / IPFIX / NetStream (goflow2 -> Vector). 90-day retention.
CREATE TABLE IF NOT EXISTS netflow_records
(
    flow_start      DateTime CODEC(DoubleDelta, ZSTD(1)),
    flow_end        DateTime CODEC(DoubleDelta, ZSTD(1)),
    exporter_ip     IPv4,
    device_id       UInt32,
    input_ifindex   UInt32,
    output_ifindex  UInt32,
    src_ip          IPv4,
    dst_ip          IPv4,
    src_port        UInt16,
    dst_port        UInt16,
    protocol        UInt8,
    bytes           UInt64,
    packets         UInt32,
    input_ifname    LowCardinality(String),
    output_ifname   LowCardinality(String)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(flow_start)
ORDER BY (device_id, flow_start)
TTL flow_start + INTERVAL 90 DAY
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

-- SNMP interface counters. The poller stores PER-INTERVAL DELTAS (octets/errors/discards
-- accumulated during poll_interval_sec, already corrected for 32/64-bit counter wraps and
-- device reboots), so rollups are simple sums and work for both 300 s and 30 s burst polling.
-- 90-day retention.
CREATE TABLE IF NOT EXISTS interface_metrics
(
    ts                 DateTime CODEC(DoubleDelta, ZSTD(1)),
    device_id          UInt32,
    interface_id       UInt32,
    poll_interval_sec  UInt16,
    in_octets          UInt64 COMMENT 'octets received during poll_interval_sec (delta)',
    out_octets         UInt64 COMMENT 'octets sent during poll_interval_sec (delta)',
    in_errors          UInt32 COMMENT 'delta',
    out_errors         UInt32 COMMENT 'delta',
    in_discards        UInt32 COMMENT 'delta',
    out_discards       UInt32 COMMENT 'delta',
    ifoper_status      UInt8  COMMENT 'IF-MIB ifOperStatus at poll time (1=up, 2=down, ...)'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (device_id, interface_id, ts)
TTL ts + INTERVAL 90 DAY
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

-- -----------------------------------------------------------------------------
-- 5-minute rollups for dashboards: AggregatingMergeTree target + materialized view.
-- Rows for one bucket may arrive in several inserts (burst polling @30 s, late pollers),
-- so the target stores partial aggregates that background merges combine. 365-day retention.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interface_metrics_5m_agg
(
    bucket             DateTime,
    device_id          UInt32,
    interface_id       UInt32,
    samples            SimpleAggregateFunction(sum, UInt64),
    covered_sec        SimpleAggregateFunction(sum, UInt64),
    in_octets          SimpleAggregateFunction(sum, UInt64),
    out_octets         SimpleAggregateFunction(sum, UInt64),
    in_errors          SimpleAggregateFunction(sum, UInt64),
    out_errors         SimpleAggregateFunction(sum, UInt64),
    in_discards        SimpleAggregateFunction(sum, UInt64),
    out_discards       SimpleAggregateFunction(sum, UInt64),
    peak_in_bps        SimpleAggregateFunction(max, Float64),
    peak_out_bps       SimpleAggregateFunction(max, Float64),
    oper_down_samples  SimpleAggregateFunction(sum, UInt64),
    last_oper_status   AggregateFunction(argMax, UInt8, DateTime)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (device_id, interface_id, bucket)
TTL bucket + INTERVAL 365 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS interface_metrics_5m_mv
TO interface_metrics_5m_agg
AS
SELECT
    toStartOfFiveMinutes(ts)                                   AS bucket,
    device_id,
    interface_id,
    toUInt64(count())                                          AS samples,
    toUInt64(sum(interface_metrics.poll_interval_sec))                           AS covered_sec,
    toUInt64(sum(interface_metrics.in_octets))                                   AS in_octets,
    toUInt64(sum(interface_metrics.out_octets))                                  AS out_octets,
    toUInt64(sum(interface_metrics.in_errors))                                   AS in_errors,
    toUInt64(sum(interface_metrics.out_errors))                                  AS out_errors,
    toUInt64(sum(interface_metrics.in_discards))                                 AS in_discards,
    toUInt64(sum(interface_metrics.out_discards))                                AS out_discards,
    toFloat64(max(interface_metrics.in_octets  * 8 / greatest(interface_metrics.poll_interval_sec, 1))) AS peak_in_bps,
    toFloat64(max(interface_metrics.out_octets * 8 / greatest(interface_metrics.poll_interval_sec, 1))) AS peak_out_bps,
    toUInt64(countIf(interface_metrics.ifoper_status != 1))                      AS oper_down_samples,
    argMaxState(interface_metrics.ifoper_status, ts)                             AS last_oper_status
FROM interface_metrics
GROUP BY bucket, device_id, interface_id;

-- Query-friendly 5-minute view used by the dashboard API, e.g.
--   SELECT * FROM interface_metrics_5m
--   WHERE device_id = 42 AND bucket >= now() - INTERVAL 1 DAY ORDER BY bucket
CREATE VIEW IF NOT EXISTS interface_metrics_5m AS
SELECT
    bucket,
    device_id,
    interface_id,
    sum(interface_metrics_5m_agg.samples)                                   AS samples,
    sum(interface_metrics_5m_agg.covered_sec)                               AS covered_sec,
    sum(interface_metrics_5m_agg.in_octets)                                 AS in_octets,
    sum(interface_metrics_5m_agg.out_octets)                                AS out_octets,
    in_octets  * 8 / greatest(covered_sec, 1)       AS avg_in_bps,
    out_octets * 8 / greatest(covered_sec, 1)       AS avg_out_bps,
    max(interface_metrics_5m_agg.peak_in_bps)                               AS peak_in_bps,
    max(interface_metrics_5m_agg.peak_out_bps)                              AS peak_out_bps,
    sum(interface_metrics_5m_agg.in_errors)                                 AS in_errors,
    sum(interface_metrics_5m_agg.out_errors)                                AS out_errors,
    sum(interface_metrics_5m_agg.in_discards)                               AS in_discards,
    sum(interface_metrics_5m_agg.out_discards)                              AS out_discards,
    sum(interface_metrics_5m_agg.oper_down_samples)                         AS oper_down_samples,
    argMaxMerge(interface_metrics_5m_agg.last_oper_status)                  AS last_oper_status
FROM interface_metrics_5m_agg
GROUP BY bucket, device_id, interface_id;
