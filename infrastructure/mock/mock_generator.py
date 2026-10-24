#!/usr/bin/env python3
"""
MTR Dashboard Phase 1 — mock data seeder.

Populates PostgreSQL (inventory) and ClickHouse (telemetry) with a realistic multi-vendor
estate so dashboards can be built before real devices are onboarded:

  PostgreSQL : 10 sites, 100 devices (Cisco ISR4451/ASR9001, Huawei NE40E-X3/AR6140,
               Adva FSP3000, Radware DefensePro 1006), 4-8 interfaces each, a handful of
               incidents (incl. a parent/child suppression), and — only if MTR_CREDENTIAL_KEY
               is set — AES-256-GCM encrypted demo SNMP credentials.
  ClickHouse : 500 syslog_events / device, 24 h of interface_metrics @ 5 min,
               1000 netflow_records / device.

All connection details come from environment variables (see .env.example). Nothing secret
is hard-coded. Re-runnable: inventory is upserted; use --reset to wipe mock data first.

Usage:
  pip install -r infrastructure/mock/requirements.txt
  set -a; . ./.env; set +a
  python infrastructure/mock/mock_generator.py [--reset] [--seed 42]
"""

from __future__ import annotations

import argparse
import base64
import ipaddress
import logging
import math
import os
import random
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, List, Sequence, Tuple

import psycopg2
import psycopg2.extras
from clickhouse_driver import Client as ClickHouseClient

log = logging.getLogger("mock_generator")

# ---------------------------------------------------------------------------
# Static reference data
# ---------------------------------------------------------------------------
SITES = [
    ("JNB-DC1", "Johannesburg", "ZA", "Africa/Johannesburg"),
    ("CPT-DC1", "Cape Town", "ZA", "Africa/Johannesburg"),
    ("DUR-POP", "Durban", "ZA", "Africa/Johannesburg"),
    ("PTA-POP", "Pretoria", "ZA", "Africa/Johannesburg"),
    ("LOS-POP", "Lagos", "NG", "Africa/Lagos"),
    ("NBO-POP", "Nairobi", "KE", "Africa/Nairobi"),
    ("LHR-POP", "London", "GB", "Europe/London"),
    ("FRA-POP", "Frankfurt", "DE", "Europe/Berlin"),
    ("AMS-IX", "Amsterdam", "NL", "Europe/Amsterdam"),
    ("DXB-POP", "Dubai", "AE", "Asia/Dubai"),
]


@dataclass(frozen=True)
class Model:
    vendor: str
    model: str
    role: str
    sys_oid: str           # representative enterprise OIDs (mock values)
    weight: int
    ifaces: Tuple[str, ...]
    speed_bps: Tuple[int, ...]


MODELS: Tuple[Model, ...] = (
    Model("cisco", "ISR4451", "ce", "1.3.6.1.4.1.9.1.1707", 22,
          tuple(f"GigabitEthernet0/0/{i}" for i in range(4)) + tuple(f"GigabitEthernet0/1/{i}" for i in range(4)),
          (1_000_000_000,)),
    Model("cisco", "ASR9001", "pe", "1.3.6.1.4.1.9.1.1639", 18,
          tuple(f"TenGigE0/0/2/{i}" for i in range(4)) + tuple(f"GigabitEthernet0/0/0/{i}" for i in range(4)),
          (10_000_000_000, 10_000_000_000, 10_000_000_000, 10_000_000_000) + (1_000_000_000,) * 4),
    Model("huawei", "NE40E-X3", "pe", "1.3.6.1.4.1.2011.2.62.2.9", 18,
          tuple(f"GigabitEthernet1/0/{i}" for i in range(4)) + tuple(f"10GE2/0/{i}" for i in range(4)),
          (1_000_000_000,) * 4 + (10_000_000_000,) * 4),
    Model("huawei", "AR6140", "ce", "1.3.6.1.4.1.2011.2.224.302", 22,
          tuple(f"GE0/0/{i}" for i in range(8)), (1_000_000_000,)),
    Model("adva", "FSP3000", "optical", "1.3.6.1.4.1.2544.1.11.1.1", 10,
          ("1-1-N1", "1-1-N2", "1-2-C1", "1-2-C2", "1-2-C3", "1-2-C4", "1-3-C1", "1-3-C2"),
          (100_000_000_000, 100_000_000_000) + (10_000_000_000,) * 6),
    Model("radware", "DefensePro 1006", "security", "1.3.6.1.4.1.89.1.1.62.47", 10,
          ("G-1", "G-2", "G-3", "G-4", "T-1", "T-2", "MNG-1", "MNG-2"),
          (1_000_000_000,) * 4 + (10_000_000_000,) * 2 + (1_000_000_000,) * 2),
)

SYS_DESCR = {
    "ISR4451": "Cisco IOS XE Software, Version 17.09.04a, ISR4451-X/K9",
    "ASR9001": "Cisco IOS XR Software, Version 7.9.2, ASR-9001",
    "NE40E-X3": "Huawei Versatile Routing Platform Software VRP (R) software, Version 8.210 (NE40E V800R021C10SPC600)",
    "AR6140": "Huawei Versatile Routing Platform Software VRP (R) software, Version 5.170 (AR6140 V300R021C10SPC100)",
    "FSP3000": "ADVA Optical Networking FSP 3000 R7 Rel. 19.2.1",
    "DefensePro 1006": "Radware DefensePro 1006, Software Version 8.32.0.0",
}

WELL_KNOWN_PORTS = [(443, 6, 40), (80, 6, 10), (53, 17, 10), (22, 6, 3), (179, 6, 2), (123, 17, 3),
                    (161, 17, 3), (514, 17, 2), (3389, 6, 2), (8443, 6, 5), (4500, 17, 5), (5060, 17, 3),
                    (0, 1, 4), (1194, 17, 3), (25, 6, 2), (3306, 6, 1), (5432, 6, 1), (2055, 17, 1)]


@dataclass
class Device:
    id: int
    hostname: str
    mgmt_ip: str
    model: Model
    interfaces: List[Tuple[int, int, str, int]] = field(default_factory=list)  # (iface_id, ifindex, name, speed)


# ---------------------------------------------------------------------------
# Connections
# ---------------------------------------------------------------------------
def env(name: str, default: str | None = None, required: bool = False) -> str:
    val = os.getenv(name, default)
    if required and not val:
        log.error("Environment variable %s is required (see .env.example)", name)
        sys.exit(2)
    return val or ""


def pg_connect():
    conn = psycopg2.connect(
        host=env("POSTGRES_HOST", "localhost"),
        port=int(env("POSTGRES_PORT", "5432")),
        dbname=env("POSTGRES_DB", "mtr_dashboard"),
        user=env("POSTGRES_USER", required=True),
        password=env("POSTGRES_PASSWORD", required=True),
        connect_timeout=10,
    )
    conn.autocommit = False
    return conn


def ch_connect() -> ClickHouseClient:
    return ClickHouseClient(
        host=env("CLICKHOUSE_HOST", "localhost"),
        port=int(env("CLICKHOUSE_PORT", "9000")),
        database=env("CLICKHOUSE_DB", "mtr"),
        user=env("CLICKHOUSE_USER", "default"),
        password=env("CLICKHOUSE_PASSWORD", required=True),
        connect_timeout=10,
        settings={"insert_block_size": 100_000},
    )


# ---------------------------------------------------------------------------
# Optional application-layer AES-256-GCM (mirrors what the backend will do)
# ---------------------------------------------------------------------------
def encrypt_secret(plaintext: str, key_b64: str) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = base64.b64decode(key_b64)
    if len(key) != 32:
        raise ValueError("MTR_CREDENTIAL_KEY must be base64 of exactly 32 bytes")
    nonce = os.urandom(12)
    return base64.b64encode(nonce + AESGCM(key).encrypt(nonce, plaintext.encode(), b"snmp")).decode()


# ---------------------------------------------------------------------------
# PostgreSQL inventory
# ---------------------------------------------------------------------------
def reset_postgres(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("TRUNCATE incidents, burst_sessions, device_credentials, interfaces, devices, sites, "
                    "snmp_credentials RESTART IDENTITY CASCADE")
    conn.commit()
    log.info("PostgreSQL mock tables truncated")


def seed_postgres(conn, rng: random.Random, n_sites: int, n_devices: int) -> List[Device]:
    sites = SITES[:n_sites]
    weights = [m.weight for m in MODELS]
    with conn.cursor() as cur:
        rows = psycopg2.extras.execute_values(
            cur,
            """INSERT INTO sites (name, city, country, timezone) VALUES %s
               ON CONFLICT (name) DO UPDATE SET city = EXCLUDED.city
               RETURNING id, name""",
            sites, fetch=True)
        site_ids = [r[0] for r in sorted(rows, key=lambda r: [s[0] for s in sites].index(r[1]))]

        device_rows = []
        per_site_counter: Dict[int, int] = {}
        for i in range(n_devices):
            s_idx = i % len(site_ids)
            model = rng.choices(MODELS, weights=weights)[0]
            n = per_site_counter[s_idx] = per_site_counter.get(s_idx, 0) + 1
            site_code = sites[s_idx][0].split("-")[0].lower()
            hostname = f"{site_code}-{model.role}-{model.vendor[:2]}{n:02d}"
            mgmt_ip = f"10.{10 + s_idx}.{rng.randint(0, 3)}.{10 + n}"
            status = rng.choices(["up", "degraded", "down", "unknown"], weights=[86, 7, 4, 3])[0]
            device_rows.append((site_ids[s_idx], hostname, mgmt_ip,
                                rng.choice(["v2c", "v3", "v3"]), model.vendor, model.model,
                                model.sys_oid, SYS_DESCR[model.model], status,
                                datetime.now(timezone.utc) - timedelta(seconds=rng.randint(5, 300))))
        rows = psycopg2.extras.execute_values(
            cur,
            """INSERT INTO devices (site_id, hostname, mgmt_ip, snmp_version, vendor, model, sys_oid,
                                    sys_descr, status, last_polled_at) VALUES %s
               ON CONFLICT (hostname) DO UPDATE SET status = EXCLUDED.status,
                                                    last_polled_at = EXCLUDED.last_polled_at
               RETURNING id, hostname, host(mgmt_ip), model""",
            device_rows, fetch=True)
        by_model = {m.model: m for m in MODELS}
        devices = [Device(r[0], r[1], r[2], by_model[r[3]]) for r in rows]

        iface_rows = []
        for d in devices:
            count = rng.randint(4, 8)
            for idx in range(count):
                name = d.model.ifaces[idx]
                speed = d.model.speed_bps[min(idx, len(d.model.speed_bps) - 1)]
                ifindex = idx + 1  # unique per device; real ifIndex values arrive with SNMP discovery
                oper = 1 if rng.random() > 0.06 else rng.choice([2, 7])
                alias = rng.choice(["Uplink to core", "Customer CE", "Peering", "Transit", "Backhaul",
                                    "DWDM lambda", "Scrubbing in", "Scrubbing out", "MGMT", ""])
                iface_rows.append((d.id, ifindex, name, alias, f"{name} {d.model.model}", speed,
                                   1, oper, datetime.now(timezone.utc)))
        rows = psycopg2.extras.execute_values(
            cur,
            """INSERT INTO interfaces (device_id, ifindex, ifname, ifalias, ifdescr, ifspeed_bps,
                                       ifadmin_status, ifoper_status, last_metric_at) VALUES %s
               ON CONFLICT (device_id, ifindex) DO UPDATE SET ifoper_status = EXCLUDED.ifoper_status,
                                                             last_metric_at = EXCLUDED.last_metric_at
               RETURNING id, device_id, ifindex, ifname, ifspeed_bps""",
            iface_rows, fetch=True, page_size=1000)
        dev_by_id = {d.id: d for d in devices}
        for iface_id, dev_id, ifindex, ifname, speed in rows:
            dev_by_id[dev_id].interfaces.append((iface_id, ifindex, ifname, int(speed)))
        for d in devices:
            d.interfaces.sort(key=lambda t: t[1])

        seed_incidents(cur, rng, devices)
        seed_credentials(cur, devices)
    conn.commit()
    log.info("PostgreSQL: %d sites, %d devices, %d interfaces", len(site_ids), len(devices),
             sum(len(d.interfaces) for d in devices))
    return devices


def seed_incidents(cur, rng: random.Random, devices: Sequence[Device]) -> None:
    now = datetime.now(timezone.utc)
    cur.execute("SELECT count(*) FROM incidents")
    if cur.fetchone()[0]:
        return  # keep re-runs idempotent
    pe = next((d for d in devices if d.model.role == "pe"), devices[0])
    cur.execute("""INSERT INTO incidents (device_id, severity, title, description, state, opened_at)
                   VALUES (%s, 'critical', %s, %s, 'open', %s) RETURNING id""",
                (pe.id, f"{pe.hostname} unreachable", "ICMP and SNMP polling failed for 3 consecutive cycles",
                 now - timedelta(minutes=42)))
    parent = cur.fetchone()[0]
    for d in rng.sample(list(devices), 3):
        cur.execute("""INSERT INTO incidents (device_id, severity, title, description, state,
                                              suppressed_by_incident_id, opened_at)
                       VALUES (%s, 'major', %s, 'Downstream of unreachable PE', 'suppressed', %s, %s)""",
                    (d.id, f"{d.hostname} BGP session down", parent, now - timedelta(minutes=40)))
    for d in rng.sample(list(devices), 6):
        iface = rng.choice(d.interfaces) if d.interfaces else None
        state = rng.choice(["open", "acknowledged", "resolved"])
        opened = now - timedelta(hours=rng.randint(1, 20))
        cur.execute("""INSERT INTO incidents (device_id, interface_id, severity, title, state, opened_at,
                                              acknowledged_at, resolved_at)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                    (d.id, iface[0] if iface else None, rng.choice(["minor", "warning", "major"]),
                     f"{d.hostname} {iface[2] if iface else ''} errors above threshold".strip(), state, opened,
                     opened + timedelta(minutes=10) if state != "open" else None,
                     opened + timedelta(minutes=55) if state == "resolved" else None))


def seed_credentials(cur, devices: Sequence[Device]) -> None:
    key = os.getenv("MTR_CREDENTIAL_KEY", "")
    if not key:
        log.info("MTR_CREDENTIAL_KEY not set — skipping encrypted demo SNMP credentials")
        return
    demo_community = os.getenv("MOCK_SNMP_COMMUNITY") or base64.urlsafe_b64encode(os.urandom(12)).decode()
    cur.execute("""INSERT INTO snmp_credentials (label, version, community_string_enc)
                   VALUES ('mock-v2c', 'v2c', %s)
                   ON CONFLICT (label) DO UPDATE SET community_string_enc = EXCLUDED.community_string_enc
                   RETURNING id""", (encrypt_secret(demo_community, key),))
    cred_id = cur.fetchone()[0]
    psycopg2.extras.execute_values(
        cur, "INSERT INTO device_credentials (device_id, credential_id) VALUES %s ON CONFLICT DO NOTHING",
        [(d.id, cred_id) for d in devices])


# ---------------------------------------------------------------------------
# ClickHouse telemetry
# ---------------------------------------------------------------------------
def syslog_templates(d: Device, rng: random.Random) -> Tuple[int, int, str, str, str]:
    """Return (facility, severity, mnemonic, program, message_body) for a device's vendor."""
    peer = f"10.{rng.randint(0, 255)}.{rng.randint(0, 255)}.{rng.randint(1, 254)}"
    iface = rng.choice(d.interfaces)[2] if d.interfaces else "Gi0/0"
    up = rng.random() < 0.5
    v = d.model.vendor
    if v == "cisco":
        choices = [
            (5, "BGP-5-ADJCHANGE", f"neighbor {peer} {'Up' if up else 'Down BGP Notification sent'}"),
            (5, "OSPF-5-ADJCHG", f"Process 1, Nbr {peer} on {iface} from {'LOADING to FULL' if up else 'FULL to DOWN'}, "
                                 f"{'Loading Done' if up else 'Neighbor Down: Dead timer expired'}"),
            (3, "LINK-3-UPDOWN", f"Interface {iface}, changed state to {'up' if up else 'down'}"),
            (5, "LINEPROTO-5-UPDOWN", f"Line protocol on Interface {iface}, changed state to {'up' if up else 'down'}"),
            (6, "SEC-6-IPACCESSLOGP", f"list EDGE-IN denied tcp {peer}({rng.randint(1024, 65535)}) -> "
                                      f"{d.mgmt_ip}(22), 1 packet"),
            (4, "SSH-4-SSH2_UNEXPECTED_MSG", f"Unexpected message type has arrived. Terminating the connection from {peer}"),
            (5, "SYS-5-CONFIG_I", f"Configured from console by netops on vty0 ({peer})"),
            (2, "PLATFORM-2-PFM_SYSTEM_RESET", "System reset by watchdog"),
        ]
        sev, mn, body = rng.choices(choices, weights=[18, 14, 16, 16, 20, 6, 8, 2])[0]
        if d.model.model == "ASR9001" and mn.startswith("BGP"):
            mn = "ROUTING-" + mn
        return 23, sev, mn, mn.rsplit("-", 2)[0], f"%{mn}: {body}"
    if v == "huawei":
        choices = [
            (3, "BGP/3/STATE_CHG_UPDOWN", f"The status of the peer {peer} changed from "
                                          f"{'OPENCONFIRM to ESTABLISHED' if up else 'ESTABLISHED to IDLE'}."),
            (4, "OSPF/4/NBR_CHANGE_E", f"Neighbor changes event: neighbor status changed. (ProcessId=1, "
                                       f"NeighborAddress={peer}, NeighborEvent={'LoadingDone' if up else 'InactivityTimer'})"),
            (4, "IFNET/4/LINK_STATE", f"The line protocol IP on the interface {iface} has entered the "
                                      f"{'UP' if up else 'DOWN'} state."),
            (4, "SECE/4/ARP_ATTACK", f"ARP attack detected from {peer} on {iface}"),
            (5, "SHELL/5/CMDRECORD", f"Recorded command information. (Task=VT0, Ip={peer}, User=netops, "
                                     f"Command=\"display bgp peer\")"),
            (2, "DEVM/2/hwBoardFail", "Board failed. (EntPhysicalIndex=17104896, Slot=2)"),
        ]
        sev, mn, body = rng.choices(choices, weights=[20, 18, 22, 12, 24, 4])[0]
        return 23, sev, mn, mn.split("/")[0], f"%%01{mn}(l)[{rng.randint(1, 9999)}]:{body}"
    if v == "adva":
        choices = [
            (2, f"LOS alarm raised on {iface} (Loss Of Signal)"),
            (5, f"LOS alarm cleared on {iface}"),
            (4, f"Optical input power low on {iface}: -24.1 dBm"),
            (6, f"User netops logged in from {peer}"),
        ]
        sev, body = rng.choice(choices)
        return 16, sev, "", "fsp3000", body
    choices = [  # radware
        (1, f"Attack Started: SYN Flood, src {peer}, dst {d.mgmt_ip}, policy WEB-PROT"),
        (5, f"Attack Ended: SYN Flood, src {peer}, policy WEB-PROT"),
        (4, f"Behavioral DoS: UDP flood detected towards 196.{rng.randint(0, 255)}.10.{rng.randint(1, 254)}"),
        (6, f"Signature match: HTTP-SQLi-Generic from {peer}"),
    ]
    sev, body = rng.choice(choices)
    return 4, sev, "", "defensepro", body


def gen_syslog(devices: Sequence[Device], rng: random.Random, per_device: int, now: datetime) -> Iterable[tuple]:
    for d in devices:
        for _ in range(per_device):
            ts = now - timedelta(seconds=rng.randint(0, 86_400))
            facility, sev, mnemonic, program, body = syslog_templates(d, rng)
            pri = facility * 8 + sev
            raw = f"<{pri}>{ts.strftime('%b %d %H:%M:%S')} {d.hostname} {body}"
            yield (ts.replace(microsecond=0), d.id, ipaddress.IPv4Address(d.mgmt_ip), facility, sev, mnemonic,
                   raw, d.hostname, program)


def gen_metrics(devices: Sequence[Device], rng: random.Random, hours: int, now: datetime) -> Iterable[tuple]:
    step = 300
    end = now.replace(second=0, microsecond=0) - timedelta(minutes=now.minute % 5)
    n_points = hours * 3600 // step
    start = end - timedelta(seconds=step * (n_points - 1))
    for d in devices:
        for iface_id, _ifindex, _name, speed in d.interfaces:
            base_util = rng.uniform(0.03, 0.55)
            down_window = None
            if rng.random() < 0.05:  # ~5% of interfaces flap once in the window
                s = rng.randint(0, n_points - 12)
                down_window = (s, s + rng.randint(1, 10))
            for p in range(n_points):
                ts = start + timedelta(seconds=p * step)
                hour = ts.hour + ts.minute / 60.0
                diurnal = 0.55 + 0.45 * math.sin((hour - 8) / 24 * 2 * math.pi)  # peak ~14:00 UTC
                oper = 2 if down_window and down_window[0] <= p <= down_window[1] else 1
                in_oct = out_oct = in_err = out_err = in_disc = out_disc = 0
                if oper == 1:
                    util_in = max(0.0, min(0.98, base_util * diurnal * rng.uniform(0.85, 1.15)))
                    util_out = max(0.0, min(0.98, util_in * rng.uniform(0.4, 1.1)))
                    # Per-interval deltas (what the poller writes after wrap correction).
                    in_oct = int(speed * util_in * step / 8)
                    out_oct = int(speed * util_out * step / 8)
                    if util_in > 0.85 or rng.random() < 0.01:
                        in_disc = rng.randint(1, 500)
                    if rng.random() < 0.004:
                        in_err = rng.randint(1, 50)
                    if rng.random() < 0.002:
                        out_err = rng.randint(1, 10)
                    if util_out > 0.85:
                        out_disc = rng.randint(1, 300)
                yield (ts, d.id, iface_id, step, in_oct, out_oct, in_err, out_err, in_disc, out_disc, oper)


def gen_flows(devices: Sequence[Device], rng: random.Random, per_device: int, now: datetime) -> Iterable[tuple]:
    ports = [p for p in WELL_KNOWN_PORTS]
    weights = [p[2] for p in ports]
    for d in devices:
        if not d.interfaces:
            continue
        exporter = ipaddress.IPv4Address(d.mgmt_ip)
        site_octet = int(d.mgmt_ip.split(".")[1])
        for _ in range(per_device):
            start = now - timedelta(seconds=rng.randint(60, 86_400))
            dur = rng.randint(1, 120)
            in_if = rng.choice(d.interfaces)
            out_if = rng.choice(d.interfaces)
            dport, proto, _ = rng.choices(ports, weights=weights)[0]
            if proto == 1:
                sport = dport = 0
            else:
                sport = rng.randint(1024, 65535)
            inbound = rng.random() < 0.6
            internal = ipaddress.IPv4Address(f"10.{site_octet}.{rng.randint(16, 250)}.{rng.randint(1, 254)}")
            external = ipaddress.IPv4Address(rng.choice([
                f"41.{rng.randint(0, 255)}.{rng.randint(0, 255)}.{rng.randint(1, 254)}",
                f"196.{rng.randint(0, 255)}.{rng.randint(0, 255)}.{rng.randint(1, 254)}",
                f"142.250.{rng.randint(0, 255)}.{rng.randint(1, 254)}",
                f"104.16.{rng.randint(0, 255)}.{rng.randint(1, 254)}",
                f"8.8.{rng.choice([4, 8])}.{rng.choice([4, 8])}",
            ]))
            src, dst = (external, internal) if inbound else (internal, external)
            if inbound:
                sport, dport = dport, sport
            packets = max(1, int(rng.lognormvariate(4, 1.6)))
            bytes_ = packets * rng.randint(64, 1500)
            yield (start.replace(microsecond=0), (start + timedelta(seconds=dur)).replace(microsecond=0), exporter,
                   d.id, in_if[1], out_if[1], src, dst, sport, dport, proto, bytes_, min(packets, 2**32 - 1),
                   in_if[2], out_if[2])


def ch_insert(ch: ClickHouseClient, table: str, columns: str, rows: Iterable[tuple], batch: int = 100_000) -> int:
    total, buf = 0, []
    sql = f"INSERT INTO {table} ({columns}) VALUES"
    for r in rows:
        buf.append(r)
        if len(buf) >= batch:
            ch.execute(sql, buf)
            total += len(buf)
            buf.clear()
    if buf:
        ch.execute(sql, buf)
        total += len(buf)
    return total


def reset_clickhouse(ch: ClickHouseClient) -> None:
    for t in ("syslog_events", "netflow_records", "interface_metrics", "interface_metrics_5m_agg"):
        ch.execute(f"TRUNCATE TABLE IF EXISTS {t}")
    log.info("ClickHouse mock tables truncated")


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sites", type=int, default=10, help="number of sites (max %d)" % len(SITES))
    ap.add_argument("--devices", type=int, default=100)
    ap.add_argument("--syslog-per-device", type=int, default=500)
    ap.add_argument("--flows-per-device", type=int, default=1000)
    ap.add_argument("--metric-hours", type=int, default=24)
    ap.add_argument("--seed", type=int, default=42, help="RNG seed for reproducible datasets")
    ap.add_argument("--reset", action="store_true", help="truncate mock tables before seeding")
    ap.add_argument("--skip-clickhouse", action="store_true")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    if not 1 <= args.sites <= len(SITES):
        ap.error(f"--sites must be between 1 and {len(SITES)}")
    rng = random.Random(args.seed)
    t0 = time.time()

    conn = pg_connect()
    try:
        if args.reset:
            reset_postgres(conn)
        devices = seed_postgres(conn, rng, args.sites, args.devices)
    finally:
        conn.close()

    if args.skip_clickhouse:
        return 0

    ch = ch_connect()
    if args.reset:
        reset_clickhouse(ch)
    now = datetime.now(timezone.utc)
    n = ch_insert(ch, "syslog_events",
                  "event_time, device_id, source_ip, facility, severity, mnemonic, raw_message, parsed_host, parsed_program",
                  gen_syslog(devices, rng, args.syslog_per_device, now))
    log.info("ClickHouse: %d syslog_events", n)
    n = ch_insert(ch, "interface_metrics",
                  "ts, device_id, interface_id, poll_interval_sec, in_octets, out_octets, in_errors, out_errors, "
                  "in_discards, out_discards, ifoper_status",
                  gen_metrics(devices, rng, args.metric_hours, now))
    log.info("ClickHouse: %d interface_metrics (5-min rollups populated by interface_metrics_5m_mv)", n)
    n = ch_insert(ch, "netflow_records",
                  "flow_start, flow_end, exporter_ip, device_id, input_ifindex, output_ifindex, src_ip, dst_ip, "
                  "src_port, dst_port, protocol, bytes, packets, input_ifname, output_ifname",
                  gen_flows(devices, rng, args.flows_per_device, now))
    log.info("ClickHouse: %d netflow_records", n)
    ch.disconnect()
    log.info("Done in %.1fs", time.time() - t0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
