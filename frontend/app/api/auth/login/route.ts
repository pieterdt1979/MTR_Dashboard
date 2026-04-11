import { NextRequest, NextResponse } from 'next/server';
import { withAuthConnection, ensureAuthTables, findActiveUserByUsername } from '@/lib/auth-db';
import { createSessionToken, setSessionCookie, verifyPassword } from '@/lib/auth';
import { internalApiError } from '@/lib/security';

function normalizeUsername(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const username = normalizeUsername(body?.username);
    const password = String(body?.password || '');

    if (!username || !password) {
      return NextResponse.json(
        { success: false, error: 'username and password are required' },
        { status: 400 }
      );
    }

    const result = await withAuthConnection(async (connection) => {
      await ensureAuthTables(connection);
      return findActiveUserByUsername(connection, username);
    });

    if (!result || !verifyPassword(password, result.password_hash)) {
      return NextResponse.json(
        { success: false, error: 'Invalid username or password' },
        { status: 401 }
      );
    }

    const token = createSessionToken({
      userId: result.id,
      username: result.username,
      role: result.role,
    });

    const response = NextResponse.json({
      success: true,
      data: {
        user: {
          id: result.id,
          username: result.username,
          displayName: result.display_name,
          role: result.role,
        },
      },
    });

    setSessionCookie(response, token);
    return response;
  } catch (error: unknown) {
    return internalApiError('Failed to login', error);
  }
}
