import mysql from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import {
  buildApiTokenPrefix,
  generateApiToken,
  hashApiToken,
  hashPassword,
  type ApiTokenRole,
  type UserRole,
} from '@/lib/auth';

export type AppUser = {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  password_hash: string;
  is_active: number | boolean;
};

export type AppUserSummary = {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  token_count?: number;
};

export type AppApiToken = {
  id: number;
  user_id: number;
  username: string;
  token_name: string;
  token_prefix: string;
  role: ApiTokenRole;
  is_active: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

type AppApiTokenRow = RowDataPacket & {
  id: number;
  user_id: number;
  username: string;
  token_name: string;
  token_prefix: string;
  role: ApiTokenRole;
  is_active: number | boolean;
  last_used_at: Date | string | null;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
};

const dbConfig = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'mtr_dashboard',
};

export async function withAuthConnection<T>(handler: (connection: mysql.Connection) => Promise<T>): Promise<T> {
  const connection = await mysql.createConnection(dbConfig);
  try {
    return await handler(connection);
  } finally {
    await connection.end();
  }
}

export async function ensureAuthTables(connection: mysql.Connection): Promise<void> {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS app_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(80) NOT NULL UNIQUE,
      display_name VARCHAR(255) NOT NULL,
      role ENUM('viewer', 'operator', 'admin') NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_role (role),
      INDEX idx_is_active (is_active)
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS app_api_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token_name VARCHAR(120) NOT NULL,
      token_prefix VARCHAR(24) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      role ENUM('viewer', 'operator', 'admin') NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      last_used_at TIMESTAMP NULL,
      expires_at TIMESTAMP NULL,
      revoked_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_token_hash (token_hash),
      UNIQUE KEY uniq_user_token_name (user_id, token_name),
      INDEX idx_user_active (user_id, is_active),
      INDEX idx_active_expiry (is_active, expires_at),
      CONSTRAINT fk_app_api_tokens_user
        FOREIGN KEY (user_id)
        REFERENCES app_users(id)
        ON DELETE CASCADE
    )
  `);
}

export async function findActiveUserByUsername(connection: mysql.Connection, username: string): Promise<AppUser | null> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id, username, display_name, role, password_hash, is_active
     FROM app_users
     WHERE username = ? AND is_active = TRUE
     LIMIT 1`,
    [username]
  );

  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0] as RowDataPacket;

  return {
    id: Number(row.id),
    username: String(row.username),
    display_name: String(row.display_name),
    role: row.role as UserRole,
    password_hash: String(row.password_hash),
    is_active: row.is_active,
  };
}

export async function upsertAuthUser(
  connection: mysql.Connection,
  input: { username: string; displayName: string; role: UserRole; password: string }
): Promise<void> {
  const hashed = hashPassword(input.password);

  await connection.execute(
    `INSERT INTO app_users (username, display_name, role, password_hash, is_active)
     VALUES (?, ?, ?, ?, TRUE)
     ON DUPLICATE KEY UPDATE
       display_name = VALUES(display_name),
       role = VALUES(role),
       password_hash = VALUES(password_hash),
       is_active = TRUE`,
    [input.username, input.displayName, input.role, hashed]
  );
}

export async function listAuthUsers(connection: mysql.Connection): Promise<AppUserSummary[]> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT
      u.id,
      u.username,
      u.display_name,
      u.role,
      u.is_active,
      u.created_at,
      u.updated_at,
      COUNT(t.id) AS token_count
     FROM app_users u
     LEFT JOIN app_api_tokens t ON t.user_id = u.id AND t.is_active = TRUE
     GROUP BY u.id, u.username, u.display_name, u.role, u.is_active, u.created_at, u.updated_at
     ORDER BY u.username ASC`
  );

  return rows.map((row) => ({
    id: Number(row.id),
    username: String(row.username),
    display_name: String(row.display_name),
    role: row.role as UserRole,
    is_active: Boolean(row.is_active),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    token_count: Number(row.token_count ?? 0),
  }));
}

export async function createAuthUser(
  connection: mysql.Connection,
  input: { username: string; displayName: string; role: UserRole; password: string }
): Promise<number> {
  const hashed = hashPassword(input.password);
  const [result] = await connection.execute<ResultSetHeader>(
    `INSERT INTO app_users (username, display_name, role, password_hash, is_active)
     VALUES (?, ?, ?, ?, TRUE)`,
    [input.username, input.displayName, input.role, hashed]
  );
  return Number(result.insertId);
}

export async function updateAuthUser(
  connection: mysql.Connection,
  userId: number,
  patch: { displayName?: string; role?: UserRole; isActive?: boolean }
): Promise<void> {
  const updates: string[] = [];
  const values: Array<string | boolean> = [];

  if (patch.displayName !== undefined) {
    updates.push('display_name = ?');
    values.push(patch.displayName);
  }
  if (patch.role !== undefined) {
    updates.push('role = ?');
    values.push(patch.role);
  }
  if (patch.isActive !== undefined) {
    updates.push('is_active = ?');
    values.push(patch.isActive);
  }

  if (updates.length === 0) return;

  values.push(String(userId));
  await connection.execute(
    `UPDATE app_users SET ${updates.join(', ')} WHERE id = ?`,
    values
  );
}

export async function resetAuthUserPassword(
  connection: mysql.Connection,
  userId: number,
  newPassword: string
): Promise<void> {
  const hashed = hashPassword(newPassword);
  await connection.execute(
    'UPDATE app_users SET password_hash = ?, is_active = TRUE WHERE id = ?',
    [hashed, userId]
  );
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

export async function listApiTokens(
  connection: mysql.Connection,
  userId?: number
): Promise<AppApiToken[]> {
  const params: Array<number> = [];
  const where = typeof userId === 'number' ? 'WHERE t.user_id = ?' : '';
  if (typeof userId === 'number') params.push(userId);

  const [rows] = await connection.execute<AppApiTokenRow[]>(
    `SELECT
      t.id,
      t.user_id,
      u.username,
      t.token_name,
      t.token_prefix,
      t.role,
      t.is_active,
      t.last_used_at,
      t.expires_at,
      t.revoked_at,
      t.created_at
     FROM app_api_tokens t
     INNER JOIN app_users u ON u.id = t.user_id
     ${where}
     ORDER BY t.created_at DESC`,
    params
  );

  return rows.map((row) => ({
    id: Number(row.id),
    user_id: Number(row.user_id),
    username: String(row.username),
    token_name: String(row.token_name),
    token_prefix: String(row.token_prefix),
    role: row.role,
    is_active: Boolean(row.is_active),
    last_used_at: toIso(row.last_used_at),
    expires_at: toIso(row.expires_at),
    revoked_at: toIso(row.revoked_at),
    created_at: toIso(row.created_at) || new Date().toISOString(),
  }));
}

export async function createApiTokenForUser(
  connection: mysql.Connection,
  input: {
    userId: number;
    tokenName: string;
    role: ApiTokenRole;
    expiresAt?: Date | null;
  }
): Promise<{ tokenId: number; plainToken: string }> {
  const plainToken = generateApiToken(input.role);
  const tokenHash = hashApiToken(plainToken);
  const tokenPrefix = buildApiTokenPrefix(plainToken);

  const [result] = await connection.execute<ResultSetHeader>(
    `INSERT INTO app_api_tokens (user_id, token_name, token_prefix, token_hash, role, is_active, expires_at)
     VALUES (?, ?, ?, ?, ?, TRUE, ?)`,
    [
      input.userId,
      input.tokenName,
      tokenPrefix,
      tokenHash,
      input.role,
      input.expiresAt || null,
    ]
  );

  return {
    tokenId: Number(result.insertId),
    plainToken,
  };
}

export async function revokeApiToken(connection: mysql.Connection, tokenId: number): Promise<void> {
  await connection.execute(
    'UPDATE app_api_tokens SET is_active = FALSE, revoked_at = CURRENT_TIMESTAMP WHERE id = ?',
    [tokenId]
  );
}

export async function findActiveApiTokenByHash(
  connection: mysql.Connection,
  tokenHash: string
): Promise<{ id: number; role: ApiTokenRole } | null> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id, role
     FROM app_api_tokens
     WHERE token_hash = ?
       AND is_active = TRUE
       AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
       AND revoked_at IS NULL
     LIMIT 1`,
    [tokenHash]
  );

  if (!rows.length) return null;
  return {
    id: Number(rows[0].id),
    role: rows[0].role as ApiTokenRole,
  };
}

export async function touchApiToken(connection: mysql.Connection, tokenId: number): Promise<void> {
  await connection.execute('UPDATE app_api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [tokenId]);
}
