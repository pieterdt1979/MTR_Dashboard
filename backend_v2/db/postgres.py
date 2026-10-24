"""asyncpg connection pool (POSTGRES_* env vars)."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

import asyncpg

from backend.config import settings

log = logging.getLogger(__name__)
_pool: Optional[asyncpg.Pool] = None


async def init_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        if not settings.pg_password:
            log.warning("POSTGRES_PASSWORD is empty — relying on trust/peer auth")
        _pool = await asyncpg.create_pool(
            host=settings.pg_host,
            port=settings.pg_port,
            database=settings.pg_db,
            user=settings.pg_user,
            password=settings.pg_password or None,
            min_size=settings.pg_pool_min,
            max_size=settings.pg_pool_max,
            command_timeout=30,
            server_settings={"application_name": "mtr-api", "timezone": "UTC"},
        )
        log.info("PostgreSQL pool ready (%s:%s/%s)", settings.pg_host, settings.pg_port, settings.pg_db)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("PostgreSQL pool not initialised; call init_pool() first")
    return _pool


async def execute(sql: str, *args: Any) -> str:
    return await get_pool().execute(sql, *args)


async def fetch(sql: str, *args: Any) -> list[asyncpg.Record]:
    return await get_pool().fetch(sql, *args)


async def fetchrow(sql: str, *args: Any) -> Optional[asyncpg.Record]:
    return await get_pool().fetchrow(sql, *args)


async def fetchval(sql: str, *args: Any) -> Any:
    return await get_pool().fetchval(sql, *args)


MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
_MIGRATION_LOCK_ID = 0x4D5452  # pg_advisory_xact_lock key ("MTR") so parallel workers serialise


async def apply_migrations() -> list[str]:
    """Apply backend/migrations/*.sql (all idempotent) in name order, one transaction each."""
    applied: list[str] = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        async with get_pool().acquire() as conn, conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock($1)", _MIGRATION_LOCK_ID)
            await conn.execute(path.read_text())
        applied.append(path.name)
    if applied:
        log.info("PostgreSQL migrations applied: %s", ", ".join(applied))
    return applied


async def ping() -> bool:
    try:
        return (await fetchval("SELECT 1")) == 1
    except Exception:  # noqa: BLE001 — health probe must never raise
        return False
