/**
 * Typed client for the Phase 2 Python API (/api/v2/*).
 *
 * - In the browser every call goes to the same-origin Next.js proxy
 *   (`/api/v2/...`), which validates the user's session cookie and forwards
 *   the request to the FastAPI backend.
 * - On the server (route handlers / server components) calls go straight to
 *   `BACKEND_URL` (default http://localhost:8000) with the internal service
 *   headers. Server-side calls are made as a read-only "viewer" identity.
 */

export type DeviceStatus = 'up' | 'down' | 'degraded' | 'unknown' | string;
export type Severity = 'critical' | 'major' | 'minor' | 'warning' | 'info' | string;
export type IncidentState = 'open' | 'acknowledged' | 'resolved' | 'suppressed' | string;
export type GroupBy = 'src_ip' | 'dst_ip' | 'protocol' | 'port';

export interface Device {
  id: number;
  hostname: string;
  mgmt_ip: string;
  vendor: string;
  model: string | null;
  snmp_version: string | null;
  status: DeviceStatus;
  last_polled_at: string | null;
  site_id: number | null;
  site_name: string | null;
  site_city: string | null;
  site_country: string | null;
  interface_count: number;
  open_incidents: number;
  burst_active: boolean;
}

export interface Interface {
  id: number;
  ifindex: number;
  ifname: string | null;
  ifalias: string | null;
  ifdescr: string | null;
  ifspeed_bps: number | null;
  ifadmin_status: number | null; // IF-MIB: 1 up, 2 down, 3 testing
  ifoper_status: number | null; // IF-MIB: 1 up, 2 down, ... 7 lowerLayerDown
  last_metric_at: string | null;
  in_bps: number | null;
  out_bps: number | null;
  metric_ts: string | null;
}

export interface BurstSession {
  id: number;
  device_id: number;
  hostname?: string | null;
  interface_id: number | null;
  ifindex?: number | null;
  ifname?: string | null;
  initiated_by: string;
  started_at: string;
  expires_at: string;
  ended_at?: string | null;
  is_active?: boolean;
  remaining_seconds: number;
}

export interface DeviceDetail extends Device {
  sys_oid: string | null;
  sys_descr: string | null;
  created_at: string;
  updated_at: string;
  interfaces: Interface[];
  active_burst: BurstSession | null;
}

export interface MetricPoint {
  ts: string;
  interface_id: number;
  ifindex: number | null;
  in_bps: number;
  out_bps: number;
  in_errors: number;
  out_errors: number;
  in_discards: number;
  out_discards: number;
  oper_status: number;
}

export interface DeviceMetrics {
  device_id: number;
  resolution: 'raw' | '5m';
  interfaces: Pick<Interface, 'id' | 'ifindex' | 'ifname' | 'ifspeed_bps'>[];
  points: MetricPoint[];
}

export interface SyslogEvent {
  timestamp: string;
  device_id: number;
  source_ip: string;
  facility: number;
  severity: number; // 0 emergency .. 7 debug
  severity_name: string;
  mnemonic: string;
  raw_message: string;
  parsed_host: string;
  parsed_program: string;
  hostname: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
  has_more?: boolean;
}

export interface FlowRecord {
  rank: number;
  key: string;
  bytes: number;
  packets: number;
  flows: number;
  protocol: number | null;
  pct: number;
}

export interface TopTalkers {
  group_by: GroupBy;
  from: string;
  to: string;
  total_bytes: number;
  total_packets: number;
  total_flows: number;
  items: FlowRecord[];
}

export interface BandwidthPoint {
  ts: string;
  in_bps: number;
  out_bps: number;
  in_mbps: number;
  out_mbps: number;
  peak_in_bps: number;
  peak_out_bps: number;
}

export interface Bandwidth {
  device_id: number;
  ifindex: number | null;
  source: 'snmp' | 'netflow';
  bucket_minutes: number;
  interface: Pick<Interface, 'id' | 'ifindex' | 'ifname' | 'ifspeed_bps'> | null;
  speed_bps: number | null;
  points: BandwidthPoint[];
}

export interface Incident {
  id: number;
  device_id: number | null;
  hostname: string | null;
  mgmt_ip: string | null;
  interface_id: number | null;
  ifname: string | null;
  severity: Severity;
  title: string;
  description: string | null;
  state: IncidentState;
  suppressed_by_incident_id: number | null;
  opened_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  duration_seconds: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Query = Record<string, string | number | boolean | null | undefined | (string | number)[]>;

const isServer = typeof window === 'undefined';

function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const qs = params.toString();
  const base = isServer ? (process.env.BACKEND_URL || 'http://localhost:8000').replace(/\/$/, '') : '';
  return `${base}/api/v2${path}${qs ? `?${qs}` : ''}`;
}

async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, query?: Query, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (isServer) {
    const secret = process.env.MTR_API_SHARED_SECRET;
    if (secret) headers['X-MTR-Internal-Token'] = secret;
    headers['X-MTR-User'] = 'nextjs-server';
    headers['X-MTR-Role'] = 'viewer';
  }
  const res = await fetch(buildUrl(path, query), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const obj = (data ?? {}) as { detail?: unknown; error?: string };
    const detail = obj.detail ?? obj.error ?? data;
    const msg =
      typeof detail === 'string'
        ? detail
        : typeof (detail as { message?: string })?.message === 'string'
          ? (detail as { message: string }).message
          : `Request failed (${res.status})`;
    throw new ApiError(res.status, msg, detail);
  }
  return data as T;
}

// ---- Devices -------------------------------------------------------------
export function getDevices(q?: { q?: string; site_id?: number; status?: string; vendor?: string }) {
  return request<Paged<Device>>('GET', '/devices', q);
}

export function getDevice(id: number) {
  return request<DeviceDetail>('GET', `/devices/${id}`);
}

export function getDeviceMetrics(
  id: number,
  q?: { from?: string; to?: string; ifindex?: number; resolution?: 'auto' | 'raw' | '5m' }
) {
  return request<DeviceMetrics>('GET', `/devices/${id}/metrics`, q);
}

// ---- Syslog --------------------------------------------------------------
export interface SyslogQuery {
  device_id?: number;
  severity?: (number | string)[];
  mnemonic_pattern?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function getSyslog(q: SyslogQuery = {}) {
  return request<Paged<SyslogEvent>>('GET', '/syslog', q as Query);
}

// ---- Flows ---------------------------------------------------------------
export function getTopTalkers(q: { device_id?: number; from?: string; to?: string; top_n?: number; group_by?: GroupBy }) {
  return request<TopTalkers>('GET', '/flows/toptalkers', q);
}

export function getBandwidth(q: {
  device_id: number;
  ifindex?: number;
  from?: string;
  to?: string;
  bucket_minutes?: number;
  source?: 'snmp' | 'netflow';
}) {
  return request<Bandwidth>('GET', '/flows/bandwidth', q);
}

// ---- Incidents -----------------------------------------------------------
export function getIncidents(q: { state?: string; device_id?: number; limit?: number; offset?: number } = {}) {
  return request<Paged<Incident>>('GET', '/incidents', q);
}

// ---- Burst ---------------------------------------------------------------
export function createBurst(body: { device_id: number; interface_id?: number | null; duration_minutes?: number }) {
  return request<BurstSession>('POST', '/burst', undefined, body);
}

export function deleteBurst(id: number) {
  return request<BurstSession>('DELETE', `/burst/${id}`);
}

export function getActiveBursts(q: { device_id?: number } = {}) {
  return request<Paged<BurstSession>>('GET', '/burst/active', q);
}

// ---- Formatting helpers shared by pages -----------------------------------
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let v = bps;
  let i = 0;
  while (Math.abs(v) >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || totalSeconds < 0) return '—';
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatTs(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export const PROTOCOL_NAMES: Record<number, string> = { 1: 'ICMP', 6: 'TCP', 17: 'UDP', 47: 'GRE', 50: 'ESP', 89: 'OSPF', 132: 'SCTP' };

export function protocolName(p: number | null | undefined): string {
  if (p === null || p === undefined) return '—';
  return PROTOCOL_NAMES[p] ?? String(p);
}
