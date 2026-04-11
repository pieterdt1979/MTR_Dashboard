import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import type { NextRequest, NextResponse } from 'next/server';

export type UserRole = 'viewer' | 'operator' | 'admin';

export type SessionUser = {
  userId: number;
  username: string;
  role: UserRole;
  exp: number;
};

export type ApiTokenRole = UserRole;

export const SESSION_COOKIE_NAME = 'mtr_session';

let devSessionSecret: string | null = null;

function base64UrlEncode(input: Buffer | string): string {
  const raw = Buffer.isBuffer(input) ? input.toString('base64') : Buffer.from(input, 'utf8').toString('base64');
  return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function getSessionSecret(): string {
  const configured = process.env.SESSION_SECRET?.trim();
  if (configured) {
    return configured;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set in production');
  }

  if (!devSessionSecret) {
    devSessionSecret = randomBytes(32).toString('base64url');
  }

  return devSessionSecret;
}

export function hashPassword(plainPassword: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(plainPassword, salt, 64);
  return `scrypt$${salt.toString('base64')}$${digest.toString('base64')}`;
}

export function verifyPassword(plainPassword: string, encodedHash: string): boolean {
  const [scheme, saltB64, digestB64] = encodedHash.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !digestB64) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(digestB64, 'base64');
  const actual = scryptSync(plainPassword, salt, expected.length);

  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function signPayload(payloadSegment: string): string {
  const signature = createHmac('sha256', getSessionSecret()).update(payloadSegment).digest();
  return base64UrlEncode(signature);
}

export function createSessionToken(input: Omit<SessionUser, 'exp'>): string {
  const sessionHours = Math.max(1, Number(process.env.SESSION_DURATION_HOURS || '12'));
  const exp = Math.floor(Date.now() / 1000) + sessionHours * 60 * 60;

  const payload: SessionUser = {
    ...input,
    exp,
  };

  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  const signatureSegment = signPayload(payloadSegment);
  return `${payloadSegment}.${signatureSegment}`;
}

export function parseSessionToken(token: string): SessionUser | null {
  const [payloadSegment, signatureSegment] = token.split('.');
  if (!payloadSegment || !signatureSegment) return null;

  const expectedSig = signPayload(payloadSegment);
  const givenSig = signatureSegment;

  const expected = Buffer.from(expectedSig, 'utf8');
  const given = Buffer.from(givenSig, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }

  try {
    const payloadRaw = base64UrlDecode(payloadSegment).toString('utf8');
    const payload = JSON.parse(payloadRaw) as SessionUser;
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.userId || !payload.username || !payload.role || !payload.exp) return null;
    if (!['viewer', 'operator', 'admin'].includes(payload.role)) return null;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return null;

    return payload;
  } catch {
    return null;
  }
}

export function getSessionFromRequest(request: NextRequest): SessionUser | null {
  const raw = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) return null;
  return parseSessionToken(raw);
}

export function setSessionCookie(response: NextResponse, token: string): void {
  const secure = process.env.NODE_ENV === 'production';
  const sessionHours = Math.max(1, Number(process.env.SESSION_DURATION_HOURS || '12'));

  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: sessionHours * 60 * 60,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function buildApiTokenPrefix(token: string): string {
  return token.slice(0, 12);
}

export function generateApiToken(role: ApiTokenRole): string {
  const random = randomBytes(24).toString('base64url');
  return `mtr_${role}_${random}`;
}
