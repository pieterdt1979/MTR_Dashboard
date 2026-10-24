"""Syslog explorer over ClickHouse `syslog_events`."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.api.deps import (
    SEVERITY_NAMES,
    TimeRange,
    device_ip_or_404,
    hostnames_by_id_and_ip,
    iso,
    require_internal,
    time_range,
)
from backend.db import clickhouse

router = APIRouter(prefix="/api/v2/syslog", tags=["syslog"], dependencies=[Depends(require_internal)])


def parse_severities(raw: Optional[str]) -> Optional[list[int]]:
    """'0,1,2' or 'error,warning' (names per RFC 5424) -> [ints]."""
    if not raw:
        return None
    out: list[int] = []
    for part in raw.split(","):
        p = part.strip().lower()
        if not p:
            continue
        if p.isdigit() and 0 <= int(p) <= 7:
            out.append(int(p))
        elif p in SEVERITY_NAMES:
            out.append(SEVERITY_NAMES.index(p))
        elif p in {"emerg", "crit", "err", "warn", "informational"}:
            out.append({"emerg": 0, "crit": 2, "err": 3, "warn": 4, "informational": 6}[p])
        else:
            raise HTTPException(status_code=422, detail=f"unknown severity {part!r}")
    return sorted(set(out)) or None


@router.get("")
async def query_syslog(
    tr: TimeRange = Depends(time_range(default_hours=24)),
    device_id: Optional[int] = None,
    severity: Optional[str] = Query(default=None, description="comma list of 0-7 or names"),
    mnemonic_pattern: Optional[str] = Query(default=None, max_length=256,
                                            description="RE2 regex matched against mnemonic and raw message"),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0, le=1_000_000),
) -> dict[str, Any]:
    where = ["event_time >= toDateTime({f:UInt32})", "event_time < toDateTime({t:UInt32})"]
    params: dict[str, Any] = {"f": tr.start_ts, "t": tr.end_ts, "limit": limit, "offset": offset}
    if device_id is not None:
        # Vector writes device_id=0 until enrichment, so also match on the device's mgmt IP.
        params["device_id"] = device_id
        params["ip"] = await device_ip_or_404(device_id)
        where.append("(device_id = {device_id:UInt32} OR (device_id = 0 AND source_ip = toIPv4({ip:String})))")
    sevs = parse_severities(severity)
    if sevs is not None:
        params["sev"] = sevs
        where.append("severity IN {sev:Array(UInt8)}")
    if mnemonic_pattern:
        params["pat"] = mnemonic_pattern
        where.append("(match(mnemonic, {pat:String}) OR match(raw_message, {pat:String}))")
    cond = " AND ".join(where)

    try:
        rows = await clickhouse.query(
            f"""SELECT toUnixTimestamp(event_time) AS ts, device_id, IPv4NumToString(source_ip) AS source_ip_str,
                       facility, severity, mnemonic, raw_message, parsed_host, parsed_program
                FROM syslog_events WHERE {cond}
                ORDER BY event_time DESC
                LIMIT {{limit:UInt32}} OFFSET {{offset:UInt32}}""",
            params,
        )
        total = (await clickhouse.query(f"SELECT count() AS n FROM syslog_events WHERE {cond}", params))[0]["n"]
    except Exception as exc:  # bad regex etc. surfaces as a ClickHouse error
        msg = str(exc)
        if mnemonic_pattern and ("regexp" in msg.lower() or "re2" in msg.lower() or "CANNOT_COMPILE" in msg):
            raise HTTPException(status_code=400, detail="invalid mnemonic_pattern regular expression") from exc
        raise

    by_id, by_ip = await hostnames_by_id_and_ip()
    items = []
    for r in rows:
        r["source_ip"] = r.pop("source_ip_str")
        unix_ts = r.pop("ts")
        dev_id = r["device_id"]
        hostname = by_id.get(dev_id)
        if not dev_id and r["source_ip"] in by_ip:
            dev_id, hostname = by_ip[r["source_ip"]]
        items.append({
            **r,
            "timestamp": iso(unix_ts),
            "device_id": dev_id or None,
            "hostname": hostname or r["parsed_host"] or r["source_ip"],
            "severity_name": SEVERITY_NAMES[r["severity"]] if r["severity"] < 8 else str(r["severity"]),
        })
    return {"items": items, "total": int(total), "limit": limit, "offset": offset,
            "has_more": offset + len(items) < int(total)}
