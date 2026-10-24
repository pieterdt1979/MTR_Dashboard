'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import IncidentsTable from '@/components/IncidentsTable';
import SyslogTable from '@/components/SyslogTable';
import {
  Card,
  ErrorBanner,
  Spinner,
  StatusPill,
  Tabs,
  VendorIcon,
  btnCls,
  btnGhostCls,
  inputCls,
  rangeToIso,
  tdCls,
  thCls,
} from '@/components/ui';
import { useAuth } from '@/app/auth-provider';
import {
  ApiError,
  createBurst,
  deleteBurst,
  formatBps,
  formatBytes,
  formatTs,
  getDevice,
  getIncidents,
  getSyslog,
  getTopTalkers,
  protocolName,
  type BurstSession,
  type DeviceDetail,
  type Incident,
  type SyslogEvent,
  type TopTalkers,
} from '@/lib/api-client';

type Tab = 'interfaces' | 'syslog' | 'flows' | 'incidents';

const IF_STATUS: Record<number, string> = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' };

function IfStatus({ v }: { v: number | null }) {
  const name = v === null ? '—' : IF_STATUS[v] ?? String(v);
  const cls = v === 1 ? 'text-emerald-300' : v === 2 || v === 7 ? 'text-red-300' : 'text-slate-400';
  return <span className={cls}>{name}</span>;
}

function formatSpeed(bps: number | null): string {
  if (!bps) return '—';
  if (bps >= 1e9) return `${bps / 1e9} Gbps`;
  if (bps >= 1e6) return `${bps / 1e6} Mbps`;
  return `${bps / 1e3} Kbps`;
}

function mbps(bps: number | null): string {
  return bps === null || bps === undefined ? '—' : (bps / 1e6).toFixed(2);
}

function useCountdown(expiresAt: string | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return 0;
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
}

function fmtCountdown(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
}

function BurstPanel({ device, onChange }: { device: DeviceDetail; onChange: () => void }) {
  const { hasRole } = useAuth();
  const canOperate = hasRole('operator');
  const burst: BurstSession | null = device.active_burst;
  const remaining = useCountdown(burst?.expires_at);
  const [duration, setDuration] = useState(30);
  const [ifaceId, setIfaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Session expired client-side -> refresh so the backend's auto-expiry is reflected.
    if (burst && remaining === 0) {
      const t = setTimeout(onChange, 2000);
      return () => clearTimeout(t);
    }
  }, [burst, remaining, onChange]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await createBurst({ device_id: device.id, interface_id: ifaceId ? Number(ifaceId) : null, duration_minutes: duration });
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to start burst session');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!burst) return;
    setBusy(true);
    setError(null);
    try {
      await deleteBurst(burst.id);
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to stop burst session');
    } finally {
      setBusy(false);
    }
  };

  const burstIface = burst?.interface_id ? device.interfaces.find((i) => i.id === burst.interface_id) : null;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Burst polling
          {burst && <span className="h-2 w-2 animate-pulse rounded-full bg-fuchsia-400" />}
        </span>
      }
      className={burst ? 'border-fuchsia-800/60' : ''}
    >
      <ErrorBanner error={error} />
      {burst ? (
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <div className="text-xs text-slate-400">Expires in</div>
            <div className="font-mono text-2xl text-fuchsia-300">{fmtCountdown(remaining)}</div>
          </div>
          <div className="text-sm text-slate-300">
            <div>
              Scope: <span className="text-slate-100">{burstIface ? burstIface.ifname ?? `ifIndex ${burstIface.ifindex}` : 'all interfaces'}</span>
            </div>
            <div>
              Started by <span className="text-slate-100">{burst.initiated_by}</span> at {formatTs(burst.started_at)}
            </div>
            <div className="text-xs text-slate-500">Polled every 30 s until {formatTs(burst.expires_at)}</div>
          </div>
          <button type="button" className={`${btnGhostCls} ml-auto border-red-800 text-red-300 hover:bg-red-950`} disabled={!canOperate || busy} onClick={stop}>
            {busy ? 'Stopping…' : 'Stop burst'}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <p className="mr-auto max-w-md text-sm text-slate-400">
            Temporarily poll this device every 30 s instead of the normal cycle. Sessions expire automatically (max 8 h).
          </p>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Interface
            <select className={inputCls} value={ifaceId} onChange={(e) => setIfaceId(e.target.value)} disabled={!canOperate}>
              <option value="">All interfaces</option>
              {device.interfaces.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.ifname || `ifIndex ${i.ifindex}`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Duration
            <select className={inputCls} value={duration} onChange={(e) => setDuration(Number(e.target.value))} disabled={!canOperate}>
              {[15, 30, 60, 120, 240, 480].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} min` : `${m / 60} h`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={btnCls}
            disabled={!canOperate || busy}
            title={canOperate ? undefined : 'Operator role required'}
            onClick={start}
          >
            {busy ? 'Starting…' : 'Start burst'}
          </button>
        </div>
      )}
    </Card>
  );
}

function InterfacesTab({ device }: { device: DeviceDetail }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="min-w-full divide-y divide-slate-800">
        <thead className="bg-slate-900">
          <tr>
            <th className={thCls}>ifName</th>
            <th className={thCls}>ifDescr</th>
            <th className={thCls}>Admin</th>
            <th className={thCls}>Oper</th>
            <th className={thCls}>Speed</th>
            <th className={`${thCls} text-right`}>In Mbps</th>
            <th className={`${thCls} text-right`}>Out Mbps</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70 bg-slate-950/40">
          {device.interfaces.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-sm text-slate-500">
                No interfaces discovered yet.
              </td>
            </tr>
          )}
          {device.interfaces.map((i) => {
            const util = i.ifspeed_bps && i.in_bps !== null ? Math.max(i.in_bps, i.out_bps ?? 0) / i.ifspeed_bps : null;
            return (
              <tr key={i.id}>
                <td className={`${tdCls} font-mono`}>
                  {i.ifname ?? `ifIndex ${i.ifindex}`}
                  {i.ifalias && <div className="text-xs text-slate-500">{i.ifalias}</div>}
                </td>
                <td className={`${tdCls} text-slate-400`}>{i.ifdescr ?? '—'}</td>
                <td className={tdCls}>
                  <IfStatus v={i.ifadmin_status} />
                </td>
                <td className={tdCls}>
                  <IfStatus v={i.ifoper_status} />
                </td>
                <td className={tdCls}>{formatSpeed(i.ifspeed_bps)}</td>
                <td className={`${tdCls} text-right font-mono`} title={formatBps(i.in_bps)}>
                  {mbps(i.in_bps)}
                </td>
                <td className={`${tdCls} text-right font-mono`} title={formatBps(i.out_bps)}>
                  {mbps(i.out_bps)}
                  {util !== null && util > 0.8 && <span className="ml-1 text-xs text-amber-300">({Math.round(util * 100)}%)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SyslogTab({ deviceId }: { deviceId: number }) {
  const [events, setEvents] = useState<SyslogEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getSyslog({ device_id: deviceId, limit: 50 })
        .then((r) => {
          if (!cancelled) {
            setEvents(r.items);
            setError(null);
          }
        })
        .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'Failed to load syslog'));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [deviceId]);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
        <span>Last 50 events · auto-refresh every 30 s</span>
        <Link href={`/syslog?device_id=${deviceId}`} className="text-sky-300 hover:underline">
          Open in Syslog Explorer →
        </Link>
      </div>
      <ErrorBanner error={error} />
      {events === null ? <Spinner /> : <SyslogTable events={events} showDevice={false} />}
    </div>
  );
}

function FlowsTab({ deviceId }: { deviceId: number }) {
  const [data, setData] = useState<TopTalkers | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getTopTalkers({ device_id: deviceId, top_n: 10, group_by: 'src_ip', ...rangeToIso('1h') })
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load flows'));
  }, [deviceId]);
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Spinner />;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
        <span>
          Top 10 source IPs · last hour · {formatBytes(data.total_bytes)} total
        </span>
        <Link href={`/flows?device_id=${deviceId}`} className="text-sky-300 hover:underline">
          Open in Flow Analytics →
        </Link>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="min-w-full divide-y divide-slate-800">
          <thead className="bg-slate-900">
            <tr>
              <th className={thCls}>Rank</th>
              <th className={thCls}>Source IP</th>
              <th className={thCls}>Protocol</th>
              <th className={`${thCls} text-right`}>Bytes</th>
              <th className={`${thCls} text-right`}>Packets</th>
              <th className={`${thCls} text-right`}>% of total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70 bg-slate-950/40">
            {data.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-500">
                  No flows exported by this device in the last hour.
                </td>
              </tr>
            )}
            {data.items.map((r) => (
              <tr key={r.key}>
                <td className={tdCls}>{r.rank}</td>
                <td className={`${tdCls} font-mono`}>{r.key}</td>
                <td className={tdCls}>{protocolName(r.protocol)}</td>
                <td className={`${tdCls} text-right`}>{formatBytes(r.bytes)}</td>
                <td className={`${tdCls} text-right`}>{r.packets.toLocaleString()}</td>
                <td className={`${tdCls} text-right`}>{r.pct.toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IncidentsTab({ deviceId }: { deviceId: number }) {
  const [items, setItems] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getIncidents({ device_id: deviceId, state: 'open,acknowledged', limit: 100 })
      .then((r) => setItems(r.items))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load incidents'));
  }, [deviceId]);
  if (error) return <ErrorBanner error={error} />;
  if (!items) return <Spinner />;
  return <IncidentsTable items={items} showDevice={false} />;
}

export default function DeviceDetailPage() {
  const params = useParams<{ id: string }>();
  const deviceId = Number(params.id);
  const [device, setDevice] = useState<DeviceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('interfaces');

  const load = useCallback(async () => {
    if (!Number.isInteger(deviceId) || deviceId <= 0) {
      setError('Invalid device id');
      return;
    }
    try {
      setDevice(await getDevice(deviceId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? (e.status === 404 ? 'Device not found' : e.message) : 'Failed to load device');
    }
  }, [deviceId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !device) {
    return (
      <div>
        <Link href="/devices" className="text-sm text-sky-300 hover:underline">
          ← Devices
        </Link>
        <div className="mt-4">
          <ErrorBanner error={error} />
        </div>
      </div>
    );
  }
  if (!device) return <Spinner />;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/devices" className="text-sm text-sky-300 hover:underline">
          ← Devices
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-3 text-2xl font-semibold text-slate-100">
              {device.hostname} <StatusPill status={device.status} />
            </h1>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-400">
              <span>
                Mgmt IP <span className="font-mono text-slate-200">{device.mgmt_ip}</span>
              </span>
              <span className="flex items-center gap-1">
                <VendorIcon vendor={device.vendor} />
              </span>
              <span>
                Model <span className="text-slate-200">{device.model ?? '—'}</span>
              </span>
              <span>
                Site <span className="text-slate-200">{device.site_name ?? '—'}</span>
                {device.site_city && <span className="text-slate-500"> ({device.site_city})</span>}
              </span>
              <span>
                SNMP <span className="text-slate-200">{device.snmp_version ?? '—'}</span>
              </span>
              <span>
                Last polled <span className="text-slate-200">{formatTs(device.last_polled_at)}</span>
              </span>
            </div>
          </div>
        </div>
        <ErrorBanner error={error} />
      </div>

      <BurstPanel device={device} onChange={load} />

      <div>
        <Tabs
          tabs={[
            { id: 'interfaces' as Tab, label: `Interfaces (${device.interfaces.length})` },
            { id: 'syslog' as Tab, label: 'Syslog' },
            { id: 'flows' as Tab, label: 'Flows' },
            { id: 'incidents' as Tab, label: `Incidents${device.open_incidents ? ` (${device.open_incidents})` : ''}` },
          ]}
          active={tab}
          onChange={setTab}
        />
        {tab === 'interfaces' && <InterfacesTab device={device} />}
        {tab === 'syslog' && <SyslogTab deviceId={device.id} />}
        {tab === 'flows' && <FlowsTab deviceId={device.id} />}
        {tab === 'incidents' && <IncidentsTab deviceId={device.id} />}
      </div>
    </div>
  );
}
