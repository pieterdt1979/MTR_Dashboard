import { NextRequest, NextResponse } from 'next/server';
import mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';
import { enforceSecurity, internalApiError } from '@/lib/security';

type RealtimeMode = 'fping';

const mysqlConfig = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'mtr_dashboard',
};

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const mongoDb = process.env.MONGODB_DATABASE || 'mtr_metrics';
const realtimeSessionCollection = process.env.MONGODB_REALTIME_SESSION_COLLECTION || 'realtime_probe_sessions';
const realtimeMaxSessions = parseInt(process.env.REALTIME_MAX_ACTIVE_SESSIONS || '5', 10);

function parseMode(value: unknown): RealtimeMode | null {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'fping') return mode;
  return null;
}

export async function GET(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'mtr-realtime-get',
    allowedRoles: ['operator'],
    rateLimit: { limit: 90, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  const { searchParams } = new URL(request.url);
  const deviceId = Number(searchParams.get('deviceId'));

  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return NextResponse.json({ success: false, error: 'deviceId must be a positive integer' }, { status: 400 });
  }

  const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  try {
    await mongo.connect();
    const session = await mongo.db(mongoDb).collection(realtimeSessionCollection).findOne(
      { device_id: deviceId },
      {
        projection: {
          _id: 0,
          device_id: 1,
          active: 1,
          mode: 1,
          interval_sec: 1,
          duration_minutes: 1,
          started_at: 1,
          end_at: 1,
          last_run_at: 1,
          stop_reason: 1,
          last_error: 1,
        },
      }
    );

    return NextResponse.json({
      success: true,
      data: session || {
        device_id: deviceId,
        active: false,
        mode: 'fping',
        interval_sec: 5,
        duration_minutes: 15,
        started_at: null,
        end_at: null,
        last_run_at: null,
        stop_reason: null,
        last_error: null,
      },
    });
  } catch (error: unknown) {
    return internalApiError('Failed to fetch realtime session', error);
  } finally {
    await mongo.close();
  }
}

export async function POST(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'mtr-realtime-post',
    allowedRoles: ['operator'],
    rateLimit: { limit: 20, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  let mysqlConn: mysql.Connection | null = null;
  const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });

  try {
    const body = await request.json();
    const deviceId = Number(body?.deviceId);
    const action = String(body?.action || '').trim().toLowerCase();

    if (!Number.isInteger(deviceId) || deviceId <= 0) {
      return NextResponse.json({ success: false, error: 'deviceId must be a positive integer' }, { status: 400 });
    }

    mysqlConn = await mysql.createConnection(mysqlConfig);
    const [rows] = await mysqlConn.execute('SELECT id FROM devices WHERE id = ? AND is_active = TRUE LIMIT 1', [deviceId]);
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Active device not found' }, { status: 404 });
    }

    await mongo.connect();
    const collection = mongo.db(mongoDb).collection(realtimeSessionCollection);

    if (action === 'stop') {
      const now = new Date();
      await collection.updateOne(
        { device_id: deviceId },
        {
          $set: {
            active: false,
            stop_reason: 'manual-stop',
            ended_at: now,
            updated_at: now,
          },
        },
        { upsert: true }
      );

      return NextResponse.json({ success: true, data: { deviceId, active: false } });
    }

    if (action !== 'start') {
      return NextResponse.json({ success: false, error: 'action must be start or stop' }, { status: 400 });
    }

    const mode = parseMode(body?.mode);
    const intervalSec = Math.max(3, Math.min(Number(body?.intervalSec || 5), 30));
    const durationMinutes = Math.max(1, Math.min(Number(body?.durationMinutes || 15), 60));

    if (!mode) {
      return NextResponse.json({ success: false, error: 'safe realtime mode currently supports fping only' }, { status: 400 });
    }

    const activeCount = await collection.countDocuments({ active: true, end_at: { $gt: new Date() } });
    if (activeCount >= realtimeMaxSessions) {
      return NextResponse.json(
        { success: false, error: `Active realtime session cap reached (${realtimeMaxSessions})` },
        { status: 429 }
      );
    }

    const now = new Date();
    const endAt = new Date(now.getTime() + durationMinutes * 60 * 1000);

    await collection.updateOne(
      { device_id: deviceId },
      {
        $set: {
          device_id: deviceId,
          active: true,
          mode,
          interval_sec: intervalSec,
          duration_minutes: durationMinutes,
          started_at: now,
          end_at: endAt,
          last_run_at: null,
          last_error: null,
          ended_at: null,
          stop_reason: null,
          updated_at: now,
        },
      },
      { upsert: true }
    );

    return NextResponse.json({
      success: true,
      data: {
        deviceId,
        active: true,
        mode,
        intervalSec,
        durationMinutes,
        endAt: endAt.toISOString(),
      },
    });
  } catch (error: unknown) {
    return internalApiError('Failed to update realtime session', error);
  } finally {
    if (mysqlConn) await mysqlConn.end();
    await mongo.close();
  }
}
