import { NextRequest, NextResponse } from 'next/server';
import type { RowDataPacket } from 'mysql2';
import {
  createApiTokenForUser,
  ensureAuthTables,
  listApiTokens,
  revokeApiToken,
  withAuthConnection,
} from '@/lib/auth-db';
import { type ApiTokenRole } from '@/lib/auth';
import { enforceSecurity, internalApiError } from '@/lib/security';

function isDbError(error: unknown): error is { code?: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function normalizeRole(input: unknown): ApiTokenRole | null {
  const value = String(input || '').trim().toLowerCase();
  if (value === 'viewer' || value === 'operator' || value === 'admin') return value;
  return null;
}

export async function GET(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'admin-tokens-get',
    allowedRoles: ['admin'],
    rateLimit: { limit: 60, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  const { searchParams } = new URL(request.url);
  const userIdParam = searchParams.get('userId');
  const userId = userIdParam ? Number(userIdParam) : undefined;

  if (userIdParam && (!Number.isInteger(userId) || (userId ?? 0) <= 0)) {
    return NextResponse.json({ success: false, error: 'userId must be a positive integer' }, { status: 400 });
  }

  try {
    const tokens = await withAuthConnection(async (connection) => {
      await ensureAuthTables(connection);
      return listApiTokens(connection, userId);
    });

    return NextResponse.json({ success: true, data: tokens, count: tokens.length });
  } catch (error: unknown) {
    return internalApiError('Failed to load API tokens', error);
  }
}

export async function POST(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'admin-tokens-post',
    allowedRoles: ['admin'],
    rateLimit: { limit: 20, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const userId = Number(body.userId);
    const tokenName = String(body.tokenName || '').trim();
    const role = normalizeRole(body.role);
    const expiresAtRaw = String(body.expiresAt || '').trim();

    if (!Number.isInteger(userId) || userId <= 0 || !tokenName || !role) {
      return NextResponse.json(
        { success: false, error: 'userId, tokenName, and role are required' },
        { status: 400 }
      );
    }

    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
    if (expiresAtRaw && !Number.isFinite(expiresAt?.getTime())) {
      return NextResponse.json({ success: false, error: 'expiresAt must be a valid date' }, { status: 400 });
    }

    const data = await withAuthConnection(async (connection) => {
      await ensureAuthTables(connection);

      const [users] = await connection.execute<RowDataPacket[]>(
        'SELECT id, role FROM app_users WHERE id = ? AND is_active = TRUE LIMIT 1',
        [userId]
      );
      if (!users.length) {
        return null;
      }

      const created = await createApiTokenForUser(connection, {
        userId,
        tokenName,
        role,
        expiresAt,
      });

      return created;
    });

    if (!data) {
      return NextResponse.json({ success: false, error: 'Active user not found' }, { status: 404 });
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          tokenId: data.tokenId,
          token: data.plainToken,
          tokenName,
          role,
          userId,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
        },
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    if (isDbError(error) && error.code === 'ER_DUP_ENTRY') {
      return NextResponse.json({ success: false, error: 'Token name already exists for this user' }, { status: 409 });
    }
    return internalApiError('Failed to create API token', error);
  }
}

export async function DELETE(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'admin-tokens-delete',
    allowedRoles: ['admin'],
    rateLimit: { limit: 30, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  const { searchParams } = new URL(request.url);
  const tokenId = Number(searchParams.get('tokenId'));

  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return NextResponse.json({ success: false, error: 'tokenId must be a positive integer' }, { status: 400 });
  }

  try {
    await withAuthConnection(async (connection) => {
      await ensureAuthTables(connection);
      await revokeApiToken(connection, tokenId);
    });

    return NextResponse.json({ success: true, data: { tokenId } });
  } catch (error: unknown) {
    return internalApiError('Failed to revoke token', error);
  }
}
