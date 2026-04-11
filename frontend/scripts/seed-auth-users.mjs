import mysql from 'mysql2/promise';
import { randomBytes, scryptSync } from 'node:crypto';

function hashPassword(plain) {
  const salt = randomBytes(16);
  const digest = scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString('base64')}$${digest.toString('base64')}`;
}

function env(name, fallback = '') {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  return value.trim();
}

function generatedPassword(label) {
  return `local-${label}-${randomBytes(12).toString('hex')}`;
}

async function ensureAuthTables(connection) {
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
}

async function upsertUser(connection, { username, displayName, role, password }) {
  const hashed = hashPassword(password);
  await connection.execute(
    `INSERT INTO app_users (username, display_name, role, password_hash, is_active)
     VALUES (?, ?, ?, ?, TRUE)
     ON DUPLICATE KEY UPDATE
       display_name = VALUES(display_name),
       role = VALUES(role),
       password_hash = VALUES(password_hash),
       is_active = TRUE`,
    [username, displayName, role, hashed]
  );
}

async function main() {
  const mysqlConfig = {
    host: env('MYSQL_HOST', 'localhost'),
    port: Number(env('MYSQL_PORT', '3306')),
    user: env('MYSQL_USER', 'root'),
    password: env('MYSQL_PASSWORD', ''),
    database: env('MYSQL_DATABASE', 'mtr_dashboard'),
  };

  const users = [
    {
      username: env('AUTH_ADMIN_USERNAME', 'admin'),
      displayName: 'Administrator',
      role: 'admin',
      password: env('AUTH_ADMIN_PASSWORD', generatedPassword('admin')),
    },
    {
      username: env('AUTH_OPERATOR_USERNAME', 'operator'),
      displayName: 'Operator',
      role: 'operator',
      password: env('AUTH_OPERATOR_PASSWORD', generatedPassword('operator')),
    },
    {
      username: env('AUTH_VIEWER_USERNAME', 'viewer'),
      displayName: 'Viewer',
      role: 'viewer',
      password: env('AUTH_VIEWER_PASSWORD', generatedPassword('viewer')),
    },
  ];

  const connection = await mysql.createConnection(mysqlConfig);
  try {
    if (!process.env.AUTH_ADMIN_PASSWORD || !process.env.AUTH_OPERATOR_PASSWORD || !process.env.AUTH_VIEWER_PASSWORD) {
      console.warn('[auth-seed] AUTH_* passwords were not provided; generated local-only bootstrap passwords are being used for this run.');
    }

    await ensureAuthTables(connection);
    for (const user of users) {
      if (!user.username || !user.password) continue;
      await upsertUser(connection, user);
    }
    console.log('[auth-seed] Auth users ensured successfully.');
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error('[auth-seed] Failed to seed auth users', error);
  process.exit(1);
});
