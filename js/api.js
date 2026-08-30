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

export const api = {
  // ── Auth ────────────────────────────────────────────────
  login: (token) => request('/auth/login', { method: 'POST', body: {}, token }),
  me: () => request('/auth/me'),
  setManagedStations: (stationCodes) => request('/auth/me/managed-stations', { method: 'PUT', body: { stationCodes } }),
  register: (data, token) => request('/auth/register', { method: 'POST', body: data, token }),
  publicStations: () => request('/public/stations'),

  // ── Inventory ───────────────────────────────────────────
  inventory: (params) => request('/inventory' + qs(params)),
  useMedicine: (body) => request('/inventory/use', { method: 'POST', body }),
  restock: (body) => request('/inventory/restock', { method: 'POST', body }),
  adjust: (body) => request('/inventory/adjust', { method: 'POST', body }),
  updateItemNotes: (inventoryId, notes, reason) => request('/inventory/notes', { method: 'POST', body: { inventoryId, notes, reason } }),
  updateItemExpiry: (inventoryId, expiryDate) => request('/inventory/expiry', { method: 'POST', body: { inventoryId, expiryDate } }),

  // ── Medicines / Batches ─────────────────────────────────
  medicines: (params) => request('/medicines' + qs(params)),
  batches: (params) => request('/batches' + qs(params)),
  createMedicine: (body) => request('/medicines', { method: 'POST', body }),
  deleteMedicine: (id) => request(`/medicines/${id}`, { method: 'DELETE' }),
  createBatch: (body) => request('/batches', { method: 'POST', body }),

  // ── Inspections ─────────────────────────────────────────
  inspections: (params) => request('/inspections' + qs(params)),
  inspection: (id) => request('/inspections/' + id),
  createInspection: (body) => request('/inspections', { method: 'POST', body }),

  // ── Shift Notes ─────────────────────────────────────────
  shiftNotes: (params) => request('/shift-notes' + qs(params)),
  createShiftNote: (body) => request('/shift-notes', { method: 'POST', body }),
  deleteShiftNote: (id) => request('/shift-notes/' + id, { method: 'DELETE' }),

  // ── Handovers ───────────────────────────────────────────
  handovers: (params) => request('/handovers' + qs(params)),
  createHandover: (body) => request('/handovers', { method: 'POST', body }),
  acknowledgeHandover: (id, body) => request(`/handovers/${id}/acknowledge`, { method: 'POST', body }),

  // ── Reports ─────────────────────────────────────────────
  reports: (params) => request('/reports' + qs(params)),
  createReport: (body) => request('/reports', { method: 'POST', body }),

  // ── Audit Log ───────────────────────────────────────────
  auditLogs: (params) => request('/audit-logs' + qs(params)),

  // ── Supply Requests ─────────────────────────────────────
  supplyRequests: (params) => request('/supply-requests' + qs(params)),
  createSupplyRequest: (body) => request('/supply-requests', { method: 'POST', body }),
  updateSupplyRequestStatus: (id, status) => request(`/supply-requests/${id}/status`, { method: 'PATCH', body: { status } }),
  cancelSupplyRequest: (id) => request(`/supply-requests/${id}/cancel`, { method: 'POST', body: {} }),

  // ── Admin: Users ────────────────────────────────────────
  users: (params) => request('/users' + qs(params)),
  approveUser: (id, body) => request(`/users/${id}/approve`, { method: 'POST', body }),
  rejectUser: (id) => request(`/users/${id}/reject`, { method: 'POST', body: {} }),
  setUserStatus: (id, status) => request(`/users/${id}/status`, { method: 'PATCH', body: { status } }),
  changeRole: (id, body) => request(`/users/${id}/role`, { method: 'PATCH', body }),
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),

  // ── Admin: Stations ─────────────────────────────────────
  stations: (params) => request('/stations' + qs(params)),
  createStation: (body) => request('/stations', { method: 'POST', body }),
  deleteStation: (id) => request(`/stations/${id}`, { method: 'DELETE' }),
};
