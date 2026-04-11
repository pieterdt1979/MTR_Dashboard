'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/auth-provider';

type ProbeMode = 'icmp' | 'tcp' | 'udp';

interface Device {
  id: number;
  ip_address: string;
  hostname: string;
  is_active: boolean;
  probe_mode: ProbeMode;
  probe_port: number | null;
  probe_tos: number | null;
  mtr_count: number;
  jitter_threshold_ms: number | null;
  created_at: string;
  updated_at: string;
}

interface DeviceFormData {
  ip_address: string;
  hostname: string;
  is_active: boolean;
  probe_mode: ProbeMode;
  probe_port: string;
  probe_tos: string;
  mtr_count: string;
  jitter_threshold_ms: string;
}

const DEFAULT_FORM: DeviceFormData = {
  ip_address: '',
  hostname: '',
  is_active: true,
  probe_mode: 'icmp',
  probe_port: '',
  probe_tos: '',
  mtr_count: '10',
  jitter_threshold_ms: '',
};

export default function HostsPage() {
  const { user, loading: authLoading, hasRole, logout } = useAuth();
  const canAdmin = hasRole('admin');

  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formData, setFormData] = useState<DeviceFormData>(DEFAULT_FORM);

  const fetchDevices = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/devices', { cache: 'no-store' });
      const result = await response.json();
      if (!result.success) {
        setError(result.error || 'Failed to fetch devices');
        setDevices([]);
        return;
      }
      setDevices(result.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch devices');
      setDevices([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDevices();
  }, []);

  const filteredDevices = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return devices;
    return devices.filter((device) => {
      return (
        device.hostname.toLowerCase().includes(search) ||
        device.ip_address.toLowerCase().includes(search)
      );
    });
  }, [devices, query]);

  const openCreateForm = () => {
    setEditingId(null);
    setFormData(DEFAULT_FORM);
    setIsFormOpen(true);
    setError(null);
  };

  const openEditForm = (device: Device) => {
    setEditingId(device.id);
    setFormData({
      ip_address: device.ip_address,
      hostname: device.hostname,
      is_active: device.is_active,
      probe_mode: device.probe_mode,
      probe_port: device.probe_port === null ? '' : String(device.probe_port),
      probe_tos: device.probe_tos === null ? '' : String(device.probe_tos),
      mtr_count: String(device.mtr_count ?? 10),
      jitter_threshold_ms: device.jitter_threshold_ms === null ? '' : String(device.jitter_threshold_ms),
    });
    setIsFormOpen(true);
    setError(null);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingId(null);
    setFormData(DEFAULT_FORM);
  };

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value, type } = e.target;
    const checked = type === 'checkbox' && 'checked' in e.target ? e.target.checked : false;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const handleSaveDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      setError(null);

      const payload = {
        ip_address: formData.ip_address.trim(),
        hostname: formData.hostname.trim(),
        is_active: formData.is_active,
        probe_mode: formData.probe_mode,
        probe_port: formData.probe_port.trim() === '' ? null : Number(formData.probe_port),
        probe_tos: formData.probe_tos.trim() === '' ? null : Number(formData.probe_tos),
        mtr_count: Number(formData.mtr_count || '10'),
        jitter_threshold_ms:
          formData.jitter_threshold_ms.trim() === '' ? null : Number(formData.jitter_threshold_ms),
      };

      const method = editingId ? 'PUT' : 'POST';
      const url = editingId ? `/api/devices?id=${editingId}` : '/api/devices';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();

      if (!result.success) {
        setError(result.error || 'Failed to save device');
        return;
      }

      closeForm();
      await fetchDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save device');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (device: Device) => {
    if (!window.confirm(`Delete ${device.hostname} (${device.ip_address})?`)) return;

    try {
      setError(null);
      const response = await fetch(`/api/devices?id=${device.id}`, { method: 'DELETE' });
      const result = await response.json();
      if (!result.success) {
        setError(result.error || 'Failed to delete device');
        return;
      }
      await fetchDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete device');
    }
  };

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
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Only administrators can manage hosts.</p>
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
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Host Management</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Manage host inventory and per-device probe profiles.</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200">
              {user.username} ({user.role})
            </span>
            <button onClick={() => logout()} className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
              Logout
            </button>
            <Link href="/" className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
              Dashboard
            </Link>
            <Link href="/path-diversity" className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
              Path Diversity
            </Link>
            <Link href="/admin-users" className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
              Manage Users
            </Link>
            <button onClick={openCreateForm} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              + Add Host
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-6 py-8">
        {error ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
            {error}
          </div>
        ) : null}

        <section className="mb-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-800">
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Search hosts</label>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by hostname or IP"
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-800">
          {loading ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading hosts...</p>
          ) : filteredDevices.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No hosts match your search.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                    <th className="py-2 pr-3">Host</th>
                    <th className="py-2 pr-3">IP</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Probe Mode</th>
                    <th className="py-2 pr-3">Port</th>
                    <th className="py-2 pr-3">QoS/TOS</th>
                    <th className="py-2 pr-3">Count</th>
                    <th className="py-2 pr-3">Jitter Threshold</th>
                    <th className="py-2 pr-3">Updated</th>
                    <th className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDevices.map((device) => (
                    <tr key={device.id} className="border-b border-zinc-100 dark:border-zinc-700/50">
                      <td className="py-2 pr-3 font-medium text-zinc-900 dark:text-zinc-100">{device.hostname}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-zinc-600 dark:text-zinc-300">{device.ip_address}</td>
                      <td className="py-2 pr-3">
                        <span className={`rounded-full px-2 py-1 text-xs ${device.is_active ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'}`}>
                          {device.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="py-2 pr-3 uppercase text-zinc-800 dark:text-zinc-200">{device.probe_mode}</td>
                      <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{device.probe_port ?? '-'}</td>
                      <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{device.probe_tos ?? '-'}</td>
                      <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{device.mtr_count}</td>
                      <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{device.jitter_threshold_ms ?? '-'}</td>
                      <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">{new Date(device.updated_at).toLocaleString()}</td>
                      <td className="py-2">
                        <div className="flex gap-2">
                          <button onClick={() => openEditForm(device)} className="rounded bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300">
                            Edit
                          </button>
                          <button onClick={() => handleDelete(device)} className="rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300">
                            Delete
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
      </main>

      {isFormOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-6 shadow-xl dark:bg-zinc-950">
            <h2 className="mb-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              {editingId ? 'Edit Host Profile' : 'Add Host'}
            </h2>

            <form onSubmit={handleSaveDevice} className="grid gap-4 md:grid-cols-2">
              <label className="text-sm text-zinc-700 dark:text-zinc-300">
                IP Address *
                <input name="ip_address" value={formData.ip_address} onChange={handleInputChange} required className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
              </label>

              <label className="text-sm text-zinc-700 dark:text-zinc-300">
                Hostname *
                <input name="hostname" value={formData.hostname} onChange={handleInputChange} required className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
              </label>

              <label className="text-sm text-zinc-700 dark:text-zinc-300">
                Probe Mode
                <select name="probe_mode" value={formData.probe_mode} onChange={handleInputChange} className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
                  <option value="icmp">ICMP</option>
                  <option value="tcp">TCP</option>
                  <option value="udp">UDP</option>
                </select>
              </label>

              <label className="text-sm text-zinc-700 dark:text-zinc-300">
                Target Port (optional)
                <input name="probe_port" type="number" min={1} max={65535} value={formData.probe_port} onChange={handleInputChange} placeholder="443" className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
              </label>

              <label className="text-sm text-zinc-700 dark:text-zinc-300">
                QoS/TOS (0-255)
                <input name="probe_tos" type="number" min={0} max={255} value={formData.probe_tos} onChange={handleInputChange} placeholder="46" className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
              </label>

              <label className="text-sm text-zinc-700 dark:text-zinc-300">
                MTR Probe Count
                <input name="mtr_count" type="number" min={1} max={200} value={formData.mtr_count} onChange={handleInputChange} className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
              </label>

              <label className="text-sm text-zinc-700 dark:text-zinc-300">
                Jitter Threshold (ms)
                <input name="jitter_threshold_ms" type="number" min={0} max={500} step="0.1" value={formData.jitter_threshold_ms} onChange={handleInputChange} placeholder="5" className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
              </label>

              <label className="md:col-span-2 flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                <input name="is_active" type="checkbox" checked={formData.is_active} onChange={handleInputChange} />
                Active host
              </label>

              <div className="md:col-span-2 flex justify-end gap-2 pt-2">
                <button type="button" onClick={closeForm} className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                  {saving ? 'Saving...' : editingId ? 'Save Changes' : 'Create Host'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
