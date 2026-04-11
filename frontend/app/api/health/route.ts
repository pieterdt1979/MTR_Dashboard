import { NextRequest, NextResponse } from 'next/server';
import mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';
import { enforceSecurity } from '@/lib/security';

type ServiceStatus = {
  ok: boolean;
  message?: string;
  latencyMs?: number;
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

async function checkMySQL(): Promise<ServiceStatus> {
  const start = Date.now();
  let connection: mysql.Connection | null = null;

  try {
    connection = await mysql.createConnection(mysqlConfig);
    await connection.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (error: unknown) {
    console.error('[health] MySQL check failed', error);
    const message = 'MySQL check failed';
    return { ok: false, message, latencyMs: Date.now() - start };
  } finally {
    if (connection) {
      await connection.end();
    }
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
    console.error('[health] MongoDB check failed', error);
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
    return {
      ok: false,
      message: `Poller state=${state}, heartbeat age=${ageSeconds}s${extra}`,
    };
  } catch (error: unknown) {
    console.error('[health] Poller check failed', error);
    const message = 'Poller status check failed';
    return { ok: false, message };
  } finally {
    await client.close();
  }
}

export async function GET(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'health-get',
    allowedRoles: ['viewer'],
    rateLimit: { limit: 60, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  const [mysqlStatus, mongoStatus, pollerStatus] = await Promise.all([
    checkMySQL(),
    checkMongo(),
    checkPoller(),
  ]);
  const allHealthy = mysqlStatus.ok && mongoStatus.ok && pollerStatus.ok;

  return NextResponse.json(
    {
      success: allHealthy,
      data: {
        mysql: mysqlStatus,
        mongodb: mongoStatus,
        poller: pollerStatus,
        checkedAt: new Date().toISOString(),
      },
      error: allHealthy ? undefined : 'One or more services are unavailable',
    },
    { status: allHealthy ? 200 : 503 }
  );
}
