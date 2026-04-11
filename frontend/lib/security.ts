import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest, type UserRole } from '@/lib/auth';
import {
  ensureAuthTables,
  findActiveApiTokenByHash,
  touchApiToken,
  withAuthConnection,
} from '@/lib/auth-db';
import { hashApiToken } from '@/lib/auth';

export type ApiRole = UserRole;

type RateLimitOptions = {
  limit: number;
  windowMs: number;
};

type SecurityOptions = {
  routeId: string;
  allowedRoles: ApiRole[];
  rateLimit: RateLimitOptions;
};

type RateEntry = {
  count: number;
  resetAt: number;
};

const rateStore = new Map<string, RateEntry>();

function getClientAddress(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  return 'unknown';
}

function getTokenFromRequest(request: NextRequest): string | null {
  const authHeader = request.headers.get('authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    return token || null;
  }

  const apiKey = request.headers.get('x-api-key')?.trim();
  return apiKey || null;
}

function normalizeRole(value: string): ApiRole | null {
  const role = value.trim().toLowerCase();
  if (role === 'viewer' || role === 'operator' || role === 'admin') return role;
  return null;
}

function loadTokenRoles(): Map<string, ApiRole> {
  const tokenRoles = new Map<string, ApiRole>();

  const adminToken = process.env.API_TOKEN_ADMIN?.trim();
  const operatorToken = process.env.API_TOKEN_OPERATOR?.trim();
  const viewerToken = process.env.API_TOKEN_VIEWER?.trim();

  if (adminToken) tokenRoles.set(adminToken, 'admin');
  if (operatorToken) tokenRoles.set(operatorToken, 'operator');
  if (viewerToken) tokenRoles.set(viewerToken, 'viewer');

  const raw = process.env.API_TOKENS_JSON?.trim();
  if (!raw) return tokenRoles;

  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [token, roleValue] of Object.entries(parsed)) {
      if (!token) continue;
      const role = normalizeRole(String(roleValue));
      if (role) tokenRoles.set(token, role);
    }
  } catch (error) {
    console.error('[security] Invalid API_TOKENS_JSON; ignoring this source.', error);
  }

  return tokenRoles;
}

function isRoleAllowed(role: ApiRole, allowedRoles: ApiRole[]): boolean {
  if (allowedRoles.includes(role)) return true;
  if (role === 'admin') return true;
  if (role === 'operator' && allowedRoles.includes('viewer')) return true;
  return false;
}

function enforceRateLimit(
  key: string,
  rateLimit: RateLimitOptions
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  const current = rateStore.get(key);

  if (!current || now >= current.resetAt) {
    rateStore.set(key, { count: 1, resetAt: now + rateLimit.windowMs });
    return { ok: true };
  }

  if (current.count >= rateLimit.limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    return { ok: false, retryAfterSeconds };
  }

  current.count += 1;
  rateStore.set(key, current);
  return { ok: true };
}

function authRequired(): boolean {
  if (process.env.SECURITY_ENFORCE_AUTH === 'true') return true;
  const tokenRoles = loadTokenRoles();
  return tokenRoles.size > 0;
}

function buildAuthResponse(status: number, message: string): NextResponse {
  return NextResponse.json(
    { success: false, error: message },
    { status }
  );
}

async function lookupDbTokenRole(token: string): Promise<ApiRole | null> {
  try {
    const tokenHash = hashApiToken(token);
    const tokenRecord = await withAuthConnection(async (connection) => {
      await ensureAuthTables(connection);
      return findActiveApiTokenByHash(connection, tokenHash);
    });

    if (!tokenRecord) return null;

    // Update usage telemetry without blocking auth success if this fails.
    withAuthConnection(async (connection) => {
      await touchApiToken(connection, tokenRecord.id);
    }).catch(() => undefined);

    return tokenRecord.role;
  } catch (error) {
    console.error('[security] Failed API token DB lookup', error);
    return null;
  }
}

export async function enforceSecurity(request: NextRequest, options: SecurityOptions): Promise<NextResponse | null> {
  const tokenRoles = loadTokenRoles();
  let role: ApiRole = 'admin';

  if (authRequired()) {
    const session = getSessionFromRequest(request);
    if (session) {
      role = session.role;
    } else {
      const token = getTokenFromRequest(request);
      if (!token) {
        return buildAuthResponse(401, 'Missing authentication');
      }

      const matchedRole = tokenRoles.get(token) ?? (await lookupDbTokenRole(token));
      if (!matchedRole) {
        return buildAuthResponse(401, 'Invalid authentication token');
      }

      role = matchedRole;
    }
  }

  if (!isRoleAllowed(role, options.allowedRoles)) {
    return buildAuthResponse(403, 'Forbidden');
  }

  const clientAddress = getClientAddress(request);
  const rateKey = `${options.routeId}:${role}:${clientAddress}`;
  const rateDecision = enforceRateLimit(rateKey, options.rateLimit);
  if (!rateDecision.ok) {
    return NextResponse.json(
      { success: false, error: 'Rate limit exceeded' },
      {
        status: 429,
        headers: {
          'Retry-After': String(rateDecision.retryAfterSeconds),
        },
      }
    );
  }

  return null;
}

export function internalApiError(publicMessage: string, error: unknown): NextResponse {
  console.error(`[api] ${publicMessage}`, error);
  return NextResponse.json({ success: false, error: publicMessage }, { status: 500 });
}
