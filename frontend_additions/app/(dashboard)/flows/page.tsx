'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Card,
  ErrorBanner,
  PageHeader,
  RANGES,
  Spinner,
  Tabs,
  inputCls,
  rangeToIso,
  tdCls,
  thCls,
  type RangeKey,
} from '@/components/ui';
import {
  ApiError,
  formatBytes,
  getBandwidth,
  getDevice,
  getDevices,
  getTopTalkers,
  protocolName,
  type Bandwidth,
  type Device,
  type GroupBy,
  type Interface,
  type TopTalkers,
} from '@/lib/api-client';

type Tab = 'talkers' | 'bandwidth';

const GROUP_LABEL: Record<GroupBy, string> = { src_ip: 'Source IP', dst_ip: 'Destination IP', protocol: 'Protocol', port: 'Port' };
const BUCKETS = { '5m': 5, '1h': 60, '1d': 1440 } as const;
type BucketKey = keyof typeof BUCKETS;

const tooltipStyle = { backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: '#e2e8f0' };

function DeviceSelect({ devices, value, onChange, allowAll }: { devices: Device[]; value: string; onChange: (v: string) => void; allowAll: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-slate-400">
      Device
      <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
        {allowAll ? <option value="">All devices</option> : <option value="">Select a device…</option>}
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.hostname}
          </option>
        ))}
      </select>
    </label>
  );
}

function RangeSelect({ value, onChange }: { value: RangeKey; onChange: (v: RangeKey) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-slate-400">
      Range
      <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value as RangeKey)}>
        {(Object.keys(RANGES) as RangeKey[]).map((r) => (
          <option key={r} value={r}>
            Last {r}
          </option>
        ))}
      </select>
    </label>
  );
}

function talkerLabel(groupBy: GroupBy, key: string, protocol: number | null): string {
  if (groupBy === 'protocol') return protocolName(Number(key));
  if (groupBy === 'port' && protocol !== null) return `${key}/${protocolName(protocol)}`;
  return key;
}

function TopTalkersTab({ devices, initialDevice }: { devices: Device[]; initialDevice: string }) {
  const [deviceId, setDeviceId] = useState(initialDevice);
  const [range, setRange] = useState<RangeKey>('1h');
  const [groupBy, setGroupBy] = useState<GroupBy>('src_ip');
  const [topN, setTopN] = useState(10);
  const [data, setData] = useState<TopTalkers | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getTopTalkers({ device_id: deviceId ? Number(deviceId) : undefined, group_by: groupBy, top_n: topN, ...rangeToIso(range) })
      .then((r) => {
        if (!cancelled) {
          setData(r);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'Failed to load top talkers'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [deviceId, range, groupBy, topN]);

  const chartData = useMemo(
    () => (data?.items ?? []).map((i) => ({ ...i, label: talkerLabel(groupBy, i.key, i.protocol) })),
    [data, groupBy]
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <DeviceSelect devices={devices} value={deviceId} onChange={setDeviceId} allowAll />
        <RangeSelect value={range} onChange={setRange} />
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Group by
          <select className={inputCls} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => (
              <option key={g} value={g}>
                {GROUP_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Top N
          <select className={inputCls} value={topN} onChange={(e) => setTopN(Number(e.target.value))}>
            {[10, 25, 50].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorBanner error={error} />
      {loading ? (
        <Spinner />
      ) : (
        <>
          <Card
            title={`Top ${topN} by ${GROUP_LABEL[groupBy]}`}
            actions={
              <span className="text-xs text-slate-400">
                Total {formatBytes(data?.total_bytes)} · {data?.total_flows.toLocaleString() ?? 0} flows
              </span>
            }
          >
            {chartData.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">No flow records in this range.</p>
            ) : (
              <div style={{ height: Math.max(240, chartData.length * 26 + 40) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 30, top: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                    <XAxis type="number" tickFormatter={(v) => formatBytes(Number(v))} stroke="#64748b" fontSize={11} />
                    <YAxis type="category" dataKey="label" width={130} stroke="#64748b" fontSize={11} interval={0} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      cursor={{ fill: 'rgba(56,189,248,0.08)' }}
                      formatter={(v) => [formatBytes(Number(v)), 'Bytes']}
                    />
                    <Bar dataKey="bytes" fill="#38bdf8" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="min-w-full divide-y divide-slate-800">
              <thead className="bg-slate-900">
                <tr>
                  <th className={thCls}>Rank</th>
                  <th className={thCls}>{GROUP_LABEL[groupBy]}</th>
                  <th className={thCls}>Protocol</th>
                  <th className={`${thCls} text-right`}>Bytes</th>
                  <th className={`${thCls} text-right`}>Packets</th>
                  <th className={`${thCls} text-right`}>% of total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 bg-slate-950/40">
                {chartData.map((r) => (
                  <tr key={r.key}>
                    <td className={tdCls}>{r.rank}</td>
                    <td className={`${tdCls} font-mono`}>{groupBy === 'protocol' ? protocolName(Number(r.key)) : r.key}</td>
                    <td className={tdCls}>{protocolName(r.protocol)}</td>
                    <td className={`${tdCls} text-right`}>{formatBytes(r.bytes)}</td>
                    <td className={`${tdCls} text-right`}>{r.packets.toLocaleString()}</td>
                    <td className={`${tdCls} text-right`}>
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded bg-slate-800">
                          <div className="h-full bg-sky-500" style={{ width: `${Math.min(100, r.pct)}%` }} />
                        </div>
                        {r.pct.toFixed(2)}%
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function BandwidthTab({ devices, initialDevice }: { devices: Device[]; initialDevice: string }) {
  const [deviceId, setDeviceId] = useState(initialDevice);
  const [interfaces, setInterfaces] = useState<Interface[]>([]);
  const [ifindex, setIfindex] = useState('');
  const [range, setRange] = useState<RangeKey>('24h');
  const [bucket, setBucket] = useState<BucketKey>('5m');
  const [data, setData] = useState<Bandwidth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIfindex('');
    setInterfaces([]);
    if (!deviceId) return;
    getDevice(Number(deviceId))
      .then((d) => setInterfaces(d.interfaces))
      .catch(() => setInterfaces([]));
  }, [deviceId]);

  useEffect(() => {
    if (!deviceId) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getBandwidth({
      device_id: Number(deviceId),
      ifindex: ifindex ? Number(ifindex) : undefined,
      bucket_minutes: BUCKETS[bucket],
      ...rangeToIso(range),
    })
      .then((r) => {
        if (!cancelled) {
          setData(r);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'Failed to load bandwidth'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [deviceId, ifindex, range, bucket]);

  const speedMbps = data?.speed_bps ? data.speed_bps / 1e6 : null;
  const chartData = useMemo(
    () =>
      (data?.points ?? []).map((p) => ({
        t: new Date(p.ts).getTime(),
        in: Number(p.in_mbps.toFixed(3)),
        out: Number(p.out_mbps.toFixed(3)),
      })),
    [data]
  );
  const fmtTick = (t: number) => {
    const d = new Date(t);
    return bucket === '1d' || range === '7d'
      ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + (bucket === '1d' ? '' : ` ${d.getHours()}:00`)
      : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <DeviceSelect devices={devices} value={deviceId} onChange={setDeviceId} allowAll={false} />
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Interface
          <select className={inputCls} value={ifindex} onChange={(e) => setIfindex(e.target.value)} disabled={!deviceId}>
            <option value="">All interfaces (aggregate)</option>
            {interfaces.map((i) => (
              <option key={i.id} value={i.ifindex}>
                {i.ifname || i.ifdescr || `ifIndex ${i.ifindex}`}
              </option>
            ))}
          </select>
        </label>
        <RangeSelect value={range} onChange={setRange} />
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Bucket
          <select className={inputCls} value={bucket} onChange={(e) => setBucket(e.target.value as BucketKey)}>
            {(Object.keys(BUCKETS) as BucketKey[]).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorBanner error={error} />
      {!deviceId ? (
        <p className="rounded-lg border border-dashed border-slate-700 py-12 text-center text-sm text-slate-500">
          Select a device to chart interface bandwidth.
        </p>
      ) : loading ? (
        <Spinner />
      ) : (
        <Card
          title={`Bandwidth — ${data?.interface?.ifname ?? 'all interfaces'}`}
          actions={speedMbps ? <span className="text-xs text-slate-400">Interface speed {speedMbps.toLocaleString()} Mbps</span> : null}
        >
          {chartData.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">No samples in this range.</p>
          ) : (
            <div className="h-96">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ left: 10, right: 30, top: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={fmtTick} stroke="#64748b" fontSize={11} />
                  <YAxis
                    stroke="#64748b"
                    fontSize={11}
                    unit=" Mbps"
                    width={90}
                    domain={[0, (max: number) => Math.ceil(Math.max(max, speedMbps ?? 0) * 1.05)]}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    cursor={{ stroke: '#94a3b8', strokeDasharray: '4 4' }}
                    labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
                    formatter={(v, name) => [`${Number(v).toLocaleString()} Mbps`, name === 'in' ? 'In' : 'Out']}
                  />
                  <Legend formatter={(v) => (v === 'in' ? 'In (Mbps)' : 'Out (Mbps)')} />
                  {speedMbps ? (
                    <ReferenceLine
                      y={speedMbps}
                      stroke="#f87171"
                      strokeDasharray="6 4"
                      label={{ value: `Speed ${speedMbps.toLocaleString()} Mbps`, fill: '#f87171', fontSize: 11, position: 'insideTopRight' }}
                    />
                  ) : null}
                  <Line type="monotone" dataKey="in" stroke="#38bdf8" dot={false} strokeWidth={2} isAnimationActive={false} />
                  <Line type="monotone" dataKey="out" stroke="#a78bfa" dot={false} strokeWidth={2} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function FlowAnalytics() {
  const search = useSearchParams();
  const [tab, setTab] = useState<Tab>(search.get('tab') === 'bandwidth' ? 'bandwidth' : 'talkers');
  const [devices, setDevices] = useState<Device[]>([]);
  const initialDevice = search.get('device_id') ?? '';

  useEffect(() => {
    getDevices()
      .then((r) => setDevices([...r.items].sort((a, b) => a.hostname.localeCompare(b.hostname))))
      .catch(() => setDevices([]));
  }, []);

  return (
    <div>
      <PageHeader title="Flow Analytics" subtitle="NetFlow / IPFIX top talkers and SNMP interface bandwidth" />
      <Tabs
        tabs={[
          { id: 'talkers' as Tab, label: 'Top Talkers' },
          { id: 'bandwidth' as Tab, label: 'Bandwidth' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'talkers' ? <TopTalkersTab devices={devices} initialDevice={initialDevice} /> : <BandwidthTab devices={devices} initialDevice={initialDevice} />}
    </div>
  );
}

export default function FlowsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <FlowAnalytics />
    </Suspense>
  );
}
