'use client';

import { IncidentSeverityBadge, tdCls, thCls } from '@/components/ui';
import { formatDuration, formatTs, type Incident } from '@/lib/api-client';

const STATE_CLS: Record<string, string> = {
  open: 'text-red-300',
  acknowledged: 'text-amber-300',
  resolved: 'text-emerald-300',
  suppressed: 'text-slate-400',
};

export default function IncidentsTable({ items, onRowClick, showDevice = true }: { items: Incident[]; onRowClick?: (i: Incident) => void; showDevice?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="min-w-full divide-y divide-slate-800">
        <thead className="bg-slate-900">
          <tr>
            <th className={thCls}>Severity</th>
            <th className={thCls}>Title</th>
            {showDevice && <th className={thCls}>Device</th>}
            <th className={thCls}>State</th>
            <th className={thCls}>Opened At</th>
            <th className={thCls}>Duration</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70 bg-slate-950/40">
          {items.length === 0 && (
            <tr>
              <td colSpan={showDevice ? 6 : 5} className="px-3 py-8 text-center text-sm text-slate-500">
                No incidents.
              </td>
            </tr>
          )}
          {items.map((i) => (
            <tr
              key={i.id}
              onClick={onRowClick ? () => onRowClick(i) : undefined}
              className={onRowClick && i.device_id ? 'cursor-pointer hover:bg-slate-800/60' : ''}
            >
              <td className={tdCls}>
                <IncidentSeverityBadge severity={i.severity} />
              </td>
              <td className={tdCls}>
                <div className="text-slate-100">{i.title}</div>
                {i.description && <div className="text-xs text-slate-500">{i.description}</div>}
              </td>
              {showDevice && (
                <td className={tdCls}>
                  {i.hostname ?? '—'}
                  {i.ifname && <span className="text-slate-500"> · {i.ifname}</span>}
                </td>
              )}
              <td className={`${tdCls} capitalize ${STATE_CLS[i.state] ?? ''}`}>{i.state}</td>
              <td className={`${tdCls} whitespace-nowrap`}>{formatTs(i.opened_at)}</td>
              <td className={`${tdCls} whitespace-nowrap`}>{formatDuration(i.duration_seconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
