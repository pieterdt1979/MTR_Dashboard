"""Burst-session driver: every MTR_BURST_INTERVAL (30 s)
  1. auto-expire sessions past expires_at (and log a WARNING per expired session), and
  2. poll the devices/interfaces of every still-active session immediately.

The 8 h cap itself is enforced in PostgreSQL (CHECK chk_burst_max_8h); the schema's
statement trigger may also expire sessions as a side effect of any write to burst_sessions,
so expired sessions are detected by `ended_at = expires_at` and de-duplicated in Redis to
make sure every auto-expiry is logged exactly once, whoever performed it.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from typing import Optional

from backend.config import settings
from backend.db import postgres
from backend.db.redis import get_redis
from backend.poller.snmp_worker import SnmpPoller

log = logging.getLogger(__name__)

EXPIRED_CANDIDATES_SQL = """
SELECT b.id, b.device_id, d.hostname, b.interface_id, b.initiated_by, b.started_at, b.expires_at
FROM burst_sessions b
JOIN devices d ON d.id = b.device_id
WHERE (b.is_active AND b.expires_at < now())
   OR (NOT b.is_active AND b.ended_at = b.expires_at AND b.expires_at > now() - interval '1 hour')
"""
EXPIRE_SQL = "UPDATE burst_sessions SET is_active = false WHERE expires_at < now() AND is_active = true"
ACTIVE_SQL = """
SELECT b.id, b.device_id, b.interface_id, i.ifindex
FROM burst_sessions b
LEFT JOIN interfaces i ON i.id = b.interface_id
WHERE b.is_active = true AND b.expires_at > now()
"""


async def expire_sessions() -> int:
    """Run the expiry UPDATE and log every session that has been auto-expired. Returns count logged."""
    candidates = await postgres.fetch(EXPIRED_CANDIDATES_SQL)
    await postgres.execute(EXPIRE_SQL)
    logged = 0
    r = get_redis()
    for c in candidates:
        if await r.set(f"burst:expired_logged:{c['id']}", "1", nx=True, ex=86400):
            log.warning(
                "Burst session %s auto-expired: device %s (%s)%s, started by %r at %s, expired at %s",
                c["id"], c["device_id"], c["hostname"],
                f" interface_id {c['interface_id']}" if c["interface_id"] else "",
                c["initiated_by"], c["started_at"].isoformat(), c["expires_at"].isoformat(),
            )
            logged += 1
    return logged


async def active_targets() -> dict[int, Optional[set[int]]]:
    """{device_id: None (whole device) | {ifindex,...}} for all active sessions."""
    whole: set[int] = set()
    per_iface: dict[int, set[int]] = defaultdict(set)
    for row in await postgres.fetch(ACTIVE_SQL):
        if row["interface_id"] is None:
            whole.add(row["device_id"])
        elif row["ifindex"] is not None:
            per_iface[row["device_id"]].add(row["ifindex"])
    targets: dict[int, Optional[set[int]]] = {dev: None for dev in whole}
    targets.update({dev: s for dev, s in per_iface.items() if dev not in whole})
    return targets


async def burst_tick(poller: SnmpPoller) -> int:
    await expire_sessions()
    targets = await active_targets()
    if not targets:
        return 0
    only = {dev: s for dev, s in targets.items() if s is not None}
    results = await poller.poll_devices(list(targets), only)
    log.debug("burst tick: %d devices polled", len(results))
    return len(results)


async def run_forever(poller: SnmpPoller, stop: asyncio.Event) -> None:
    interval = max(5, settings.burst_interval)
    log.info("Burst manager started (interval %ss, max %sh)", interval, settings.burst_max_hours)
    while not stop.is_set():
        started = time.monotonic()
        try:
            await burst_tick(poller)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("burst tick failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=max(1.0, interval - (time.monotonic() - started)))
        except asyncio.TimeoutError:
            pass
