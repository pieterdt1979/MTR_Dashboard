/**
 * Catch-all proxy: /api/v2/<path> (Next.js) -> ${BACKEND_URL}/api/v2/<path> (FastAPI).
 *
 * Authentication stays in Next.js: the existing session cookie / API token is
 * validated with enforceSecurity() (viewer for reads, operator for writes).
 * The caller's identity is then forwarded to FastAPI in X-MTR-User / X-MTR-Role
 * together with the shared secret X-MTR-Internal-Token (MTR_API_SHARED_SECRET),
 * so the Python API never has to parse the Next.js session cookie.
 * Backend JSON bodies and status codes are returned as-is.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest, type UserRole } from '@/lib/auth';
import { enforceSecurity } from '@/lib/security';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ path: string[] }> };

const BACKEND_TIMEOUT_MS = Number(process.env.BACKEND_TIMEOUT_MS || 30000);

function backendBase(): string {
  return (process.env.BACKEND_URL || 'http://localhost:8000').replace(/\/$/, '');
}

async function proxy(request: NextRequest, ctx: Ctx, method: 'GET' | 'POST' | 'DELETE'): Promise<NextResponse> {
  const isWrite = method !== 'GET';
  const denied = await enforceSecurity(request, {
    routeId: isWrite ? 'api-v2-write' : 'api-v2-read',
    allowedRoles: [isWrite ? 'operator' : 'viewer'],
    rateLimit: isWrite ? { limit: 30, windowMs: 60_000 } : { limit: 600, windowMs: 60_000 },
  });
  if (denied) return denied;

  const { path } = await ctx.params;
  const segments = (path ?? []).map((s) => encodeURIComponent(s));
  if (segments.some((s) => s === '..' || s === '.')) {
    return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
  }
  const target = `${backendBase()}/api/v2/${segments.join('/')}${request.nextUrl.search}`;

  // Identity: logged-in session user, otherwise (API token / auth disabled) a service identity.
  // enforceSecurity has already confirmed the caller holds the required role.
  const session = getSessionFromRequest(request);
  const user = session?.username ?? 'api-token';
  const role: UserRole = session?.role ?? (isWrite ? 'operator' : 'viewer');

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-MTR-User': user,
    'X-MTR-Role': role,
  };
  const secret = process.env.MTR_API_SHARED_SECRET;
  if (secret) headers['X-MTR-Internal-Token'] = secret;
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) headers['X-Forwarded-For'] = fwd;

  let body: string | undefined;
  if (method === 'POST') {
    body = await request.text();
    headers['Content-Type'] = request.headers.get('content-type') || 'application/json';
  }

  try {
    const res = await fetch(target, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
    const text = await res.text();
    return new NextResponse(text || null, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error(`[api/v2] backend request failed: ${method} ${target}`, error);
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return NextResponse.json(
      { success: false, error: timedOut ? 'Backend timeout' : 'Backend unavailable' },
      { status: timedOut ? 504 : 502 }
    );
  }
}

export function GET(request: NextRequest, ctx: Ctx) {
  return proxy(request, ctx, 'GET');
}

export function POST(request: NextRequest, ctx: Ctx) {
  return proxy(request, ctx, 'POST');
}

export function DELETE(request: NextRequest, ctx: Ctx) {
  return proxy(request, ctx, 'DELETE');
}
