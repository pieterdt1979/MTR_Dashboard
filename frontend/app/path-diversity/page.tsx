'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/app/auth-provider';

type Device = {
  id: number;
  hostname: string;
  ip_address: string;
  is_active: boolean;
};

type PathInput = {
  id: string;
  deviceId: number;
  site: string;
  linkRole: 'primary' | 'backup' | 'other';
};

type RouteHop = {
  hop: number;
  host: string;
};

type RouteResult = {
  deviceId: number;
  hostname: string;
  ipAddress: string;
  timestamp: string;
  hops: RouteHop[];
  routeSignature: string;
};

type SharedHop = {
  host: string;
  seenInDeviceCount: number;
  seenAtHops: number[];
  affectedDeviceIds: number[];
};

type CompareResponse = {
  hours: number;
  since: string;
  routes: RouteResult[];
  sharedHops: SharedHop[];
  missingDeviceIds: number[];
  risk: {
    level: 'minimal' | 'low' | 'medium' | 'high';
    sharedHopCount: number;
    earlySharedHopCount: number;
  };
};

function newPathInput(): PathInput {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    deviceId: 0,
    site: '',
    linkRole: 'primary',
  };
}

export default function PathDiversityPage() {
  const { user, loading: authLoading, logout } = useAuth();

  const [devices, setDevices] = useState<Device[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [pathInputs, setPathInputs] = useState<PathInput[]>([newPathInput(), newPathInput()]);
  const [rangeHours, setRangeHours] = useState(24);
  const [loadingCompare, setLoadingCompare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareResult, setCompareResult] = useState<CompareResponse | null>(null);

  useEffect(() => {
    const loadDevices = async () => {
      try {
        setLoadingDevices(true);
        setError(null);
        const response = await fetch('/api/devices', { cache: 'no-store' });
        const result = await response.json();
        if (!result.success) {
          throw new Error(result.error || 'Failed to load devices');
        }
        const allDevices = (result.data || []) as Device[];
        setDevices(allDevices.filter((device) => device.is_active));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load devices');
      } finally {
        setLoadingDevices(false);
      }
    };

    loadDevices();
  }, []);

  const updateInput = (id: string, patch: Partial<PathInput>) => {
    setPathInputs((prev) => prev.map((input) => (input.id === id ? { ...input, ...patch } : input)));
  };

  const addPath = () => {
    setPathInputs((prev) => [...prev, newPathInput()]);
  };

  const removePath = (id: string) => {
    setPathInputs((prev) => (prev.length <= 2 ? prev : prev.filter((input) => input.id !== id)));
  };

  const comparePaths = async () => {
    const selectedIds = pathInputs
      .map((input) => input.deviceId)
      .filter((id) => Number.isInteger(id) && id > 0);

    const uniqueIds = [...new Set(selectedIds)];
    if (uniqueIds.length < 2) {
      setError('Select at least two hosts to compare path diversity.');
      return;
    }

    try {
      setLoadingCompare(true);
      setError(null);
      const response = await fetch(
        `/api/mtr/route-compare?deviceIds=${uniqueIds.join(',')}&hours=${rangeHours}`,
        { cache: 'no-store' }
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || 'Failed to compare routes');
      }
      setCompareResult(result.data as CompareResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to compare routes');
      setCompareResult(null);
    } finally {
      setLoadingCompare(false);
    }
  };

  const sharedHopSet = new Set(compareResult?.sharedHops.map((hop) => hop.host) || []);

  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300">
        Loading session...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-900">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Path Diversity</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Compare latest MTR routes for primary/backup circuits and detect potential shared single points of failure.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200">
              {user.username} ({user.role})
            </span>
            <button
              onClick={() => logout()}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Logout
            </button>
            <Link
              href="/"
              className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Back To Dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <section className="mb-6 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-5">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="text-sm text-zinc-700 dark:text-zinc-300">Window</label>
            <select
              value={rangeHours}
              onChange={(e) => setRangeHours(Number(e.target.value))}
              className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
            >
              <option value={1}>Last 1 hour</option>
              <option value={6}>Last 6 hours</option>
              <option value={24}>Last 24 hours</option>
              <option value={72}>Last 72 hours</option>
              <option value={168}>Last 7 days</option>
            </select>
            <button
              onClick={comparePaths}
              disabled={loadingCompare || loadingDevices}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {loadingCompare ? 'Comparing...' : 'Compare Paths'}
            </button>
            <button
              onClick={addPath}
              className="rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            >
              + Add Host Path
            </button>
            <Link
              href="/"
              className="rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            >
              Dashboard
            </Link>
          </div>

          {loadingDevices ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading active hosts...</p>
          ) : null}

          <div className="space-y-3">
            {pathInputs.map((input, idx) => (
              <div key={input.id} className="grid gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 md:grid-cols-[1fr_1fr_140px_auto]">
                <select
                  value={input.deviceId}
                  onChange={(e) => updateInput(input.id, { deviceId: Number(e.target.value) })}
                  className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
                >
                  <option value={0}>Select host path #{idx + 1}</option>
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.hostname} ({device.ip_address})
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={input.site}
                  onChange={(e) => updateInput(input.id, { site: e.target.value })}
                  placeholder="Site label (e.g. Host-A)"
                  className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
                />
                <select
                  value={input.linkRole}
                  onChange={(e) => updateInput(input.id, { linkRole: e.target.value as PathInput['linkRole'] })}
                  className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
                >
                  <option value="primary">Primary</option>
                  <option value="backup">Backup</option>
                  <option value="other">Other</option>
                </select>
                <button
                  onClick={() => removePath(input.id)}
                  disabled={pathInputs.length <= 2}
                  className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </section>

        {error ? (
          <div className="mb-6 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        ) : null}

        {compareResult ? (
          <>
            <section className="mb-6 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-5">
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Risk Summary</h2>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  compareResult.risk.level === 'high'
                    ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                    : compareResult.risk.level === 'medium'
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                      : compareResult.risk.level === 'low'
                        ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
                        : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                }`}>
                  {compareResult.risk.level.toUpperCase()} SPOF Risk
                </span>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Shared hops: {compareResult.risk.sharedHopCount}, early shared hops (hop 1-4): {compareResult.risk.earlySharedHopCount}
                </p>
              </div>

              {compareResult.sharedHops.length === 0 ? (
                <p className="text-sm text-emerald-700 dark:text-emerald-300">No shared hops found across selected routes in the selected window.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-[760px] w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left text-zinc-500 dark:text-zinc-400">
                        <th className="py-2 pr-3">Shared Hop</th>
                        <th className="py-2 pr-3">Seen In</th>
                        <th className="py-2 pr-3">Hop Indexes</th>
                        <th className="py-2">Affected Device IDs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compareResult.sharedHops.map((hop) => (
                        <tr key={hop.host} className="border-b border-zinc-100 dark:border-zinc-700/60">
                          <td className="py-2 pr-3 font-mono text-xs text-zinc-800 dark:text-zinc-200">{hop.host}</td>
                          <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{hop.seenInDeviceCount} routes</td>
                          <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{hop.seenAtHops.join(', ')}</td>
                          <td className="py-2 text-zinc-700 dark:text-zinc-300">{hop.affectedDeviceIds.join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-5">
              <h2 className="mb-3 text-lg font-semibold text-zinc-900 dark:text-white">Visual Route Lanes</h2>
              <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
                Shared nodes are highlighted in red. Compare primary/backup lanes to confirm path diversity.
              </p>

              <div className="space-y-4">
                {compareResult.routes.map((route, routeIdx) => {
                  const mapped = pathInputs.find((input) => input.deviceId === route.deviceId);
                  const laneLabel = mapped?.site
                    ? `${mapped.site} - ${mapped.linkRole.toUpperCase()}`
                    : route.hostname;

                  return (
                    <div key={route.deviceId} className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className={`inline-block h-2.5 w-2.5 rounded-full ${routeIdx % 4 === 0 ? 'bg-blue-500' : routeIdx % 4 === 1 ? 'bg-green-500' : routeIdx % 4 === 2 ? 'bg-amber-500' : 'bg-fuchsia-500'}`} />
                        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{laneLabel}</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">{route.hostname} ({route.ipAddress})</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">Last poll: {new Date(route.timestamp).toLocaleString()}</p>
                      </div>

                      {route.hops.length === 0 ? (
                        <p className="text-sm text-zinc-600 dark:text-zinc-400">No hops available in latest poll.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <div className="flex min-w-[720px] items-center gap-2 py-1">
                            {route.hops.map((hop, i) => {
                              const shared = sharedHopSet.has(hop.host);
                              return (
                                <div key={`${route.deviceId}-${hop.hop}-${i}`} className="flex items-center gap-2">
                                  <div className={`min-w-[110px] rounded-md border px-2 py-1 text-xs ${
                                    shared
                                      ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-900/20 dark:text-red-300'
                                      : 'border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300'
                                  }`}>
                                    <p className="font-semibold">Hop {hop.hop}</p>
                                    <p className="font-mono">{hop.host}</p>
                                  </div>
                                  {i < route.hops.length - 1 ? (
                                    <span className="text-zinc-400 dark:text-zinc-500">→</span>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {compareResult.missingDeviceIds.length > 0 ? (
                <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-700 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                  No recent MTR data found for device IDs: {compareResult.missingDeviceIds.join(', ')} in the selected time window.
                </div>
              ) : null}
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
