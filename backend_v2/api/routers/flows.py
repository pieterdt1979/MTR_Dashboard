"""Flow analytics (netflow_records) and interface bandwidth time series (interface_metrics)."""
from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.api.deps import TimeRange, device_ip_or_404, iso, require_internal, time_range
from backend.db import clickhouse, postgres

router = APIRouter(prefix="/api/v2/flows", tags=["flows"], dependencies=[Depends(require_internal)])

GROUP_EXPR = {
    "src_ip": "IPv4NumToString(src_ip)",
    "dst_ip": "IPv4NumToString(dst_ip)",
    "protocol": "toString(protocol)",
    "port": "toString(dst_port)",
}


async def _device_filter(device_id: Optional[int], params: dict[str, Any]) -> str:
    if device_id is None:
        return "1"
    params["device_id"] = device_id
    params["ip"] = await device_ip_or_404(device_id)
    # goflow2/Vector rows carry device_id=0 until enrichment -> fall back to the exporter IP.
    return "(device_id = {device_id:UInt32} OR (device_id = 0 AND exporter_ip = toIPv4({ip:String})))"


@router.get("/toptalkers")
async def top_talkers(
    tr: TimeRange = Depends(time_range(default_hours=1)),
    device_id: Optional[int] = None,
    top_n: int = Query(default=10, ge=1, le=100),
    group_by: Literal["src_ip", "dst_ip", "protocol", "port"] = "src_ip",
) -> dict[str, Any]:
    params: dict[str, Any] = {"f": tr.start_ts, "t": tr.end_ts, "n": top_n}
    dev = await _device_filter(device_id, params)
    cond = f"flow_start >= toDateTime({{f:UInt32}}) AND flow_start < toDateTime({{t:UInt32}}) AND {dev}"
    key = GROUP_EXPR[group_by]
    rows = await clickhouse.query(
        f"""SELECT {key} AS grp, sum(bytes) AS sum_bytes, sum(packets) AS sum_packets, count() AS n_flows,
                   topKWeighted(1)(protocol, bytes)[1] AS top_proto
            FROM netflow_records WHERE {cond}
            GROUP BY grp ORDER BY sum_bytes DESC LIMIT {{n:UInt32}}""",
        params,
    )
    totals = (await clickhouse.query(
        f"SELECT sum(bytes) AS sum_bytes, sum(packets) AS sum_packets, count() AS n_flows FROM netflow_records WHERE {cond}",
        params,
    ))[0]
    total_bytes = int(totals["sum_bytes"] or 0)
    items = [
        {"rank": i + 1, "key": r["grp"], "bytes": int(r["sum_bytes"]), "packets": int(r["sum_packets"]),
         "flows": int(r["n_flows"]), "protocol": int(r["top_proto"]),
         "pct": round(100.0 * int(r["sum_bytes"]) / total_bytes, 2) if total_bytes else 0.0}
        for i, r in enumerate(rows)
    ]
    return {"group_by": group_by, "from": iso(tr.start_ts), "to": iso(tr.end_ts),
            "total_bytes": total_bytes, "total_packets": int(totals["sum_packets"] or 0),
            "total_flows": int(totals["n_flows"] or 0), "items": items}


@router.get("/bandwidth")
async def bandwidth(
    device_id: int,
    tr: TimeRange = Depends(time_range(default_hours=24)),
    ifindex: Optional[int] = None,
    bucket_minutes: int = Query(default=5, ge=1, le=1440),
    source: Literal["snmp", "netflow"] = "snmp",
) -> dict[str, Any]:
    """In/Out bps per time bucket. source=snmp uses interface_metrics deltas (authoritative);
    source=netflow sums flow bytes by input/output ifindex (sampled, already rate-corrected)."""
    if tr.seconds / (bucket_minutes * 60) > 5000:
        raise HTTPException(status_code=422, detail="too many buckets; increase bucket_minutes")
    iface = None
    if ifindex is not None:
        iface = await postgres.fetchrow(
            "SELECT id, ifindex, ifname, ifspeed_bps FROM interfaces WHERE device_id = $1 AND ifindex = $2",
            device_id, ifindex,
        )
        if iface is None:
            raise HTTPException(status_code=404, detail="interface not found")
    params: dict[str, Any] = {"f": tr.start_ts, "t": tr.end_ts, "b": bucket_minutes, "device_id": device_id}
    bucket_sec = bucket_minutes * 60

    if source == "snmp":
        params["iid"] = iface["id"] if iface else 0
        iface_cond = "AND interface_id = {iid:UInt32}" if iface else ""
        if bucket_minutes >= 5 and bucket_minutes % 5 == 0:
            inner = f"""SELECT toStartOfInterval(bucket, INTERVAL {{b:UInt32}} MINUTE) AS b, interface_id,
                               sum(in_octets) AS i, sum(out_octets) AS o, sum(covered_sec) AS c,
                               max(peak_in_bps) AS pi, max(peak_out_bps) AS po
                        FROM interface_metrics_5m
                        WHERE device_id = {{device_id:UInt32}} {iface_cond}
                          AND bucket >= toDateTime({{f:UInt32}}) AND bucket < toDateTime({{t:UInt32}})
                        GROUP BY b, interface_id"""
        else:
            inner = f"""SELECT toStartOfInterval(ts, INTERVAL {{b:UInt32}} MINUTE) AS b, interface_id,
                               sum(in_octets) AS i, sum(out_octets) AS o, sum(poll_interval_sec) AS c,
                               max(in_octets * 8 / greatest(poll_interval_sec, 1)) AS pi,
                               max(out_octets * 8 / greatest(poll_interval_sec, 1)) AS po
                        FROM interface_metrics
                        WHERE device_id = {{device_id:UInt32}} {iface_cond}
                          AND ts >= toDateTime({{f:UInt32}}) AND ts < toDateTime({{t:UInt32}})
                        GROUP BY b, interface_id"""
        # Average rate per interface = octets / seconds actually covered; device total = sum over interfaces.
        sql = f"""SELECT toUnixTimestamp(b) AS ts,
                         sum(i * 8 / greatest(c, 1)) AS in_bps, sum(o * 8 / greatest(c, 1)) AS out_bps,
                         sum(pi) AS peak_in_bps, sum(po) AS peak_out_bps
                  FROM ({inner}) GROUP BY b ORDER BY b"""
    else:
        params["ip"] = await device_ip_or_404(device_id)
        params["ifx"] = ifindex or 0
        dev = "(device_id = {device_id:UInt32} OR (device_id = 0 AND exporter_ip = toIPv4({ip:String})))"
        in_cond = "input_ifindex = {ifx:UInt32}" if ifindex is not None else "1"
        out_cond = "output_ifindex = {ifx:UInt32}" if ifindex is not None else "1"
        sql = f"""SELECT toUnixTimestamp(toStartOfInterval(flow_start, INTERVAL {{b:UInt32}} MINUTE)) AS ts,
                         sumIf(bytes, {in_cond}) * 8 / {bucket_sec} AS in_bps,
                         sumIf(bytes, {out_cond}) * 8 / {bucket_sec} AS out_bps,
                         in_bps AS peak_in_bps, out_bps AS peak_out_bps
                  FROM netflow_records
                  WHERE {dev} AND flow_start >= toDateTime({{f:UInt32}}) AND flow_start < toDateTime({{t:UInt32}})
                  GROUP BY ts ORDER BY ts"""
    rows = await clickhouse.query(sql, params)
    points = [{"ts": iso(r["ts"]),
               "in_bps": float(r["in_bps"]), "out_bps": float(r["out_bps"]),
               "in_mbps": round(float(r["in_bps"]) / 1e6, 3), "out_mbps": round(float(r["out_bps"]) / 1e6, 3),
               "peak_in_bps": float(r["peak_in_bps"]), "peak_out_bps": float(r["peak_out_bps"])}
              for r in rows]
    return {"device_id": device_id, "ifindex": ifindex, "source": source, "bucket_minutes": bucket_minutes,
            "interface": dict(iface) if iface else None,
            "speed_bps": int(iface["ifspeed_bps"]) if iface and iface["ifspeed_bps"] else None,
            "points": points}
