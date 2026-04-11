import { NextRequest, NextResponse } from 'next/server';
import mysql from 'mysql2/promise';
import { MongoClient, ObjectId } from 'mongodb';
import { enforceSecurity, internalApiError } from '@/lib/security';

type ProbeMode = 'fping' | 'mtr';

const mysqlConfig = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'mtr_dashboard',
};

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const mongoDb = process.env.MONGODB_DATABASE || 'mtr_metrics';
const probeRequestCollection = process.env.MONGODB_PROBE_REQUEST_COLLECTION || 'probe_requests';

function normalizeMode(value: unknown): ProbeMode | null {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'fping' || mode === 'mtr') return mode;
  return null;
}

export async function GET(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'mtr-probe-get',
    allowedRoles: ['operator'],
    rateLimit: { limit: 60, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get('requestId');
  if (!requestId) {
    return NextResponse.json({ success: false, error: 'requestId is required' }, { status: 400 });
  }
  if (!ObjectId.isValid(requestId)) {
    return NextResponse.json({ success: false, error: 'requestId is invalid' }, { status: 400 });
  }

  const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  try {
    await mongo.connect();
    const collection = mongo.db(mongoDb).collection(probeRequestCollection);
    const doc = await collection.findOne(
      { _id: new ObjectId(requestId) },
      { projection: { device_id: 1, mode: 1, status: 1, requested_at: 1, started_at: 1, completed_at: 1, result_message: 1 } }
    );

    if (!doc) {
      return NextResponse.json({ success: false, error: 'Probe request not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: doc });
  } catch (error: unknown) {
    return internalApiError('Failed to fetch probe request', error);
  } finally {
    await mongo.close();
  }
}

export async function POST(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'mtr-probe-post',
    allowedRoles: ['operator'],
    rateLimit: { limit: 25, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  let mysqlConn: mysql.Connection | null = null;
  const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });

  try {
    const body = await request.json();
    const deviceId = Number(body?.deviceId);
    const mode = normalizeMode(body?.mode);

    if (!Number.isInteger(deviceId) || deviceId <= 0) {
      return NextResponse.json({ success: false, error: 'deviceId must be a positive integer' }, { status: 400 });
    }

    if (!mode) {
      return NextResponse.json({ success: false, error: 'mode must be fping or mtr' }, { status: 400 });
    }

    mysqlConn = await mysql.createConnection(mysqlConfig);
    const [rows] = await mysqlConn.execute(
      'SELECT id, hostname, ip_address FROM devices WHERE id = ? AND is_active = TRUE LIMIT 1',
      [deviceId]
    );

    const devices = Array.isArray(rows) ? rows as Array<{ id: number; hostname: string; ip_address: string }> : [];
    if (!devices.length) {
      return NextResponse.json({ success: false, error: 'Active device not found' }, { status: 404 });
    }

    await mongo.connect();
    const collection = mongo.db(mongoDb).collection(probeRequestCollection);

    const now = new Date();
    const inserted = await collection.insertOne({
      device_id: deviceId,
      mode,
      status: 'pending',
      requested_at: now,
      updated_at: now,
    });

    return NextResponse.json({
      success: true,
      data: {
        requestId: inserted.insertedId.toString(),
        status: 'pending',
        deviceId,
        mode,
      },
    });
  } catch (error: unknown) {
    return internalApiError('Failed to queue probe request', error);
  } finally {
    if (mysqlConn) await mysqlConn.end();
    await mongo.close();
  }
}
