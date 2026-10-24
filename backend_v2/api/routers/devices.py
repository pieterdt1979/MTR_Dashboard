"""Device inventory + per-device interface metrics."""
from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.api.deps import TimeRange, iso, require_internal, time_range
from backend.db import clickhouse, postgres

router = APIRouter(prefix="/api/v2/devices", tags=["devices"], dependencies=[Depends(require_internal)])

DEVICE_COLUMNS = """
    d.id, d.hostname, host(d.mgmt_ip) AS mgmt_ip, d.vendor::text AS vendor, d.model,
    d.snmp_version::text AS snmp_version, d.status::text AS status, d.last_polled_at,
    d.site_id, s.name AS site_name, s.city AS site_city, s.country AS site_country,
    (SELECT count(*) FROM interfaces i WHERE i.device_id = d.id)::int AS interface_count,
    (SELECT count(*) FROM incidents x WHERE x.device_id = d.id AND x.state IN ('open','acknowledged'))::int
        AS open_incidents,
    EXISTS (SELECT 1 FROM active_burst_sessions b WHERE b.device_id = d.id) AS burst_active
"""


@router.get("")
async def list_devices(
    q: Optional[str] = Query(default=None, description="hostname / IP / model substring"),
    site_id: Optional[int] = None,
    status: Optional[Literal["up", "down", "degraded", "unknown"]] = None,
    vendor: Optional[str] = None,
) -> dict[str, Any]:
    rows = await postgres.fetch(
        f"""SELECT {DEVICE_COLUMNS}
            FROM devices d JOIN sites s ON s.id = d.site_id
            WHERE ($1::text IS NULL OR d.hostname ILIKE '%' || $1 || '%'
                   OR host(d.mgmt_ip) LIKE $1 || '%' OR d.model ILIKE '%' || $1 || '%')
              AND ($2::int  IS NULL OR d.site_id = $2)
              AND ($3::text IS NULL OR d.status::text = $3)
              AND ($4::text IS NULL OR d.vendor::text = $4)
            ORDER BY d.hostname""",
        q, site_id, status, vendor,
    )
    items = [dict(r) for r in rows]
    return {"items": items, "total": len(items)}


@router.get("/{device_id}")
async def get_device(device_id: int) -> dict[str, Any]:
    row = await postgres.fetchrow(
        f"""SELECT {DEVICE_COLUMNS}, d.sys_oid, d.sys_descr, d.created_at, d.updated_at
            FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = $1""",
        device_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="device not found")
    device = dict(row)

    ifaces = await postgres.fetch(
        """SELECT id, ifindex, ifname, ifalias, ifdescr, ifspeed_bps, ifadmin_status, ifoper_status, last_metric_at
           FROM interfaces WHERE device_id = $1 ORDER BY ifindex""",
        device_id,
    )
    # Latest sample per interface (last 2 h) -> current In/Out bps.
    latest = await clickhouse.query(
        """SELECT interface_id,
                  argMax(in_octets  * 8 / greatest(poll_interval_sec, 1), ts) AS in_bps,
                  argMax(out_octets * 8 / greatest(poll_interval_sec, 1), ts) AS out_bps,
                  toUnixTimestamp(max(ts)) AS last_unix
           FROM interface_metrics
           WHERE device_id = {device_id:UInt32} AND ts >= now() - INTERVAL 2 HOUR
           GROUP BY interface_id""",
        {"device_id": device_id},
    )
    by_iface = {r["interface_id"]: r for r in latest}
    device["interfaces"] = []
    for i in ifaces:
        d = dict(i)
        m = by_iface.get(i["id"])
        d["in_bps"] = float(m["in_bps"]) if m else None
        d["out_bps"] = float(m["out_bps"]) if m else None
        d["metric_ts"] = iso(m["last_unix"]) if m else None
        device["interfaces"].append(d)

    burst = await postgres.fetchrow(
        """SELECT id, device_id, interface_id, initiated_by, started_at, expires_at,
                  GREATEST(0, EXTRACT(EPOCH FROM expires_at - now()))::int AS remaining_seconds
           FROM active_burst_sessions WHERE device_id = $1 ORDER BY started_at DESC LIMIT 1""",
        device_id,
    )
    device["active_burst"] = dict(burst) if burst else None
    return device


@router.get("/{device_id}/metrics")
async def device_metrics(
    device_id: int,
    tr: TimeRange = Depends(time_range(default_hours=6)),
    ifindex: Optional[int] = None,
    resolution: Literal["auto", "raw", "5m"] = "auto",
) -> dict[str, Any]:
    ifaces = await postgres.fetch(
        """SELECT id, ifindex, ifname, ifspeed_bps FROM interfaces
           WHERE device_id = $1 AND ($2::int IS NULL OR ifindex = $2) ORDER BY ifindex""",
        device_id, ifindex,
    )
    if not ifaces:
        exists = await postgres.fetchval("SELECT 1 FROM devices WHERE id = $1", device_id)
        if not exists:
            raise HTTPException(status_code=404, detail="device not found")
        if ifindex is not None:
            raise HTTPException(status_code=404, detail="interface not found")
        return {"device_id": device_id, "resolution": "raw", "interfaces": [], "points": []}

    use_raw = resolution == "raw" or (resolution == "auto" and tr.seconds <= 6 * 3600)
    params = {"device_id": device_id, "ids": [i["id"] for i in ifaces], "f": tr.start_ts, "t": tr.end_ts}
    if use_raw:
        sql = """SELECT toUnixTimestamp(ts) AS unix_ts, interface_id,
                        in_octets * 8 / greatest(poll_interval_sec, 1)  AS in_bps,
                        out_octets * 8 / greatest(poll_interval_sec, 1) AS out_bps,
                        in_errors, out_errors, in_discards, out_discards, ifoper_status AS oper_status
                 FROM interface_metrics
                 WHERE device_id = {device_id:UInt32} AND interface_id IN {ids:Array(UInt32)}
                   AND ts >= toDateTime({f:UInt32}) AND ts < toDateTime({t:UInt32})
                 ORDER BY unix_ts LIMIT 200000"""
    else:
        sql = """SELECT toUnixTimestamp(bucket) AS unix_ts, interface_id, avg_in_bps AS in_bps, avg_out_bps AS out_bps,
                        in_errors, out_errors, in_discards, out_discards, last_oper_status AS oper_status
                 FROM interface_metrics_5m
                 WHERE device_id = {device_id:UInt32} AND interface_id IN {ids:Array(UInt32)}
                   AND bucket >= toDateTime({f:UInt32}) AND bucket < toDateTime({t:UInt32})
                 ORDER BY unix_ts LIMIT 200000"""
    rows = await clickhouse.query(sql, params)
    idx_by_id = {i["id"]: i["ifindex"] for i in ifaces}
    points = [
        {**{k: v for k, v in r.items() if k != "unix_ts"}, "ts": iso(r["unix_ts"]), "ifindex": idx_by_id.get(r["interface_id"]),
         "in_bps": float(r["in_bps"]), "out_bps": float(r["out_bps"])}
        for r in rows
    ]
    return {
        "device_id": device_id,
        "resolution": "raw" if use_raw else "5m",
        "interfaces": [dict(i) for i in ifaces],
        "points": points,
    }
