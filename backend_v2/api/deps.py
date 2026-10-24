"""Shared API dependencies: internal-auth check, caller identity, time-range parsing."""
from __future__ import annotations

import hmac
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Header, HTTPException, Query

from backend.config import settings
from backend.db import postgres

SEVERITY_NAMES = ["emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"]


@dataclass
class Caller:
    username: Optional[str]
    role: str


async def require_internal(
    x_mtr_internal_token: Optional[str] = Header(default=None),
    x_mtr_user: Optional[str] = Header(default=None),
    x_mtr_role: Optional[str] = Header(default=None),
) -> Caller:
    """The Next.js proxy authenticates users (session cookie / API token via lib/security.ts) and
    calls this API with the shared secret MTR_API_SHARED_SECRET plus the caller identity.
    If the secret is unset (local development) every request is accepted as admin."""
    secret = settings.api_shared_secret
    if not secret:
        return Caller(x_mtr_user, (x_mtr_role or "admin").lower())
    if not x_mtr_internal_token or not hmac.compare_digest(x_mtr_internal_token, secret):
        raise HTTPException(status_code=401, detail="Missing or invalid internal API token")
    role = (x_mtr_role or "viewer").lower()
    if role not in {"viewer", "operator", "admin"}:
        role = "viewer"
    return Caller(x_mtr_user, role)


def require_operator(caller: Caller) -> None:
    if caller.role not in {"operator", "admin"}:
        raise HTTPException(status_code=403, detail="operator role required")


def parse_time(value: Optional[str], default: datetime) -> datetime:
    """ISO-8601 ('2026-10-24T08:00:00Z') or unix epoch seconds."""
    if value is None or value == "":
        return default
    try:
        if value.replace(".", "", 1).isdigit():
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"invalid timestamp {value!r}") from exc


@dataclass
class TimeRange:
    start: datetime
    end: datetime

    @property
    def start_ts(self) -> int:
        return int(self.start.timestamp())

    @property
    def end_ts(self) -> int:
        return int(self.end.timestamp())

    @property
    def seconds(self) -> int:
        return max(1, self.end_ts - self.start_ts)


def time_range(default_hours: float):
    def _dep(
        from_: Optional[str] = Query(default=None, alias="from", description="ISO-8601 or epoch seconds"),
        to: Optional[str] = Query(default=None, description="ISO-8601 or epoch seconds"),
    ) -> TimeRange:
        now = datetime.now(timezone.utc)
        end = parse_time(to, now)
        start = parse_time(from_, end - timedelta(hours=default_hours))
        if start >= end:
            raise HTTPException(status_code=422, detail="'from' must be before 'to'")
        return TimeRange(start, end)

    return _dep


def iso(ts: Optional[int | float]) -> Optional[str]:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


async def device_ip_or_404(device_id: int) -> str:
    ip = await postgres.fetchval("SELECT host(mgmt_ip) FROM devices WHERE id = $1", device_id)
    if ip is None:
        raise HTTPException(status_code=404, detail="device not found")
    return ip


async def hostnames_by_id_and_ip() -> tuple[dict[int, str], dict[str, tuple[int, str]]]:
    rows = await postgres.fetch("SELECT id, hostname, host(mgmt_ip) AS ip FROM devices")
    return {r["id"]: r["hostname"] for r in rows}, {r["ip"]: (r["id"], r["hostname"]) for r in rows}
