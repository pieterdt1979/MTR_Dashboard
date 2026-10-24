'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ErrorBanner, PageHeader, Spinner, StatusPill, VendorIcon, inputCls, tdCls, thCls } from '@/components/ui';
import { ApiError, formatTs, getDevices, type Device } from '@/lib/api-client';

const STATUSES = ['up', 'down', 'degraded', 'unknown'] as const;
const REFRESH_MS = 60_000;

function relative(ts: string | null): string {
  if (!ts) return 'never';
  const diff = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return `${Math.max(diff, 0)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function DeviceInventory() {
  const router = useRouter();
  const search = useSearchParams();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [burstOnly, setBurstOnly] = useState(search.get('burst') === '1');

  useEffect(() => {
    setBurstOnly(search.get('burst') === '1');
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await getDevices();
        if (!cancelled) {
          setDevices(res.items);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Failed to load devices');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return devices.filter((d) => {
      if (status && d.status !== status) return false;
      if (burstOnly && !d.burst_active) return false;
      if (!q) return true;
      return [d.hostname, d.mgmt_ip, d.site_name, d.vendor, d.model].some((v) => v?.toLowerCase().includes(q));
    });
  }, [devices, query, status, burstOnly]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { up: 0, down: 0, degraded: 0, unknown: 0 };
    for (const d of devices) c[d.status] = (c[d.status] ?? 0) + 1;
    return c;
  }, [devices]);

  return (
    <div>
      <PageHeader
        title="Devices"
        subtitle={`${devices.length} devices · ${counts.up} up · ${counts.down} down · ${counts.degraded} degraded · ${counts.unknown} unknown`}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          className={`${inputCls} w-80`}
          placeholder="Search hostname, IP, site, vendor…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" className="accent-fuchsia-500" checked={burstOnly} onChange={(e) => setBurstOnly(e.target.checked)} />
          Burst active only
        </label>
        <span className="ml-auto text-sm text-slate-400">{filtered.length} shown</span>
      </div>
      <ErrorBanner error={error} />
      {loading ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="min-w-full divide-y divide-slate-800">
            <thead className="bg-slate-900">
              <tr>
                <th className={thCls}>Hostname</th>
                <th className={thCls}>Site</th>
                <th className={thCls}>Vendor</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Last Polled</th>
                <th className={`${thCls} text-right`}>Interfaces</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 bg-slate-950/40">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-500">
                    No devices match.
                  </td>
                </tr>
              )}
              {filtered.map((d) => (
                <tr key={d.id} onClick={() => router.push(`/devices/${d.id}`)} className="cursor-pointer hover:bg-slate-800/60">
                  <td className={tdCls}>
                    <div className="font-medium text-slate-100">
                      {d.hostname}
                      {d.burst_active && (
                        <span className="ml-2 rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-300">BURST</span>
                      )}
                      {d.open_incidents > 0 && (
                        <span className="ml-2 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
                          {d.open_incidents} incident{d.open_incidents > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-xs text-slate-500">{d.mgmt_ip}</div>
                  </td>
                  <td className={tdCls}>{d.site_name ?? '—'}</td>
                  <td className={tdCls}>
                    <VendorIcon vendor={d.vendor} />
                  </td>
                  <td className={tdCls}>
                    <StatusPill status={d.status} />
                  </td>
                  <td className={`${tdCls} whitespace-nowrap`} title={formatTs(d.last_polled_at)}>
                    {relative(d.last_polled_at)}
                  </td>
                  <td className={`${tdCls} text-right`}>{d.interface_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function DevicesPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <DeviceInventory />
    </Suspense>
  );
}
