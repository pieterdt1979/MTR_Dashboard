'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import IncidentsTable from '@/components/IncidentsTable';
import { ErrorBanner, PageHeader, Spinner, inputCls } from '@/components/ui';
import { ApiError, getIncidents, type Incident } from '@/lib/api-client';

const STATE_FILTERS = [
  { value: 'open,acknowledged', label: 'Active (open + acknowledged)' },
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'suppressed', label: 'Suppressed' },
  { value: '', label: 'All' },
];

const REFRESH_MS = 30_000;

export default function IncidentsPage() {
  const router = useRouter();
  const [state, setState] = useState('open,acknowledged');
  const [items, setItems] = useState<Incident[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = async () => {
      try {
        const res = await getIncidents({ state: state || undefined, limit: 500 });
        if (!cancelled) {
          setItems(res.items);
          setTotal(res.total);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Failed to load incidents');
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
  }, [state]);

  return (
    <div>
      <PageHeader
        title="Incidents"
        subtitle={`${total} incident${total === 1 ? '' : 's'}`}
        actions={
          <select className={inputCls} value={state} onChange={(e) => setState(e.target.value)}>
            {STATE_FILTERS.map((s) => (
              <option key={s.label} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        }
      />
      <ErrorBanner error={error} />
      {loading ? (
        <Spinner />
      ) : (
        <IncidentsTable items={items} onRowClick={(i) => i.device_id && router.push(`/devices/${i.device_id}`)} />
      )}
    </div>
  );
}
