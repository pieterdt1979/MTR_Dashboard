import { NextRequest, NextResponse } from 'next/server';
import mysql from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { enforceSecurity } from '@/lib/security';

type ProbeMode = 'icmp' | 'tcp' | 'udp';

const dbConfig = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'mtr_dashboard',
};

const DEVICE_FIELDS = `
  id,
  ip_address,
  hostname,
  is_active,
  probe_mode,
  probe_port,
  probe_tos,
  mtr_count,
  jitter_threshold_ms,
  created_at,
  updated_at
`;

async function ensureDeviceProfileColumns(connection: mysql.Connection) {
  const requiredColumns: Array<{ name: string; ddl: string }> = [
    {
      name: 'probe_mode',
      ddl: "ALTER TABLE devices ADD COLUMN probe_mode ENUM('icmp', 'tcp', 'udp') NOT NULL DEFAULT 'icmp'",
    },
    { name: 'probe_port', ddl: 'ALTER TABLE devices ADD COLUMN probe_port INT NULL' },
    { name: 'probe_tos', ddl: 'ALTER TABLE devices ADD COLUMN probe_tos INT NULL' },
    { name: 'mtr_count', ddl: 'ALTER TABLE devices ADD COLUMN mtr_count SMALLINT NOT NULL DEFAULT 10' },
    { name: 'jitter_threshold_ms', ddl: 'ALTER TABLE devices ADD COLUMN jitter_threshold_ms DOUBLE NULL' },
  ];

  for (const column of requiredColumns) {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SHOW COLUMNS FROM devices LIKE '${column.name}'`
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      await connection.execute(column.ddl);
    }
  }
}

function isDbError(error: unknown): error is { code?: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isValidIPv4(ip: string): boolean {
  const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  return ipv4Pattern.test(ip);
}

function isValidHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 255) return false;
  const hostnamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return hostnamePattern.test(hostname) || isValidIPv4(hostname);
}

function normalizeProbeMode(value: unknown, fallback: ProbeMode = 'icmp'): ProbeMode | null {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return null;
  const lowered = value.trim().toLowerCase();
  if (lowered === 'icmp' || lowered === 'tcp' || lowered === 'udp') {
    return lowered;
  }
  return null;
}

function normalizeOptionalInt(
  value: unknown,
  min: number,
  max: number
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) return undefined;
  if (parsed < min || parsed > max) return undefined;
  return parsed;
}

function normalizeRequiredInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < min || parsed > max) return null;
  return parsed;
}

function validateCreateOrUpdate(body: Record<string, unknown>) {
  const ipAddress = String(body.ip_address || '').trim();
  const hostname = String(body.hostname || '').trim();

  if (!ipAddress || !hostname) {
    return { ok: false as const, error: 'ip_address and hostname are required' };
  }

  if (!isValidIPv4(ipAddress)) {
    return { ok: false as const, error: 'Invalid IPv4 address format' };
  }

  if (!isValidHostname(hostname)) {
    return { ok: false as const, error: 'Invalid hostname format' };
  }

  const isActive = body.is_active === undefined ? true : body.is_active;
  if (typeof isActive !== 'boolean') {
    return { ok: false as const, error: 'is_active must be a boolean' };
  }

  const probeMode = normalizeProbeMode(body.probe_mode, 'icmp');
  if (!probeMode) {
    return { ok: false as const, error: 'probe_mode must be icmp, tcp, or udp' };
  }

  const probePort = normalizeOptionalInt(body.probe_port, 1, 65535);
  if (probePort === undefined) {
    return { ok: false as const, error: 'probe_port must be null or an integer between 1 and 65535' };
  }

  const probeTos = normalizeOptionalInt(body.probe_tos, 0, 255);
  if (probeTos === undefined) {
    return { ok: false as const, error: 'probe_tos must be null or an integer between 0 and 255' };
  }

  const mtrCount = normalizeRequiredInt(body.mtr_count, 10, 1, 200);
  if (mtrCount === null) {
    return { ok: false as const, error: 'mtr_count must be an integer between 1 and 200' };
  }

  const jitterThreshold =
    body.jitter_threshold_ms === undefined || body.jitter_threshold_ms === null || body.jitter_threshold_ms === ''
      ? null
      : Number(body.jitter_threshold_ms);
  if (jitterThreshold !== null && (!Number.isFinite(jitterThreshold) || jitterThreshold < 0 || jitterThreshold > 500)) {
    return { ok: false as const, error: 'jitter_threshold_ms must be null or a number between 0 and 500' };
  }

  return {
    ok: true as const,
    data: {
      ip_address: ipAddress,
      hostname,
      is_active: isActive,
      probe_mode: probeMode,
      probe_port: probePort,
      probe_tos: probeTos,
      mtr_count: mtrCount,
      jitter_threshold_ms: jitterThreshold,
    },
  };
}

function validatePatch(body: Record<string, unknown>) {
  const updates: string[] = [];
  const values: Array<string | number | boolean | null> = [];

  if (body.ip_address !== undefined) {
    const ipAddress = String(body.ip_address || '').trim();
    if (!isValidIPv4(ipAddress)) {
      return { ok: false as const, error: 'Invalid IPv4 address format' };
    }
    updates.push('ip_address = ?');
    values.push(ipAddress);
  }

  if (body.hostname !== undefined) {
    const hostname = String(body.hostname || '').trim();
    if (!isValidHostname(hostname)) {
      return { ok: false as const, error: 'Invalid hostname format' };
    }
    updates.push('hostname = ?');
    values.push(hostname);
  }

  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') {
      return { ok: false as const, error: 'is_active must be a boolean' };
    }
    updates.push('is_active = ?');
    values.push(body.is_active);
  }

  if (body.probe_mode !== undefined) {
    const probeMode = normalizeProbeMode(body.probe_mode);
    if (!probeMode) {
      return { ok: false as const, error: 'probe_mode must be icmp, tcp, or udp' };
    }
    updates.push('probe_mode = ?');
    values.push(probeMode);
  }

  if (body.probe_port !== undefined) {
    const probePort = normalizeOptionalInt(body.probe_port, 1, 65535);
    if (probePort === undefined) {
      return { ok: false as const, error: 'probe_port must be null or an integer between 1 and 65535' };
    }
    updates.push('probe_port = ?');
    values.push(probePort);
  }

  if (body.probe_tos !== undefined) {
    const probeTos = normalizeOptionalInt(body.probe_tos, 0, 255);
    if (probeTos === undefined) {
      return { ok: false as const, error: 'probe_tos must be null or an integer between 0 and 255' };
    }
    updates.push('probe_tos = ?');
    values.push(probeTos);
  }

  if (body.mtr_count !== undefined) {
    const mtrCount = normalizeRequiredInt(body.mtr_count, 10, 1, 200);
    if (mtrCount === null) {
      return { ok: false as const, error: 'mtr_count must be an integer between 1 and 200' };
    }
    updates.push('mtr_count = ?');
    values.push(mtrCount);
  }

  if (body.jitter_threshold_ms !== undefined) {
    const jitterThreshold =
      body.jitter_threshold_ms === null || body.jitter_threshold_ms === ''
        ? null
        : Number(body.jitter_threshold_ms);
    if (jitterThreshold !== null && (!Number.isFinite(jitterThreshold) || jitterThreshold < 0 || jitterThreshold > 500)) {
      return { ok: false as const, error: 'jitter_threshold_ms must be null or a number between 0 and 500' };
    }
    updates.push('jitter_threshold_ms = ?');
    values.push(jitterThreshold);
  }

  if (updates.length === 0) {
    return { ok: false as const, error: 'No fields to update' };
  }

  return { ok: true as const, updates, values };
}

export async function GET(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'devices-get',
    allowedRoles: ['viewer'],
    rateLimit: { limit: 120, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    await ensureDeviceProfileColumns(connection);
    const [rows] = await connection.execute(
      `SELECT ${DEVICE_FIELDS} FROM devices ORDER BY created_at DESC`
    );

    return NextResponse.json({
      success: true,
      data: rows,
      count: Array.isArray(rows) ? rows.length : 0,
    });
  } catch (error: unknown) {
    console.error('MySQL error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch devices' },
      { status: 500 }
    );
  } finally {
    if (connection) await connection.end();
  }
}

export async function POST(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'devices-post',
    allowedRoles: ['admin'],
    rateLimit: { limit: 30, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const validated = validateCreateOrUpdate(body);

    if (!validated.ok) {
      return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
    }

    connection = await mysql.createConnection(dbConfig);
    await ensureDeviceProfileColumns(connection);

    const [result] = await connection.execute(
      'INSERT INTO devices (ip_address, hostname, is_active, probe_mode, probe_port, probe_tos, mtr_count, jitter_threshold_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        validated.data.ip_address,
        validated.data.hostname,
        validated.data.is_active,
        validated.data.probe_mode,
        validated.data.probe_port,
        validated.data.probe_tos,
        validated.data.mtr_count,
        validated.data.jitter_threshold_ms,
      ]
    );

    const insertId = (result as ResultSetHeader).insertId;
    const [rows] = await connection.execute(
      `SELECT ${DEVICE_FIELDS} FROM devices WHERE id = ?`,
      [insertId]
    );

    return NextResponse.json(
      {
        success: true,
        message: 'Device created successfully',
        data: Array.isArray(rows) ? rows[0] : null,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    console.error('MySQL error:', error);
    if (isDbError(error) && error.code === 'ER_DUP_ENTRY') {
      return NextResponse.json(
        { success: false, error: 'Device with this IP address already exists' },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { success: false, error: 'Failed to create device' },
      { status: 500 }
    );
  } finally {
    if (connection) await connection.end();
  }
}

export async function PUT(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'devices-put',
    allowedRoles: ['admin'],
    rateLimit: { limit: 30, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  let connection;
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || Number.isNaN(parseInt(id, 10))) {
      return NextResponse.json(
        { success: false, error: 'Valid device ID is required' },
        { status: 400 }
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const validated = validateCreateOrUpdate(body);

    if (!validated.ok) {
      return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
    }

    connection = await mysql.createConnection(dbConfig);
    await ensureDeviceProfileColumns(connection);

    const [existing] = await connection.execute('SELECT id FROM devices WHERE id = ?', [parseInt(id, 10)]);
    if (!Array.isArray(existing) || existing.length === 0) {
      return NextResponse.json({ success: false, error: 'Device not found' }, { status: 404 });
    }

    await connection.execute(
      'UPDATE devices SET ip_address = ?, hostname = ?, is_active = ?, probe_mode = ?, probe_port = ?, probe_tos = ?, mtr_count = ?, jitter_threshold_ms = ? WHERE id = ?',
      [
        validated.data.ip_address,
        validated.data.hostname,
        validated.data.is_active,
        validated.data.probe_mode,
        validated.data.probe_port,
        validated.data.probe_tos,
        validated.data.mtr_count,
        validated.data.jitter_threshold_ms,
        parseInt(id, 10),
      ]
    );

    const [rows] = await connection.execute(`SELECT ${DEVICE_FIELDS} FROM devices WHERE id = ?`, [parseInt(id, 10)]);

    return NextResponse.json({
      success: true,
      message: 'Device updated successfully',
      data: Array.isArray(rows) ? rows[0] : null,
    });
  } catch (error: unknown) {
    console.error('MySQL error:', error);
    if (isDbError(error) && error.code === 'ER_DUP_ENTRY') {
      return NextResponse.json(
        { success: false, error: 'Device with this IP address already exists' },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { success: false, error: 'Failed to update device' },
      { status: 500 }
    );
  } finally {
    if (connection) await connection.end();
  }
}

export async function PATCH(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'devices-patch',
    allowedRoles: ['admin'],
    rateLimit: { limit: 30, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  let connection;
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || Number.isNaN(parseInt(id, 10))) {
      return NextResponse.json(
        { success: false, error: 'Valid device ID is required' },
        { status: 400 }
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const validated = validatePatch(body);

    if (!validated.ok) {
      return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
    }

    connection = await mysql.createConnection(dbConfig);
    await ensureDeviceProfileColumns(connection);

    const [existing] = await connection.execute('SELECT id FROM devices WHERE id = ?', [parseInt(id, 10)]);
    if (!Array.isArray(existing) || existing.length === 0) {
      return NextResponse.json({ success: false, error: 'Device not found' }, { status: 404 });
    }

    validated.values.push(parseInt(id, 10));
    await connection.execute(`UPDATE devices SET ${validated.updates.join(', ')} WHERE id = ?`, validated.values);

    const [rows] = await connection.execute(`SELECT ${DEVICE_FIELDS} FROM devices WHERE id = ?`, [parseInt(id, 10)]);

    return NextResponse.json({
      success: true,
      message: 'Device updated successfully',
      data: Array.isArray(rows) ? rows[0] : null,
    });
  } catch (error: unknown) {
    console.error('MySQL error:', error);
    if (isDbError(error) && error.code === 'ER_DUP_ENTRY') {
      return NextResponse.json(
        { success: false, error: 'Device with this IP address already exists' },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { success: false, error: 'Failed to update device' },
      { status: 500 }
    );
  } finally {
    if (connection) await connection.end();
  }
}

export async function DELETE(request: NextRequest) {
  const securityResponse = await enforceSecurity(request, {
    routeId: 'devices-delete',
    allowedRoles: ['admin'],
    rateLimit: { limit: 30, windowMs: 60_000 },
  });
  if (securityResponse) return securityResponse;

  let connection;
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || Number.isNaN(parseInt(id, 10))) {
      return NextResponse.json(
        { success: false, error: 'Valid device ID is required' },
        { status: 400 }
      );
    }

    connection = await mysql.createConnection(dbConfig);
    await ensureDeviceProfileColumns(connection);

    const [existing] = await connection.execute('SELECT ip_address FROM devices WHERE id = ?', [parseInt(id, 10)]);
    if (!Array.isArray(existing) || existing.length === 0) {
      return NextResponse.json({ success: false, error: 'Device not found' }, { status: 404 });
    }

    const deviceRows = existing as Array<RowDataPacket & { ip_address: string }>;
    const device = deviceRows[0];

    await connection.execute('DELETE FROM devices WHERE id = ?', [parseInt(id, 10)]);

    return NextResponse.json({
      success: true,
      message: 'Device deleted successfully',
      data: { id: parseInt(id, 10), ip_address: device.ip_address },
    });
  } catch (error: unknown) {
    console.error('MySQL error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete device' },
      { status: 500 }
    );
  } finally {
    if (connection) await connection.end();
  }
}
