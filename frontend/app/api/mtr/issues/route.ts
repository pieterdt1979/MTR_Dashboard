import { NextRequest, NextResponse } from 'next/server';
import mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';
import { enforceSecurity, internalApiError } from '@/lib/security';

type Severity = 'healthy' | 'warning' | 'critical';
type HostState = 'healthy' | 'warning' | 'critical' | 'down' | 'route-changed';

type DeviceRow = {
  id: number;
  ip_address: string;
  hostname: string;
  is_active: number | boolean;
};

type FpingStatusDoc = {
  device_id: number;
  timestamp?: Date;
  alive?: boolean;
  avg_latency_ms?: number;
  stddev_ms?: number;
  sample_count?: number;
  sent_count?: number;
  loss_pct?: number;
};

type IssueRow = {
  deviceId: number;
  hostname: string;
  ipAddress: string;
  state: HostState;
  severity: Severity;
  reasons: string[];
  routeChanged: boolean;
  lastUpdate: string | null;
  ageSeconds: number | null;
  destinationLatencyMs: number;
  destinationLossPct: number;
  hopCount: number;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  snoozedUntil: string | null;
  snoozed: boolean;
  muted: boolean;
};

type IncidentControlDoc = {
  _id: string;
  deviceId: number;
  acknowledged?: boolean;
  acknowledgedAt?: Date;
  snoozedUntil?: Date;
  updatedAt?: Date;
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
const mongoCollection = process.env.MONGODB_COLLECTION || 'mtr_results';
const mongoFpingCollection = process.env.MONGODB_FPING_COLLECTION || 'fping_status';
const incidentCollection = process.env.MONGODB_INCIDENT_COLLECTION || 'noc_incidents';

const pollingIntervalMinutes = parseInt(process.env.POLLING_INTERVAL_MINUTES || '5', 10);
const staleAfterSeconds = pollingIntervalMinutes * 60 * 2 + 30;
const latencyWarningMs = parseFloat(process.env.DEST_LATENCY_WARNING_MS || '60');
const latencyCriticalMs = parseFloat(process.env.DEST_LATENCY_CRITICAL_MS || '120');
const lossWarningPct = parseFloat(process.env.DEST_LOSS_WARNING_PCT || '5');
const lossCriticalPct = parseFloat(process.env.DEST_LOSS_CRITICAL_PCT || '20');

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractHubs(mtrResult: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(mtrResult.hubs)) {
    return mtrResult.hubs.filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null);
  }

  const report =
    typeof mtrResult.report === 'object' && mtrResult.report !== null
      ? (mtrResult.report as Record<string, unknown>)
      : null;

  if (report && Array.isArray(report.hubs)) {
    return report.hubs.filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null);
  }

  return [];
}

function computeRouteSignature(hubs: Record<string, unknown>[]): string {
  return hubs.map((hub) => String(hub.host ?? hub.hostname ?? '?')).join(' > ');
}

function computeDestinationMetrics(hubs: Record<string, unknown>[]): {
  destinationLatencyMs: number;
  destinationLossPct: number;
  hopCount: number;
} {
  if (!hubs.length) {
    return { destinationLatencyMs: 0, destinationLossPct: 0, hopCount: 0 };
  }

  const last = hubs[hubs.length - 1];
  const destinationLatencyMs = toNumber(last.Avg ?? last.avg ?? last.Last ?? last.last) ?? 0;
  const destinationLossPct = toNumber(last['Loss%'] ?? last.Loss ?? last.loss) ?? 0;

  return { destinationLatencyMs, destinationLossPct, hopCount: hubs.length };
}

function rankSeverity(severity: Severity): number {
  if (severity === 'critical') return 3;
  if (severity === 'warning') return 2;
  return 1;
}

function classifyStatus(input: {
  mtrAgeSeconds: number | null;
  fpingAgeSeconds: number | null;
  fpingAlive: boolean;
  fpingLossPct: number;
  hasFpingData: boolean;
  destinationLatencyMs: number;
  destinationLossPct: number;
  routeChanged: boolean;
  hasMtrData: boolean;
}): { state: HostState; severity: Severity; reasons: string[] } {
  const reasons: string[] = [];
  let state: HostState = 'healthy';
  let severity: Severity = 'healthy';
  const hasHealthyMtrSnapshot = input.hasMtrData && input.destinationLossPct < lossCriticalPct;
  const hasRecentHealthyMtr =
    hasHealthyMtrSnapshot &&
    input.mtrAgeSeconds !== null &&
    input.mtrAgeSeconds <= staleAfterSeconds;

  if (!input.hasFpingData || input.fpingAgeSeconds === null || input.fpingAgeSeconds > staleAfterSeconds) {
    reasons.push('No recent fping telemetry');
    return { state: 'down', severity: 'critical', reasons };
  }

  if (!input.fpingAlive) {
    if (hasRecentHealthyMtr) {
      reasons.push('fping sweep reports host unreachable, but recent MTR still indicates path health');
      return { state: 'warning', severity: 'warning', reasons };
    }
    if (hasHealthyMtrSnapshot) {
      reasons.push('fping sweep reports host unreachable; latest MTR snapshot is healthy (likely ICMP-filtered destination)');
      return { state: 'warning', severity: 'warning', reasons };
    }
    reasons.push('fping sweep reports host unreachable');
    return { state: 'down', severity: 'critical', reasons };
  }

  if (input.fpingLossPct >= lossCriticalPct) {
    reasons.push(`fping loss ${input.fpingLossPct.toFixed(1)}% >= ${lossCriticalPct}%`);
    state = 'critical';
    severity = 'critical';
  } else if (input.fpingLossPct >= lossWarningPct) {
    reasons.push(`fping loss ${input.fpingLossPct.toFixed(1)}% >= ${lossWarningPct}%`);
    state = 'warning';
    severity = 'warning';
  }

  if (!input.hasMtrData || input.mtrAgeSeconds === null || input.mtrAgeSeconds > staleAfterSeconds) {
    if (reasons.length) {
      reasons.push('MTR snapshot stale or unavailable; classification driven by fping telemetry');
      return { state, severity, reasons };
    }
    reasons.push('Host reachable via fping, awaiting next MTR trigger window');
    return { state: 'healthy', severity: 'healthy', reasons };
  }

  if (input.destinationLossPct >= lossCriticalPct) {
    reasons.push(`Destination loss ${input.destinationLossPct.toFixed(1)}% >= ${lossCriticalPct}%`);
    state = 'critical';
    severity = 'critical';
  } else if (input.destinationLossPct >= lossWarningPct) {
    reasons.push(`Destination loss ${input.destinationLossPct.toFixed(1)}% >= ${lossWarningPct}%`);
    state = 'warning';
    severity = 'warning';
  }

  if (input.destinationLatencyMs >= latencyCriticalMs) {
    reasons.push(`Destination latency ${input.destinationLatencyMs.toFixed(1)}ms >= ${latencyCriticalMs}ms`);
    state = 'critical';
    severity = 'critical';
  } else if (input.destinationLatencyMs >= latencyWarningMs && severity !== 'critical') {
    reasons.push(`Destination latency ${input.destinationLatencyMs.toFixed(1)}ms >= ${latencyWarningMs}ms`);
    state = 'warning';
    severity = 'warning';
  }

  if (input.routeChanged && severity === 'healthy') {
    reasons.push('Route signature changed since previous poll');
    state = 'route-changed';
    severity = 'warning';
  } else if (input.routeChanged) {
    reasons.push('Route signature changed since previous poll');
  }

  if (!reasons.length) {
    reasons.push('No active issues');
  }

  return { state, severity, reasons };
}

export async function GET(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'mtr-issues-get',
    allowedRoles: ['viewer'],
    rateLimit: { limit: 100, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  const { searchParams } = new URL(request.url);
  const includeHealthy = searchParams.get('includeHealthy') === 'true';
  const includeMuted = searchParams.get('includeMuted') === 'true';

  let mysqlConn: mysql.Connection | null = null;
  const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });

  try {
    mysqlConn = await mysql.createConnection(mysqlConfig);
    await mongo.connect();

    const [deviceRows] = await mysqlConn.execute(
      'SELECT id, ip_address, hostname, is_active FROM devices WHERE is_active = TRUE ORDER BY hostname ASC'
    );
    const devices = (Array.isArray(deviceRows) ? deviceRows : []) as DeviceRow[];

    const deviceIds = devices.map((d) => d.id);
    if (!deviceIds.length) {
      return NextResponse.json({
        success: true,
        data: {
          issues: [],
          counts: { total: 0, healthy: 0, warning: 0, critical: 0, down: 0, routeChanged: 0 },
          generatedAt: new Date().toISOString(),
        },
      });
    }

    const recentDocs = await mongo
      .db(mongoDb)
      .collection(mongoCollection)
      .find(
        { device_id: { $in: deviceIds } },
        { projection: { device_id: 1, timestamp: 1, mtr_result: 1 } }
      )
      .sort({ timestamp: -1 })
      .limit(Math.max(deviceIds.length * 6, 60))
      .toArray();

    const fpingDocs = await mongo
      .db(mongoDb)
      .collection<FpingStatusDoc>(mongoFpingCollection)
      .find(
        { device_id: { $in: deviceIds } },
        { projection: { device_id: 1, timestamp: 1, alive: 1, avg_latency_ms: 1, stddev_ms: 1, sample_count: 1, sent_count: 1, loss_pct: 1 } }
      )
      .toArray();
    const fpingByDevice = new Map<number, FpingStatusDoc>();
    for (const doc of fpingDocs) {
      const id = toNumber(doc.device_id);
      if (id === null) continue;
      fpingByDevice.set(id, doc);
    }

    const controlDocs = await mongo
      .db(mongoDb)
      .collection<IncidentControlDoc>(incidentCollection)
      .find({ deviceId: { $in: deviceIds } })
      .toArray();
    const controlsByDevice = new Map<number, IncidentControlDoc>();
    for (const doc of controlDocs) {
      controlsByDevice.set(doc.deviceId, doc);
    }

    const latestByDevice = new Map<number, Array<Record<string, unknown>>>();
    for (const doc of recentDocs) {
      const id = toNumber(doc.device_id);
      if (id === null) continue;
      const list = latestByDevice.get(id) || [];
      if (list.length >= 2) continue;
      list.push(doc as unknown as Record<string, unknown>);
      latestByDevice.set(id, list);
    }

    const issues: IssueRow[] = devices.map((device) => {
      const records = latestByDevice.get(device.id) || [];
      const latest = records[0];
      const previous = records[1];

      const latestMtr =
        latest && typeof latest.mtr_result === 'object' && latest.mtr_result !== null
          ? (latest.mtr_result as Record<string, unknown>)
          : null;
      const previousMtr =
        previous && typeof previous.mtr_result === 'object' && previous.mtr_result !== null
          ? (previous.mtr_result as Record<string, unknown>)
          : null;

      const latestHubs = latestMtr ? extractHubs(latestMtr) : [];
      const previousHubs = previousMtr ? extractHubs(previousMtr) : [];

      const latestSig = computeRouteSignature(latestHubs);
      const previousSig = computeRouteSignature(previousHubs);
      const routeChanged = !!latestSig && !!previousSig && latestSig !== previousSig;

      const metrics = computeDestinationMetrics(latestHubs);
      const latestTimestamp = latest?.timestamp instanceof Date ? latest.timestamp : null;
      const mtrAgeSeconds = latestTimestamp ? Math.floor((Date.now() - latestTimestamp.getTime()) / 1000) : null;

      const fpingDoc = fpingByDevice.get(device.id);
      const fpingTimestamp = fpingDoc?.timestamp instanceof Date ? fpingDoc.timestamp : null;
      const fpingAgeSeconds = fpingTimestamp
        ? Math.floor((Date.now() - fpingTimestamp.getTime()) / 1000)
        : null;
      const fpingAlive = fpingDoc?.alive !== false;
      const fpingLatency = toNumber(fpingDoc?.avg_latency_ms);
      const fpingSampleCount = toNumber(fpingDoc?.sample_count) ?? 0;
      const fpingSentCount = toNumber(fpingDoc?.sent_count) ?? parseInt(process.env.FPING_COUNT || '3', 10);
      const fpingLossPct =
        toNumber(fpingDoc?.loss_pct) ??
        (fpingSentCount > 0
          ? Math.max(0, Math.min(100, ((fpingSentCount - fpingSampleCount) / fpingSentCount) * 100))
          : (fpingAlive ? 0 : 100));

      const status = classifyStatus({
        mtrAgeSeconds,
        fpingAgeSeconds,
        fpingAlive,
        fpingLossPct,
        hasFpingData: !!fpingDoc,
        destinationLatencyMs: latestHubs.length ? metrics.destinationLatencyMs : (fpingLatency ?? 0),
        destinationLossPct: latestHubs.length ? metrics.destinationLossPct : fpingLossPct,
        routeChanged,
        hasMtrData: !!latest,
      });

      const displayLatency = latestHubs.length ? metrics.destinationLatencyMs : (fpingLatency ?? 0);
      const displayLoss = latestHubs.length ? metrics.destinationLossPct : fpingLossPct;
      const displayHops = latestHubs.length ? metrics.hopCount : 0;

      const lastUpdateIso =
        latestTimestamp && fpingTimestamp
          ? (latestTimestamp.getTime() > fpingTimestamp.getTime() ? latestTimestamp.toISOString() : fpingTimestamp.toISOString())
          : latestTimestamp
            ? latestTimestamp.toISOString()
            : fpingTimestamp
              ? fpingTimestamp.toISOString()
              : null;

      const control = controlsByDevice.get(device.id);
      const snoozedUntil = control?.snoozedUntil instanceof Date ? control.snoozedUntil : null;
      const snoozed = !!snoozedUntil && snoozedUntil.getTime() > Date.now();
      const acknowledged = !!control?.acknowledged;
      const muted = snoozed || acknowledged;

      return {
        deviceId: device.id,
        hostname: device.hostname,
        ipAddress: device.ip_address,
        state: status.state,
        severity: status.severity,
        reasons: status.reasons,
        routeChanged,
        lastUpdate: lastUpdateIso,
        ageSeconds: fpingAgeSeconds,
        destinationLatencyMs: Number(displayLatency.toFixed(2)),
        destinationLossPct: Number(displayLoss.toFixed(2)),
        hopCount: displayHops,
        acknowledged,
        acknowledgedAt:
          control?.acknowledgedAt instanceof Date ? control.acknowledgedAt.toISOString() : null,
        snoozedUntil: snoozedUntil ? snoozedUntil.toISOString() : null,
        snoozed,
        muted,
      };
    });

    const filtered = issues.filter((i) => {
      if (!includeHealthy && i.severity === 'healthy') return false;
      if (!includeMuted && i.muted) return false;
      return true;
    });
    filtered.sort((a, b) => {
      const sevDiff = rankSeverity(b.severity) - rankSeverity(a.severity);
      if (sevDiff !== 0) return sevDiff;
      const ageA = a.ageSeconds ?? Number.MAX_SAFE_INTEGER;
      const ageB = b.ageSeconds ?? Number.MAX_SAFE_INTEGER;
      return ageA - ageB;
    });

    const counts = {
      total: issues.length,
      healthy: issues.filter((i) => i.severity === 'healthy').length,
      warning: issues.filter((i) => i.severity === 'warning').length,
      critical: issues.filter((i) => i.severity === 'critical').length,
      down: issues.filter((i) => i.state === 'down').length,
      routeChanged: issues.filter((i) => i.routeChanged).length,
      acknowledged: issues.filter((i) => i.acknowledged).length,
      snoozed: issues.filter((i) => i.snoozed).length,
      muted: issues.filter((i) => i.muted).length,
    };

    return NextResponse.json({
      success: true,
      data: {
        issues: filtered,
        counts,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error: unknown) {
    return internalApiError('Failed to build issues view', error);
  } finally {
    if (mysqlConn) await mysqlConn.end();
    await mongo.close();
  }
}

export async function POST(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'mtr-issues-post',
    allowedRoles: ['operator'],
    rateLimit: { limit: 40, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  try {
    const body = await request.json();
    const deviceId = Number(body?.deviceId);
    const action = String(body?.action || '');
    const durationMinutes = Number(body?.durationMinutes || 30);

    if (!Number.isInteger(deviceId) || deviceId <= 0) {
      return NextResponse.json({ success: false, error: 'deviceId must be a positive integer' }, { status: 400 });
    }

    if (!['ack', 'unack', 'snooze', 'unsnooze'].includes(action)) {
      return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
    }

    await mongo.connect();
    const collection = mongo.db(mongoDb).collection<IncidentControlDoc>(incidentCollection);
    const now = new Date();

    if (action === 'ack') {
      await collection.updateOne(
        { _id: `device:${deviceId}` },
        {
          $set: {
            deviceId,
            acknowledged: true,
            acknowledgedAt: now,
            updatedAt: now,
          },
        },
        { upsert: true }
      );
    }

    if (action === 'unack') {
      await collection.updateOne(
        { _id: `device:${deviceId}` },
        {
          $set: { deviceId, acknowledged: false, updatedAt: now },
          $unset: { acknowledgedAt: '' },
        },
        { upsert: true }
      );
    }

    if (action === 'snooze') {
      const minutes = Number.isFinite(durationMinutes) ? Math.max(5, Math.min(durationMinutes, 1440)) : 30;
      const until = new Date(Date.now() + minutes * 60 * 1000);
      await collection.updateOne(
        { _id: `device:${deviceId}` },
        {
          $set: {
            deviceId,
            snoozedUntil: until,
            updatedAt: now,
          },
        },
        { upsert: true }
      );
    }

    if (action === 'unsnooze') {
      await collection.updateOne(
        { _id: `device:${deviceId}` },
        {
          $set: { deviceId, updatedAt: now },
          $unset: { snoozedUntil: '' },
        },
        { upsert: true }
      );
    }

    return NextResponse.json({ success: true, data: { deviceId, action } });
  } catch (error: unknown) {
    return internalApiError('Failed to update incident control', error);
  } finally {
    await mongo.close();
  }
}
