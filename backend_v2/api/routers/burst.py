"""Burst (30 s high-frequency) polling sessions. Hard 8 h cap enforced by PostgreSQL."""
from __future__ import annotations

from typing import Any, Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend.api.deps import Caller, require_internal, require_operator
from backend.config import settings
from backend.db import postgres

router = APIRouter(prefix="/api/v2/burst", tags=["burst"])

SESSION_SELECT = """
SELECT b.id, b.device_id, d.hostname, b.interface_id, i.ifindex, i.ifname, b.initiated_by,
       b.started_at, b.expires_at, b.ended_at, b.is_active,
       CASE WHEN b.is_active AND b.expires_at > now()
            THEN EXTRACT(EPOCH FROM b.expires_at - now())::int ELSE 0 END AS remaining_seconds
FROM burst_sessions b
JOIN devices d ON d.id = b.device_id
LEFT JOIN interfaces i ON i.id = b.interface_id
"""


class BurstCreate(BaseModel):
    device_id: int
    interface_id: Optional[int] = None
    initiated_by: Optional[str] = Field(default=None, max_length=128)
    duration_minutes: int = Field(default=480, ge=1, le=480)


@router.post("", status_code=201)
async def create_burst(body: BurstCreate, caller: Caller = Depends(require_internal)) -> dict[str, Any]:
    require_operator(caller)
    # Trusted identity from the proxy wins over the body field.
    initiated_by = caller.username or body.initiated_by or "api"
    minutes = min(body.duration_minutes, settings.burst_max_hours * 60)
    if not await postgres.fetchval("SELECT 1 FROM devices WHERE id = $1", body.device_id):
        raise HTTPException(status_code=404, detail="device not found")
    if body.interface_id is not None and not await postgres.fetchval(
        "SELECT 1 FROM interfaces WHERE id = $1 AND device_id = $2", body.interface_id, body.device_id
    ):
        raise HTTPException(status_code=404, detail="interface not found on this device")
    try:
        new_id = await postgres.fetchval(
            """INSERT INTO burst_sessions (device_id, interface_id, initiated_by, started_at, expires_at)
               VALUES ($1, $2, $3, now(), now() + make_interval(mins => $4)) RETURNING id""",
            body.device_id, body.interface_id, initiated_by, minutes,
        )
    except asyncpg.UniqueViolationError as exc:
        existing = await postgres.fetchrow(
            SESSION_SELECT + " WHERE b.device_id = $1 AND COALESCE(b.interface_id, 0) = COALESCE($2, 0) AND b.is_active",
            body.device_id, body.interface_id,
        )
        raise HTTPException(status_code=409, detail={
            "message": "an active burst session already exists for this target",
            "session": _jsonable(existing),
        }) from exc
    except asyncpg.CheckViolationError as exc:
        raise HTTPException(status_code=400, detail="burst duration exceeds the 8 hour maximum") from exc
    return dict(await postgres.fetchrow(SESSION_SELECT + " WHERE b.id = $1", new_id))


@router.delete("/{session_id}")
async def end_burst(session_id: int, caller: Caller = Depends(require_internal)) -> dict[str, Any]:
    require_operator(caller)
    try:
        updated = await postgres.fetchval(
            "UPDATE burst_sessions SET is_active = false WHERE id = $1 AND is_active RETURNING id", session_id
        )
    except asyncpg.TriggeredDataChangeViolationError:
        # Only possible without migration 002: the expiry trigger ended this overdue session first.
        updated = None
    if updated is None:
        if await postgres.fetchval("SELECT 1 FROM burst_sessions WHERE id = $1", session_id):
            raise HTTPException(status_code=409, detail="burst session already ended")
        raise HTTPException(status_code=404, detail="burst session not found")
    return dict(await postgres.fetchrow(SESSION_SELECT + " WHERE b.id = $1", session_id))


@router.get("/active", dependencies=[Depends(require_internal)])
async def active_bursts(device_id: Optional[int] = None) -> dict[str, Any]:
    rows = await postgres.fetch(
        SESSION_SELECT + " WHERE b.is_active AND b.expires_at > now() AND ($1::int IS NULL OR b.device_id = $1)"
        " ORDER BY b.expires_at",
        device_id,
    )
    items = [dict(r) for r in rows]
    return {"items": items, "total": len(items)}


@router.get("", dependencies=[Depends(require_internal)])
async def list_bursts(device_id: Optional[int] = None, limit: int = Query(default=50, ge=1, le=500)) -> dict[str, Any]:
    rows = await postgres.fetch(
        SESSION_SELECT + " WHERE ($1::int IS NULL OR b.device_id = $1) ORDER BY b.started_at DESC LIMIT $2",
        device_id, limit,
    )
    items = [dict(r) for r in rows]
    return {"items": items, "total": len(items)}


def _jsonable(row: Optional[asyncpg.Record]) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    return {k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in dict(row).items()}
