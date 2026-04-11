'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/auth-provider';

interface Device {
  id: number;
  ip_address: string;
  hostname: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface ServiceHealth {
  ok: boolean;
  latencyMs?: number;
  message?: string;
}

interface HealthState {
  mysql: ServiceHealth;
  mongodb: ServiceHealth;
  poller: ServiceHealth;
  checkedAt?: string;
}

interface MtrPoint {
  timestamp: string;
  bucketStart: string;
  bucketEnd: string;
  sourceSamples: number;
  fpingLatencyMs: number;
  fpingJitterMs: number;
  fpingLossPct: number;
  reachablePct: number;
  routeChanged: boolean;
}

interface MtrStats {
  deviceId: number;
  hostname: string | null;
  ipAddress: string | null;
  sampleCount: number;
  rawSampleCount: number;
  rangeHours: number;
  rangeStart?: string;
  rangeEnd?: string;
  aggregation: {
    applied: boolean;
    method: 'mean';
    maxPoints: number;
    inputPoints: number;
    outputPoints: number;
    bucketMinutes: number;
  };
  summary: {
    latency: { min: number; max: number; avg: number };
    destinationLatency: { min: number; max: number; avg: number };
    hops: { min: number; max: number; avg: number };
    loss: { min: number; max: number; avg: number };
    destinationLoss: { min: number; max: number; avg: number };
    routeChanges: number;
  };
  points: MtrPoint[];
  routeDiff?: {
    changed: boolean;
    changedAt: string | null;
    firstChangedHop: number | null;
    previousHopCount: number;
    currentHopCount: number;
    previousRoute: string[];
    currentRoute: string[];
  };
}

type Severity = 'healthy' | 'warning' | 'critical';
type HostState = 'healthy' | 'warning' | 'critical' | 'down' | 'route-changed';

interface IssueItem {
  deviceId: number;
  hostname: string;
  ipAddress: string;
  state: HostState;
  severity: Severity;
  reasons: string[];
  routeChanged: boolean;
  lastUpdate: string | null;
  ageSeconds: number | null;
  destinationLatencyMs: number;
  destinationLossPct: number;
  hopCount: number;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  snoozedUntil: string | null;
  snoozed: boolean;
  muted: boolean;
}

interface IssueCounts {
  total: number;
  healthy: number;
  warning: number;
  critical: number;
  down: number;
  routeChanged: number;
  acknowledged: number;
  snoozed: number;
  muted: number;
}

interface RealtimeSession {
  device_id: number;
  active: boolean;
  mode: 'fping';
  interval_sec: number;
  duration_minutes: number;
  started_at: string | null;
  end_at: string | null;
  last_run_at: string | null;
  stop_reason: string | null;
  last_error: string | null;
}

type ProbeMode = 'fping' | 'mtr';

export default function Home() {
  const { user, loading: authLoading, hasRole, logout } = useAuth();
  const canOperate = hasRole('operator');
  const canAdmin = hasRole('admin');

  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formData, setFormData] = useState({
    ip_address: '',
    hostname: '',
    is_active: true,
  });
  const [health, setHealth] = useState<HealthState | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [mtrStats, setMtrStats] = useState<MtrStats | null>(null);
  const [statsRangeMode, setStatsRangeMode] = useState<'preset' | 'custom'>('preset');
  const [statsRangeHours, setStatsRangeHours] = useState(1);
  const [statsMaxPoints, setStatsMaxPoints] = useState(120);
  const [customRangeStart, setCustomRangeStart] = useState(() => {
    const now = new Date();
    const start = new Date(now.getTime() - 1 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}`;
  });
  const [customRangeEnd, setCustomRangeEnd] = useState(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  });
  const [hoveredPoint, setHoveredPoint] = useState<MtrPoint | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  const [issuesLoading, setIssuesLoading] = useState(true);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [issues, setIssues] = useState<IssueItem[]>([]);
  const [issueCounts, setIssueCounts] = useState<IssueCounts | null>(null);
  const [showOnlyIssues, setShowOnlyIssues] = useState(true);
  const [includeMuted, setIncludeMuted] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<'all' | Severity>('all');
  const [stateFilter, setStateFilter] = useState<'all' | HostState>('all');
  const [realtimeSession, setRealtimeSession] = useState<RealtimeSession | null>(null);
  const [realtimeIntervalSec, setRealtimeIntervalSec] = useState(5);
  const [realtimeDurationMin, setRealtimeDurationMin] = useState(15);
  const [realtimeBusy, setRealtimeBusy] = useState(false);
  const [probeBusyMode, setProbeBusyMode] = useState<ProbeMode | null>(null);

  // Fetch devices on component mount
  useEffect(() => {
    fetchHealth();
    fetchIssues(showOnlyIssues, includeMuted);

    const interval = setInterval(() => {
      fetchHealth();
      fetchIssues(showOnlyIssues, includeMuted);
    }, 15000);

    return () => clearInterval(interval);
  }, [showOnlyIssues, includeMuted]);

  const fetchIssues = async (issuesOnly: boolean, includeMutedRows: boolean) => {
    try {
      setIssuesLoading(true);
      setIssuesError(null);
      const response = await fetch(`/api/mtr/issues?includeHealthy=${issuesOnly ? 'false' : 'true'}&includeMuted=${includeMutedRows ? 'true' : 'false'}`, {
        cache: 'no-store',
      });
      const result = await response.json();
      if (!result.success) {
        setIssuesError(result.error || 'Failed to load issue data');
        setIssues([]);
        return;
      }
      setIssues(result.data?.issues || []);
      setIssueCounts(result.data?.counts || null);
    } catch (err) {
      setIssuesError(err instanceof Error ? err.message : 'Failed to load issue data');
      setIssues([]);
    } finally {
      setIssuesLoading(false);
    }
  };

  const applyIncidentAction = async (
    deviceId: number,
    action: 'ack' | 'unack' | 'snooze' | 'unsnooze',
    durationMinutes = 30
  ) => {
    if (!canOperate) {
      setIssuesError('Insufficient permissions for incident actions.');
      return;
    }
    try {
      const response = await fetch('/api/mtr/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, action, durationMinutes }),
      });
      const result = await response.json();
      if (!result.success) {
        setIssuesError(result.error || 'Failed to apply incident action');
      }
      await fetchIssues(showOnlyIssues, includeMuted);
    } catch (err) {
      setIssuesError(err instanceof Error ? err.message : 'Failed to apply incident action');
    }
  };

  const fetchHealth = async () => {
    try {
      setHealthLoading(true);
      const response = await fetch('/api/health', { cache: 'no-store' });
      const result = await response.json();

      if (result?.data?.mysql && result?.data?.mongodb && result?.data?.poller) {
        setHealth(result.data as HealthState);
      }
    } catch {
      setHealth({
        mysql: { ok: false, message: 'Health endpoint unreachable' },
        mongodb: { ok: false, message: 'Health endpoint unreachable' },
        poller: { ok: false, message: 'Health endpoint unreachable' },
      });
    } finally {
      setHealthLoading(false);
    }
  };

  const HealthBadge = ({ label, status }: { label: string; status: ServiceHealth | undefined }) => {
    const isOk = !!status?.ok;
    return (
      <div
        title={status?.message || `${label} is ${isOk ? 'healthy' : 'unreachable'}`}
        className="flex items-center gap-2 rounded-full border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5"
      >
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            isOk ? 'bg-emerald-500' : 'bg-red-500'
          }`}
        />
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
        {typeof status?.latencyMs === 'number' ? (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{status.latencyMs}ms</span>
        ) : null}
      </div>
    );
  };

  const fetchDevices = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/devices');
      
      if (!response.ok) {
        throw new Error('Failed to fetch devices');
      }

      const result = await response.json();
      if (result.success) {
        setDevices(result.data || []);
      } else {
        setError(result.error || 'Failed to fetch devices');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const fetchMtrStats = useCallback(async (
    deviceId: number,
    options?: {
      hours?: number;
      maxPoints?: number;
      startIso?: string;
      endIso?: string;
    }
  ) => {
    try {
      setStatsLoading(true);
      setStatsError(null);
      setSelectedDeviceId(deviceId);
      setHoveredPoint(null);
      setTooltip(null);

      const params = new URLSearchParams({
        deviceId: String(deviceId),
        maxPoints: String(options?.maxPoints ?? statsMaxPoints),
        includeRealtime: 'true',
      });

      if (options?.startIso && options?.endIso) {
        params.set('start', options.startIso);
        params.set('end', options.endIso);
      } else {
        params.set('hours', String(options?.hours ?? statsRangeHours));
      }

      const response = await fetch(`/api/mtr/stats?${params.toString()}`, {
        cache: 'no-store',
      });
      const result = await response.json();

      if (!result.success) {
        setStatsError(result.error || 'Failed to load MTR statistics');
        setMtrStats(null);
        return;
      }

      setMtrStats(result.data as MtrStats);
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : 'Failed to load MTR statistics');
      setMtrStats(null);
    } finally {
      setStatsLoading(false);
    }
  }, [statsMaxPoints, statsRangeHours]);

  const fetchRealtimeSession = useCallback(async (deviceId: number) => {
    try {
      const response = await fetch(`/api/mtr/realtime?deviceId=${deviceId}`, { cache: 'no-store' });
      const result = await response.json();
      if (!result.success) {
        setRealtimeSession(null);
        return;
      }
      setRealtimeSession(result.data as RealtimeSession);
    } catch {
      setRealtimeSession(null);
    }
  }, []);

  const triggerProbeNow = async (mode: ProbeMode) => {
    if (!canOperate) {
      setStatsError('Insufficient permissions for probe actions.');
      return;
    }
    if (selectedDeviceId === null) return;
    try {
      setProbeBusyMode(mode);
      setStatsError(null);
      const response = await fetch('/api/mtr/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: selectedDeviceId, mode }),
      });
      const result = await response.json();
      if (!result.success) {
        setStatsError(result.error || `Failed to run ${mode} probe`);
        return;
      }
      setTimeout(() => {
        refetchSelectedStats();
      }, mode === 'mtr' ? 4000 : 1500);
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : `Failed to run ${mode} probe`);
    } finally {
      setProbeBusyMode(null);
    }
  };

  const updateRealtimeSession = async (action: 'start' | 'stop') => {
    if (!canOperate) {
      setStatsError('Insufficient permissions for realtime actions.');
      return;
    }
    if (selectedDeviceId === null) return;
    try {
      setRealtimeBusy(true);
      setStatsError(null);
      const response = await fetch('/api/mtr/realtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: selectedDeviceId,
          action,
          mode: 'fping',
          intervalSec: realtimeIntervalSec,
          durationMinutes: realtimeDurationMin,
        }),
      });
      const result = await response.json();
      if (!result.success) {
        setStatsError(result.error || 'Failed to update realtime session');
        return;
      }

      if (action === 'start') {
        setStatsRangeMode('preset');
        setStatsRangeHours(1);
        setStatsMaxPoints(240);
      }

      await fetchRealtimeSession(selectedDeviceId);
      if (action === 'start') {
        await fetchMtrStats(selectedDeviceId, { hours: 1, maxPoints: 240 });
      } else {
        await refetchSelectedStats();
      }
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : 'Failed to update realtime session');
    } finally {
      setRealtimeBusy(false);
    }
  };

  const parseCustomRange = (): { startIso: string; endIso: string } | null => {
    if (!customRangeStart || !customRangeEnd) {
      setStatsError('Custom range requires both start and end values.');
      return null;
    }

    const start = new Date(customRangeStart);
    const end = new Date(customRangeEnd);

    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
      setStatsError('Custom range contains invalid date values.');
      return null;
    }

    if (end <= start) {
      setStatsError('Custom range end must be after start.');
      return null;
    }

    const durationMs = end.getTime() - start.getTime();
    if (durationMs > 30 * 24 * 60 * 60 * 1000) {
      setStatsError('Custom range cannot exceed 30 days.');
      return null;
    }

    return { startIso: start.toISOString(), endIso: end.toISOString() };
  };

  const loadStatsForDevice = (deviceId: number, override?: { hours?: number; maxPoints?: number }) => {
    if (statsRangeMode === 'custom') {
      const custom = parseCustomRange();
      if (!custom) return;
      fetchMtrStats(deviceId, {
        maxPoints: override?.maxPoints ?? statsMaxPoints,
        startIso: custom.startIso,
        endIso: custom.endIso,
      });
      fetchRealtimeSession(deviceId);
      return;
    }

    fetchMtrStats(deviceId, {
      hours: override?.hours ?? statsRangeHours,
      maxPoints: override?.maxPoints ?? statsMaxPoints,
    });
    fetchRealtimeSession(deviceId);
  };

  const refetchSelectedStats = (override?: { hours?: number; maxPoints?: number }) => {
    if (selectedDeviceId === null) return;
    loadStatsForDevice(selectedDeviceId, override);
  };

  // Refresh faster while realtime probe sessions are active.
  useEffect(() => {
    if (selectedDeviceId === null || (!mtrStats && !statsLoading && !statsError)) {
      return;
    }

    const refreshIntervalMs = realtimeSession?.active ? 5000 : 5 * 60 * 1000;

    const interval = setInterval(() => {
      if (statsRangeMode === 'custom') {
        if (!customRangeStart || !customRangeEnd) {
          return;
        }

        const start = new Date(customRangeStart);
        const end = new Date(customRangeEnd);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
          return;
        }

        fetchMtrStats(selectedDeviceId, {
          maxPoints: statsMaxPoints,
          startIso: start.toISOString(),
          endIso: end.toISOString(),
        });
        if (realtimeSession?.active) {
          fetchRealtimeSession(selectedDeviceId);
        }
        return;
      }

      fetchMtrStats(selectedDeviceId, {
        hours: statsRangeHours,
        maxPoints: statsMaxPoints,
      });
      if (realtimeSession?.active) {
        fetchRealtimeSession(selectedDeviceId);
      }
    }, refreshIntervalMs);

    return () => clearInterval(interval);
  }, [
    selectedDeviceId,
    mtrStats,
    statsLoading,
    statsError,
    statsRangeMode,
    statsRangeHours,
    statsMaxPoints,
    realtimeSession?.active,
    customRangeStart,
    customRangeEnd,
    fetchMtrStats,
    fetchRealtimeSession,
  ]);

  const formatTimeLabel = (timestamp: string): string => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const filteredIssues = issues.filter((item) => {
    if (severityFilter !== 'all' && item.severity !== severityFilter) return false;
    if (stateFilter !== 'all' && item.state !== stateFilter) return false;
    return true;
  });

  const stateBadgeClass = (state: HostState) => {
    if (state === 'down') return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    if (state === 'critical') return 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300';
    if (state === 'warning' || state === 'route-changed') {
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
    }
    return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300';
  };

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const handleAddDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      const method = editingId ? 'PUT' : 'POST';
      const url = editingId 
        ? `/api/devices?id=${editingId}` 
        : '/api/devices';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const result = await response.json();

      if (result.success) {
        await fetchDevices();
        setFormData({ ip_address: '', hostname: '', is_active: true });
        setIsFormOpen(false);
        setEditingId(null);
      } else {
        setError(result.error || 'Failed to save device');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const handleEditDevice = (device: Device) => {
    setFormData({
      ip_address: device.ip_address,
      hostname: device.hostname,
      is_active: device.is_active,
    });
    setEditingId(device.id);
    setIsFormOpen(true);
  };

  const handleDeleteDevice = async (id: number) => {
    if (!confirm('Are you sure you want to delete this device?')) return;

    try {
      const response = await fetch(`/api/devices?id=${id}`, {
        method: 'DELETE',
      });

      const result = await response.json();

      if (result.success) {
        await fetchDevices();
      } else {
        setError(result.error || 'Failed to delete device');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingId(null);
    setFormData({ ip_address: '', hostname: '', is_active: true });
    setError(null);
  };

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
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-lg">MTR</span>
              </div>
              <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">
                MTR Dashboard
              </h1>
            </div>
            <div className="flex items-center gap-3">
              {healthLoading ? (
                <div className="text-xs text-zinc-500 dark:text-zinc-400">Checking DB health...</div>
              ) : (
                <>
                  <HealthBadge label="MySQL" status={health?.mysql} />
                  <HealthBadge label="MongoDB" status={health?.mongodb} />
                  <HealthBadge label="Poller" status={health?.poller} />
                </>
              )}
              <Link
                href="/path-diversity"
                className="px-3 py-2 border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                Path Diversity
              </Link>
              {canAdmin ? (
                <Link
                  href="/backend-overview"
                  className="px-3 py-2 border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                >
                  Backend Overview
                </Link>
              ) : null}
              {canAdmin ? (
                <Link
                  href="/admin-users"
                  className="px-3 py-2 border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                >
                  Manage Users
                </Link>
              ) : null}
              {canAdmin ? (
                <Link
                  href="/hosts"
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Manage Hosts
                </Link>
              ) : null}
              <span className="text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200">
                {user.username} ({user.role})
              </span>
              <button
                onClick={() => logout()}
                className="px-3 py-2 border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <section className="mb-6 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-5">
          <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <button
              onClick={() => {
                setShowOnlyIssues(true);
                setSeverityFilter('critical');
                setStateFilter('all');
              }}
              className="rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/20 px-3 py-2 text-left"
            >
              <p className="text-xs text-rose-700 dark:text-rose-300">Critical</p>
              <p className="text-xl font-semibold text-rose-800 dark:text-rose-200">{issueCounts?.critical ?? '-'}</p>
            </button>
            <button
              onClick={() => {
                setShowOnlyIssues(true);
                setSeverityFilter('all');
                setStateFilter('down');
              }}
              className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-left"
            >
              <p className="text-xs text-red-700 dark:text-red-300">Down</p>
              <p className="text-xl font-semibold text-red-800 dark:text-red-200">{issueCounts?.down ?? '-'}</p>
            </button>
            <button
              onClick={() => {
                setShowOnlyIssues(true);
                setSeverityFilter('all');
                setStateFilter('route-changed');
              }}
              className="rounded-lg border border-fuchsia-300 dark:border-fuchsia-800 bg-fuchsia-50 dark:bg-fuchsia-900/20 px-3 py-2 text-left"
            >
              <p className="text-xs text-fuchsia-700 dark:text-fuchsia-300">Route Changed</p>
              <p className="text-xl font-semibold text-fuchsia-800 dark:text-fuchsia-200">{issueCounts?.routeChanged ?? '-'}</p>
            </button>
            <button
              onClick={() => setIncludeMuted((v) => !v)}
              className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-left"
            >
              <p className="text-xs text-amber-700 dark:text-amber-300">Muted (Ack/Snoozed)</p>
              <p className="text-xl font-semibold text-amber-800 dark:text-amber-200">{issueCounts?.muted ?? '-'}</p>
              <p className="text-xs text-amber-700 dark:text-amber-300">{includeMuted ? 'Included' : 'Hidden'}</p>
            </button>
            <button
              onClick={() => {
                setShowOnlyIssues(true);
                setSeverityFilter('all');
                setStateFilter('all');
              }}
              className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-left"
            >
              <p className="text-xs text-zinc-600 dark:text-zinc-400">Open Incidents</p>
              <p className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{(issueCounts?.critical ?? 0) + (issueCounts?.warning ?? 0)}</p>
            </button>
          </div>

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Issues View</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">Focus on unhealthy hosts, route changes, and destination quality.</p>
            </div>
            <button
              onClick={() => {
                const next = !showOnlyIssues;
                setShowOnlyIssues(next);
                fetchIssues(next, includeMuted);
              }}
              className="rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            >
              {showOnlyIssues ? 'Showing: Issues Only' : 'Showing: All Hosts'}
            </button>
          </div>

          <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Total Hosts</p>
              <p className="text-xl font-semibold text-zinc-900 dark:text-white">{issueCounts?.total ?? '-'}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Critical</p>
              <p className="text-xl font-semibold text-rose-700 dark:text-rose-300">{issueCounts?.critical ?? '-'}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Warning</p>
              <p className="text-xl font-semibold text-amber-700 dark:text-amber-300">{issueCounts?.warning ?? '-'}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Down</p>
              <p className="text-xl font-semibold text-red-700 dark:text-red-300">{issueCounts?.down ?? '-'}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Route Changes</p>
              <p className="text-xl font-semibold text-fuchsia-700 dark:text-fuchsia-300">{issueCounts?.routeChanged ?? '-'}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Healthy</p>
              <p className="text-xl font-semibold text-emerald-700 dark:text-emerald-300">{issueCounts?.healthy ?? '-'}</p>
            </div>
          </div>

          <div className="mb-3 flex flex-wrap gap-2">
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value as 'all' | Severity)}
              className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
            >
              <option value="all">Severity: All</option>
              <option value="critical">Severity: Critical</option>
              <option value="warning">Severity: Warning</option>
              <option value="healthy">Severity: Healthy</option>
            </select>
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value as 'all' | HostState)}
              className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
            >
              <option value="all">State: All</option>
              <option value="down">State: Down</option>
              <option value="critical">State: Critical</option>
              <option value="warning">State: Warning</option>
              <option value="route-changed">State: Route Changed</option>
              <option value="healthy">State: Healthy</option>
            </select>
          </div>

          {issuesLoading ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading issues...</p>
          ) : issuesError ? (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
              {issuesError}
            </div>
          ) : filteredIssues.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No hosts match the current filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left text-zinc-500 dark:text-zinc-400">
                    <th className="py-2 pr-3">Host</th>
                    <th className="py-2 pr-3">State</th>
                    <th className="py-2 pr-3">Dest Latency</th>
                    <th className="py-2 pr-3">Dest Loss</th>
                    <th className="py-2 pr-3">Hops</th>
                    <th className="py-2 pr-3">Last Update</th>
                    <th className="py-2 pr-3">Reason</th>
                    <th className="py-2 pr-3">Suppression</th>
                    <th className="py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredIssues.map((issue) => (
                    <tr key={issue.deviceId} className="border-b border-zinc-100 dark:border-zinc-700/60">
                      <td className="py-2 pr-3">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">{issue.hostname}</div>
                        <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{issue.ipAddress}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <span className={`rounded-full px-2 py-1 text-xs font-semibold ${stateBadgeClass(issue.state)}`}>
                          {issue.state}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-zinc-800 dark:text-zinc-200">{issue.destinationLatencyMs.toFixed(2)} ms</td>
                      <td className="py-2 pr-3 text-zinc-800 dark:text-zinc-200">{issue.destinationLossPct.toFixed(2)}%</td>
                      <td className="py-2 pr-3 text-zinc-800 dark:text-zinc-200">{issue.hopCount}</td>
                      <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">
                        {issue.lastUpdate ? new Date(issue.lastUpdate).toLocaleString() : 'No data'}
                      </td>
                      <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">{issue.reasons[0]}</td>
                      <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">
                        {issue.snoozed ? (
                          <span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                            Snoozed until {issue.snoozedUntil ? new Date(issue.snoozedUntil).toLocaleTimeString() : '-'}
                          </span>
                        ) : issue.acknowledged ? (
                          <span className="rounded bg-blue-100 px-2 py-1 text-xs text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">Acknowledged</span>
                        ) : (
                          <span className="text-xs">None</span>
                        )}
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1">
                          <button
                            onClick={() => loadStatsForDevice(issue.deviceId)}
                            className="rounded bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300"
                          >
                            Investigate
                          </button>
                          <button
                            onClick={() => applyIncidentAction(issue.deviceId, issue.acknowledged ? 'unack' : 'ack')}
                            disabled={!canOperate}
                            className="rounded bg-indigo-100 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300"
                          >
                            {issue.acknowledged ? 'Unack' : 'Ack'}
                          </button>
                          <button
                            onClick={() => applyIncidentAction(issue.deviceId, issue.snoozed ? 'unsnooze' : 'snooze', 30)}
                            disabled={!canOperate}
                            className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-300"
                          >
                            {issue.snoozed ? 'Unsnooze' : 'Snooze 30m'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {error && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-red-800 dark:text-red-300 text-sm">{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-sm mt-2 text-red-700 dark:text-red-400 hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {(statsLoading || statsError || mtrStats) && (
          <section className="mb-6 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">MTR Statistics</h2>
                {mtrStats?.hostname || mtrStats?.ipAddress ? (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    {mtrStats?.hostname || 'Unknown host'}
                    {mtrStats?.ipAddress ? ` (${mtrStats.ipAddress})` : ''}
                  </p>
                ) : selectedDeviceId !== null ? (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">Device ID: {selectedDeviceId}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={statsRangeMode}
                  onChange={(e) => {
                    const nextMode = e.target.value as 'preset' | 'custom';
                    setStatsRangeMode(nextMode);
                    if (selectedDeviceId === null) return;

                    if (nextMode === 'custom') {
                      const custom = parseCustomRange();
                      if (!custom) return;
                      fetchMtrStats(selectedDeviceId, {
                        maxPoints: statsMaxPoints,
                        startIso: custom.startIso,
                        endIso: custom.endIso,
                      });
                      return;
                    }

                    fetchMtrStats(selectedDeviceId, {
                      hours: statsRangeHours,
                      maxPoints: statsMaxPoints,
                    });
                  }}
                  className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-xs"
                >
                  <option value="preset">Preset range</option>
                  <option value="custom">Custom range</option>
                </select>
                <select
                  value={statsRangeHours}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setStatsRangeHours(next);
                    if (statsRangeMode === 'preset' && selectedDeviceId !== null) {
                      fetchMtrStats(selectedDeviceId, {
                        hours: next,
                        maxPoints: statsMaxPoints,
                      });
                    }
                  }}
                  disabled={statsRangeMode !== 'preset'}
                  className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-xs disabled:opacity-50"
                >
                  <option value={1}>Last 1h</option>
                  <option value={6}>Last 6h</option>
                  <option value={24}>Last 24h</option>
                  <option value={72}>Last 72h</option>
                  <option value={168}>Last 7d</option>
                  <option value={720}>Last 30d</option>
                </select>
                <select
                  value={statsMaxPoints}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setStatsMaxPoints(next);
                    refetchSelectedStats({ maxPoints: next });
                  }}
                  className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-xs"
                >
                  <option value={72}>Compact (~72 points)</option>
                  <option value={120}>Balanced (~120 points)</option>
                  <option value={180}>Detailed (~180 points)</option>
                  <option value={240}>Dense (~240 points)</option>
                </select>
                <button
                  onClick={() => refetchSelectedStats()}
                  className="rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                >
                  Refresh
                </button>
                <button
                  onClick={() => {
                    setMtrStats(null);
                    setStatsError(null);
                    setSelectedDeviceId(null);
                    setRealtimeSession(null);
                    setHoveredPoint(null);
                    setTooltip(null);
                  }}
                  className="text-sm text-zinc-600 dark:text-zinc-300 hover:underline"
                >
                  Close
                </button>
              </div>
            </div>

            {statsRangeMode === 'custom' ? (
              <div className="mb-3 grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                <label className="text-xs text-zinc-600 dark:text-zinc-400">
                  Start
                  <input
                    type="datetime-local"
                    value={customRangeStart}
                    onChange={(e) => setCustomRangeStart(e.target.value)}
                    className="mt-1 w-full rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-xs"
                  />
                </label>
                <label className="text-xs text-zinc-600 dark:text-zinc-400">
                  End
                  <input
                    type="datetime-local"
                    value={customRangeEnd}
                    onChange={(e) => setCustomRangeEnd(e.target.value)}
                    className="mt-1 w-full rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-xs"
                  />
                </label>
                <div className="flex items-end">
                  <button
                    onClick={() => refetchSelectedStats()}
                    className="w-full rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300"
                  >
                    Apply Custom Range
                  </button>
                </div>
              </div>
            ) : null}

            {selectedDeviceId !== null ? (
              <div className="mb-3 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => triggerProbeNow('fping')}
                    disabled={!canOperate || probeBusyMode !== null}
                    className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300"
                  >
                    {probeBusyMode === 'fping' ? 'Running FPing...' : 'Poll Now (FPing)'}
                  </button>
                  <button
                    onClick={() => triggerProbeNow('mtr')}
                    disabled={!canOperate || probeBusyMode !== null}
                    className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300"
                  >
                    {probeBusyMode === 'mtr' ? 'Running MTR...' : 'Poll Now (MTR)'}
                  </button>
                  <select
                    value={realtimeIntervalSec}
                    onChange={(e) => setRealtimeIntervalSec(Number(e.target.value))}
                    className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-xs"
                  >
                    <option value={3}>Realtime every 3s</option>
                    <option value={5}>Realtime every 5s</option>
                    <option value={10}>Realtime every 10s</option>
                    <option value={15}>Realtime every 15s</option>
                  </select>
                  <select
                    value={realtimeDurationMin}
                    onChange={(e) => setRealtimeDurationMin(Number(e.target.value))}
                    className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-xs"
                  >
                    <option value={5}>Duration 5m</option>
                    <option value={15}>Duration 15m</option>
                    <option value={30}>Duration 30m</option>
                    <option value={60}>Duration 60m</option>
                  </select>
                  {realtimeSession?.active ? (
                    <button
                      onClick={() => updateRealtimeSession('stop')}
                      disabled={!canOperate || realtimeBusy}
                      className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
                    >
                      {realtimeBusy ? 'Stopping...' : 'Stop Realtime FPing'}
                    </button>
                  ) : (
                    <button
                      onClick={() => updateRealtimeSession('start')}
                      disabled={!canOperate || realtimeBusy}
                      className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
                    >
                      {realtimeBusy ? 'Starting...' : 'Start Realtime FPing'}
                    </button>
                  )}
                </div>
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {realtimeSession?.active
                    ? `Realtime active until ${realtimeSession.end_at ? new Date(realtimeSession.end_at).toLocaleTimeString() : '-'} (graph refreshes every 5s).`
                    : 'Realtime disabled. Graph refreshes on normal cadence.'}
                </p>
              </div>
            ) : null}

            {statsLoading ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading probe statistics...</p>
            ) : null}

            {statsError ? (
              <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3">
                <p className="text-sm text-red-700 dark:text-red-300">{statsError}</p>
              </div>
            ) : null}

            {mtrStats ? (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">FPing Latency Avg</p>
                    <p className="text-xl font-semibold text-zinc-900 dark:text-white">{mtrStats.summary.destinationLatency.avg} ms</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">min {mtrStats.summary.destinationLatency.min} / max {mtrStats.summary.destinationLatency.max}</p>
                  </div>
                  <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">Previous Hop Count</p>
                    <p className="text-xl font-semibold text-zinc-900 dark:text-white">{mtrStats.routeDiff?.previousHopCount ?? '-'}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">Current hop count: {mtrStats.routeDiff?.currentHopCount ?? '-'}</p>
                  </div>
                  <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">FPing Packet Loss Avg</p>
                    <p className="text-xl font-semibold text-zinc-900 dark:text-white">{mtrStats.summary.destinationLoss.avg}%</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      Raw samples: {mtrStats.rawSampleCount} / Plotted: {mtrStats.sampleCount}
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/40 p-3 text-xs text-zinc-600 dark:text-zinc-300">
                  <p className="mb-1">
                    Range: {mtrStats.rangeStart ? new Date(mtrStats.rangeStart).toLocaleString() : '-'} - {mtrStats.rangeEnd ? new Date(mtrStats.rangeEnd).toLocaleString() : '-'}
                  </p>
                  {mtrStats.aggregation.applied
                    ? `Aggregated by mean into ~${mtrStats.aggregation.outputPoints} points (${mtrStats.aggregation.bucketMinutes} minute buckets) for readability.`
                    : 'Showing raw polling points (no aggregation needed for this selected range/density).'}
                </div>

                <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
                  <p className="mb-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">FPing Latency + Jitter Over Time</p>
                  <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">Green line = fping latency, cyan bars = fping jitter, orange line = packet loss. Route changes remain in the comparison panel below.</p>
                  {(() => {
                    const points = mtrStats.points;
                    const width = 860;
                    const height = 260;
                    const margin = { top: 16, right: 48, bottom: 28, left: 48 };
                    const innerW = width - margin.left - margin.right;
                    const innerH = height - margin.top - margin.bottom;

                    const latencies = points.map((p) => p.fpingLatencyMs);
                    const jitters = points.map((p) => p.fpingJitterMs);
                    const losses = points.map((p) => p.fpingLossPct);
                    const maxLatency = Math.max(...latencies, 1) * 1.15;
                    const maxJitter = Math.max(...jitters, 1);
                    const maxLoss = 100;

                    const xFor = (i: number) =>
                      margin.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
                    const yLatency = (v: number) => margin.top + (1 - v / maxLatency) * innerH;
                    const yJitter = (v: number) => margin.top + (1 - v / maxJitter) * innerH;
                    const yLoss = (v: number) => margin.top + (1 - Math.max(0, Math.min(v, maxLoss)) / maxLoss) * innerH;

                    const linePath = points
                      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(2)} ${yLatency(p.fpingLatencyMs).toFixed(2)}`)
                      .join(' ');
                    const lossPath = points
                      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(2)} ${yLoss(p.fpingLossPct).toFixed(2)}`)
                      .join(' ');

                    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
                      const value = Number((maxLatency * t).toFixed(1));
                      const y = yLatency(value);
                      return { value, y };
                    });

                    const desiredXLabels = 6;
                    const xLabelIndexes = Array.from({ length: desiredXLabels }, (_, i) =>
                      Math.round((i / Math.max(desiredXLabels - 1, 1)) * Math.max(points.length - 1, 0))
                    ).filter((idx, pos, arr) => idx >= 0 && arr.indexOf(idx) === pos);

                    return (
                      <div className="relative overflow-x-auto" onMouseLeave={() => {
                        setHoveredPoint(null);
                        setTooltip(null);
                      }}>
                        <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[720px] w-full h-64">
                          {yTicks.map((tick) => (
                            <g key={tick.y}>
                              <line
                                x1={margin.left}
                                y1={tick.y}
                                x2={width - margin.right}
                                y2={tick.y}
                                className="stroke-zinc-200 dark:stroke-zinc-700"
                                strokeDasharray="4 4"
                              />
                              <text
                                x={margin.left - 8}
                                y={tick.y + 4}
                                textAnchor="end"
                                className="fill-zinc-500 text-[10px]"
                              >
                                {tick.value}
                              </text>
                            </g>
                          ))}

                          {points.map((point, i) => {
                            const x = xFor(i);
                            const barWidth = Math.max(4, innerW / Math.max(points.length * 2, 16));
                            const barTop = yJitter(point.fpingJitterMs);
                            const barHeight = margin.top + innerH - barTop;
                            return (
                              <g key={`${point.timestamp}-${i}`}>
                                <rect
                                  x={x - barWidth / 2}
                                  y={barTop}
                                  width={barWidth}
                                  height={barHeight}
                                  className="fill-cyan-200 dark:fill-cyan-700/70"
                                  opacity="0.8"
                                />
                              </g>
                            );
                          })}

                          <path d={linePath} fill="none" strokeWidth="2.5" className="stroke-emerald-500" />
                          <path d={lossPath} fill="none" strokeWidth="2" className="stroke-orange-500" strokeDasharray="5 3" />
                          {points.map((point, i) => (
                            <g key={`p-${point.timestamp}-${i}`}>
                              <circle
                                cx={xFor(i)}
                                cy={yLatency(point.fpingLatencyMs)}
                                r={2.5}
                                className="fill-emerald-500"
                              />
                              <circle
                                cx={xFor(i)}
                                cy={yLoss(point.fpingLossPct)}
                                r={2}
                                className="fill-orange-500"
                              />
                              <circle
                                cx={xFor(i)}
                                cy={yLatency(point.fpingLatencyMs)}
                                r={8}
                                fill="transparent"
                                onMouseEnter={(event) => {
                                  const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                                  if (!rect) return;
                                  setHoveredPoint(point);
                                  setTooltip({
                                    x: event.clientX - rect.left,
                                    y: event.clientY - rect.top,
                                  });
                                }}
                                onMouseMove={(event) => {
                                  const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                                  if (!rect) return;
                                  setTooltip({
                                    x: event.clientX - rect.left,
                                    y: event.clientY - rect.top,
                                  });
                                }}
                              />
                            </g>
                          ))}

                          {xLabelIndexes.map((idx) => (
                            <text
                              key={`x-${idx}`}
                              x={xFor(idx)}
                              y={height - 8}
                              textAnchor="middle"
                              className="fill-zinc-500 text-[10px]"
                            >
                              {formatTimeLabel(points[idx].timestamp)}
                            </text>
                          ))}

                          <text x={margin.left} y={12} className="fill-zinc-500 text-[10px]">Latency (ms)</text>
                          <text x={width - margin.right + 8} y={12} className="fill-zinc-500 text-[10px]">Jitter (ms)</text>
                          <text x={width - margin.right + 8} y={margin.top + 4} className="fill-zinc-500 text-[10px]">{maxJitter.toFixed(1)}</text>
                          <text x={width - margin.right + 8} y={margin.top + innerH + 4} className="fill-zinc-500 text-[10px]">0</text>
                          <text x={margin.left + 86} y={12} className="fill-orange-500 text-[10px]">Loss (%) 0-100</text>
                        </svg>
                        {hoveredPoint && tooltip ? (
                          <div
                            className="pointer-events-none absolute z-10 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white/95 dark:bg-zinc-900/95 px-3 py-2 text-xs shadow-lg"
                            style={{ left: Math.min(tooltip.x + 12, 600), top: Math.max(tooltip.y - 120, 8) }}
                          >
                            <p className="font-semibold text-zinc-900 dark:text-zinc-100">{new Date(hoveredPoint.timestamp).toLocaleString()}</p>
                            <p className="text-zinc-700 dark:text-zinc-300">Bucket: {new Date(hoveredPoint.bucketStart).toLocaleTimeString()} - {new Date(hoveredPoint.bucketEnd).toLocaleTimeString()}</p>
                            <p className="text-zinc-700 dark:text-zinc-300">Samples: {hoveredPoint.sourceSamples}</p>
                            <p className="text-zinc-700 dark:text-zinc-300">FPing latency: {hoveredPoint.fpingLatencyMs.toFixed(2)} ms</p>
                            <p className="text-zinc-700 dark:text-zinc-300">FPing jitter: {hoveredPoint.fpingJitterMs.toFixed(2)} ms</p>
                            <p className="text-zinc-700 dark:text-zinc-300">FPing loss: {hoveredPoint.fpingLossPct.toFixed(2)}%</p>
                            <p className="text-zinc-700 dark:text-zinc-300">Reachability: {hoveredPoint.reachablePct.toFixed(2)}%</p>
                          </div>
                        ) : null}
                      </div>
                    );
                  })()}
                </div>

                <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
                  <p className="mb-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">Route Diff (Latest vs Previous Poll)</p>
                  {mtrStats.routeDiff?.changed ? (
                    <div className="space-y-2 text-sm">
                      <p className="text-amber-700 dark:text-amber-300">
                        Route changed at hop {mtrStats.routeDiff.firstChangedHop ?? '?'}
                        {mtrStats.routeDiff.changedAt ? ` (${new Date(mtrStats.routeDiff.changedAt).toLocaleString()})` : ''}
                      </p>
                      <p className="text-zinc-600 dark:text-zinc-400">
                        <span className="font-medium">Previous:</span> {mtrStats.routeDiff.previousRoute.join(' -> ')}
                      </p>
                      <p className="text-zinc-700 dark:text-zinc-300">
                        <span className="font-medium">Current:</span> {mtrStats.routeDiff.currentRoute.join(' -> ')}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-emerald-700 dark:text-emerald-300">No route change between latest two polls.</p>
                  )}
                </div>
              </div>
            ) : null}
          </section>
        )}

        {canAdmin ? (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-5">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Host Lifecycle Management</h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Device create, edit, search, and delete operations have moved to the dedicated hosts page to keep this dashboard health-focused.
          </p>
          <div className="mt-4">
            <Link
              href="/hosts"
              className="inline-flex rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Open Host Management
            </Link>
          </div>
        </section>
        ) : null}
      </main>
    </div>
  );
}
