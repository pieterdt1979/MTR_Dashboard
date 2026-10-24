'use client';

import type { SyslogEvent } from '@/lib/api-client';
import { formatTs } from '@/lib/api-client';
import { SyslogSeverityBadge, tdCls, thCls } from '@/components/ui';

/** Shared syslog table used by the Syslog Explorer and the device detail Syslog tab. */
export default function SyslogTable({
  events,
  onRowClick,
  showDevice = true,
  emptyText = 'No syslog events for the selected filters.',
}: {
  events: SyslogEvent[];
  onRowClick?: (e: SyslogEvent) => void;
  showDevice?: boolean;
  emptyText?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="min-w-full divide-y divide-slate-800">
        <thead className="bg-slate-900">
          <tr>
            <th className={thCls}>Timestamp</th>
            {showDevice && <th className={thCls}>Device</th>}
            <th className={thCls}>Severity</th>
            <th className={thCls}>Mnemonic</th>
            <th className={thCls}>Raw Message</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70 bg-slate-950/40">
          {events.length === 0 && (
            <tr>
              <td colSpan={showDevice ? 5 : 4} className="px-3 py-8 text-center text-sm text-slate-500">
                {emptyText}
              </td>
            </tr>
          )}
          {events.map((e, i) => (
            <tr
              key={`${e.timestamp}-${e.device_id}-${i}`}
              onClick={onRowClick ? () => onRowClick(e) : undefined}
              className={onRowClick ? 'cursor-pointer hover:bg-slate-800/60' : ''}
            >
              <td className={`${tdCls} whitespace-nowrap font-mono text-xs text-slate-400`}>{formatTs(e.timestamp)}</td>
              {showDevice && (
                <td className={`${tdCls} whitespace-nowrap`}>
                  {e.hostname || e.parsed_host || e.source_ip}
                  {!e.device_id && <span className="ml-1 text-xs text-slate-500">(unmapped)</span>}
                </td>
              )}
              <td className={tdCls}>
                <SyslogSeverityBadge severity={e.severity} />
              </td>
              <td className={`${tdCls} whitespace-nowrap font-mono text-xs`}>{e.mnemonic || '—'}</td>
              <td className={`${tdCls} max-w-xl truncate font-mono text-xs text-slate-300`} title={e.raw_message}>
                {e.raw_message}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
