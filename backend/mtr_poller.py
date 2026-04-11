#!/usr/bin/env python3
"""
Production-oriented MTR Poller

Flow:
1) Run fping in batch across active devices.
2) Evaluate trigger policy per device using Postgres-backed state.
3) Run or dispatch full MTR only when trigger conditions are met.
"""

import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import mysql.connector
import schedule
from dotenv import load_dotenv
from pymongo import ASCENDING, MongoClient
from pymongo.errors import ConnectionFailure

try:
    import pika
except Exception:  # pragma: no cover - optional dependency at runtime
    pika = None

try:
    import psycopg
except Exception:  # pragma: no cover - optional dependency at runtime
    psycopg = None

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.FileHandler('mtr_poller.log'), logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


class StartupValidationError(Exception):
    """Raised when startup preflight validation fails."""


@dataclass
class Device:
    id: int
    ip_address: str
    hostname: str
    is_active: bool
    probe_mode: str
    probe_port: Optional[int]
    probe_tos: Optional[int]
    mtr_count: int
    jitter_threshold_ms: Optional[float]
    created_at: datetime
    updated_at: datetime


@dataclass
class DeviceProbeState:
    device_id: int
    baseline_latency_ms: Optional[float]
    last_latency_ms: Optional[float]
    last_jitter_ms: Optional[float]
    last_fping_at: Optional[datetime]
    last_mtr_at: Optional[datetime]
    consecutive_jitter_breach: int
    cooldown_until: Optional[datetime]


class MySQLClient:
    def __init__(self):
        self.host = os.getenv('MYSQL_HOST', 'localhost')
        self.port = int(os.getenv('MYSQL_PORT', '3306'))
        self.user = os.getenv('MYSQL_USER', 'root')
        self.password = os.getenv('MYSQL_PASSWORD', '')
        self.database = os.getenv('MYSQL_DATABASE', 'mtr_dashboard')
        self.connection = None

    def connect(self):
        try:
            self.connection = mysql.connector.connect(
                host=self.host,
                port=self.port,
                user=self.user,
                password=self.password,
                database=self.database,
            )
            self.connection.autocommit = True
            logger.info('Connected to MySQL at %s:%s', self.host, self.port)
        except mysql.connector.Error as e:
            logger.error('MySQL connection error: %s', e)
            raise

    def disconnect(self):
        if self.connection and self.connection.is_connected():
            self.connection.close()
            logger.info('MySQL connection closed')

    def ensure_profile_columns(self):
        cursor = self.connection.cursor()
        required_columns = {
            'probe_mode': "ALTER TABLE devices ADD COLUMN probe_mode ENUM('icmp', 'tcp', 'udp') NOT NULL DEFAULT 'icmp'",
            'probe_port': 'ALTER TABLE devices ADD COLUMN probe_port INT NULL',
            'probe_tos': 'ALTER TABLE devices ADD COLUMN probe_tos INT NULL',
            'mtr_count': 'ALTER TABLE devices ADD COLUMN mtr_count SMALLINT NOT NULL DEFAULT 10',
            'jitter_threshold_ms': 'ALTER TABLE devices ADD COLUMN jitter_threshold_ms DOUBLE NULL',
        }
        for column_name, ddl in required_columns.items():
            cursor.execute('SHOW COLUMNS FROM devices LIKE %s', (column_name,))
            if cursor.fetchone() is None:
                cursor.execute(ddl)
                logger.info('Added missing devices column: %s', column_name)
        cursor.close()

    def fetch_active_devices(self) -> List[Device]:
        if not self.connection or not self.connection.is_connected():
            self.connect()

        cursor = self.connection.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT
                id,
                ip_address,
                hostname,
                is_active,
                probe_mode,
                probe_port,
                probe_tos,
                mtr_count,
                jitter_threshold_ms,
                created_at,
                updated_at
            FROM devices
            WHERE is_active = TRUE
            """
        )
        rows = cursor.fetchall()
        cursor.close()

        devices: List[Device] = []
        for row in rows:
            devices.append(
                Device(
                    id=row['id'],
                    ip_address=row['ip_address'],
                    hostname=row['hostname'],
                    is_active=bool(row['is_active']),
                    probe_mode=str(row.get('probe_mode') or 'icmp'),
                    probe_port=int(row['probe_port']) if row.get('probe_port') is not None else None,
                    probe_tos=int(row['probe_tos']) if row.get('probe_tos') is not None else None,
                    mtr_count=int(row.get('mtr_count') or int(os.getenv('MTR_COUNT', '10'))),
                    jitter_threshold_ms=float(row['jitter_threshold_ms']) if row.get('jitter_threshold_ms') is not None else None,
                    created_at=row['created_at'],
                    updated_at=row['updated_at'],
                )
            )

        logger.info('Fetched %d active devices from MySQL', len(devices))
        return devices

    def get_deleted_device_ids(self, known_ids: List[int]) -> List[int]:
        if not self.connection or not self.connection.is_connected():
            self.connect()

        cursor = self.connection.cursor()
        cursor.execute('SELECT id FROM devices WHERE is_active = TRUE')
        current_ids = {row[0] for row in cursor.fetchall()}
        cursor.close()

        return [device_id for device_id in known_ids if device_id not in current_ids]


class MongoDBClient:
    def __init__(self):
        self.uri = os.getenv('MONGODB_URI', 'mongodb://localhost:27017')
        self.database = os.getenv('MONGODB_DATABASE', 'mtr_metrics')
        self.collection_name = os.getenv('MONGODB_COLLECTION', 'mtr_results')
        self.fping_collection_name = os.getenv('MONGODB_FPING_COLLECTION', 'fping_status')
        self.fping_history_collection_name = os.getenv('MONGODB_FPING_HISTORY_COLLECTION', 'fping_results')
        self.realtime_fping_collection_name = os.getenv('MONGODB_REALTIME_FPING_COLLECTION', 'fping_realtime_results')
        self.realtime_session_collection_name = os.getenv('MONGODB_REALTIME_SESSION_COLLECTION', 'realtime_probe_sessions')
        self.probe_request_collection_name = os.getenv('MONGODB_PROBE_REQUEST_COLLECTION', 'probe_requests')
        self.realtime_ttl_seconds = int(os.getenv('MONGODB_REALTIME_TTL_SECONDS', '86400'))
        self.status_collection_name = os.getenv('MONGODB_STATUS_COLLECTION', 'service_status')
        self.client = None
        self.collection = None
        self.fping_collection = None
        self.fping_history_collection = None
        self.realtime_fping_collection = None
        self.realtime_session_collection = None
        self.probe_request_collection = None
        self.status_collection = None

    def connect(self):
        try:
            self.client = MongoClient(self.uri, serverSelectionTimeoutMS=5000)
            self.client.admin.command('ping')
            db = self.client[self.database]
            self.collection = db[self.collection_name]
            self.fping_collection = db[self.fping_collection_name]
            self.fping_history_collection = db[self.fping_history_collection_name]
            self.realtime_fping_collection = db[self.realtime_fping_collection_name]
            self.realtime_session_collection = db[self.realtime_session_collection_name]
            self.probe_request_collection = db[self.probe_request_collection_name]
            self.status_collection = db[self.status_collection_name]
            self.realtime_fping_collection.create_index([('timestamp', ASCENDING)], expireAfterSeconds=self.realtime_ttl_seconds)
            self.realtime_fping_collection.create_index([('device_id', ASCENDING), ('timestamp', ASCENDING)])
            self.realtime_session_collection.create_index([('active', ASCENDING), ('end_at', ASCENDING)])
            self.realtime_session_collection.create_index([('device_id', ASCENDING)], unique=True)
            self.probe_request_collection.create_index([('status', ASCENDING), ('requested_at', ASCENDING)])
            logger.info('Connected to MongoDB at %s, database: %s', self.uri, self.database)
        except ConnectionFailure as e:
            logger.error('MongoDB connection error: %s', e)
            raise

    def disconnect(self):
        if self.client:
            self.client.close()
            logger.info('MongoDB connection closed')

    def insert_mtr_result(
        self,
        device_id: int,
        ip_address: str,
        hostname: str,
        mtr_json: Dict[str, Any],
        trigger_reason: str,
    ):
        report = mtr_json.get('report', {}) if isinstance(mtr_json, dict) else {}
        report_hubs = report.get('hubs', []) if isinstance(report, dict) else []
        report_mtr = report.get('mtr', {}) if isinstance(report, dict) else {}

        document = {
            'device_id': device_id,
            'ip_address': ip_address,
            'hostname': hostname,
            'timestamp': datetime.now(timezone.utc),
            'mtr_result': mtr_json,
            'metadata': {
                'hops': len(report_hubs) if isinstance(report_hubs, list) else 0,
                'destination': report_mtr.get('dst', ip_address) if isinstance(report_mtr, dict) else ip_address,
                'trigger_reason': trigger_reason,
            },
        }
        self.collection.insert_one(document)

    def delete_device_data(self, device_id: int):
        result = self.collection.delete_many({'device_id': device_id})
        if self.fping_collection is not None:
            self.fping_collection.delete_many({'device_id': device_id})
        if self.fping_history_collection is not None:
            self.fping_history_collection.delete_many({'device_id': device_id})
        logger.info('Deleted %d records for device %s', result.deleted_count, device_id)

    def upsert_fping_status(
        self,
        device_id: int,
        ip_address: str,
        hostname: str,
        alive: bool,
        avg_latency_ms: Optional[float],
        stddev_ms: Optional[float],
        sample_count: int,
        sent_count: int,
        loss_pct: float,
        trigger_reason: str,
    ):
        if self.fping_collection is None and self.fping_history_collection is None:
            return

        now = datetime.now(timezone.utc)

        if self.fping_collection is not None:
            self.fping_collection.update_one(
                {'device_id': device_id},
                {
                    '$set': {
                        'device_id': device_id,
                        'ip_address': ip_address,
                        'hostname': hostname,
                        'timestamp': now,
                        'alive': alive,
                        'avg_latency_ms': avg_latency_ms,
                        'stddev_ms': stddev_ms,
                        'sample_count': sample_count,
                        'sent_count': sent_count,
                        'loss_pct': loss_pct,
                        'last_trigger_decision': trigger_reason,
                    }
                },
                upsert=True,
            )

        if self.fping_history_collection is not None:
            self.fping_history_collection.insert_one(
                {
                    'device_id': device_id,
                    'ip_address': ip_address,
                    'hostname': hostname,
                    'timestamp': now,
                    'alive': alive,
                    'avg_latency_ms': avg_latency_ms,
                    'stddev_ms': stddev_ms,
                    'sample_count': sample_count,
                    'sent_count': sent_count,
                    'loss_pct': loss_pct,
                    'trigger_decision': trigger_reason,
                }
            )

    def insert_realtime_fping_result(
        self,
        device_id: int,
        ip_address: str,
        hostname: str,
        alive: bool,
        avg_latency_ms: Optional[float],
        stddev_ms: Optional[float],
        sample_count: int,
        sent_count: int,
        loss_pct: float,
        source: str,
    ):
        if self.realtime_fping_collection is None:
            return

        self.realtime_fping_collection.insert_one(
            {
                'device_id': device_id,
                'ip_address': ip_address,
                'hostname': hostname,
                'timestamp': datetime.now(timezone.utc),
                'alive': alive,
                'avg_latency_ms': avg_latency_ms,
                'stddev_ms': stddev_ms,
                'sample_count': sample_count,
                'sent_count': sent_count,
                'loss_pct': loss_pct,
                'source': source,
            }
        )

    def expire_realtime_sessions(self, now: datetime):
        if self.realtime_session_collection is None:
            return

        self.realtime_session_collection.update_many(
            {'active': True, 'end_at': {'$lte': now}},
            {'$set': {'active': False, 'ended_at': now, 'stop_reason': 'expired', 'updated_at': now}},
        )

    def get_active_realtime_sessions(self, now: datetime, limit: int) -> List[Dict[str, Any]]:
        if self.realtime_session_collection is None:
            return []

        return list(
            self.realtime_session_collection.find(
                {'active': True, 'mode': 'fping', 'end_at': {'$gt': now}}
            )
            .sort([('updated_at', -1)])
            .limit(limit)
        )

    def update_realtime_session(self, device_id: int, fields: Dict[str, Any]):
        if self.realtime_session_collection is None:
            return

        fields['updated_at'] = datetime.now(timezone.utc)
        self.realtime_session_collection.update_one({'device_id': device_id}, {'$set': fields})

    def get_pending_probe_requests(self, limit: int) -> List[Dict[str, Any]]:
        if self.probe_request_collection is None:
            return []

        return list(
            self.probe_request_collection.find({'status': 'pending'})
            .sort([('requested_at', 1)])
            .limit(limit)
        )

    def claim_probe_request(self, request_id: Any) -> bool:
        if self.probe_request_collection is None:
            return False

        result = self.probe_request_collection.update_one(
            {'_id': request_id, 'status': 'pending'},
            {'$set': {'status': 'running', 'started_at': datetime.now(timezone.utc)}},
        )
        return result.modified_count == 1

    def complete_probe_request(self, request_id: Any, success: bool, message: str):
        if self.probe_request_collection is None:
            return

        self.probe_request_collection.update_one(
            {'_id': request_id},
            {
                '$set': {
                    'status': 'done' if success else 'error',
                    'completed_at': datetime.now(timezone.utc),
                    'result_message': message,
                }
            },
        )

    def update_poller_heartbeat(self, state: str, last_error: Optional[str] = None):
        if self.status_collection is None:
            return

        doc = {
            'service': 'mtr_poller',
            'state': state,
            'heartbeat_at': datetime.now(timezone.utc),
            'host': os.getenv('HOSTNAME', 'unknown'),
            'pid': os.getpid(),
            'polling_interval_minutes': int(os.getenv('POLLING_INTERVAL_MINUTES', '5')),
        }
        if last_error:
            doc['last_error'] = last_error

        self.status_collection.update_one({'_id': 'mtr_poller'}, {'$set': doc}, upsert=True)


class PostgresStateClient:
    def __init__(self):
        self.host = os.getenv('POSTGRES_HOST', 'localhost')
        self.port = int(os.getenv('POSTGRES_PORT', '5432'))
        self.user = os.getenv('POSTGRES_USER', 'mtr_state_user')
        self.password = os.getenv('POSTGRES_PASSWORD', 'mtr_state_password')
        self.database = os.getenv('POSTGRES_DB', 'mtr_state')
        self.table = os.getenv('POSTGRES_STATE_TABLE', 'device_probe_state')
        self.conn = None

    def connect(self):
        if psycopg is None:
            raise StartupValidationError('psycopg is not installed but Postgres state is required')

        self.conn = psycopg.connect(
            host=self.host,
            port=self.port,
            user=self.user,
            password=self.password,
            dbname=self.database,
        )
        self.conn.autocommit = True
        self._ensure_schema()
        logger.info('Connected to PostgreSQL at %s:%s/%s', self.host, self.port, self.database)

    def disconnect(self):
        if self.conn:
            self.conn.close()
            self.conn = None

    def _ensure_schema(self):
        with self.conn.cursor() as cur:
            cur.execute(
                f"""
                CREATE TABLE IF NOT EXISTS {self.table} (
                    device_id INTEGER PRIMARY KEY,
                    baseline_latency_ms DOUBLE PRECISION,
                    last_latency_ms DOUBLE PRECISION,
                    last_jitter_ms DOUBLE PRECISION,
                    last_fping_at TIMESTAMPTZ,
                    last_mtr_at TIMESTAMPTZ,
                    consecutive_jitter_breach INTEGER NOT NULL DEFAULT 0,
                    cooldown_until TIMESTAMPTZ,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )

    def get_states(self, device_ids: List[int]) -> Dict[int, DeviceProbeState]:
        if not device_ids:
            return {}

        sql = f"""
            SELECT
                device_id,
                baseline_latency_ms,
                last_latency_ms,
                last_jitter_ms,
                last_fping_at,
                last_mtr_at,
                consecutive_jitter_breach,
                cooldown_until
            FROM {self.table}
            WHERE device_id = ANY(%s)
        """

        result: Dict[int, DeviceProbeState] = {}
        with self.conn.cursor() as cur:
            cur.execute(sql, (device_ids,))
            for row in cur.fetchall():
                result[row[0]] = DeviceProbeState(
                    device_id=row[0],
                    baseline_latency_ms=row[1],
                    last_latency_ms=row[2],
                    last_jitter_ms=row[3],
                    last_fping_at=row[4],
                    last_mtr_at=row[5],
                    consecutive_jitter_breach=row[6],
                    cooldown_until=row[7],
                )
        return result

    def upsert_state(
        self,
        device_id: int,
        baseline_latency_ms: Optional[float],
        last_latency_ms: Optional[float],
        last_jitter_ms: Optional[float],
        last_fping_at: datetime,
        consecutive_jitter_breach: int,
        cooldown_until: Optional[datetime],
    ):
        sql = f"""
            INSERT INTO {self.table}
              (device_id, baseline_latency_ms, last_latency_ms, last_jitter_ms, last_fping_at, consecutive_jitter_breach, cooldown_until, updated_at)
            VALUES
              (%s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (device_id) DO UPDATE SET
              baseline_latency_ms = EXCLUDED.baseline_latency_ms,
              last_latency_ms = EXCLUDED.last_latency_ms,
              last_jitter_ms = EXCLUDED.last_jitter_ms,
              last_fping_at = EXCLUDED.last_fping_at,
              consecutive_jitter_breach = EXCLUDED.consecutive_jitter_breach,
              cooldown_until = EXCLUDED.cooldown_until,
              updated_at = NOW()
        """
        with self.conn.cursor() as cur:
            cur.execute(
                sql,
                (
                    device_id,
                    baseline_latency_ms,
                    last_latency_ms,
                    last_jitter_ms,
                    last_fping_at,
                    consecutive_jitter_breach,
                    cooldown_until,
                ),
            )

    def mark_mtr_run(self, device_id: int, now: datetime):
        sql = f"""
            INSERT INTO {self.table} (device_id, last_mtr_at, updated_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (device_id) DO UPDATE SET
              last_mtr_at = EXCLUDED.last_mtr_at,
              updated_at = NOW()
        """
        with self.conn.cursor() as cur:
            cur.execute(sql, (device_id, now))


class RabbitMQClient:
    def __init__(self):
        self.enabled_mode = os.getenv('MTR_DISPATCH_MODE', 'direct').strip().lower()
        self.url = os.getenv('RABBITMQ_URL', '').strip()
        self.queue = os.getenv('MTR_JOB_QUEUE', 'mtr_jobs')
        self.conn = None
        self.channel = None

    def required(self) -> bool:
        return self.enabled_mode in {'rabbitmq-producer', 'rabbitmq-worker'}

    def connect(self):
        if not self.required():
            return
        if pika is None:
            raise StartupValidationError('pika is not installed but rabbitmq dispatch mode is enabled')
        if not self.url:
            raise StartupValidationError('RABBITMQ_URL must be set when rabbitmq dispatch mode is enabled')

        params = pika.URLParameters(self.url)
        self.conn = pika.BlockingConnection(params)
        self.channel = self.conn.channel()
        self.channel.queue_declare(queue=self.queue, durable=True)
        logger.info('Connected to RabbitMQ queue %s', self.queue)

    def disconnect(self):
        if self.conn:
            self.conn.close()
            self.conn = None
            self.channel = None

    def publish_job(self, payload: Dict[str, Any]):
        if not self.channel:
            return
        self.channel.basic_publish(
            exchange='',
            routing_key=self.queue,
            body=json.dumps(payload),
            properties=pika.BasicProperties(delivery_mode=2),
        )

    def consume_one(self) -> Optional[Tuple[int, Dict[str, Any]]]:
        if not self.channel:
            return None
        method, _, body = self.channel.basic_get(queue=self.queue, auto_ack=False)
        if not method:
            return None
        payload = json.loads(body.decode('utf-8'))
        return method.delivery_tag, payload

    def ack(self, delivery_tag: int):
        if self.channel:
            self.channel.basic_ack(delivery_tag)

    def nack(self, delivery_tag: int):
        if self.channel:
            self.channel.basic_nack(delivery_tag, requeue=True)


class FpingRunner:
    @staticmethod
    def run_batch(devices: List[Device]) -> Dict[str, Dict[str, Any]]:
        """Run fping in parallel and return metrics keyed by target IP."""
        if not devices:
            return {}

        fping_count = int(os.getenv('FPING_COUNT', '3'))
        fping_interval_ms = int(os.getenv('FPING_INTERVAL_MS', '10'))
        fping_period_ms = int(os.getenv('FPING_PERIOD_MS', '500'))
        fping_timeout_s = int(os.getenv('FPING_TIMEOUT_SECONDS', '40'))

        ips = [d.ip_address for d in devices]
        cmd = [
            'fping',
            '-i',
            str(fping_interval_ms),
            '-p',
            str(fping_period_ms),
            '-C',
            str(fping_count),
            '-q',
            *ips,
        ]

        logger.debug('Running command: %s', ' '.join(cmd))
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=fping_timeout_s)

        # fping writes probe lines to stderr in -q/-C mode.
        output = proc.stderr or ''
        results: Dict[str, Dict[str, Any]] = {}
        for line in output.splitlines():
            line = line.strip()
            if not line or ' : ' not in line:
                continue
            host, samples_raw = line.split(' : ', 1)
            host = host.strip()
            tokens = samples_raw.strip().split()
            samples: List[float] = []
            for token in tokens:
                if token == '-':
                    continue
                try:
                    samples.append(float(token))
                except ValueError:
                    continue

            avg_latency = sum(samples) / len(samples) if samples else None
            if len(samples) > 1:
                sample_mean = sum(samples) / len(samples)
                variance = sum((value - sample_mean) ** 2 for value in samples) / len(samples)
                stddev_ms = variance ** 0.5
            else:
                stddev_ms = None

            results[host] = {
                'alive': bool(samples),
                'avg_latency_ms': avg_latency,
                'stddev_ms': stddev_ms,
                'samples_ms': samples,
                'sample_count': len(samples),
                'sent_count': fping_count,
                'loss_pct': float(((fping_count - len(samples)) / fping_count) * 100) if fping_count > 0 else 100.0,
            }

        return results


class MTRRunner:
    @staticmethod
    def run_mtr(device: Device) -> Optional[Dict[str, Any]]:
        try:
            probe_mode = (device.probe_mode or os.getenv('MTR_PROBE_MODE', 'icmp')).strip().lower()
            if probe_mode not in {'icmp', 'tcp', 'udp'}:
                probe_mode = 'icmp'

            probe_count = device.mtr_count if device.mtr_count > 0 else int(os.getenv('MTR_COUNT', '10'))
            default_tcp_port = int(os.getenv('MTR_TCP_PORT', '443'))
            default_udp_port = int(os.getenv('MTR_UDP_PORT', '33434'))

            cmd = ['mtr', '-j', '-e', '-c', str(probe_count)]
            if probe_mode == 'tcp':
                cmd.extend(['-T', '-P', str(device.probe_port if device.probe_port is not None else default_tcp_port)])
            elif probe_mode == 'udp':
                cmd.extend(['-u', '-P', str(device.probe_port if device.probe_port is not None else default_udp_port)])

            if device.probe_tos is not None:
                cmd.extend(['-Q', str(device.probe_tos)])

            cmd.append(device.ip_address)
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if proc.returncode != 0:
                logger.warning('mtr command failed for %s: %s', device.ip_address, proc.stderr.strip())
                return None
            return json.loads(proc.stdout)
        except subprocess.TimeoutExpired:
            logger.error('mtr command timed out for %s', device.ip_address)
            return None
        except json.JSONDecodeError as e:
            logger.error('Failed to parse mtr JSON for %s: %s', device.ip_address, e)
            return None
        except Exception as e:
            logger.error('Unexpected error running mtr for %s: %s', device.ip_address, e)
            return None


class MTRPoller:
    def __init__(self):
        self.mysql = MySQLClient()
        self.mongodb = MongoDBClient()
        self.pg_state = PostgresStateClient()
        self.rabbit = RabbitMQClient()
        self.fping = FpingRunner()
        self.mtr_runner = MTRRunner()
        self.executor = ThreadPoolExecutor(max_workers=int(os.getenv('MTR_MAX_WORKERS', '10')))
        self.running = False
        self.known_device_ids = set()

        self.dispatch_mode = os.getenv('MTR_DISPATCH_MODE', 'direct').strip().lower()
        self.force_mtr_interval_minutes = int(os.getenv('MTR_FORCE_INTERVAL_MINUTES', '60'))
        self.jitter_threshold_ms = float(os.getenv('MTR_JITTER_THRESHOLD_MS', '5'))
        self.consecutive_breach_required = int(os.getenv('MTR_CONSECUTIVE_BREACHES', '2'))
        self.cooldown_minutes = int(os.getenv('MTR_TRIGGER_COOLDOWN_MINUTES', '15'))
        self.baseline_alpha = float(os.getenv('MTR_BASELINE_ALPHA', '0.2'))
        self.realtime_max_sessions = int(os.getenv('REALTIME_MAX_ACTIVE_SESSIONS', '5'))
        self.realtime_device_map: Dict[int, Device] = {}
        self.realtime_next_device_refresh = 0.0

    def _validate_startup_config(self):
        required = [
            'MYSQL_HOST',
            'MYSQL_PORT',
            'MYSQL_USER',
            'MYSQL_PASSWORD',
            'MYSQL_DATABASE',
            'MONGODB_URI',
            'MONGODB_DATABASE',
            'POSTGRES_HOST',
            'POSTGRES_PORT',
            'POSTGRES_USER',
            'POSTGRES_PASSWORD',
            'POSTGRES_DB',
        ]
        missing = [name for name in required if not os.getenv(name, '').strip()]
        if missing:
            raise StartupValidationError(f'Missing required env vars: {", ".join(missing)}')

        if self.dispatch_mode not in {'direct', 'rabbitmq-producer', 'rabbitmq-worker'}:
            raise StartupValidationError('MTR_DISPATCH_MODE must be one of: direct, rabbitmq-producer, rabbitmq-worker')

    def _validate_mysql_schema(self):
        cursor = self.mysql.connection.cursor()
        cursor.execute('SHOW TABLES LIKE %s', ('devices',))
        has_devices = cursor.fetchone() is not None
        cursor.execute('SHOW TABLES LIKE %s', ('polling_jobs',))
        has_jobs = cursor.fetchone() is not None
        cursor.close()

        if not has_devices or not has_jobs:
            missing = []
            if not has_devices:
                missing.append('devices')
            if not has_jobs:
                missing.append('polling_jobs')
            raise StartupValidationError('Missing MySQL tables: ' + ', '.join(missing))

        self.mysql.ensure_profile_columns()

    def run_preflight_checks(self):
        self._validate_startup_config()
        self.mysql.connect()
        self._validate_mysql_schema()
        self.mongodb.connect()
        self.pg_state.connect()
        self.rabbit.connect()
        self.mongodb.update_poller_heartbeat('starting')
        logger.info('Startup preflight checks passed (MySQL, MongoDB, Postgres, schema).')

    def start(self):
        logger.info('Starting MTR Poller (%s mode)', self.dispatch_mode)
        self.running = True
        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)

        self.run_preflight_checks()
        self.update_known_devices()
        self.mongodb.update_poller_heartbeat('running')

        if self.dispatch_mode == 'rabbitmq-worker':
            self.run_worker_loop()
            return

        polling_interval = int(os.getenv('POLLING_INTERVAL_MINUTES', '5'))
        cleanup_interval = int(os.getenv('CLEANUP_INTERVAL_HOURS', '1'))
        schedule.every(polling_interval).minutes.do(self.poll_once)
        schedule.every(cleanup_interval).hours.do(self.cleanup_deleted_devices)

        logger.info('Scheduler started. Polling every %s minutes, cleanup every %s hours.', polling_interval, cleanup_interval)
        self.poll_once()

        while self.running:
            schedule.run_pending()
            self.run_realtime_tick()
            time.sleep(1)

    def stop(self):
        logger.info('Stopping MTR Poller')
        self.running = False
        self.executor.shutdown(wait=False)
        try:
            self.mongodb.update_poller_heartbeat('stopped')
        except Exception:
            pass
        self.rabbit.disconnect()
        self.pg_state.disconnect()
        self.mysql.disconnect()
        self.mongodb.disconnect()

    def signal_handler(self, signum, _frame):
        logger.info('Received signal %s, shutting down...', signum)
        self.stop()
        sys.exit(0)

    def update_known_devices(self):
        devices = self.mysql.fetch_active_devices()
        self.known_device_ids = {d.id for d in devices}
        logger.info('Updated known device IDs: %d devices', len(self.known_device_ids))

    def _evaluate_trigger(
        self,
        state: Optional[DeviceProbeState],
        current_latency_ms: Optional[float],
        current_stddev_ms: Optional[float],
        jitter_threshold_ms: float,
        now: datetime,
    ) -> Tuple[bool, str, Optional[float], int, Optional[datetime], Optional[float]]:
        baseline = state.baseline_latency_ms if state else None
        consecutive = state.consecutive_jitter_breach if state else 0
        cooldown_until = state.cooldown_until if state else None
        jitter = None

        if current_latency_ms is not None:
            if baseline is None:
                baseline = current_latency_ms
            else:
                jitter = abs(current_latency_ms - baseline)

        if cooldown_until and cooldown_until > now:
            # Update baseline passively even in cooldown.
            if current_latency_ms is not None and baseline is not None:
                baseline = self.baseline_alpha * current_latency_ms + (1 - self.baseline_alpha) * baseline
            return False, 'cooldown', baseline, consecutive, cooldown_until, jitter

        if state is None or state.last_mtr_at is None:
            if current_latency_ms is not None and baseline is not None:
                baseline = self.baseline_alpha * current_latency_ms + (1 - self.baseline_alpha) * baseline
            return True, 'bootstrap', baseline, 0, now + timedelta(minutes=self.cooldown_minutes), jitter

        max_age = timedelta(minutes=self.force_mtr_interval_minutes)
        if now - state.last_mtr_at >= max_age:
            if current_latency_ms is not None and baseline is not None:
                baseline = self.baseline_alpha * current_latency_ms + (1 - self.baseline_alpha) * baseline
            return True, 'periodic-refresh', baseline, 0, now + timedelta(minutes=self.cooldown_minutes), jitter

        trigger_metric = current_stddev_ms if current_stddev_ms is not None else jitter
        if trigger_metric is not None and trigger_metric > jitter_threshold_ms:
            consecutive += 1
            if consecutive >= self.consecutive_breach_required:
                if current_latency_ms is not None and baseline is not None:
                    baseline = self.baseline_alpha * current_latency_ms + (1 - self.baseline_alpha) * baseline
                return True, 'jitter-breach', baseline, 0, now + timedelta(minutes=self.cooldown_minutes), trigger_metric
        else:
            consecutive = 0

        if current_latency_ms is not None and baseline is not None:
            baseline = self.baseline_alpha * current_latency_ms + (1 - self.baseline_alpha) * baseline

        return False, 'stable', baseline, consecutive, cooldown_until, jitter

    async def run_mtr_for_device(self, device: Device, trigger_reason: str):
        try:
            mtr_json = await asyncio.get_event_loop().run_in_executor(
                self.executor,
                self.mtr_runner.run_mtr,
                device,
            )
            if mtr_json:
                self.mongodb.insert_mtr_result(
                    device_id=device.id,
                    ip_address=device.ip_address,
                    hostname=device.hostname,
                    mtr_json=mtr_json,
                    trigger_reason=trigger_reason,
                )
                self.pg_state.mark_mtr_run(device.id, datetime.now(timezone.utc))
                logger.info('Stored MTR result for %s (%s) [%s]', device.hostname, device.ip_address, trigger_reason)
            else:
                logger.warning('Failed to get MTR result for %s (%s)', device.hostname, device.ip_address)
        except Exception as e:
            logger.error('Error processing device %s: %s', device.id, e)

    def _publish_job(self, device: Device, trigger_reason: str):
        payload = {
            'device': {
                'id': device.id,
                'ip_address': device.ip_address,
                'hostname': device.hostname,
                'is_active': device.is_active,
                'probe_mode': device.probe_mode,
                'probe_port': device.probe_port,
                'probe_tos': device.probe_tos,
                'mtr_count': device.mtr_count,
                'jitter_threshold_ms': device.jitter_threshold_ms,
            },
            'trigger_reason': trigger_reason,
            'queued_at': datetime.now(timezone.utc).isoformat(),
        }
        self.rabbit.publish_job(payload)

    def poll_once(self):
        logger.info('Starting fping + trigger cycle')
        try:
            devices = self.mysql.fetch_active_devices()
            if not devices:
                logger.warning('No active devices found in MySQL')
                return

            states = self.pg_state.get_states([d.id for d in devices])
            fping_results = self.fping.run_batch(devices)
            now = datetime.now(timezone.utc)

            triggered: List[Tuple[Device, str]] = []
            for device in devices:
                fping_data = fping_results.get(device.ip_address, {})
                current_latency = fping_data.get('avg_latency_ms')
                current_stddev = fping_data.get('stddev_ms')
                samples = fping_data.get('samples_ms') or []
                sample_count = int(fping_data.get('sample_count') or len(samples))
                sent_count = int(fping_data.get('sent_count') or int(os.getenv('FPING_COUNT', '3')))
                loss_pct = float(fping_data.get('loss_pct') if fping_data.get('loss_pct') is not None else (100.0 if sent_count <= 0 else ((sent_count - sample_count) / sent_count) * 100.0))
                alive = bool(fping_data.get('alive'))
                state = states.get(device.id)
                jitter_threshold = device.jitter_threshold_ms if device.jitter_threshold_ms is not None else self.jitter_threshold_ms

                should_trigger, reason, new_baseline, new_consecutive, cooldown_until, jitter = self._evaluate_trigger(
                    state,
                    current_latency,
                    current_stddev,
                    jitter_threshold,
                    now,
                )

                self.pg_state.upsert_state(
                    device_id=device.id,
                    baseline_latency_ms=new_baseline,
                    last_latency_ms=current_latency,
                    last_jitter_ms=jitter,
                    last_fping_at=now,
                    consecutive_jitter_breach=new_consecutive,
                    cooldown_until=cooldown_until,
                )

                if should_trigger:
                    triggered.append((device, reason))

                self.mongodb.upsert_fping_status(
                    device_id=device.id,
                    ip_address=device.ip_address,
                    hostname=device.hostname,
                    alive=alive,
                    avg_latency_ms=current_latency,
                    stddev_ms=current_stddev,
                    sample_count=sample_count,
                    sent_count=sent_count,
                    loss_pct=loss_pct,
                    trigger_reason=reason,
                )

            if self.dispatch_mode == 'rabbitmq-producer':
                for device, reason in triggered:
                    self._publish_job(device, reason)
                logger.info('Triggered %d MTR jobs (published to queue)', len(triggered))
            else:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                tasks = [self.run_mtr_for_device(device, reason) for device, reason in triggered]
                if tasks:
                    loop.run_until_complete(asyncio.gather(*tasks))
                loop.close()
                logger.info('Triggered %d inline MTR jobs', len(triggered))

            self.mongodb.update_poller_heartbeat('running')
        except Exception as e:
            logger.error('Error during polling cycle: %s', e)
            self.mongodb.update_poller_heartbeat('error', str(e))

    def run_worker_loop(self):
        logger.info('Starting RabbitMQ worker loop')
        while self.running:
            try:
                item = self.rabbit.consume_one()
                if not item:
                    self.run_realtime_tick()
                    time.sleep(1)
                    continue

                delivery_tag, payload = item
                raw = payload.get('device', {})
                reason = str(payload.get('trigger_reason', 'queued-trigger'))
                now = datetime.now(timezone.utc)
                device = Device(
                    id=int(raw['id']),
                    ip_address=str(raw['ip_address']),
                    hostname=str(raw.get('hostname', raw['ip_address'])),
                    is_active=bool(raw.get('is_active', True)),
                    probe_mode=str(raw.get('probe_mode', 'icmp')),
                    probe_port=int(raw['probe_port']) if raw.get('probe_port') is not None else None,
                    probe_tos=int(raw['probe_tos']) if raw.get('probe_tos') is not None else None,
                    mtr_count=int(raw.get('mtr_count', 10)),
                    jitter_threshold_ms=float(raw['jitter_threshold_ms']) if raw.get('jitter_threshold_ms') is not None else None,
                    created_at=now,
                    updated_at=now,
                )

                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                loop.run_until_complete(self.run_mtr_for_device(device, reason))
                loop.close()
                self.rabbit.ack(delivery_tag)
                self.run_realtime_tick()
            except Exception as e:
                logger.error('Worker processing error: %s', e)
                try:
                    self.mongodb.update_poller_heartbeat('error', str(e))
                except Exception:
                    pass
                time.sleep(1)

    def _run_fping_for_device(self, device: Device, source: str):
        result = self.fping.run_batch([device]).get(device.ip_address, {})
        current_latency = result.get('avg_latency_ms')
        current_stddev = result.get('stddev_ms')
        samples = result.get('samples_ms') or []
        sample_count = int(result.get('sample_count') or len(samples))
        sent_count = int(result.get('sent_count') or int(os.getenv('FPING_COUNT', '3')))
        loss_pct = float(result.get('loss_pct') if result.get('loss_pct') is not None else (100.0 if sent_count <= 0 else ((sent_count - sample_count) / sent_count) * 100.0))
        alive = bool(result.get('alive'))

        self.mongodb.insert_realtime_fping_result(
            device_id=device.id,
            ip_address=device.ip_address,
            hostname=device.hostname,
            alive=alive,
            avg_latency_ms=current_latency,
            stddev_ms=current_stddev,
            sample_count=sample_count,
            sent_count=sent_count,
            loss_pct=loss_pct,
            source=source,
        )
        self.mongodb.upsert_fping_status(
            device_id=device.id,
            ip_address=device.ip_address,
            hostname=device.hostname,
            alive=alive,
            avg_latency_ms=current_latency,
            stddev_ms=current_stddev,
            sample_count=sample_count,
            sent_count=sent_count,
            loss_pct=loss_pct,
            trigger_reason=source,
        )

    def process_probe_requests(self, device_map: Dict[int, Device]):
        requests = self.mongodb.get_pending_probe_requests(limit=10)
        for request in requests:
            request_id = request.get('_id')
            if request_id is None or not self.mongodb.claim_probe_request(request_id):
                continue

            try:
                device_id = int(request.get('device_id'))
                mode = str(request.get('mode', 'fping')).strip().lower()
                device = device_map.get(device_id)
                if not device:
                    self.mongodb.complete_probe_request(request_id, False, 'Device is not active')
                    continue

                if mode == 'fping':
                    self._run_fping_for_device(device, source='manual-probe')
                    self.mongodb.complete_probe_request(request_id, True, 'fping probe completed')
                elif mode == 'mtr':
                    mtr_json = self.mtr_runner.run_mtr(device)
                    if not mtr_json:
                        self.mongodb.complete_probe_request(request_id, False, 'mtr probe failed')
                        continue
                    self.mongodb.insert_mtr_result(
                        device_id=device.id,
                        ip_address=device.ip_address,
                        hostname=device.hostname,
                        mtr_json=mtr_json,
                        trigger_reason='manual-probe',
                    )
                    self.pg_state.mark_mtr_run(device.id, datetime.now(timezone.utc))
                    self.mongodb.complete_probe_request(request_id, True, 'mtr probe completed')
                else:
                    self.mongodb.complete_probe_request(request_id, False, f'Unsupported mode: {mode}')
            except Exception as e:
                logger.error('Manual probe request failed: %s', e)
                self.mongodb.complete_probe_request(request_id, False, str(e))

    def process_realtime_sessions(self, device_map: Dict[int, Device]):
        now = datetime.now(timezone.utc)
        self.mongodb.expire_realtime_sessions(now)
        sessions = self.mongodb.get_active_realtime_sessions(now, self.realtime_max_sessions)

        for session in sessions:
            try:
                device_id = int(session.get('device_id'))
                device = device_map.get(device_id)
                if not device:
                    self.mongodb.update_realtime_session(device_id, {
                        'active': False,
                        'stop_reason': 'device-inactive',
                        'ended_at': datetime.now(timezone.utc),
                    })
                    continue

                interval_sec = int(session.get('interval_sec') or 5)
                interval_sec = max(3, min(interval_sec, 60))
                last_run_at = session.get('last_run_at')
                if isinstance(last_run_at, datetime):
                    last_run_normalized = last_run_at if last_run_at.tzinfo else last_run_at.replace(tzinfo=timezone.utc)
                    if (now - last_run_normalized).total_seconds() < interval_sec:
                        continue

                self._run_fping_for_device(device, source='realtime-session')
                self.mongodb.update_realtime_session(device_id, {
                    'last_run_at': datetime.now(timezone.utc),
                    'last_error': None,
                })
            except Exception as e:
                logger.error('Realtime polling failed: %s', e)
                try:
                    self.mongodb.update_realtime_session(int(session.get('device_id')), {'last_error': str(e)})
                except Exception:
                    pass

    def run_realtime_tick(self):
        try:
            now_ts = time.time()
            if now_ts >= self.realtime_next_device_refresh:
                devices = self.mysql.fetch_active_devices()
                self.realtime_device_map = {d.id: d for d in devices}
                self.realtime_next_device_refresh = now_ts + 15

            self.process_probe_requests(self.realtime_device_map)
            self.process_realtime_sessions(self.realtime_device_map)
        except Exception as e:
            logger.error('Realtime tick error: %s', e)

    def cleanup_deleted_devices(self):
        logger.info('Running cleanup for deleted devices')
        try:
            deleted_ids = self.mysql.get_deleted_device_ids(list(self.known_device_ids))
            for device_id in deleted_ids:
                self.mongodb.delete_device_data(device_id)
                self.known_device_ids.discard(device_id)
        except Exception as e:
            logger.error('Error during cleanup: %s', e)


def main():
    poller = MTRPoller()
    try:
        poller.start()
    except KeyboardInterrupt:
        logger.info('Keyboard interrupt received')
    except StartupValidationError as e:
        logger.error('Startup validation failed: %s', e)
    except Exception as e:
        logger.error('Fatal error: %s', e)
    finally:
        poller.stop()


if __name__ == '__main__':
    main()
