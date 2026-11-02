// js/api.js — REST client for the AEMS backend.
// Base URL resolution: window.AEMS_API_BASE override > local dev (localhost:4000)
// > RAILWAY_API_ORIGIN from js/config.js (production). See config.js before deploying.

import { RAILWAY_API_ORIGIN } from './config.js';

function defaultBase() {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') return 'http://localhost:4000/api';
  return RAILWAY_API_ORIGIN ? RAILWAY_API_ORIGIN.replace(/\/+$/, '') + '/api' : '';
}

let API_BASE = (window.AEMS_API_BASE || defaultBase()).replace(/\/+$/, '');

/** Live API base (updates if the loopback fallback below swaps hosts). */
export function getApiBase() { return API_BASE; }

// If the page is served via 127.0.0.1 (or vice-versa) the CORS origin check can
// reject the very first cross-origin request. Swap the loopback host and retry once.
function altLoopbackBase() {
  if (window.AEMS_API_BASE) return null;
  const swap = API_BASE.replace(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+\/api)$/,
    (m, host, port) => `http://${host === 'localhost' ? '127.0.0.1' : 'localhost'}${port}`);
  return swap !== API_BASE ? swap : null;
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'API_ERROR';
    this.details = details;
  }
}

let _token = null;

export function setToken(token) { _token = token || null; }
export function getToken() { return _token; }

function qs(params) {
  if (!params) return '';
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

async function request(path, { method = 'GET', body, token } = {}) {
  if (!API_BASE) {
    throw new ApiError(0, 'API_NOT_CONFIGURED', 'AEMS API URL is not configured — set RAILWAY_API_ORIGIN in js/config.js');
  }
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const tok = token ?? _token;
  if (tok) headers.Authorization = `Bearer ${tok}`;

  let res;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: payload });
  } catch {
    const alt = altLoopbackBase();
    if (alt) {
      try {
        res = await fetch(alt + path, { method, headers, body: payload });
        API_BASE = alt;
      } catch {
        throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the AEMS server (${API_BASE}). Is it running?`);
      }
    } else {
      throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the AEMS server (${API_BASE}). Is it running?`);
    }
  }

  if (res.status === 401 && !token) {
    const { renewSession } = await import('./auth.js');
    const renewed = await renewSession();
    if (renewed) return request(path, { method, body });
  }

  let json = null;
  try { json = await res.json(); } catch { /* no body */ }

  if (!res.ok) {
    const e = json?.error || {};
    throw new ApiError(res.status, e.code || 'HTTP_ERROR', e.message || `Request failed (${res.status})`, e.details);
  }

  return json ? json.data : undefined;
}

/**
 * Loads a caller-scoped inventory in bounded API pages. The legacy `inventory`
 * method still returns the original array contract for older integrations.
 */
async function inventoryAll(params = {}) {
  const pageSize = 200;
  const first = await request('/inventory' + qs({ ...params, page: 1, pageSize }));
  if (Array.isArray(first)) return first;

  const rows = [...(first?.items || [])];
  const total = Number(first?.total) || rows.length;
  const pageCount = Math.ceil(total / pageSize);
  for (let start = 2; start <= pageCount; start += 4) {
    const pages = Array.from({ length: Math.min(4, pageCount - start + 1) }, (_, i) => start + i);
    const resultPages = await Promise.all(pages.map((page) =>
      request('/inventory' + qs({ ...params, page, pageSize })),
    ));
    resultPages.forEach((result) => rows.push(...(result?.items || [])));
  }

  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  return unique.sort((a, b) =>
    new Date(a.batch?.expiryDate || 0).getTime() - new Date(b.batch?.expiryDate || 0).getTime() ||
    String(a.ambulanceId || '').localeCompare(String(b.ambulanceId || '')),
  );
}

/** Opens an authenticated SSE response for live notification refresh events. */
export async function openNotificationStream(signal) {
  if (!API_BASE) throw new ApiError(0, 'API_NOT_CONFIGURED', 'AEMS API URL is not configured');
  const headers = { Accept: 'text/event-stream' };
  if (_token) headers.Authorization = `Bearer ${_token}`;
  let response;
  try {
    response = await fetch(`${API_BASE}/notifications/stream`, { headers, signal });
  } catch (error) {
    const alternate = altLoopbackBase();
    if (!alternate) throw error;
    response = await fetch(`${alternate}/notifications/stream`, { headers, signal });
    API_BASE = alternate;
  }
  if (response.status === 401) {
    const { renewSession } = await import('./auth.js');
    if (await renewSession()) return openNotificationStream(signal);
  }
  if (!response.ok || !response.body) {
    let message = `Notification stream unavailable (${response.status})`;
    try { message = (await response.json())?.error?.message || message; } catch { /* SSE/plain response */ }
    throw new ApiError(response.status, 'NOTIFICATION_STREAM_ERROR', message);
  }
  return response.body;
}

export const api = {
  // ── Auth ────────────────────────────────────────────────
  login: (token) => request('/auth/login', { method: 'POST', body: {}, token }),
  me: () => request('/auth/me'),
  // Administrator-only: assign which units another supervisor is responsible for.
  setManagedStations: (userId, stationCodes) =>
    request(`/users/${userId}/managed-stations`, { method: 'PUT', body: { stationCodes } }),
  // Supervisor self-service: edit the units on your OWN managed list.
  setMyManagedStations: (stationCodes) =>
    request('/me/managed-stations', { method: 'PUT', body: { stationCodes } }),
  register: (data, token) => request('/auth/register', { method: 'POST', body: data, token }),
  publicStations: () => request('/public/stations'),

  // ── In-app notifications ─────────────────────────────────
  notifications: (params) => request('/notifications' + qs(params)),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: 'POST', body: {} }),
  markAllNotificationsRead: () => request('/notifications/read-all', { method: 'POST', body: {} }),

  // 🗺️ Duty unit (crew: current unit + roster allow-list)
  dutyState: () => request('/me/duty'),
  // Switching is unlimited; the reason is mandatory and lands in the audit trail.
  switchDutyUnit: (data) => request('/me/duty/switch', { method: 'POST', body: data }),
  // Administrator-only: replace a user's roster allow-list.
  setUserUnits: (userId, stationIds) =>
    request(`/users/${userId}/units`, { method: 'PUT', body: { stationIds } }),

  // ── Inventory ───────────────────────────────────────────
  inventory: (params) => request('/inventory' + qs(params)),
  inventoryAll: (params) => inventoryAll(params),
  useMedicine: (body) => request('/inventory/use', { method: 'POST', body }),
  restock: (body) => request('/inventory/restock', { method: 'POST', body }),
  adjust: (body) => request('/inventory/adjust', { method: 'POST', body }),
  updateItemNotes: (inventoryId, notes, reason) => request('/inventory/notes', { method: 'POST', body: { inventoryId, notes, reason } }),
  updateItemExpiry: (inventoryId, expiryDate) => request('/inventory/expiry', { method: 'POST', body: { inventoryId, expiryDate } }),
  // Per-unit lot edit — overrides this ambulance's stock line only.
  updateInventoryLot: (inventoryId, body) => request(`/inventory/${inventoryId}/lot`, { method: 'PATCH', body }),
  deleteStock: (inventoryId, body) => request('/inventory/' + inventoryId, { method: 'DELETE', body }),
  importInventory: (body) => request('/inventory/import', { method: 'POST', body }),

  // ── Medicines / Batches ─────────────────────────────────
  medicines: (params) => request('/medicines' + qs(params)),
  batches: (params) => request('/batches' + qs(params)),
  createMedicine: (body) => request('/medicines', { method: 'POST', body }),
  deleteMedicine: (id, force) => request(`/medicines/${id}`, { method: 'DELETE', body: { force: !!force } }),
  createBatch: (body) => request('/batches', { method: 'POST', body }),
  // Edit a lot (number/expiry/supplier/received date). Reason is required.
  updateBatch: (id, body) => request(`/batches/${id}`, { method: 'PATCH', body }),

  // ── Stock Reasons ───────────────────────────────────────
  // Code-based reason catalogue, filtered by item type and/or action.
  stockReasons: (params) => request('/stock-reasons' + qs(params)),

  // ── Inspections ─────────────────────────────────────────
  inspections: (params) => request('/inspections' + qs(params)),
  inspection: (id) => request('/inspections/' + id),
  // Supervisor at-a-glance rollup across the units they look after.
  inspectionOverview: (params) => request('/inspections/overview' + qs(params)),
  createInspection: (body) => request('/inspections', { method: 'POST', body }),
  // Save/resume a draft (replaces its lines entirely).
  updateInspection: (id, body) => request('/inspections/' + id, { method: 'PUT', body }),
  completeInspection: (id) => request(`/inspections/${id}/complete`, { method: 'POST', body: {} }),
  acknowledgeInspection: (id, reviewNotes) =>
    request(`/inspections/${id}/acknowledge`, { method: 'POST', body: { reviewNotes } }),
  voidInspection: (id, voidReason) => request(`/inspections/${id}/void`, { method: 'POST', body: { voidReason } }),
  deleteInspection: (id) => request('/inspections/' + id, { method: 'DELETE' }),

  // ── Shift Notes ─────────────────────────────────────────
  shiftNotes: (params) => request('/shift-notes' + qs(params)),
  createShiftNote: (body) => request('/shift-notes', { method: 'POST', body }),
  deleteShiftNote: (id, reason) => request('/shift-notes/' + id, { method: 'DELETE', body: { reason } }),
  restoreShiftNote: (id) => request('/shift-notes/' + id + '/restore', { method: 'POST' }),

  // ── Handovers ───────────────────────────────────────────
  handovers: (params) => request('/handovers' + qs(params)),
  createHandover: (body) => request('/handovers', { method: 'POST', body }),
  acknowledgeHandover: (id, body) => request(`/handovers/${id}/acknowledge`, { method: 'POST', body }),

  // ── Supply Requests ─────────────────────────────────────
  supplyRequests: (params) => request('/supply-requests' + qs(params)),
  createSupplyRequest: (body) => request('/supply-requests', { method: 'POST', body }),
  updateSupplyRequestStatus: (id, status) => request(`/supply-requests/${id}/status`, { method: 'PATCH', body: { status } }),
  cancelSupplyRequest: (id) => request(`/supply-requests/${id}/cancel`, { method: 'POST', body: {} }),
  // Fulfilment lifecycle: held on arrival (DISPATCHED→RECEIVED) until double-confirmed.
  dispatchSupplyRequest: (id, body) => request(`/supply-requests/${id}/dispatch`, { method: 'POST', body }),
  receiveSupplyRequest: (id, body) => request(`/supply-requests/${id}/receive`, { method: 'POST', body }),
  confirmSupplyRequest: (id) => request(`/supply-requests/${id}/confirm`, { method: 'POST', body: {} }),
  closeSupplyRequest: (id) => request(`/supply-requests/${id}/close`, { method: 'POST', body: {} }),

  // ── Reports ─────────────────────────────────────────────
  reports: (params) => request('/reports' + qs(params)),
  createReport: (body) => request('/reports', { method: 'POST', body }),
  // Fleet/station analytics rollup for the Reports Dashboard.
  reportAnalytics: (params) => request('/reports/analytics' + qs(params)),

  // ── Audit Log ───────────────────────────────────────────
  auditLogs: (params) => request('/audit-logs' + qs(params)),

  // ── Admin: Users ────────────────────────────────────────
  users: (params) => request('/users' + qs(params)),
  approveUser: (id, body) => request(`/users/${id}/approve`, { method: 'POST', body }),
  rejectUser: (id) => request(`/users/${id}/reject`, { method: 'POST', body: {} }),
  setUserStatus: (id, status) => request(`/users/${id}/status`, { method: 'PATCH', body: { status } }),
  changeRole: (id, body) => request(`/users/${id}/role`, { method: 'PATCH', body }),
  setUserPassword: (id, password) => request(`/users/${id}/password`, { method: 'PUT', body: { password } }),
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),

  // ── Auth: password ──────────────────────────────────────
  // Records a self-service password change (the change itself happens in
  // Firebase on the client; this only writes the audit trail).
  recordPasswordChange: () => request('/auth/password-changed', { method: 'POST', body: {} }),
  updateMySupervisorZone: (supervisorZone) =>
    request('/me/supervisor-zone', { method: 'PUT', body: { supervisorZone } }),

  // ── Admin: Stations ─────────────────────────────────────
  stations: (params) => request('/stations' + qs(params)),
  createStation: (body) => request('/stations', { method: 'POST', body }),
  updateStation: (id, body) => request(`/stations/${id}`, { method: 'PATCH', body }),
  deleteStation: (id) => request(`/stations/${id}`, { method: 'DELETE' }),

  // ── Admin: Distribution ─────────────────────────────────
  distributionTemplates: () => request('/distributions/templates'),
  createDistributionTemplate: (body) => request('/distributions/templates', { method: 'POST', body }),
  updateDistributionTemplate: (id, body) => request(`/distributions/templates/${id}`, { method: 'PATCH', body }),
  deleteDistributionTemplate: (id) => request(`/distributions/templates/${id}`, { method: 'DELETE' }),
  applyDistribution: (body) => request('/distributions/apply', { method: 'POST', body }),
  distributions: (params) => request('/distributions' + qs(params)),
};
