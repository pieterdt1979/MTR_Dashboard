'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import SyslogTable from '@/components/SyslogTable';
import {
  ErrorBanner,
  PageHeader,
  Spinner,
  SYSLOG_SEVERITIES,
  SyslogSeverityBadge,
  btnCls,
  btnGhostCls,
  inputCls,
  syslogSeverityClass,
} from '@/components/ui';
import { ApiError, formatTs, getDevices, getSyslog, type Device, type SyslogEvent } from '@/lib/api-client';

const PAGE_SIZE = 100;
const REFRESH_MS = 10_000;

type Filters = {
  deviceId: string;
  severities: number[];
  pattern: string;
  from: string; // datetime-local value
  to: string;
};

function localInputToIso(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function SyslogExplorer() {
  const router = useRouter();
  const search = useSearchParams();
  const [devices, setDevices] = useState<Device[]>([]);
  const [draft, setDraft] = useState<Filters>(() => ({
    deviceId: search.get('device_id') ?? '',
    severities: [],
    pattern: search.get('mnemonic_pattern') ?? '',
    from: '',
    to: '',
  }));
  const [applied, setApplied] = useState<Filters>(draft);
  const [offset, setOffset] = useState(0);
  const [events, setEvents] = useState<SyslogEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [selected, setSelected] = useState<SyslogEvent | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    getDevices()
      .then((r) => setDevices(r.items))
      .catch(() => setDevices([]));
  }, []);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await getSyslog({
          device_id: applied.deviceId ? Number(applied.deviceId) : undefined,
          severity: applied.severities.length ? applied.severities : undefined,
          mnemonic_pattern: applied.pattern || undefined,
          from: localInputToIso(applied.from),
          to: localInputToIso(applied.to),
          limit: PAGE_SIZE,
          offset,
        });
        setEvents(res.items);
        setTotal(res.total);
        setHasMore(Boolean(res.has_more));
        setError(null);
        setLastUpdated(new Date());
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Failed to load syslog events');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [applied, offset]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => load(true), REFRESH_MS);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  const toggleSeverity = (v: number) =>
    setDraft((d) => ({
      ...d,
      severities: d.severities.includes(v) ? d.severities.filter((s) => s !== v) : [...d.severities, v].sort(),
    }));

  const apply = () => {
    setOffset(0);
    setApplied(draft);
  };

  const reset = () => {
    const empty: Filters = { deviceId: '', severities: [], pattern: '', from: '', to: '' };
    setDraft(empty);
    setApplied(empty);
    setOffset(0);
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const sortedDevices = useMemo(() => [...devices].sort((a, b) => a.hostname.localeCompare(b.hostname)), [devices]);

  return (
    <div>
      <PageHeader
        title="Syslog Explorer"
        subtitle={`${total.toLocaleString()} matching events${lastUpdated ? ` · updated ${lastUpdated.toLocaleTimeString()}` : ''}`}
        actions={
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="accent-sky-500" />
            Auto-refresh (10s)
            {autoRefresh && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />}
          </label>
        }
      />

      <form
        className="mb-4 space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Device
            <select className={inputCls} value={draft.deviceId} onChange={(e) => setDraft({ ...draft, deviceId: e.target.value })}>
              <option value="">All devices</option>
              {sortedDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.hostname} ({d.mgmt_ip})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Mnemonic / regex
            <input
              className={`${inputCls} font-mono`}
              placeholder="e.g. LINK-3-UPDOWN or ^BGP"
              value={draft.pattern}
              onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            From
            <input type="datetime-local" className={inputCls} value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            To
            <input type="datetime-local" className={inputCls} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs text-slate-400">Severity:</span>
          {SYSLOG_SEVERITIES.map((s) => {
            const on = draft.severities.includes(s.value);
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => toggleSeverity(s.value)}
                className={`rounded px-2 py-1 text-xs ring-1 ring-inset transition-opacity ${syslogSeverityClass(s.value)} ${
                  on ? 'opacity-100 font-semibold' : 'opacity-60 hover:opacity-90'
                }`}
                aria-pressed={on}
              >
                {s.label}
              </button>
            );
          })}
          <div className="ml-auto flex gap-2">
            <button type="button" className={btnGhostCls} onClick={reset}>
              Reset
            </button>
            <button type="submit" className={btnCls}>
              Apply filters
            </button>
          </div>
        </div>
      </form>

      <ErrorBanner error={error} />
      {loading ? <Spinner /> : <SyslogTable events={events} onRowClick={setSelected} />}

      <div className="mt-4 flex items-center justify-between text-sm text-slate-400">
        <span>
          Page {page} of {pages.toLocaleString()} · showing {events.length ? offset + 1 : 0}–{offset + events.length}
        </span>
        <div className="flex gap-2">
          <button className={btnGhostCls} disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            ← Previous
          </button>
          <button className={btnGhostCls} disabled={!hasMore || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>
            Next →
          </button>
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-black/50" onClick={() => setSelected(null)} />
          <aside className="relative z-50 flex h-full w-full max-w-xl flex-col border-l border-slate-800 bg-slate-900 shadow-2xl">
            <header className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <h2 className="font-semibold text-slate-100">Syslog event</h2>
              <button type="button" onClick={() => setSelected(null)} className="text-slate-400 hover:text-white">
                ✕
              </button>
            </header>
            <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm">
              <dl className="grid grid-cols-3 gap-x-4 gap-y-2">
                <dt className="text-slate-400">Timestamp</dt>
                <dd className="col-span-2 font-mono">{formatTs(selected.timestamp)}</dd>
                <dt className="text-slate-400">Device</dt>
                <dd className="col-span-2">{selected.hostname || selected.parsed_host || '—'}</dd>
                <dt className="text-slate-400">Source IP</dt>
                <dd className="col-span-2 font-mono">{selected.source_ip}</dd>
                <dt className="text-slate-400">Severity</dt>
                <dd className="col-span-2">
                  <SyslogSeverityBadge severity={selected.severity} />
                </dd>
                <dt className="text-slate-400">Facility</dt>
                <dd className="col-span-2">{selected.facility}</dd>
                <dt className="text-slate-400">Mnemonic</dt>
                <dd className="col-span-2 font-mono">{selected.mnemonic || '—'}</dd>
                <dt className="text-slate-400">Program</dt>
                <dd className="col-span-2 font-mono">{selected.parsed_program || '—'}</dd>
              </dl>
              <div>
                <div className="mb-1 text-slate-400">Raw message</div>
                <pre className="whitespace-pre-wrap break-all rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-slate-200">
                  {selected.raw_message}
                </pre>
              </div>
            </div>
            <footer className="border-t border-slate-800 p-4">
              <button
                type="button"
                className={btnCls}
                disabled={!selected.device_id}
                title={selected.device_id ? undefined : 'Source IP is not mapped to a known device'}
                onClick={() => router.push(`/devices/${selected.device_id}`)}
              >
                Go to Device →
              </button>
            </footer>
          </aside>
        </div>
      )}
    </div>
  );
}

export default function SyslogPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <SyslogExplorer />
    </Suspense>
  );
}
