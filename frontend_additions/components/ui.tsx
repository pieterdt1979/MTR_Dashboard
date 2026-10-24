'use client';

import type { ReactNode } from 'react';

export const SYSLOG_SEVERITIES = [
  { value: 0, name: 'emergency', label: 'Emergency' },
  { value: 1, name: 'alert', label: 'Alert' },
  { value: 2, name: 'critical', label: 'Critical' },
  { value: 3, name: 'error', label: 'Error' },
  { value: 4, name: 'warning', label: 'Warning' },
  { value: 5, name: 'notice', label: 'Notice' },
  { value: 6, name: 'info', label: 'Info' },
  { value: 7, name: 'debug', label: 'Debug' },
] as const;

/** Emergency/Alert/Critical red, Error orange, Warning yellow, Notice/Info blue, Debug grey. */
export function syslogSeverityClass(sev: number): string {
  if (sev <= 2) return 'bg-red-500/15 text-red-300 ring-red-500/40';
  if (sev === 3) return 'bg-orange-500/15 text-orange-300 ring-orange-500/40';
  if (sev === 4) return 'bg-yellow-500/15 text-yellow-300 ring-yellow-500/40';
  if (sev <= 6) return 'bg-blue-500/15 text-blue-300 ring-blue-500/40';
  return 'bg-slate-500/15 text-slate-300 ring-slate-500/40';
}

export function SyslogSeverityBadge({ severity }: { severity: number }) {
  const label = SYSLOG_SEVERITIES[severity]?.label ?? String(severity);
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${syslogSeverityClass(severity)}`}>
      {label}
    </span>
  );
}

const INCIDENT_SEV: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-300 ring-red-500/40',
  major: 'bg-orange-500/15 text-orange-300 ring-orange-500/40',
  minor: 'bg-yellow-500/15 text-yellow-300 ring-yellow-500/40',
  warning: 'bg-yellow-500/15 text-yellow-300 ring-yellow-500/40',
  info: 'bg-blue-500/15 text-blue-300 ring-blue-500/40',
};

export function IncidentSeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${
        INCIDENT_SEV[severity] ?? 'bg-slate-500/15 text-slate-300 ring-slate-500/40'
      }`}
    >
      {severity}
    </span>
  );
}

const STATUS: Record<string, string> = {
  up: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
  down: 'bg-red-500/15 text-red-300 ring-red-500/40',
  degraded: 'bg-amber-500/15 text-amber-300 ring-amber-500/40',
  unknown: 'bg-slate-500/15 text-slate-300 ring-slate-500/40',
};

const DOT: Record<string, string> = {
  up: 'bg-emerald-400',
  down: 'bg-red-400',
  degraded: 'bg-amber-400',
  unknown: 'bg-slate-400',
};

export function StatusPill({ status }: { status: string }) {
  const s = STATUS[status] ? status : 'unknown';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${STATUS[s]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[s]}`} />
      {status || 'unknown'}
    </span>
  );
}

const VENDOR: Record<string, { label: string; cls: string }> = {
  cisco: { label: 'CS', cls: 'bg-sky-600' },
  juniper: { label: 'JN', cls: 'bg-emerald-700' },
  arista: { label: 'AR', cls: 'bg-indigo-600' },
  huawei: { label: 'HW', cls: 'bg-red-700' },
  nokia: { label: 'NK', cls: 'bg-blue-800' },
  fortinet: { label: 'FT', cls: 'bg-rose-700' },
  paloalto: { label: 'PA', cls: 'bg-orange-700' },
  mikrotik: { label: 'MT', cls: 'bg-slate-600' },
};

export function VendorIcon({ vendor }: { vendor: string }) {
  const key = (vendor || '').toLowerCase().replace(/[^a-z]/g, '');
  const v = VENDOR[key] ?? { label: (vendor || '?').slice(0, 2).toUpperCase(), cls: 'bg-slate-700' };
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-flex h-6 w-6 items-center justify-center rounded text-[10px] font-bold text-white ${v.cls}`}>{v.label}</span>
      <span className="capitalize">{vendor || '—'}</span>
    </span>
  );
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-slate-800 bg-slate-900/60 ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="mb-4 rounded-md border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-300">{error}</div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" />
      {label}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { id: T; label: ReactNode }[]; active: T; onChange: (id: T) => void }) {
  return (
    <div className="mb-4 flex gap-1 border-b border-slate-800">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            active === t.id ? 'border-sky-400 text-sky-300' : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export const inputCls =
  'rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500';

export const btnCls =
  'inline-flex items-center gap-2 rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50';

export const btnGhostCls =
  'inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50';

export const thCls = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400';
export const tdCls = 'px-3 py-2 text-sm text-slate-200';

/** Time range presets used by flows / device pages. */
export const RANGES = {
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 24 * 3600,
  '7d': 7 * 86400,
} as const;
export type RangeKey = keyof typeof RANGES;

export function rangeToIso(range: RangeKey): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - RANGES[range] * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}
