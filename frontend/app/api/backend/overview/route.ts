import { NextRequest, NextResponse } from 'next/server';
import mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';
import net from 'net';
import { enforceSecurity } from '@/lib/security';

type ServiceStatus = {
  ok: boolean;
  message?: string;
  latencyMs?: number;
};

type StackItem = {
  name: string;
  component: string;
  purpose: string;
  version: string;
};

const mysqlConfig = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'mtr_dashboard',
};

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const mongoDb = process.env.MONGODB_DATABASE || 'mtr_metrics';
const statusCollection = process.env.MONGODB_STATUS_COLLECTION || 'service_status';
const pollingIntervalMinutes = parseInt(process.env.POLLING_INTERVAL_MINUTES || '5', 10);

const postgresHost = process.env.POSTGRES_HOST || 'localhost';
const postgresPort = parseInt(process.env.POSTGRES_PORT || '5432', 10);
const rabbitHost = process.env.RABBITMQ_HOST || 'localhost';
const rabbitPort = parseInt(process.env.RABBITMQ_PORT || '5672', 10);

function checkTcp(host: string, port: number, timeoutMs = 2500): Promise<ServiceStatus> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();

    const done = (status: ServiceStatus) => {
      socket.destroy();
      resolve(status);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ ok: true, latencyMs: Date.now() - start }));
    socket.once('timeout', () => done({ ok: false, message: 'TCP health check timeout', latencyMs: Date.now() - start }));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      console.error('[overview] TCP check failed', error);
      done({ ok: false, message: 'TCP health check failed', latencyMs: Date.now() - start });
    });

    socket.connect(port, host);
  });
}

async function checkMySQL(): Promise<ServiceStatus> {
  const start = Date.now();
  let connection: mysql.Connection | null = null;

  try {
    connection = await mysql.createConnection(mysqlConfig);
    await connection.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (error: unknown) {
    console.error('[overview] MySQL check failed', error);
    const message = 'MySQL check failed';
    return { ok: false, message, latencyMs: Date.now() - start };
  } finally {
    if (connection) await connection.end();
  }
}

async function checkMongo(): Promise<ServiceStatus> {
  const start = Date.now();
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000 });

  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return { ok: true, latencyMs: Date.now() - start };
  } catch (error: unknown) {
    console.error('[overview] MongoDB check failed', error);
    const message = 'MongoDB check failed';
    return { ok: false, message, latencyMs: Date.now() - start };
  } finally {
    await client.close();
  }
}

async function checkPoller(): Promise<ServiceStatus> {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    type PollerHeartbeatDoc = {
      _id: string;
      state?: string;
      heartbeat_at?: Date | string;
      last_error?: string;
    };

    const doc = await client
      .db(mongoDb)
      .collection<PollerHeartbeatDoc>(statusCollection)
      .findOne({ _id: 'mtr_poller' });

    if (!doc || !doc.heartbeat_at) {
      return { ok: false, message: 'No poller heartbeat found yet' };
    }

    const heartbeat = new Date(doc.heartbeat_at);
    if (Number.isNaN(heartbeat.getTime())) {
      return { ok: false, message: 'Invalid poller heartbeat timestamp' };
    }

    const ageSeconds = Math.floor((Date.now() - heartbeat.getTime()) / 1000);
    const staleAfterSeconds = Math.max(pollingIntervalMinutes * 60 * 2 + 30, 90);
    const isRunning = (doc.state || '').toLowerCase() === 'running' && ageSeconds <= staleAfterSeconds;

    if (isRunning) {
      return { ok: true, message: `Heartbeat ${ageSeconds}s ago` };
    }

    const state = doc.state || 'unknown';
    const extra = doc.last_error ? ` (${doc.last_error})` : '';
    return { ok: false, message: `Poller state=${state}, heartbeat age=${ageSeconds}s${extra}` };
  } catch (error: unknown) {
    console.error('[overview] Poller check failed', error);
    const message = 'Poller status check failed';
    return { ok: false, message };
  } finally {
    await client.close();
  }
}

const stack: StackItem[] = [
  { name: 'Python 3.13', component: 'Poller Runtime', purpose: 'Runs fping + MTR orchestration loop', version: '3.13.x' },
  { name: 'MySQL 9.2', component: 'Inventory DB', purpose: 'Stores devices and poll job metadata', version: '9.2.x' },
  { name: 'MongoDB 8', component: 'Metrics DB', purpose: 'Stores fping/MTR telemetry and health docs', version: '8.x' },
  { name: 'PostgreSQL 16', component: 'Trigger State DB', purpose: 'Stores per-device baseline and cooldown state', version: '16.x' },
  { name: 'RabbitMQ 3.13', component: 'Dispatch Queue', purpose: 'Optional queue for producer/worker MTR dispatch', version: '3.13.x' },
  { name: 'fping + mtr', component: 'Probe Tools', purpose: 'Network reachability and path diagnostics', version: 'System package' },
];

export async function GET(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'backend-overview-get',
    allowedRoles: ['admin'],
    rateLimit: { limit: 30, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  const [mysqlStatus, mongoStatus, pollerStatus, postgresStatus, rabbitStatus] = await Promise.all([
    checkMySQL(),
    checkMongo(),
    checkPoller(),
    checkTcp(postgresHost, postgresPort),
    checkTcp(rabbitHost, rabbitPort),
  ]);

  const services = {
    mysql: mysqlStatus,
    mongodb: mongoStatus,
    poller: pollerStatus,
    postgres: postgresStatus,
    rabbitmq: rabbitStatus,
  };

  const allHealthy = Object.values(services).every((s) => s.ok);

  return NextResponse.json(
    {
      success: allHealthy,
      data: {
        stack,
        services,
        checkedAt: new Date().toISOString(),
      },
      error: allHealthy ? undefined : 'One or more backend services are unavailable',
    },
    { status: allHealthy ? 200 : 503 }
  );
}
