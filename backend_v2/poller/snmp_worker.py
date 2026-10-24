"""Async SNMPv2c/v3 IF-MIB poller.

Per poll of a device:
  1. GET sysUpTime (reachability + reboot detection).
  2. Bulk-walk the IF-MIB / IF-MIB::ifXTable columns (64-bit HC octet counters; 32-bit fallback).
  3. Upsert `interfaces` rows in PostgreSQL (ON CONFLICT (device_id, ifindex)).
  4. Compute per-interface deltas against the previous counters kept in Redis
     (HSET device:{id}:counters ifindex:{n}:in <value> ...) and insert them into
     ClickHouse `interface_metrics` as octets-per-interval (never raw counters).
  5. Update devices.status / devices.last_polled_at.

Normal cycles (MTR_POLL_INTERVAL, default 300 s) and burst polls (30 s, see burst_manager)
share the same Redis baseline, so deltas are always relative to the last sample actually
taken and `poll_interval_sec` is the measured elapsed time — nothing is double counted.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from pysnmp.hlapi.v3arch.asyncio import (
    CommunityData,
    ContextData,
    ObjectIdentity,
    ObjectType,
    SnmpEngine,
    UdpTransportTarget,
    UsmUserData,
    bulk_walk_cmd,
    get_cmd,
    usm3DESEDEPrivProtocol,
    usmAesCfb128Protocol,
    usmAesCfb192Protocol,
    usmAesCfb256Protocol,
    usmDESPrivProtocol,
    usmHMAC128SHA224AuthProtocol,
    usmHMAC192SHA256AuthProtocol,
    usmHMAC256SHA384AuthProtocol,
    usmHMAC384SHA512AuthProtocol,
    usmHMACMD5AuthProtocol,
    usmHMACSHAAuthProtocol,
    usmNoAuthProtocol,
    usmNoPrivProtocol,
)
from pyasn1.type.univ import OctetString

from backend.config import settings
from backend.db import clickhouse, postgres
from backend.db.redis import get_redis

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------- OIDs
SYS_UPTIME = "1.3.6.1.2.1.1.3.0"
IF_COLUMNS: dict[str, str] = {
    "ifIndex": "1.3.6.1.2.1.2.2.1.1",
    "ifDescr": "1.3.6.1.2.1.2.2.1.2",
    "ifSpeed": "1.3.6.1.2.1.2.2.1.5",
    "ifAdminStatus": "1.3.6.1.2.1.2.2.1.7",
    "ifOperStatus": "1.3.6.1.2.1.2.2.1.8",
    "ifInDiscards": "1.3.6.1.2.1.2.2.1.13",
    "ifInErrors": "1.3.6.1.2.1.2.2.1.14",
    "ifOutDiscards": "1.3.6.1.2.1.2.2.1.19",
    "ifOutErrors": "1.3.6.1.2.1.2.2.1.20",
    "ifName": "1.3.6.1.2.1.31.1.1.1.1",
    "ifHCInOctets": "1.3.6.1.2.1.31.1.1.1.6",
    "ifHCOutOctets": "1.3.6.1.2.1.31.1.1.1.10",
    "ifHighSpeed": "1.3.6.1.2.1.31.1.1.1.15",
    "ifAlias": "1.3.6.1.2.1.31.1.1.1.18",
}
FALLBACK_32 = {"ifInOctets": "1.3.6.1.2.1.2.2.1.10", "ifOutOctets": "1.3.6.1.2.1.2.2.1.16"}
STRING_COLUMNS = {"ifDescr", "ifName", "ifAlias"}

AUTH_PROTOCOLS = {
    None: usmNoAuthProtocol,
    "MD5": usmHMACMD5AuthProtocol,
    "SHA": usmHMACSHAAuthProtocol,
    "SHA224": usmHMAC128SHA224AuthProtocol,
    "SHA256": usmHMAC192SHA256AuthProtocol,
    "SHA384": usmHMAC256SHA384AuthProtocol,
    "SHA512": usmHMAC384SHA512AuthProtocol,
}
PRIV_PROTOCOLS = {
    None: usmNoPrivProtocol,
    "DES": usmDESPrivProtocol,
    "3DES": usm3DESEDEPrivProtocol,
    "AES": usmAesCfb128Protocol,
    "AES192": usmAesCfb192Protocol,
    "AES256": usmAesCfb256Protocol,
}

C32 = 2**32
C64 = 2**64
UINT32_MAX = C32 - 1
UINT16_MAX = 2**16 - 1


# --------------------------------------------------------------------------- credentials
class CredentialError(RuntimeError):
    pass


def decrypt_secret(ciphertext_b64: Optional[str], key_b64: str) -> Optional[str]:
    """Inverse of mock_generator.encrypt_secret: base64(nonce12 || ct || tag16), AAD b"snmp"."""
    if not ciphertext_b64:
        return None
    if not key_b64:
        raise CredentialError("MTR_CREDENTIAL_KEY is not set; cannot decrypt SNMP credentials")
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = base64.b64decode(key_b64)
    if len(key) != 32:
        raise CredentialError("MTR_CREDENTIAL_KEY must be base64 of exactly 32 bytes")
    blob = base64.b64decode(ciphertext_b64)
    try:
        return AESGCM(key).decrypt(blob[:12], blob[12:], b"snmp").decode()
    except Exception as exc:  # InvalidTag etc.
        raise CredentialError("credential decryption failed (wrong MTR_CREDENTIAL_KEY?)") from exc


@dataclass
class DeviceTarget:
    device_id: int
    hostname: str
    ip: str
    version: str
    community: Optional[str] = None
    v3_username: Optional[str] = None
    v3_auth_proto: Optional[str] = None
    v3_auth_key: Optional[str] = None
    v3_priv_proto: Optional[str] = None
    v3_priv_key: Optional[str] = None

    def auth_data(self) -> CommunityData | UsmUserData:
        if self.version == "v2c":
            return CommunityData(self.community or "", mpModel=1)
        auth_proto = self.v3_auth_proto if self.v3_auth_key else None
        priv_proto = self.v3_priv_proto if (self.v3_priv_key and auth_proto) else None
        return UsmUserData(
            self.v3_username,
            authKey=self.v3_auth_key if auth_proto else None,
            privKey=self.v3_priv_key if priv_proto else None,
            authProtocol=AUTH_PROTOCOLS[auth_proto],
            privProtocol=PRIV_PROTOCOLS[priv_proto],
        )


@dataclass
class PollResult:
    device_id: int
    reachable: bool
    interfaces: int = 0
    metrics_written: int = 0
    error: Optional[str] = None
    status: str = "unknown"


@dataclass
class IfRow:
    ifindex: int
    values: dict[str, Any] = field(default_factory=dict)


TARGETS_SQL = """
SELECT d.id, d.hostname, host(d.mgmt_ip) AS ip,
       c.version::text AS version, c.community_string_enc, c.v3_username,
       c.v3_auth_proto, c.v3_auth_key_enc, c.v3_priv_proto, c.v3_priv_key_enc
FROM devices d
JOIN LATERAL (
    SELECT sc.*
    FROM device_credentials dc
    JOIN snmp_credentials sc ON sc.id = dc.credential_id
    WHERE dc.device_id = d.id
    ORDER BY (sc.version = d.snmp_version) DESC, sc.id
    LIMIT 1
) c ON true
WHERE ($1::int[] IS NULL OR d.id = ANY($1::int[]))
ORDER BY d.id
"""

UPSERT_IFACES_SQL = """
INSERT INTO interfaces (device_id, ifindex, ifname, ifalias, ifdescr, ifspeed_bps,
                        ifadmin_status, ifoper_status, last_metric_at)
SELECT $1, u.ifindex, u.ifname, u.ifalias, u.ifdescr, u.speed, u.admin, u.oper,
       CASE WHEN u.has_metric THEN now() END
FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::smallint[],
            $8::smallint[], $9::bool[])
     AS u(ifindex, ifname, ifalias, ifdescr, speed, admin, oper, has_metric)
ON CONFLICT (device_id, ifindex) DO UPDATE SET
    ifname         = EXCLUDED.ifname,
    ifalias        = EXCLUDED.ifalias,
    ifdescr        = EXCLUDED.ifdescr,
    ifspeed_bps    = EXCLUDED.ifspeed_bps,
    ifadmin_status = EXCLUDED.ifadmin_status,
    ifoper_status  = EXCLUDED.ifoper_status,
    last_metric_at = COALESCE(EXCLUDED.last_metric_at, interfaces.last_metric_at)
RETURNING id, ifindex
"""


# --------------------------------------------------------------------------- helpers
def _to_python(value: Any, as_string: bool) -> Any:
    if as_string or isinstance(value, OctetString):
        try:
            return bytes(value).decode("utf-8", "replace").strip("\x00").strip()
        except Exception:  # noqa: BLE001
            return value.prettyPrint()
    try:
        return int(value)
    except (TypeError, ValueError):
        return None  # noSuchObject / noSuchInstance / endOfMibView


def counter_delta(new: Optional[int], old: Optional[int], wrap: int) -> Optional[int]:
    """Delta between two counter readings. None = no baseline or counter reset (discard)."""
    if new is None or old is None:
        return None
    if new >= old:
        return new - old
    if wrap == C32 and old - new > C32 // 2:  # genuine 32-bit wrap
        return new + C32 - old
    return None  # 64-bit counters never wrap in practice -> treat as discontinuity


def _clamp(v: Optional[int], lo: int, hi: int, default: int) -> int:
    return v if v is not None and lo <= v <= hi else default


def derive_device_status(rows: Iterable[IfRow]) -> str:
    """up, or degraded if any *in-use* interface (admin up + has ifAlias) is operationally down."""
    for r in rows:
        v = r.values
        if v.get("ifAdminStatus") == 1 and v.get("ifAlias") and v.get("ifOperStatus") in (2, 7):
            return "degraded"
    return "up"


# --------------------------------------------------------------------------- poller
class SnmpPoller:
    def __init__(self) -> None:
        self.engine = SnmpEngine()
        self.sem = asyncio.Semaphore(max(1, settings.snmp_concurrency))
        self._locks: dict[int, asyncio.Lock] = {}
        self._cred_errors_logged: set[int] = set()

    def device_lock(self, device_id: int) -> asyncio.Lock:
        return self._locks.setdefault(device_id, asyncio.Lock())

    # ---------------------------------------------------------------- targets
    async def load_targets(self, device_ids: Optional[list[int]] = None) -> list[DeviceTarget]:
        rows = await postgres.fetch(TARGETS_SQL, device_ids)
        targets: list[DeviceTarget] = []
        for r in rows:
            try:
                key = settings.credential_key
                targets.append(DeviceTarget(
                    device_id=r["id"], hostname=r["hostname"], ip=r["ip"], version=r["version"],
                    community=decrypt_secret(r["community_string_enc"], key),
                    v3_username=r["v3_username"],
                    v3_auth_proto=r["v3_auth_proto"],
                    v3_auth_key=decrypt_secret(r["v3_auth_key_enc"], key),
                    v3_priv_proto=r["v3_priv_proto"],
                    v3_priv_key=decrypt_secret(r["v3_priv_key_enc"], key),
                ))
            except CredentialError as exc:
                if r["id"] not in self._cred_errors_logged:
                    log.error("device %s (%s): %s — skipping", r["id"], r["hostname"], exc)
                    self._cred_errors_logged.add(r["id"])
        return targets

    # ---------------------------------------------------------------- SNMP I/O
    async def _transport(self, t: DeviceTarget) -> UdpTransportTarget:
        return await UdpTransportTarget.create(
            (t.ip, settings.snmp_port), timeout=settings.snmp_timeout, retries=settings.snmp_retries
        )

    async def _get_uptime(self, t: DeviceTarget, transport) -> int:
        err_ind, err_stat, _idx, var_binds = await get_cmd(
            self.engine, t.auth_data(), transport, ContextData(), ObjectType(ObjectIdentity(SYS_UPTIME))
        )
        if err_ind:
            raise ConnectionError(str(err_ind))
        if err_stat:
            raise ConnectionError(err_stat.prettyPrint())
        return int(var_binds[0][1])

    async def _walk(self, t: DeviceTarget, transport, oid: str, as_string: bool) -> dict[int, Any]:
        out: dict[int, Any] = {}
        async for err_ind, err_stat, _idx, var_binds in bulk_walk_cmd(
            self.engine, t.auth_data(), transport, ContextData(), 0, 25,
            ObjectType(ObjectIdentity(oid)), lexicographicMode=False,
        ):
            if err_ind:
                raise ConnectionError(str(err_ind))
            if err_stat:
                break  # e.g. column not supported on this agent
            for name, value in var_binds:
                v = _to_python(value, as_string)
                if v is not None:
                    out[int(tuple(name)[-1])] = v
        return out

    async def walk_interfaces(self, t: DeviceTarget) -> tuple[int, dict[int, IfRow], bool]:
        """Returns (sysUpTime ticks, {ifindex: IfRow}, uses_hc_counters)."""
        transport = await self._transport(t)
        uptime = await self._get_uptime(t, transport)
        names = list(IF_COLUMNS)
        results = await asyncio.gather(
            *(self._walk(t, transport, IF_COLUMNS[n], n in STRING_COLUMNS) for n in names)
        )
        columns = dict(zip(names, results))
        hc = bool(columns["ifHCInOctets"])
        if not hc:
            fb = await asyncio.gather(*(self._walk(t, transport, o, False) for o in FALLBACK_32.values()))
            columns["ifHCInOctets"], columns["ifHCOutOctets"] = fb
        indexes = set(columns["ifIndex"]) or set(columns["ifDescr"])
        rows = {i: IfRow(i, {n: columns[n].get(i) for n in names}) for i in sorted(indexes)}
        return uptime, rows, hc

    # ---------------------------------------------------------------- one device
    async def poll_device(self, t: DeviceTarget, only_ifindexes: Optional[set[int]] = None) -> PollResult:
        """Poll one device. `only_ifindexes` limits metric rows (burst on a single interface)."""
        lock = self.device_lock(t.device_id)
        if lock.locked():
            return PollResult(t.device_id, reachable=True, error="poll already in progress")
        async with lock, self.sem:
            try:
                uptime, rows, hc = await self.walk_interfaces(t)
            except Exception as exc:  # noqa: BLE001 — any SNMP failure = unreachable
                await postgres.execute(
                    "UPDATE devices SET status = 'down', last_polled_at = now() WHERE id = $1", t.device_id
                )
                log.info("device %s (%s %s) unreachable: %s", t.device_id, t.hostname, t.ip, exc)
                return PollResult(t.device_id, reachable=False, error=str(exc), status="down")

            now = time.time()
            metric_rows = await self._compute_deltas(t.device_id, uptime, rows, hc, now, only_ifindexes)
            iface_ids = await self._upsert_interfaces(t.device_id, rows, {m["_ifindex"] for m in metric_rows})
            ch_rows = []
            for m in metric_rows:
                iid = iface_ids.get(m.pop("_ifindex"))
                if iid is not None:
                    m["interface_id"] = iid
                    ch_rows.append(m)
            if ch_rows:
                await clickhouse.execute_insert("interface_metrics", ch_rows)

            status = derive_device_status(rows.values())
            await postgres.execute(
                "UPDATE devices SET status = $2::device_status_t, last_polled_at = now() WHERE id = $1",
                t.device_id, status,
            )
            return PollResult(t.device_id, True, len(rows), len(ch_rows), status=status)

    async def _upsert_interfaces(self, device_id: int, rows: dict[int, IfRow], with_metric: set[int]) -> dict[int, int]:
        if not rows:
            return {}
        idx, names, aliases, descrs, speeds, admins, opers, has_m = ([] for _ in range(8))
        for i, r in rows.items():
            v = r.values
            descr = v.get("ifDescr") or ""
            high = v.get("ifHighSpeed") or 0
            speed = high * 1_000_000 if high else v.get("ifSpeed")
            idx.append(i)
            names.append((v.get("ifName") or descr or f"if{i}")[:128])
            aliases.append((v.get("ifAlias") or None) and v["ifAlias"][:255])
            descrs.append(descr[:255] or None)
            speeds.append(speed)
            admins.append(_clamp(v.get("ifAdminStatus"), 1, 3, 1))
            opers.append(_clamp(v.get("ifOperStatus"), 1, 7, 4))
            has_m.append(i in with_metric)
        recs = await postgres.fetch(UPSERT_IFACES_SQL, device_id, idx, names, aliases, descrs,
                                    speeds, admins, opers, has_m)
        return {r["ifindex"]: r["id"] for r in recs}

    async def _compute_deltas(self, device_id: int, uptime: int, rows: dict[int, IfRow], hc: bool,
                              now: float, only: Optional[set[int]]) -> list[dict[str, Any]]:
        """Read previous counters from Redis, compute deltas, store the new baseline."""
        r = get_redis()
        key = f"device:{device_id}:counters"
        prev = await r.hgetall(key)
        rebooted = "sysuptime" in prev and uptime < int(prev["sysuptime"])
        if rebooted:
            log.warning("device %s: sysUpTime went backwards — counters reset, re-baselining", device_id)
        octet_wrap = C64 if hc else C32
        new: dict[str, Any] = {"sysuptime": uptime, "hc": int(hc)}
        out: list[dict[str, Any]] = []
        ts = datetime.fromtimestamp(int(now), tz=timezone.utc)

        fields = (("in", "ifHCInOctets", octet_wrap), ("out", "ifHCOutOctets", octet_wrap),
                  ("in_err", "ifInErrors", C32), ("out_err", "ifOutErrors", C32),
                  ("in_disc", "ifInDiscards", C32), ("out_disc", "ifOutDiscards", C32))
        for i, row in rows.items():
            v = row.values
            pfx = f"ifindex:{i}:"
            # Burst on a single interface: leave other interfaces' baselines untouched so the
            # next normal cycle computes a correct (longer) delta for them.
            if only is not None and i not in only:
                continue
            for short, col, _w in fields:
                if v.get(col) is not None:
                    new[pfx + short] = v[col]
            new[pfx + "ts"] = now
            if rebooted or (pfx + "ts") not in prev:
                continue
            elapsed = now - float(prev[pfx + "ts"])
            if elapsed < 1 or elapsed > UINT16_MAX:
                continue
            deltas: dict[str, Optional[int]] = {}
            for short, col, wrap in fields:
                old = prev.get(pfx + short)
                deltas[short] = counter_delta(v.get(col), int(old) if old is not None else None, wrap)
            if deltas["in"] is None or deltas["out"] is None:
                continue
            high = v.get("ifHighSpeed") or 0
            speed = high * 1_000_000 if high else (v.get("ifSpeed") or 0)
            if speed and max(deltas["in"], deltas["out"]) * 8 / elapsed > speed * 1.5:
                log.debug("device %s ifindex %s: implausible rate, sample discarded", device_id, i)
                continue
            out.append({
                "_ifindex": i,
                "ts": ts,
                "device_id": device_id,
                "poll_interval_sec": int(round(elapsed)),
                "in_octets": deltas["in"],
                "out_octets": deltas["out"],
                "in_errors": min(deltas["in_err"] or 0, UINT32_MAX),
                "out_errors": min(deltas["out_err"] or 0, UINT32_MAX),
                "in_discards": min(deltas["in_disc"] or 0, UINT32_MAX),
                "out_discards": min(deltas["out_disc"] or 0, UINT32_MAX),
                "ifoper_status": _clamp(v.get("ifOperStatus"), 1, 7, 4),
            })
        pipe = r.pipeline()
        pipe.hset(key, mapping=new)
        pipe.expire(key, max(settings.poll_interval * 4, 3600))
        await pipe.execute()
        return out

    # ---------------------------------------------------------------- many devices
    async def poll_devices(self, device_ids: Optional[list[int]] = None,
                           only_ifindexes: Optional[dict[int, set[int]]] = None) -> list[PollResult]:
        targets = await self.load_targets(device_ids)
        only_ifindexes = only_ifindexes or {}
        results = await asyncio.gather(
            *(self.poll_device(t, only_ifindexes.get(t.device_id)) for t in targets), return_exceptions=True
        )
        out: list[PollResult] = []
        for t, res in zip(targets, results):
            if isinstance(res, BaseException):
                log.exception("device %s poll crashed", t.device_id, exc_info=res)
                out.append(PollResult(t.device_id, False, error=repr(res)))
            else:
                out.append(res)
        return out

    async def poll_cycle(self) -> list[PollResult]:
        started = time.monotonic()
        results = await self.poll_devices()
        up = sum(r.reachable for r in results)
        metrics = sum(r.metrics_written for r in results)
        log.info("SNMP cycle: %d devices (%d reachable), %d metric rows, %.1fs",
                 len(results), up, metrics, time.monotonic() - started)
        return results

    async def run_forever(self, stop: asyncio.Event) -> None:
        interval = max(10, settings.poll_interval)
        log.info("SNMP poller started (interval %ss)", interval)
        while not stop.is_set():
            started = time.monotonic()
            try:
                await self.poll_cycle()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — keep the loop alive
                log.exception("SNMP poll cycle failed")
            remaining = interval - (time.monotonic() - started)
            try:
                await asyncio.wait_for(stop.wait(), timeout=max(1.0, remaining))
            except asyncio.TimeoutError:
                pass
