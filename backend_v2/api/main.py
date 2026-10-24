"""MTR Phase 2 FastAPI application.

Run:  uvicorn backend.api.main:app --host 0.0.0.0 --port 8000 --workers 4

With several uvicorn workers every process serves the API, but only the worker holding the
Redis leader lock (mtr:poller:leader) runs the SNMP poller and burst manager, so devices are
never polled twice.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.api.routers import burst, devices, flows, incidents, syslog
from backend.config import settings
from backend.db import clickhouse, postgres
from backend.db import redis as redis_db
from backend.poller import burst_manager
from backend.poller.snmp_worker import SnmpPoller

logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)s [%(process)d] %(name)s: %(message)s",
)
log = logging.getLogger("mtr.api")


class BackgroundPollers:
    """Leader-elected supervisor for the SNMP poller + burst manager tasks."""

    def __init__(self) -> None:
        self.lock = redis_db.LeaderLock(ttl=60)
        self.stop = asyncio.Event()
        self.is_leader = False
        self._children: list[asyncio.Task] = []
        self._supervisor: Optional[asyncio.Task] = None

    def start(self) -> None:
        self._supervisor = asyncio.create_task(self._supervise(), name="poller-supervisor")

    async def _start_children(self) -> None:
        poller = SnmpPoller()
        child_stop = asyncio.Event()
        self._child_stop = child_stop
        self._children = [
            asyncio.create_task(poller.run_forever(child_stop), name="snmp-poller"),
            asyncio.create_task(burst_manager.run_forever(poller, child_stop), name="burst-manager"),
        ]

    async def _stop_children(self) -> None:
        if not self._children:
            return
        self._child_stop.set()
        for t in self._children:
            t.cancel()
        await asyncio.gather(*self._children, return_exceptions=True)
        self._children = []

    async def _supervise(self) -> None:
        while not self.stop.is_set():
            try:
                leader = await self.lock.acquire_or_renew()
            except Exception as exc:  # noqa: BLE001 — Redis down: never poll without counter state
                log.warning("leader lock unavailable (%s); pollers paused", exc)
                leader = False
            if leader and not self.is_leader:
                log.info("acquired poller leadership — starting SNMP poller and burst manager")
                await self._start_children()
            elif not leader and self.is_leader:
                log.warning("lost poller leadership — stopping background tasks")
                await self._stop_children()
            self.is_leader = leader
            try:
                await asyncio.wait_for(self.stop.wait(), timeout=20)
            except asyncio.TimeoutError:
                pass

    async def shutdown(self) -> None:
        self.stop.set()
        if self._supervisor:
            self._supervisor.cancel()
            await asyncio.gather(self._supervisor, return_exceptions=True)
        await self._stop_children()
        if self.is_leader:
            await self.lock.release()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    if not settings.api_shared_secret:
        log.warning("MTR_API_SHARED_SECRET is not set: every request is treated as admin (development only)")
    await postgres.init_pool()
    if settings.apply_migrations:
        await postgres.apply_migrations()
    await clickhouse.init_client()
    await redis_db.init_redis()
    pollers: Optional[BackgroundPollers] = None
    if settings.snmp_enabled:
        pollers = BackgroundPollers()
        pollers.start()
    else:
        log.info("SNMP_POLLER_ENABLED=false — API only, no background polling")
    app.state.pollers = pollers
    try:
        yield
    finally:
        if pollers:
            await pollers.shutdown()
        await redis_db.close_redis()
        await clickhouse.close_client()
        await postgres.close_pool()


app = FastAPI(title="MTR Dashboard API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.frontend_origin.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

for r in (devices.router, syslog.router, flows.router, burst.router, incidents.router):
    app.include_router(r)


@app.get("/health", tags=["health"])
async def health() -> JSONResponse:
    pg, ch, rd = await asyncio.gather(postgres.ping(), clickhouse.ping(), redis_db.ping())
    pollers = getattr(app.state, "pollers", None)
    try:  # any worker can report whether *some* worker currently runs the pollers
        poller_running = bool(rd and await redis_db.get_redis().exists("mtr:poller:leader"))
    except Exception:  # noqa: BLE001
        poller_running = False
    body: dict[str, Any] = {
        "status": "ok" if (pg and ch) else "degraded",
        "postgres": pg,
        "clickhouse": ch,
        "redis": rd,
        "poller_running": poller_running,
        "this_worker_is_leader": bool(pollers and pollers.is_leader),
    }
    return JSONResponse(body, status_code=200 if (pg and ch) else 503)
