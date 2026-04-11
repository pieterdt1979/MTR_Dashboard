import { NextRequest, NextResponse } from 'next/server';
import { MongoClient } from 'mongodb';
import { enforceSecurity, internalApiError } from '@/lib/security';

type RouteHop = {
  hop: number;
  host: string;
};

type RouteResult = {
  deviceId: number;
  hostname: string;
  ipAddress: string;
  timestamp: string;
  hops: RouteHop[];
  routeSignature: string;
};

type SharedHop = {
  host: string;
  seenInDeviceCount: number;
  seenAtHops: number[];
  affectedDeviceIds: number[];
};

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const mongoDb = process.env.MONGODB_DATABASE || 'mtr_metrics';
const mongoCollection = process.env.MONGODB_COLLECTION || 'mtr_results';

function extractHops(mtrResult: Record<string, unknown>): RouteHop[] {
  const report =
    typeof mtrResult.report === 'object' && mtrResult.report !== null
      ? (mtrResult.report as Record<string, unknown>)
      : null;

  const hubs = report && Array.isArray(report.hubs) ? report.hubs : [];
  const hops: RouteHop[] = [];

  for (const rawHub of hubs) {
    if (typeof rawHub !== 'object' || rawHub === null) continue;
    const hub = rawHub as Record<string, unknown>;
    const hop = Number(hub.count ?? hub.hop ?? 0);
    const host = String(hub.host ?? hub.hostname ?? '?').trim();
    if (!Number.isFinite(hop) || hop <= 0) continue;
    hops.push({ hop, host: host || '?' });
  }

  return hops.sort((a, b) => a.hop - b.hop);
}

function toRouteResult(doc: Record<string, unknown>): RouteResult | null {
  const deviceId = Number(doc.device_id);
  if (!Number.isInteger(deviceId) || deviceId <= 0) return null;

  const mtrResult =
    typeof doc.mtr_result === 'object' && doc.mtr_result !== null
      ? (doc.mtr_result as Record<string, unknown>)
      : {};

  const hops = extractHops(mtrResult);

  const ts = doc.timestamp instanceof Date ? doc.timestamp.toISOString() : String(doc.timestamp ?? '');

  return {
    deviceId,
    hostname: String(doc.hostname ?? 'unknown-host'),
    ipAddress: String(doc.ip_address ?? 'unknown-ip'),
    timestamp: ts,
    hops,
    routeSignature: hops.map((h) => h.host).join(' > '),
  };
}

function buildSharedHops(routes: RouteResult[]): SharedHop[] {
  const usage = new Map<
    string,
    { deviceIds: Set<number>; hopIndexes: Set<number> }
  >();

  for (const route of routes) {
    const uniqueHostsForRoute = new Set<string>();
    for (const hop of route.hops) {
      const host = hop.host;
      // Skip unresolved or empty hops for SPOF analysis.
      if (!host || host === '?' || host === '*') continue;
      if (uniqueHostsForRoute.has(host)) continue;
      uniqueHostsForRoute.add(host);

      const entry = usage.get(host) || { deviceIds: new Set<number>(), hopIndexes: new Set<number>() };
      entry.deviceIds.add(route.deviceId);
      entry.hopIndexes.add(hop.hop);
      usage.set(host, entry);
    }
  }

  const shared: SharedHop[] = [];
  for (const [host, info] of usage.entries()) {
    if (info.deviceIds.size <= 1) continue;
    shared.push({
      host,
      seenInDeviceCount: info.deviceIds.size,
      seenAtHops: [...info.hopIndexes].sort((a, b) => a - b),
      affectedDeviceIds: [...info.deviceIds].sort((a, b) => a - b),
    });
  }

  return shared.sort((a, b) => b.seenInDeviceCount - a.seenInDeviceCount || a.host.localeCompare(b.host));
}

export async function GET(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'mtr-route-compare-get',
    allowedRoles: ['viewer'],
    rateLimit: { limit: 80, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  const { searchParams } = new URL(request.url);
  const rawDeviceIds = (searchParams.get('deviceIds') || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  const hours = Number(searchParams.get('hours') || '24');

  if (!rawDeviceIds.length) {
    return NextResponse.json(
      { success: false, error: 'deviceIds query parameter is required' },
      { status: 400 }
    );
  }

  const deviceIds = [...new Set(rawDeviceIds)].slice(0, 12);

  if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
    return NextResponse.json(
      { success: false, error: 'hours must be between 1 and 720' },
      { status: 400 }
    );
  }

  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });

  try {
    await client.connect();
    const collection = client.db(mongoDb).collection(mongoCollection);

    const docs = await collection
      .aggregate([
        {
          $match: {
            device_id: { $in: deviceIds },
            timestamp: { $gte: since },
          },
        },
        { $sort: { timestamp: -1 } },
        {
          $group: {
            _id: '$device_id',
            latest: { $first: '$$ROOT' },
          },
        },
        { $replaceRoot: { newRoot: '$latest' } },
      ])
      .toArray();

    const routes = docs
      .map((doc) => toRouteResult(doc as unknown as Record<string, unknown>))
      .filter((route): route is RouteResult => route !== null)
      .sort((a, b) => a.hostname.localeCompare(b.hostname));

    const sharedHops = buildSharedHops(routes);
    const missingDeviceIds = deviceIds.filter((id) => !routes.some((route) => route.deviceId === id));

    const criticalShared = sharedHops.filter((hop) => hop.seenAtHops.some((idx) => idx <= 4)).length;
    const riskLevel = criticalShared >= 2 ? 'high' : criticalShared === 1 ? 'medium' : sharedHops.length > 0 ? 'low' : 'minimal';

    return NextResponse.json({
      success: true,
      data: {
        hours,
        since: since.toISOString(),
        routes,
        sharedHops,
        missingDeviceIds,
        risk: {
          level: riskLevel,
          sharedHopCount: sharedHops.length,
          earlySharedHopCount: criticalShared,
        },
      },
    });
  } catch (error: unknown) {
    return internalApiError('Failed to compare routes', error);
  } finally {
    await client.close();
  }
}
