'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';

type UserRole = 'viewer' | 'operator' | 'admin';

type SessionUser = {
  id: number;
  username: string;
  role: UserRole;
};

type AuthContextValue = {
  user: SessionUser | null;
  loading: boolean;
  refreshSession: () => Promise<void>;
  logout: () => Promise<void>;
  hasRole: (role: UserRole) => boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}

const roleOrder: Record<UserRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshSession = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result?.success || !result?.data?.user) {
        setUser(null);
        return;
      }
      setUser(result.data.user as SessionUser);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const run = async () => {
      setLoading(true);
      await refreshSession();
      if (mounted) setLoading(false);
    };
    run();
    return () => {
      mounted = false;
    };
  }, [refreshSession]);

  useEffect(() => {
    if (loading) return;

    const isLoginRoute = pathname === '/login';
    if (!user && !isLoginRoute) {
      router.replace('/login');
      return;
    }

    if (user && isLoginRoute) {
      router.replace('/');
    }
  }, [loading, pathname, router, user]);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      setUser(null);
      router.replace('/login');
    }
  }, [router]);

  const hasRole = useCallback(
    (requiredRole: UserRole) => {
      if (!user) return false;
      return roleOrder[user.role] >= roleOrder[requiredRole];
    },
    [user]
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, refreshSession, logout, hasRole }),
    [user, loading, refreshSession, logout, hasRole]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
