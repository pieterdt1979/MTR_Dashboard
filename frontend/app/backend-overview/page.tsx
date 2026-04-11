'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/auth-provider';

type ServiceStatus = {
  ok: boolean;
  message?: string;
  latencyMs?: number;
};

type StackItem = {
  name: string;
  component: string;
  purpose: string;
  version: string;
};

type OverviewResponse = {
  stack: StackItem[];
  services: {
    mysql: ServiceStatus;
    mongodb: ServiceStatus;
    poller: ServiceStatus;
    postgres: ServiceStatus;
    rabbitmq: ServiceStatus;
  };
  checkedAt: string;
};

export default function BackendOverviewPage() {
  const { user, loading: authLoading, hasRole, logout } = useAuth();
  const canAdmin = hasRole('admin');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<OverviewResponse | null>(null);

  const fetchOverview = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/backend/overview', { cache: 'no-store' });
      const result = await response.json();
      if (!result.data) {
        setError(result.error || 'Failed to load backend overview');
        setData(null);
        return;
      }
      setData(result.data as OverviewResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load backend overview');
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverview();
    const interval = setInterval(fetchOverview, 15000);
    return () => clearInterval(interval);
  }, []);

  const statusPill = (name: string, status: ServiceStatus) => (
    <div key={name} className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-zinc-900 dark:text-white capitalize">{name}</p>
        <span
          className={`rounded-full px-2 py-1 text-xs font-semibold ${
            status.ok
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
              : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
          }`}
        >
          {status.ok ? 'Healthy' : 'Unhealthy'}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        {typeof status.latencyMs === 'number' ? `Latency: ${status.latencyMs}ms` : 'Latency: -'}
      </p>
      {status.message ? (
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{status.message}</p>
      ) : null}
    </div>
  );

  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300">
        Loading session...
      </div>
    );
  }

  if (!canAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-900 px-4">
        <div className="w-full max-w-lg rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-6 text-center">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Admin access required</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Only administrators can view backend overview data.</p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/" className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">Back to Dashboard</Link>
            <button onClick={() => logout()} className="rounded-md border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm text-zinc-700 dark:text-zinc-200">Logout</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-900">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
        <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Backend Overview</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Tech stack and live backend health at a glance.</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200">
              {user.username} ({user.role})
            </span>
            <button
              onClick={() => logout()}
              className="rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            >
              Logout
            </button>
            <button
              onClick={fetchOverview}
              className="rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            >
              Refresh
            </button>
            <Link
              href="/"
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Back to Dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8 space-y-6">
        {loading ? <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading backend overview...</p> : null}
        {error ? (
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        ) : null}

        {data ? (
          <>
            <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-5">
              <div className="mb-4 flex items-center justify-between gap-4">
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Service Health</h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Checked: {new Date(data.checkedAt).toLocaleString()}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                {statusPill('mysql', data.services.mysql)}
                {statusPill('mongodb', data.services.mongodb)}
                {statusPill('poller', data.services.poller)}
                {statusPill('postgres', data.services.postgres)}
                {statusPill('rabbitmq', data.services.rabbitmq)}
              </div>
            </section>

            <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-5">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Backend Tech Stack</h2>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left text-zinc-500 dark:text-zinc-400">
                      <th className="py-2 pr-3">Technology</th>
                      <th className="py-2 pr-3">Component</th>
                      <th className="py-2 pr-3">Purpose</th>
                      <th className="py-2">Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stack.map((item) => (
                      <tr key={`${item.name}-${item.component}`} className="border-b border-zinc-100 dark:border-zinc-700/60">
                        <td className="py-2 pr-3 font-medium text-zinc-900 dark:text-zinc-100">{item.name}</td>
                        <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{item.component}</td>
                        <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{item.purpose}</td>
                        <td className="py-2 text-zinc-600 dark:text-zinc-400">{item.version}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
