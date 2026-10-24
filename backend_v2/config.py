"""Environment-driven settings. Nothing secret has a default."""
from __future__ import annotations

import os
from dataclasses import dataclass, field

try:  # optional .env for local development; containers get real env vars
    from dotenv import load_dotenv

    load_dotenv(os.getenv("MTR_ENV_FILE", ".env"), override=False)
except ImportError:  # pragma: no cover
    pass


def _int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw.split()[0])  # tolerate "300   # comment" from .env files
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    # PostgreSQL
    pg_host: str = field(default_factory=lambda: os.getenv("POSTGRES_HOST", "localhost"))
    pg_port: int = field(default_factory=lambda: _int("POSTGRES_PORT", 5432))
    pg_db: str = field(default_factory=lambda: os.getenv("POSTGRES_DB", "mtr_dashboard"))
    pg_user: str = field(default_factory=lambda: os.getenv("POSTGRES_USER", "mtr_app"))
    pg_password: str = field(default_factory=lambda: os.getenv("POSTGRES_PASSWORD", ""))
    pg_pool_min: int = field(default_factory=lambda: _int("POSTGRES_POOL_MIN", 2))
    pg_pool_max: int = field(default_factory=lambda: _int("POSTGRES_POOL_MAX", 10))
    apply_migrations: bool = field(default_factory=lambda: _bool("MTR_APPLY_MIGRATIONS", True))

    # ClickHouse (HTTP interface — clickhouse-connect speaks HTTP, not the native 9000 protocol)
    ch_host: str = field(default_factory=lambda: os.getenv("CLICKHOUSE_HOST", "localhost"))
    ch_http_port: int = field(default_factory=lambda: _int("CLICKHOUSE_HTTP_PORT", 8123))
    ch_db: str = field(default_factory=lambda: os.getenv("CLICKHOUSE_DB", "mtr"))
    ch_user: str = field(default_factory=lambda: os.getenv("CLICKHOUSE_USER", "default"))
    ch_password: str = field(default_factory=lambda: os.getenv("CLICKHOUSE_PASSWORD", ""))

    # Redis
    redis_host: str = field(default_factory=lambda: os.getenv("REDIS_HOST", "localhost"))
    redis_port: int = field(default_factory=lambda: _int("REDIS_PORT", 6379))
    redis_password: str = field(default_factory=lambda: os.getenv("REDIS_PASSWORD", ""))
    redis_db: int = field(default_factory=lambda: _int("REDIS_DB", 0))

    # Poller
    snmp_enabled: bool = field(default_factory=lambda: _bool("SNMP_POLLER_ENABLED", True))
    poll_interval: int = field(default_factory=lambda: _int("MTR_POLL_INTERVAL", 300))
    burst_interval: int = field(default_factory=lambda: _int("MTR_BURST_INTERVAL", 30))
    burst_max_hours: int = field(default_factory=lambda: _int("MTR_BURST_MAX_HOURS", 8))
    snmp_timeout: int = field(default_factory=lambda: _int("SNMP_TIMEOUT", 3))
    snmp_retries: int = field(default_factory=lambda: _int("SNMP_RETRIES", 1))
    snmp_port: int = field(default_factory=lambda: _int("SNMP_PORT", 161))
    snmp_concurrency: int = field(default_factory=lambda: _int("SNMP_CONCURRENCY", 50))
    credential_key: str = field(default_factory=lambda: os.getenv("MTR_CREDENTIAL_KEY", ""))

    # API
    frontend_origin: str = field(default_factory=lambda: os.getenv("FRONTEND_ORIGIN", "http://localhost:3000"))
    api_shared_secret: str = field(default_factory=lambda: os.getenv("MTR_API_SHARED_SECRET", ""))
    log_level: str = field(default_factory=lambda: os.getenv("LOG_LEVEL", "INFO").split()[0].upper())


settings = Settings()
