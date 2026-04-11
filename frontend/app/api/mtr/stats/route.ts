import { NextRequest, NextResponse } from 'next/server';
import { MongoClient } from 'mongodb';
import { enforceSecurity, internalApiError } from '@/lib/security';

type FpingPoint = {
  timestamp: string;
  bucketStart: string;
  bucketEnd: string;
  sourceSamples: number;
  fpingLatencyMs: number;
  fpingJitterMs: number;
  fpingLossPct: number;
  reachablePct: number;
  routeChanged: boolean;
};

type FpingHistoryDoc = {
  timestamp?: Date | string;
  alive?: boolean;
  avg_latency_ms?: number;
  stddev_ms?: number;
  sample_count?: number;
};

type HopStat = {
  hop: number;
  host: string;
  avgLatencyMs: number;
  bestMs: number;
  worstMs: number;
  lossPct: number;
};

type RouteDiff = {
  changed: boolean;
  changedAt: string | null;
  firstChangedHop: number | null;
  previousHopCount: number;
  currentHopCount: number;
  previousRoute: string[];
  currentRoute: string[];
};

type AggregationMeta = {
  applied: boolean;
  method: 'mean';
  maxPoints: number;
  inputPoints: number;
  outputPoints: number;
  bucketMinutes: number;
};

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const mongoDb = process.env.MONGODB_DATABASE || 'mtr_metrics';
const mongoCollection = process.env.MONGODB_COLLECTION || 'mtr_results';
const mongoFpingHistoryCollection = process.env.MONGODB_FPING_HISTORY_COLLECTION || 'fping_results';
const mongoRealtimeFpingCollection = process.env.MONGODB_REALTIME_FPING_COLLECTION || 'fping_realtime_results';

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractHubs(mtrResult: Record<string, unknown>): unknown[] {
  if (Array.isArray(mtrResult.hubs)) {
    return mtrResult.hubs;
  }

  const report =
    typeof mtrResult.report === 'object' && mtrResult.report !== null
      ? (mtrResult.report as Record<string, unknown>)
      : null;

  if (report && Array.isArray(report.hubs)) {
    return report.hubs;
  }

  return [];
}

function latestHopStats(hubs: unknown[]): HopStat[] {
  const result: HopStat[] = [];

  for (const rawHub of hubs) {
    if (typeof rawHub !== 'object' || rawHub === null) continue;
    const hub = rawHub as Record<string, unknown>;

    result.push({
      hop: toNumber(hub.count ?? hub.hop) ?? 0,
      host: String(hub.host ?? hub.hostname ?? '*'),
      avgLatencyMs: toNumber(hub.Avg ?? hub.avg) ?? 0,
      bestMs: toNumber(hub.Best ?? hub.best) ?? 0,
      worstMs: toNumber(hub.Wrst ?? hub.worst) ?? 0,
      lossPct: toNumber(hub['Loss%'] ?? hub.Loss ?? hub.loss) ?? 0,
    });
  }

  return result.sort((a, b) => a.hop - b.hop);
}

function findFirstDifferentHop(previous: string[], current: string[]): number | null {
  const maxLen = Math.max(previous.length, current.length);
  for (let i = 0; i < maxLen; i += 1) {
    if ((previous[i] || '') !== (current[i] || '')) {
      return i + 1;
    }
  }
  return null;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function bucketByTime<T>(
  items: T[],
  getTimestamp: (item: T) => Date,
  rangeStart: Date,
  bucketSizeMs: number
): T[][] {
  const buckets = new Map<number, T[]>();

  for (const item of items) {
    const ts = getTimestamp(item).getTime();
    const idx = Math.max(0, Math.floor((ts - rangeStart.getTime()) / bucketSizeMs));
    const current = buckets.get(idx);
    if (current) {
      current.push(item);
    } else {
      buckets.set(idx, [item]);
    }
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, values]) => values);
}

export async function GET(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'mtr-stats-get',
    allowedRoles: ['viewer'],
    rateLimit: { limit: 150, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  const { searchParams } = new URL(request.url);
  const deviceId = Number(searchParams.get('deviceId'));
  const hours = Number(searchParams.get('hours') || '24');
  const maxPoints = Number(searchParams.get('maxPoints') || '120');
  const includeRealtime = searchParams.get('includeRealtime') === 'true';
  const startParam = searchParams.get('start');
  const endParam = searchParams.get('end');

  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return NextResponse.json(
      { success: false, error: 'deviceId must be a positive integer' },
      { status: 400 }
    );
  }

  if (!Number.isFinite(maxPoints) || maxPoints < 10 || maxPoints > 500) {
    return NextResponse.json(
      { success: false, error: 'maxPoints must be between 10 and 500' },
      { status: 400 }
    );
  }

  const hasCustomStart = Boolean(startParam);
  const hasCustomEnd = Boolean(endParam);
  if (hasCustomStart !== hasCustomEnd) {
    return NextResponse.json(
      { success: false, error: 'start and end must be provided together' },
      { status: 400 }
    );
  }

  let rangeStart: Date;
  let rangeEnd: Date;
  let rangeHours: number;

  if (hasCustomStart && hasCustomEnd) {
    rangeStart = new Date(String(startParam));
    rangeEnd = new Date(String(endParam));

    if (!Number.isFinite(rangeStart.getTime()) || !Number.isFinite(rangeEnd.getTime())) {
      return NextResponse.json(
        { success: false, error: 'start/end must be valid ISO date values' },
        { status: 400 }
      );
    }

    if (rangeEnd <= rangeStart) {
      return NextResponse.json(
        { success: false, error: 'end must be greater than start' },
        { status: 400 }
      );
    }

    rangeHours = (rangeEnd.getTime() - rangeStart.getTime()) / (60 * 60 * 1000);
    if (rangeHours > 720) {
      return NextResponse.json(
        { success: false, error: 'custom range cannot exceed 720 hours (30 days)' },
        { status: 400 }
      );
    }
  } else {
    if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
      return NextResponse.json(
        { success: false, error: 'hours must be between 1 and 720' },
        { status: 400 }
      );
    }

    rangeEnd = new Date();
    rangeStart = new Date(Date.now() - hours * 60 * 60 * 1000);
    rangeHours = hours;
  }

  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });

  try {
    await client.connect();
    const db = client.db(mongoDb);
    const mtrCollection = db.collection(mongoCollection);
    const fpingHistoryCollection = db.collection<FpingHistoryDoc>(mongoFpingHistoryCollection);
    const realtimeFpingCollection = db.collection<FpingHistoryDoc>(mongoRealtimeFpingCollection);

    const mtrDocs = await mtrCollection
      .find(
        { device_id: deviceId, timestamp: { $gte: rangeStart, $lte: rangeEnd } },
        { projection: { timestamp: 1, mtr_result: 1, hostname: 1, ip_address: 1 } }
      )
      .sort({ timestamp: 1 })
      .limit(10000)
      .toArray();

    const fpingDocs = await fpingHistoryCollection
      .find(
        { device_id: deviceId, timestamp: { $gte: rangeStart, $lte: rangeEnd } },
        { projection: { timestamp: 1, alive: 1, avg_latency_ms: 1, stddev_ms: 1, sample_count: 1 } }
      )
      .sort({ timestamp: 1 })
      .limit(10000)
      .toArray();

    const realtimeDocs = includeRealtime
      ? await realtimeFpingCollection
          .find(
            { device_id: deviceId, timestamp: { $gte: rangeStart, $lte: rangeEnd } },
            { projection: { timestamp: 1, alive: 1, avg_latency_ms: 1, stddev_ms: 1, sample_count: 1 } }
          )
          .sort({ timestamp: 1 })
          .limit(10000)
          .toArray()
      : [];

    const mergedFpingDocs = [...fpingDocs, ...realtimeDocs].sort((a, b) => {
      const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(String(a.timestamp)).getTime();
      const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(String(b.timestamp)).getTime();
      return ta - tb;
    });

    const minBucketMs = includeRealtime ? 5 * 1000 : 60 * 1000;
    const rangeMs = Math.max(minBucketMs, rangeEnd.getTime() - rangeStart.getTime());
    const bucketSizeMs = Math.max(minBucketMs, Math.ceil(rangeMs / Math.max(10, Math.min(maxPoints, 500))));
    const groupedDocs = bucketByTime(
      mergedFpingDocs,
      (doc) => (doc.timestamp instanceof Date ? doc.timestamp : new Date(String(doc.timestamp))),
      rangeStart,
      bucketSizeMs
    );

    const points: FpingPoint[] = groupedDocs.map((bucketDocs) => {
      const latencyValues: number[] = [];
      const jitterValues: number[] = [];
      const aliveValues: number[] = [];

      const firstDoc = bucketDocs[0];
      const lastDoc = bucketDocs[bucketDocs.length - 1];
      const firstTimestamp =
        firstDoc.timestamp instanceof Date ? firstDoc.timestamp : new Date(String(firstDoc.timestamp));
      const lastTimestamp =
        lastDoc.timestamp instanceof Date ? lastDoc.timestamp : new Date(String(lastDoc.timestamp));

      for (const doc of bucketDocs) {
        const latency = toNumber(doc.avg_latency_ms);
        const jitter = toNumber(doc.stddev_ms);
        if (latency !== null) latencyValues.push(latency);
        if (jitter !== null) jitterValues.push(jitter);
        aliveValues.push(doc.alive === false ? 0 : 1);
      }

      const latencyAvg = average(latencyValues);
      const jitterAvg = average(jitterValues);
      const reachablePct = average(aliveValues) * 100;

      return {
        timestamp: lastTimestamp.toISOString(),
        bucketStart: firstTimestamp.toISOString(),
        bucketEnd: lastTimestamp.toISOString(),
        sourceSamples: bucketDocs.length,
        fpingLatencyMs: Number(latencyAvg.toFixed(2)),
        fpingJitterMs: Number(jitterAvg.toFixed(2)),
        reachablePct: Number(reachablePct.toFixed(2)),
        fpingLossPct: Number((100 - reachablePct).toFixed(2)),
        routeChanged: false,
      };
    });

    const latencies = points.map((p) => p.fpingLatencyMs);
    const losses = points.map((p) => p.fpingLossPct);

    const latestDoc = mtrDocs.length ? mtrDocs[mtrDocs.length - 1] : null;
    const previousDoc = mtrDocs.length > 1 ? mtrDocs[mtrDocs.length - 2] : null;
    const latestResult =
      latestDoc && typeof latestDoc.mtr_result === 'object' && latestDoc.mtr_result !== null
        ? (latestDoc.mtr_result as Record<string, unknown>)
        : null;
    const previousResult =
      previousDoc && typeof previousDoc.mtr_result === 'object' && previousDoc.mtr_result !== null
        ? (previousDoc.mtr_result as Record<string, unknown>)
        : null;
    const latestHops = latestResult ? latestHopStats(extractHubs(latestResult)) : [];

    const currentRoute = latestHops.map((h) => h.host || '?');
    const previousRoute = previousResult
      ? latestHopStats(extractHubs(previousResult)).map((h) => h.host || '?')
      : [];
    const routeChanged =
      currentRoute.length > 0 &&
      previousRoute.length > 0 &&
      currentRoute.join(' > ') !== previousRoute.join(' > ');

    const routeDiff: RouteDiff = {
      changed: routeChanged,
      changedAt:
        routeChanged && latestDoc && latestDoc.timestamp instanceof Date
          ? latestDoc.timestamp.toISOString()
          : null,
      firstChangedHop: routeChanged ? findFirstDifferentHop(previousRoute, currentRoute) : null,
      previousHopCount: previousRoute.length,
      currentHopCount: currentRoute.length,
      previousRoute,
      currentRoute,
    };
    const hopCountsForSummary = [routeDiff.previousHopCount, routeDiff.currentHopCount].filter((v) => v > 0);

    return NextResponse.json({
      success: true,
      data: {
        deviceId,
        hostname: latestDoc?.hostname ?? null,
        ipAddress: latestDoc?.ip_address ?? null,
        sampleCount: points.length,
        rawSampleCount: mergedFpingDocs.length,
        rangeHours: Number(rangeHours.toFixed(2)),
        rangeStart: rangeStart.toISOString(),
        rangeEnd: rangeEnd.toISOString(),
        aggregation: {
          applied: mergedFpingDocs.length > points.length,
          method: 'mean',
          maxPoints,
          inputPoints: mergedFpingDocs.length,
          outputPoints: points.length,
          bucketMinutes: Math.max(1, Math.round(bucketSizeMs / 60000)),
        } as AggregationMeta,
        summary: {
          latency: {
            min: latencies.length ? Math.min(...latencies) : 0,
            max: latencies.length ? Math.max(...latencies) : 0,
            avg: latencies.length ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)) : 0,
          },
          destinationLatency: {
            min: latencies.length ? Math.min(...latencies) : 0,
            max: latencies.length ? Math.max(...latencies) : 0,
            avg: latencies.length
              ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2))
              : 0,
          },
          hops: {
            min: hopCountsForSummary.length ? Math.min(...hopCountsForSummary) : 0,
            max: hopCountsForSummary.length ? Math.max(...hopCountsForSummary) : 0,
            avg: hopCountsForSummary.length
              ? Number((hopCountsForSummary.reduce((a, b) => a + b, 0) / hopCountsForSummary.length).toFixed(2))
              : 0,
          },
          loss: {
            min: losses.length ? Math.min(...losses) : 0,
            max: losses.length ? Math.max(...losses) : 0,
            avg: losses.length ? Number((losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(2)) : 0,
          },
          destinationLoss: {
            min: losses.length ? Math.min(...losses) : 0,
            max: losses.length ? Math.max(...losses) : 0,
            avg: losses.length
              ? Number((losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(2))
              : 0,
          },
          routeChanges: routeChanged ? 1 : 0,
        },
        points,
        latestHops,
        routeDiff,
      },
    });
  } catch (error: unknown) {
    return internalApiError('Failed to fetch MTR stats', error);
  } finally {
    await client.close();
  }
}
