import { NextRequest, NextResponse } from 'next/server';
import {
  createAuthUser,
  ensureAuthTables,
  listAuthUsers,
  resetAuthUserPassword,
  updateAuthUser,
  withAuthConnection,
} from '@/lib/auth-db';
import { getSessionFromRequest, type UserRole } from '@/lib/auth';
import { enforceSecurity, internalApiError } from '@/lib/security';

type UpdateBody = {
  userId?: unknown;
  displayName?: unknown;
  role?: unknown;
  isActive?: unknown;
  newPassword?: unknown;
};

function isDbError(error: unknown): error is { code?: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function normalizeRole(input: unknown): UserRole | null {
  const value = String(input || '').trim().toLowerCase();
  if (value === 'viewer' || value === 'operator' || value === 'admin') return value;
  return null;
}

export async function GET(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'admin-users-get',
    allowedRoles: ['admin'],
    rateLimit: { limit: 60, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  try {
    const users = await withAuthConnection(async (connection) => {
      await ensureAuthTables(connection);
      return listAuthUsers(connection);
    });

    return NextResponse.json({ success: true, data: users, count: users.length });
  } catch (error: unknown) {
    return internalApiError('Failed to load users', error);
  }
}

export async function POST(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'admin-users-post',
    allowedRoles: ['admin'],
    rateLimit: { limit: 20, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const username = String(body.username || '').trim().toLowerCase();
    const displayName = String(body.displayName || '').trim();
    const role = normalizeRole(body.role);
    const password = String(body.password || '');

    if (!username || !displayName || !role || password.length < 8) {
      return NextResponse.json(
        { success: false, error: 'username, displayName, role, and password (min 8 chars) are required' },
        { status: 400 }
      );
    }

    const userId = await withAuthConnection(async (connection) => {
      await ensureAuthTables(connection);
      return createAuthUser(connection, { username, displayName, role, password });
    });

    return NextResponse.json(
      { success: true, data: { id: userId, username, displayName, role } },
      { status: 201 }
    );
  } catch (error: unknown) {
    if (isDbError(error) && error.code === 'ER_DUP_ENTRY') {
      return NextResponse.json({ success: false, error: 'Username already exists' }, { status: 409 });
    }
    return internalApiError('Failed to create user', error);
  }
}

export async function PATCH(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'admin-users-patch',
    allowedRoles: ['admin'],
    rateLimit: { limit: 30, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  try {
    const body = (await request.json()) as UpdateBody;
    const userId = Number(body.userId);

    if (!Number.isInteger(userId) || userId <= 0) {
      return NextResponse.json({ success: false, error: 'Valid userId is required' }, { status: 400 });
    }

    const displayName =
      body.displayName === undefined ? undefined : String(body.displayName || '').trim();
    const role = body.role === undefined ? undefined : normalizeRole(body.role);
    const isActive = body.isActive === undefined ? undefined : Boolean(body.isActive);
    const newPassword =
      body.newPassword === undefined ? undefined : String(body.newPassword || '');

    if (
      displayName === undefined &&
      role === undefined &&
      isActive === undefined &&
      newPassword === undefined
    ) {
      return NextResponse.json({ success: false, error: 'No update fields provided' }, { status: 400 });
    }

    if (displayName !== undefined && !displayName) {
      return NextResponse.json({ success: false, error: 'displayName cannot be empty' }, { status: 400 });
    }

    if (body.role !== undefined && !role) {
      return NextResponse.json({ success: false, error: 'role must be viewer, operator, or admin' }, { status: 400 });
    }

    if (newPassword !== undefined && newPassword.length < 8) {
      return NextResponse.json({ success: false, error: 'newPassword must be at least 8 characters' }, { status: 400 });
    }

    const session = getSessionFromRequest(request);
    if (session && session.userId === userId) {
      if (role && role !== 'admin') {
        return NextResponse.json({ success: false, error: 'Cannot remove your own admin role' }, { status: 400 });
      }
      if (isActive === false) {
        return NextResponse.json({ success: false, error: 'Cannot deactivate your own account' }, { status: 400 });
      }
    }

    await withAuthConnection(async (connection) => {
      await ensureAuthTables(connection);
      const roleForUpdate: UserRole | undefined = role ?? undefined;
      await updateAuthUser(connection, userId, {
        displayName,
        role: roleForUpdate,
        isActive,
      });
      if (newPassword !== undefined) {
        await resetAuthUserPassword(connection, userId, newPassword);
      }
    });

    return NextResponse.json({ success: true, data: { userId } });
  } catch (error: unknown) {
    return internalApiError('Failed to update user', error);
  }
}
