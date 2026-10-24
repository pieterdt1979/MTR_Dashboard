'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/app/auth-provider';
import { getActiveBursts } from '@/lib/api-client';

const NAV = [
  { href: '/', label: 'Overview', icon: '◎' },
  { href: '/devices', label: 'Devices', icon: '▤' },
  { href: '/syslog', label: 'Syslog Explorer', icon: '≡' },
  { href: '/flows', label: 'Flow Analytics', icon: '⇄' },
  { href: '/incidents', label: 'Incidents', icon: '⚠' },
];

const BURST_POLL_MS = 15_000;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, loading, logout } = useAuth();
  const [burstCount, setBurstCount] = useState<number | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await getActiveBursts();
        if (!cancelled) setBurstCount(res.total);
      } catch {
        if (!cancelled) setBurstCount(null);
      }
    };
    load();
    const t = setInterval(load, BURST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [user]);

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  if (loading || !user) {
    // AuthProvider redirects to /login when there is no session.
    return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">Loading…</div>;
  }

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900/80">
        <div className="border-b border-slate-800 px-5 py-4">
          <div className="text-lg font-semibold tracking-tight text-sky-300">MTR NetMon</div>
          <div className="text-xs text-slate-500">Enterprise network monitoring</div>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive(item.href) ? 'bg-sky-500/15 text-sky-300' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <span className="w-4 text-center text-slate-400">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="space-y-3 border-t border-slate-800 p-4">
          <Link
            href="/devices?burst=1"
            title="Active burst polling sessions"
            className={`flex items-center justify-between rounded-md px-3 py-2 text-xs ring-1 ring-inset ${
              burstCount ? 'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/40' : 'bg-slate-800/60 text-slate-400 ring-slate-700'
            }`}
          >
            <span className="flex items-center gap-2">
              {burstCount ? <span className="h-2 w-2 animate-pulse rounded-full bg-fuchsia-400" /> : null}
              Burst sessions
            </span>
            <span className="rounded-full bg-slate-950/60 px-2 py-0.5 font-semibold">{burstCount ?? '–'}</span>
          </Link>
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>
              {user.username} <span className="text-slate-600">({user.role})</span>
            </span>
            <button type="button" onClick={logout} className="text-slate-400 hover:text-white">
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">{children}</main>
    </div>
  );
}
