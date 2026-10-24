"""Incidents (PostgreSQL)."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.api.deps import require_internal
from backend.db import postgres

router = APIRouter(prefix="/api/v2/incidents", tags=["incidents"], dependencies=[Depends(require_internal)])

STATES = {"open", "acknowledged", "suppressed", "resolved"}


@router.get("")
async def list_incidents(
    state: Optional[str] = Query(default=None, description="comma list: open,acknowledged,suppressed,resolved"),
    device_id: Optional[int] = None,
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    states = None
    if state:
        states = [s.strip().lower() for s in state.split(",") if s.strip()]
        bad = [s for s in states if s not in STATES]
        if bad:
            raise HTTPException(status_code=422, detail=f"unknown state(s): {', '.join(bad)}")
    where = "($1::text[] IS NULL OR x.state::text = ANY($1::text[])) AND ($2::int IS NULL OR x.device_id = $2)"
    rows = await postgres.fetch(
        f"""SELECT x.id, x.device_id, d.hostname, host(d.mgmt_ip) AS mgmt_ip, x.interface_id, i.ifname,
                   x.severity::text AS severity, x.title, x.description, x.state::text AS state,
                   x.suppressed_by_incident_id, x.opened_at, x.acknowledged_at, x.resolved_at,
                   EXTRACT(EPOCH FROM COALESCE(x.resolved_at, now()) - x.opened_at)::bigint AS duration_seconds
            FROM incidents x
            JOIN devices d ON d.id = x.device_id
            LEFT JOIN interfaces i ON i.id = x.interface_id
            WHERE {where}
            ORDER BY (x.state IN ('open','acknowledged')) DESC,
                     array_position(ARRAY['critical','major','minor','warning','info'], x.severity::text),
                     x.opened_at DESC
            LIMIT $3 OFFSET $4""",
        states, device_id, limit, offset,
    )
    total = await postgres.fetchval(f"SELECT count(*) FROM incidents x WHERE {where}", states, device_id)
    return {"items": [dict(r) for r in rows], "total": int(total), "limit": limit, "offset": offset}
