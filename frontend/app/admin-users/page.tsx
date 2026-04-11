'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { useAuth } from '@/app/auth-provider';

type UserRole = 'viewer' | 'operator' | 'admin';

type AdminUser = {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  token_count?: number;
};

type ApiToken = {
  id: number;
  user_id: number;
  username: string;
  token_name: string;
  token_prefix: string;
  role: UserRole;
  is_active: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export default function AdminUsersPage() {
  const { user, loading: authLoading, hasRole, logout } = useAuth();
  const canAdmin = hasRole('admin');

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newUser, setNewUser] = useState({
    username: '',
    displayName: '',
    role: 'viewer' as UserRole,
    password: '',
  });

  const [tokenForm, setTokenForm] = useState({
    userId: '',
    tokenName: '',
    role: 'viewer' as UserRole,
    expiresAt: '',
  });
  const [newTokenValue, setNewTokenValue] = useState<string | null>(null);

  async function loadData() {
    try {
      setLoading(true);
      setError(null);
      const [usersRes, tokensRes] = await Promise.all([
        fetch('/api/admin/users', { cache: 'no-store' }),
        fetch('/api/admin/tokens', { cache: 'no-store' }),
      ]);

      const usersJson = await usersRes.json();
      const tokensJson = await tokensRes.json();

      if (!usersRes.ok || !usersJson.success) {
        throw new Error(usersJson.error || 'Failed to load users');
      }
      if (!tokensRes.ok || !tokensJson.success) {
        throw new Error(tokensJson.error || 'Failed to load tokens');
      }

      setUsers(usersJson.data || []);
      setTokens(tokensJson.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin data');
      setUsers([]);
      setTokens([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function createUser(event: FormEvent) {
    event.preventDefault();
    try {
      setBusy(true);
      setError(null);
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Failed to create user');
      }

      setNewUser({ username: '', displayName: '', role: 'viewer', password: '' });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setBusy(false);
    }
  }

  async function patchUser(userId: number, patch: Record<string, unknown>) {
    try {
      setBusy(true);
      setError(null);
      const response = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...patch }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Failed to update user');
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(userId: number) {
    const newPassword = window.prompt('Enter a new password (minimum 8 characters):');
    if (!newPassword) return;
    await patchUser(userId, { newPassword });
  }

  async function createToken(event: FormEvent) {
    event.preventDefault();
    try {
      setBusy(true);
      setError(null);
      setNewTokenValue(null);

      const payload = {
        userId: Number(tokenForm.userId),
        tokenName: tokenForm.tokenName,
        role: tokenForm.role,
        expiresAt: tokenForm.expiresAt || null,
      };

      const response = await fetch('/api/admin/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Failed to create token');
      }

      setNewTokenValue(result.data.token);
      setTokenForm({ userId: '', tokenName: '', role: 'viewer', expiresAt: '' });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create token');
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(tokenId: number) {
    if (!window.confirm('Revoke this token? This cannot be undone.')) return;
    try {
      setBusy(true);
      setError(null);
      const response = await fetch(`/api/admin/tokens?tokenId=${tokenId}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Failed to revoke token');
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke token');
    } finally {
      setBusy(false);
    }
  }

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
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Only administrators can manage users and tokens.</p>
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
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Admin Users & API Tokens</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Manage user accounts, reset passwords, and issue scoped API tokens.</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200">
              {user.username} ({user.role})
            </span>
            <button onClick={() => logout()} className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">Logout</button>
            <Link href="/" className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">Dashboard</Link>
            <button onClick={() => loadData()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700" disabled={busy}>Refresh</button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-6 py-8 space-y-6">
        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
            {error}
          </div>
        ) : null}

        {newTokenValue ? (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300">
            <p className="font-semibold">Copy this token now. It will not be shown again.</p>
            <p className="mt-1 font-mono break-all">{newTokenValue}</p>
          </div>
        ) : null}

        <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Create User</h2>
          <form onSubmit={createUser} className="mt-4 grid gap-3 md:grid-cols-4">
            <input value={newUser.username} onChange={(e) => setNewUser((s) => ({ ...s, username: e.target.value }))} placeholder="username" className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900" required />
            <input value={newUser.displayName} onChange={(e) => setNewUser((s) => ({ ...s, displayName: e.target.value }))} placeholder="display name" className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900" required />
            <select value={newUser.role} onChange={(e) => setNewUser((s) => ({ ...s, role: e.target.value as UserRole }))} className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900">
              <option value="viewer">viewer</option>
              <option value="operator">operator</option>
              <option value="admin">admin</option>
            </select>
            <input type="password" value={newUser.password} onChange={(e) => setNewUser((s) => ({ ...s, password: e.target.value }))} placeholder="password (min 8)" className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900" required />
            <button type="submit" disabled={busy} className="md:col-span-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">Create User</button>
          </form>
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Users</h2>
          {loading ? <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">Loading users...</p> : null}
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[920px] w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left text-zinc-500 dark:text-zinc-400">
                  <th className="py-2 pr-3">Username</th>
                  <th className="py-2 pr-3">Display Name</th>
                  <th className="py-2 pr-3">Role</th>
                  <th className="py-2 pr-3">Active</th>
                  <th className="py-2 pr-3">Active Tokens</th>
                  <th className="py-2 pr-3">Updated</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((item) => (
                  <tr key={item.id} className="border-b border-zinc-100 dark:border-zinc-700/60">
                    <td className="py-2 pr-3 font-medium text-zinc-900 dark:text-zinc-100">{item.username}</td>
                    <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{item.display_name}</td>
                    <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{item.role}</td>
                    <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{item.is_active ? 'Yes' : 'No'}</td>
                    <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{item.token_count ?? 0}</td>
                    <td className="py-2 pr-3 text-zinc-500 dark:text-zinc-400">{new Date(item.updated_at).toLocaleString()}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => resetPassword(item.id)} className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-300">Reset Password</button>
                        <button onClick={() => patchUser(item.id, { isActive: !item.is_active })} className="rounded bg-zinc-200 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-200">{item.is_active ? 'Deactivate' : 'Activate'}</button>
                        <select value={item.role} onChange={(e) => patchUser(item.id, { role: e.target.value })} className="rounded border border-zinc-300 px-1 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-900">
                          <option value="viewer">viewer</option>
                          <option value="operator">operator</option>
                          <option value="admin">admin</option>
                        </select>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Create API Token</h2>
          <form onSubmit={createToken} className="mt-4 grid gap-3 md:grid-cols-4">
            <select value={tokenForm.userId} onChange={(e) => setTokenForm((s) => ({ ...s, userId: e.target.value }))} className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900" required>
              <option value="">Select user</option>
              {users.filter((u) => u.is_active).map((u) => (
                <option key={u.id} value={u.id}>{u.username}</option>
              ))}
            </select>
            <input value={tokenForm.tokenName} onChange={(e) => setTokenForm((s) => ({ ...s, tokenName: e.target.value }))} placeholder="token name" className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900" required />
            <select value={tokenForm.role} onChange={(e) => setTokenForm((s) => ({ ...s, role: e.target.value as UserRole }))} className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900">
              <option value="viewer">viewer</option>
              <option value="operator">operator</option>
              <option value="admin">admin</option>
            </select>
            <input type="datetime-local" value={tokenForm.expiresAt} onChange={(e) => setTokenForm((s) => ({ ...s, expiresAt: e.target.value }))} className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900" />
            <button type="submit" disabled={busy} className="md:col-span-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">Create Token</button>
          </form>
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">API Tokens</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[980px] w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left text-zinc-500 dark:text-zinc-400">
                  <th className="py-2 pr-3">User</th>
                  <th className="py-2 pr-3">Token Name</th>
                  <th className="py-2 pr-3">Prefix</th>
                  <th className="py-2 pr-3">Role</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Last Used</th>
                  <th className="py-2 pr-3">Expires</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((token) => (
                  <tr key={token.id} className="border-b border-zinc-100 dark:border-zinc-700/60">
                    <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{token.username}</td>
                    <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{token.token_name}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-zinc-600 dark:text-zinc-400">{token.token_prefix}...</td>
                    <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{token.role}</td>
                    <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{token.is_active ? 'Active' : 'Revoked'}</td>
                    <td className="py-2 pr-3 text-zinc-500 dark:text-zinc-400">{token.last_used_at ? new Date(token.last_used_at).toLocaleString() : '-'}</td>
                    <td className="py-2 pr-3 text-zinc-500 dark:text-zinc-400">{token.expires_at ? new Date(token.expires_at).toLocaleString() : 'Never'}</td>
                    <td className="py-2">
                      <button disabled={!token.is_active || busy} onClick={() => revokeToken(token.id)} className="rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-200 disabled:opacity-50 dark:bg-red-900/30 dark:text-red-300">Revoke</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
