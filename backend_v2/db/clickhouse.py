"""clickhouse-connect async HTTP client (CLICKHOUSE_* env vars).

clickhouse-connect talks to the HTTP interface (CLICKHOUSE_HTTP_PORT, default 8123);
CLICKHOUSE_PORT (9000, native protocol) is not used by this client.
Queries use server-side parameter binding: ``{name:Type}`` placeholders + a params dict.
"""
from __future__ import annotations

import logging
from typing import Any, Optional, Sequence

import clickhouse_connect
from clickhouse_connect.driver.asyncclient import AsyncClient

from backend.config import settings

log = logging.getLogger(__name__)
_client: Optional[AsyncClient] = None


async def init_client() -> AsyncClient:
    global _client
    if _client is None:
        _client = await clickhouse_connect.get_async_client(
            host=settings.ch_host,
            port=settings.ch_http_port,
            username=settings.ch_user,
            password=settings.ch_password,
            database=settings.ch_db,
            settings={"max_execution_time": 60},
        )
        log.info("ClickHouse client ready (%s:%s/%s)", settings.ch_host, settings.ch_http_port, settings.ch_db)
    return _client


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.close()
        _client = None


def get_client() -> AsyncClient:
    if _client is None:
        raise RuntimeError("ClickHouse client not initialised; call init_client() first")
    return _client


async def query(sql: str, params: Optional[dict[str, Any]] = None) -> list[dict[str, Any]]:
    result = await get_client().query(sql, parameters=params or {})
    cols = result.column_names
    return [dict(zip(cols, row)) for row in result.result_rows]


async def execute_insert(table: str, rows: Sequence[dict[str, Any]]) -> int:
    """Insert a list of dicts (all with the same keys). Returns rows written."""
    if not rows:
        return 0
    columns = list(rows[0].keys())
    data = [[r[c] for c in columns] for r in rows]
    await get_client().insert(table, data, column_names=columns)
    return len(data)


async def ping() -> bool:
    try:
        return bool(await get_client().ping())
    except Exception:  # noqa: BLE001
        return False
