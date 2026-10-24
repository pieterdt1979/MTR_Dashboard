"""Shared redis.asyncio client (REDIS_* env vars) + single-leader lock for background tasks."""
from __future__ import annotations

import logging
import uuid
from typing import Optional

import redis.asyncio as aioredis

from backend.config import settings

log = logging.getLogger(__name__)
_client: Optional[aioredis.Redis] = None

# Renew only if we still own the lock (atomic compare-and-expire).
_RENEW_LUA = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('expire', KEYS[1], ARGV[2])
end
return 0
"""
_RELEASE_LUA = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""


async def init_redis() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = aioredis.Redis(
            host=settings.redis_host,
            port=settings.redis_port,
            password=settings.redis_password or None,
            db=settings.redis_db,
            decode_responses=True,
            socket_timeout=5,
            socket_connect_timeout=5,
            health_check_interval=30,
        )
    return _client


def get_redis() -> aioredis.Redis:
    if _client is None:
        raise RuntimeError("Redis client not initialised; call init_redis() first")
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def ping() -> bool:
    try:
        return bool(await get_redis().ping())
    except Exception:  # noqa: BLE001
        return False


class LeaderLock:
    """Ensures only one uvicorn worker / replica runs the pollers."""

    def __init__(self, key: str = "mtr:poller:leader", ttl: int = 60) -> None:
        self.key = key
        self.ttl = ttl
        self.token = uuid.uuid4().hex

    async def acquire_or_renew(self) -> bool:
        r = get_redis()
        if await r.set(self.key, self.token, nx=True, ex=self.ttl):
            return True
        return bool(await r.eval(_RENEW_LUA, 1, self.key, self.token, self.ttl))

    async def release(self) -> None:
        try:
            await get_redis().eval(_RELEASE_LUA, 1, self.key, self.token)
        except Exception:  # noqa: BLE001
            pass
