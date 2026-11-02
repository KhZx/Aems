// js/supervisor.js — Supervisor dashboard backed by the REST API (no Firebase RTDB).
// Multi-station: shows ONLY the units assigned to the caller (ManagedStation).

import { initI18n, setLanguage, getCurrentLang, t, onLanguageChanged, unitLabel } from './i18n.js';
import { initAppSession, setSession, renewSession, roleRedirectPath, clearSession, signOutAll } from './auth.js';
import { api } from './api.js';
import { icon, mountSprite } from './icons.js';
import { confirmDialog, promptDialog } from './confirm.js';
import { initSidebarNavigation } from './sidebar-nav.js';
import { initNotificationCenter } from './notifications.js';
import { createReportsDashboard } from './reports.js';
import { openChangePasswordDialog } from './password.js';

mountSprite();
initSidebarNavigation();

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function truncate(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''); }

// Shifts are fixed to A / B / C / D, each either morning or night.
const SHIFT_IDS = ['A', 'B', 'C', 'D'];
const SHIFT_PERIODS = ['Morning', 'Night'];
function shiftLabel(code, period) {
  const c = SHIFT_IDS.includes(code) ? code : '';
  const p = SHIFT_PERIODS.includes(period) ? period : '';
  if (c && p) return `${c} · ${t('app.settings.period_' + p.toLowerCase())}`;
  return c || '';
}

function isoDate(d) { const dt = d instanceof Date ? d : new Date(d ?? NaN); return isNaN(dt) ? null : dt; }
function fmtDate(d) { const dt = isoDate(d); return dt ? dt.toLocaleDateString() : ''; }
function fmtDateTime(d) { const dt = isoDate(d); return dt ? dt.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; }
function daysLeft(expiry) { const dt = isoDate(expiry); return dt ? Math.ceil((dt.getTime() - Date.now()) / 86400000) : null; }
function daysLabel(expiry) { const dl = daysLeft(expiry); if (dl == null) return ''; return dl < 0 ? ` (${Math.abs(dl)}d)` : ` (${dl}d)`; }

// ── Categories ─────────────────────────────────────────────
const CATS = [
  ['MEDICATION', 'modal.item.cat.medication'],
  ['LIFEPAK', 'modal.item.cat.lifepak'],
  ['RESPONDER', 'modal.item.cat.responder'],
  ['SUCTION', 'modal.item.cat.suction'],
  ['CAREVENT', 'modal.item.cat.carevent'],
  ['STATION_STORE', 'modal.item.cat.store'],
  ['CAR_CONTENTS', 'modal.item.cat.car'],
];
function catLabel(c) { const k = CATS.find((x) => x[0] === c); return k ? t(k[1]) : (c || '—'); }

// ── Audit action → i18n label ──────────────────────────────
const AUDIT_ACTION_KEYS = {
  USE_MEDICINE: 'sup.audit.action.use',
  RESTOCK: 'sup.audit.action.restock',
  RETURN: 'sup.audit.action.return',
  ADJUST_INVENTORY: 'sup.audit.action.sup_edit',
  DAMAGED: 'sup.audit.action.damage',
  EXPIRED: 'sup.audit.action.expire',
  INITIAL_STOCK: 'sup.audit.action.initial',
  INSPECTION: 'sup.audit.action.check',
  INSPECTION_DRAFT: 'sup.audit.action.insp_draft',
  INSPECTION_DRAFT_UPDATE: 'sup.audit.action.insp_draft_update',
  INSPECTION_DRAFT_DELETE: 'sup.audit.action.insp_draft_delete',
  INSPECTION_COMPLETE: 'sup.audit.action.insp_complete',
  INSPECTION_ACKNOWLEDGE: 'sup.audit.action.insp_ack',
  INSPECTION_VOID: 'sup.audit.action.insp_void',
  SUBMIT_HANDOVER: 'sup.audit.action.handover',
  ACKNOWLEDGE_HANDOVER: 'sup.audit.action.handover',
  CREATE_REPORT: 'sup.audit.action.report',
  TRANSFER: 'sup.audit.action.transfer',
  CREATE_SHIFT_NOTE: 'sup.audit.action.shiftnote',
  DELETE_SHIFT_NOTE: 'sup.audit.action.shiftnote',
  CREATE_MEDICINE: 'sup.audit.action.medicine',
  UPDATE_MEDICINE: 'sup.audit.action.edit',
  DELETE_MEDICINE: 'sup.audit.action.delete',
  CREATE_BATCH: 'sup.audit.action.batch',
  CREATE_STATION: 'sup.audit.action.station',
  UPDATE_STATION: 'sup.audit.action.edit',
  DELETE_STATION: 'sup.audit.action.delete',
  CREATE_AMBULANCE: 'sup.audit.action.station',
  UPDATE_AMBULANCE: 'sup.audit.action.edit',
  DELETE_AMBULANCE: 'sup.audit.action.delete',
  LOGIN: 'sup.audit.action.login',
  CREATE_USER: 'sup.audit.action.user',
  APPROVE_USER: 'sup.audit.action.user',
  REJECT_USER: 'sup.audit.action.user',
  CHANGE_ROLE: 'sup.audit.action.edit',
  DELETE_USER: 'sup.audit.action.delete',
  SUPERVISOR_EDIT: 'sup.audit.action.sup_edit',
  CREATE_SUPPLY_REQUEST: 'sup.audit.action.supply',
  APPROVE_SUPPLY_REQUEST: 'sup.audit.action.supply_approve',
  REJECT_SUPPLY_REQUEST: 'sup.audit.action.supply_reject',
  FULFIL_SUPPLY_REQUEST: 'sup.audit.action.supply_fulfil',
  CANCEL_SUPPLY_REQUEST: 'sup.audit.action.supply_cancel',
  DISTRIBUTE_STOCK: 'sup.audit.action.distribution',
  DUTY_SWITCH: 'sup.audit.action.duty_switch',
  UPDATE_USER_UNITS: 'sup.audit.action.units',
  UPDATE_SUPERVISOR_ZONE: 'sup.audit.action.zone',
};
function auditActionLabel(action) { return t(AUDIT_ACTION_KEYS[action] || 'sup.audit.action.generic', { action: action || '—' }); }

// ── State ──────────────────────────────────────────────────
let _session = null;
let stations = [];            // ordered list of assigned station ids
let _supData = {};            // id -> { id, code, name, items[] }
let _stationMeta = new Map(); // id -> { code, name }
let _directory = [];          // publicStations() listing
let _rawInventory = [];
let _rawAudit = [];
let _crew = [];               // approved users, for the duty board
let _handovers = [];
let _handoverLoadError = false;
let _auditPage = 0;           // server pages of audit already loaded
let _auditTotal = 0;          // total audit rows the backend holds for this scope
const AUDIT_PAGE_SIZE = 100;

/** Metadata keys that are bookkeeping, not "details the user filled in". */
const INTERNAL_META_KEYS = new Set(['userId', 'userEmail', 'medicineId', 'referenceId', 'ipAddress', 'userAgent', 'templateId', 'ambulanceId', 'corrections', 'lost', 'found', 'notChecked', 'notCheckedCount', 'checkedCount', 'inventoryId', 'reversals', 'fromStationId', 'toStationId']);

function fmtMetaVal(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
const _expanded = new Set();
let _reportSet = new Set();
let _reportData = null;
let _editTarget = null;
let _currentPage = 'overview';
let _toastTimer = null;
let _supplyRequests = [];
let _supplyPending = 0;

// ── Status helpers ─────────────────────────────────────────
function expiryFromISO(exp) {
  const dl = daysLeft(exp);
  if (dl == null) return 'NONE';
  if (dl < 0) return 'EXPIRED';
  if (dl <= 7) return 'CRITICAL';
  if (dl <= 30) return 'WARNING';
  return 'VALID';
}
function itemStatusKey(i) {
  const es = i.expiryStatus || expiryFromISO(i.expiry);
  if (es === 'EXPIRED') return 'expired';
  if (es === 'CRITICAL' || es === 'WARNING') return 'warning';
  return 'ok';
}
function stationStats(items) {
  let expired = 0, warning = 0, ok = 0;
  (items || []).forEach((i) => {
    const k = itemStatusKey(i);
    if (k === 'expired') expired++;
    else if (k === 'warning') warning++;
    else ok++;
  });
  const total = (items || []).length;
  return { expired, warning, ok, total };
}

function normalizeItem(r) {
  const b = r.batch || {};
  const amb = r.ambulance || {};
  const st = amb.station || {};
  return {
    id: r.id,
    name: b.medicine?.name || 'Unknown',
    category: b.medicine?.category || '',
    size: b.medicine?.size || null,
    quantity: Number(r.quantity) || 0,
    notes: r.notes || '',
    unit: b.medicine?.unit || '',
    strength: b.medicine?.strength || '',
    batchNumber: b.batchNumber || '',
    expiry: b.expiryDate || null,
    location: amb.vehicleNumber ? `${icon('ambulance')} ${esc(amb.vehicleNumber)}` : null,
    vehicleNumber: amb.vehicleNumber || '',
    supplier: b.supplier || '',
    lastCheck: r.updatedAt || null,
    ambulanceId: r.ambulanceId || null,
    stationId: st.id || null,
    expiryStatus: r.expiryStatus || expiryFromISO(b.expiryDate),
  };
}

function stationById(id) { return _supData[id] || null; }
function stationByCode(code) {
  if (!code) return null;
  return Object.values(_supData).find((d) => d && (d.code === code || d.name === code)) || null;
}

// ── Fetchers ───────────────────────────────────────────────
async function refreshInventory() {
  // Load bounded pages so large managed fleets never arrive as one huge API
  // response; the client helper merges pages for existing dashboard views.
  _rawInventory = await api.inventoryAll({});
  rebuildStations();
}
async function refreshAudit() {
  // Page 1: the backend auto-scopes this to the units the supervisor manages,
  // so a freshly tracked unit's entire history shows up immediately.
  const res = await api.auditLogs({ page: 1, pageSize: AUDIT_PAGE_SIZE });
  _rawAudit = Array.isArray(res) ? res : (res?.logs || []);
  _auditTotal = (res && res.total) || _rawAudit.length;
  _auditPage = 1;
}
async function refreshHandovers() {
  try {
    const first = await api.handovers({ page: 1, pageSize: 200 });
    const handovers = [...(first?.handovers || [])];
    const total = Number(first?.total) || handovers.length;
    for (let page = 2; handovers.length < total && page <= 20; page++) {
      const next = await api.handovers({ page, pageSize: 200 });
      const rows = next?.handovers || [];
      if (!rows.length) break;
      handovers.push(...rows);
    }
    _handovers = handovers;
    _handoverLoadError = false;
  } catch {
    _handovers = [];
    _handoverLoadError = true;
  }
  renderHandoverPage();
}
async function loadDirectory() {
  try {
    _directory = await api.publicStations();
    _directory.forEach((s) => _stationMeta.set(s.id, { code: s.code, name: s.name }));
  } catch { _directory = []; }
}

// ── Duty board ──────────────────────────────────────────────
/** Pages through GET /users (max 200/page) so the board sees every crew member. */
async function refreshCrew() {
  try {
    const users = [];
    let page = 1;
    for (;;) {
      const res = await api.users({ page, pageSize: 200 });
      const rows = (res && res.users) || [];
      users.push(...rows);
      const total = (res && res.total) || 0;
      if (!rows.length || users.length >= total || page >= 50) break;
      page += 1;
    }
    _crew = users;
  } catch { /* keep the previous snapshot */ }
}

/** id -> {code,name} for every known unit (directory + units seen on users). */
function unitIndex() {
  const map = new Map();
  _directory.forEach((s) => map.set(s.id, { code: s.code, name: s.name }));
  _crew.forEach((u) => {
    if (u.station && !map.has(u.station.id)) map.set(u.station.id, { code: u.station.code, name: u.station.name });
  });
  return map;
}

window.renderDuty = function () {
  const q = ($('dutySearch')?.value || '').trim().toLowerCase();
  const managed = new Set(stations);
  const idx = unitIndex();
  const unitName = (id) => { const m = idx.get(id); return m ? unitLabel(m.code, m.name) : '—'; };
  const CREW_ROLES = new Set(['PARAMEDIC', 'SUPERVISOR']);

  const crew = _crew.filter((u) => u.status === 'active' && CREW_ROLES.has(String(u.role || '').toUpperCase()));
  const haystack = (u) => [
    u.displayName, u.email, u.empId, u.role,
    u.station ? unitLabel(u.station.code, u.station.name) : '',
    ...(u.dutyUnitIds || []).map((id) => unitName(id)),
  ].filter(Boolean).join(' ').toLowerCase();
  const matches = (u) => !q || haystack(u).includes(q);

  const byUnit = new Map();
  const unassigned = [];
  const available = [];
  crew.forEach((u) => {
    const rosterHit = (u.dutyUnitIds || []).some((id) => managed.has(id));
    if (managed.size && rosterHit && (!u.stationId || !managed.has(u.stationId))) available.push(u);
    if (u.stationId) {
      if (!byUnit.has(u.stationId)) byUnit.set(u.stationId, []);
      byUnit.get(u.stationId).push(u);
    } else {
      unassigned.push(u);
    }
  });

  const rosterLabel = (u) => {
    const ids = (u.dutyUnitIds || []).filter((id) => idx.has(id));
    if (ids.length < 2) return '';
    return `<div class="duty-crew-roster">${t('sup.duty.roster')}: ${ids.map((id) => unitName(id)).join(' · ')}</div>`;
  };
  const crewRows = (list) => {
    const shown = list.filter(matches);
    if (!shown.length) return `<div class="duty-empty">${t('sup.duty.empty_unit')}</div>`;
    return shown.map((u) => `
      <div class="duty-crew-row">
        <div>
          <div class="duty-crew-name">${esc(u.displayName || u.email)}</div>
          <div class="duty-crew-sub"><span class="duty-role-tag">${esc(u.role)}</span>${u.empId ? esc(u.empId) : ''}</div>
        </div>
        ${rosterLabel(u)}
      </div>`).join('');
  };

  const unitIds = [...new Set([...managed, ...byUnit.keys()])];
  unitIds.sort((a, b) => {
    const am = managed.has(a) ? 0 : 1;
    const bm = managed.has(b) ? 0 : 1;
    if (am !== bm) return am - bm;
    return String(idx.get(a)?.code || '').localeCompare(String(idx.get(b)?.code || ''), undefined, { numeric: true });
  });

  const cards = unitIds.map((id) => {
    const mine = managed.has(id);
    const list = byUnit.get(id) || [];
    return `<div class="duty-unit-card${mine ? ' mine' : ''}${list.filter(matches).length ? '' : ' empty'}">
      <div class="duty-unit-head">
        <span class="duty-unit-label">${esc(unitName(id))}</span>
        <span class="duty-unit-count">${t('sup.duty.crew_count', { n: list.length })}</span>
      </div>
      ${crewRows(list)}
    </div>`;
  });
  if (unassigned.length) {
    cards.push(`<div class="duty-unit-card empty">
      <div class="duty-unit-head">
        <span class="duty-unit-label">${t('sup.duty.unassigned')}</span>
        <span class="duty-unit-count">${t('sup.duty.crew_count', { n: unassigned.length })}</span>
      </div>
      ${crewRows(unassigned)}
    </div>`);
  }
  $('dutyUnitGrid').innerHTML = cards.join('') ||
    `<div class="duty-empty">${t('sup.duty.empty_unit')}</div>`;
  $('dutyCrewCount').textContent = `${crew.length} ${t('sup.duty.total')}`;

  const pill = $('dutyManagedPill');
  pill.style.display = managed.size ? '' : 'none';
  pill.textContent = `${managed.size} ${t('sup.manage.units')}`;

  const availShown = available.filter(matches);
  $('dutyAvailableWrap').innerHTML = availShown.length ? `
    <div class="section-head" style="margin-bottom:4px;">
      <div class="section-title" style="font-size:.85rem;">${t('sup.duty.available')}</div>
      <span style="font-size:.7rem;color:var(--text3);">${availShown.length}</span>
    </div>
    <div class="duty-available">
      ${availShown.map((u) => `
        <div class="duty-available-row">
          <div>
            <div class="duty-crew-name">${esc(u.displayName || u.email)}</div>
            <div class="duty-crew-sub"><span class="duty-role-tag">${esc(u.role)}</span>${u.empId ? esc(u.empId) : ''}</div>
          </div>
          ${rosterLabel(u)}
        </div>`).join('')}
    </div>
    <div style="font-size:.68rem;color:var(--text3);margin-top:6px;">${t('sup.duty.available_sub')}</div>` : '';

  const switches = _rawAudit.filter((e) => e.action === 'DUTY_SWITCH').slice(0, 30);
  $('dutySwitchCount').textContent = `${switches.length}`;
  $('dutySwitchList').innerHTML = switches.length ? switches.map((e) => {
    const m = (e.metadata && typeof e.metadata === 'object') ? e.metadata : {};
    const from = unitLabel(m.from, m.fromName);
    const to = unitLabel(m.to, m.toName);
    const who = e.user?.displayName || e.user?.email || e.userName || e.userEmail || '—';
    const reason = e.reason || m.reason || '';
    return `<div class="duty-switch-row">
      <div class="duty-switch-time">${fmtDateTime(e.createdAt)}</div>
      <div class="duty-switch-main">
        <div><strong>${esc(who)}</strong><span class="duty-switch-arrow">→</span>${esc(from)}<span class="duty-switch-arrow">→</span>${esc(to)}</div>
        ${reason ? `<div class="duty-switch-reason">"${esc(String(reason))}"</div>` : ''}
      </div>
    </div>`;
  }).join('') : `<div class="duty-empty" style="padding:14px 0;">${t('sup.duty.no_switches')}</div>`;
};

window.refreshDutyBoard = async function () {
  await Promise.all([refreshCrew(), refreshAudit()]);
  renderDuty();
};

function rebuildStations() {
  _supData = {};
  stations.forEach((id) => {
    const meta = _stationMeta.get(id) || {};
    _supData[id] = {
      id,
      code: meta.code || id,
      name: meta.code ? unitLabel(meta.code, meta.name) : (meta.name || id),
      items: _rawInventory
        .filter((r) => (r.ambulance?.station?.id) === id)
        .map(normalizeItem)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

// ── Boot ───────────────────────────────────────────────────
async function boot() {
  try {
    let sess = await initAppSession();
    if (!sess) { window.location.href = '/login.html'; return; }
    if (sess.user?.role !== 'SUPERVISOR') { window.location.href = roleRedirectPath(sess); return; }
    _session = sess;
    window.AEMS_PERMS = sess.permissions || [];
    initNotificationCenter();

    try {
      const me = await api.me();
      _session = { ..._session, ...me };
      setSession(_session);
    } catch (e) {
      if (e && /sign in|session|401/i.test(String(e.message || e))) {
        const ok = await renewSession();
        if (!ok) { window.location.href = '/login.html'; return; }
        _session = getCachedSession();
      }
    }

    const user = _session.user || {};
    applyAssignment(user);

    $('sidebarName')?.textContent && ($('sidebarName').textContent = user.name || user.email || '—');
    $('sidebarZone')?.textContent && ($('sidebarZone').textContent = user.supervisorZone ? `${t('sup.zone')} ${user.supervisorZone}` : '');

    initI18n();
    wireLangToggle();
    wireShiftControls();
    wireSupervisorZone();

    await Promise.all([loadDirectory(), refreshInventory(), refreshAudit(), refreshCrew(), loadSupply(), refreshHandovers()]);
    $('pageLoader')?.classList.add('hide');
    applyAll();
    toast(t('sup.toast.data_refreshed'), 'success');
  } catch (err) {
    console.error('supervisor boot failed:', err);
    $('pageLoader')?.classList.add('hide');
    toast('Failed to load dashboard — ' + (err && err.message ? err.message : err), 'error');
  }
}

function getCachedSession() {
  try {
    const raw = localStorage.getItem('aems_session');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Toast ──────────────────────────────────────────────────
function toast(msg, type = '') {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.borderColor = type === 'error' ? 'rgba(239,68,68,.5)' : type === 'success' ? 'rgba(110,231,183,.5)' : 'var(--border)';
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
window.toast = toast;

// ── Page routing ───────────────────────────────────────────
function closeSidebar() {
  document.querySelector('.sidebar')?.classList.remove('open');
  document.getElementById('sidebarOverlay')?.classList.remove('show');
}
function toggleSidebar(force) {
  const sb = document.querySelector('.sidebar');
  const open = typeof force === 'boolean' ? force : !sb?.classList.contains('open');
  sb?.classList.toggle('open', open);
  document.getElementById('sidebarOverlay')?.classList.toggle('show', open);
}
document.getElementById('supMenuBtn')?.addEventListener('click', () => toggleSidebar());
document.getElementById('sidebarOverlay')?.addEventListener('click', () => toggleSidebar(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleSidebar(false); });
document.querySelector('.sidebar')?.addEventListener('click', (e) => {
  if (e.target.closest('.nav-item, .st-item, .btn-logout')) toggleSidebar(false);
});

const PAGE_TITLE_KEYS = {
  overview: 'sup.page.overview', stations: 'sup.page.stations',
  inspections: 'sup.page.inspections', reports: 'sup.page.reports',
  handovers: 'sup.page.handovers',
  audit: 'sup.page.audit', manage: 'sup.page.manage',
  supply: 'sup.page.supply', duty: 'sup.page.duty',
  analytics: 'sup.page.analytics', settings: 'sup.page.settings',
};

/** Re-applies the topbar page title in the current language. */
function paintPageTitle() {
  const el = $('pageTitle');
  if (el) el.textContent = PAGE_TITLE_KEYS[_currentPage] ? t(PAGE_TITLE_KEYS[_currentPage]) : _currentPage;
}

window.showPage = function (id) {
  _currentPage = id;
  closeSidebar();
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
  $('page-' + id)?.classList.add('active');
  document.querySelector(`.nav-item[onclick="showPage('${id}')"]`)?.classList.add('active');
  paintPageTitle();
  if (id === 'overview') renderOverview();
  if (id === 'stations') renderStationsPage();
  if (id === 'inspections') { if (_inspOverview) renderInspections(); else refreshInspections(); }
  if (id === 'handovers') refreshHandovers();
  if (id === 'reports') { renderReportSelector(); loadSavedReports(); }
  if (id === 'analytics') ensureAnalytics();
  if (id === 'audit') renderAudit();
  if (id === 'manage') renderManage();
  if (id === 'supply') renderSupplyReview();
  if (id === 'duty') { renderDuty(); if (!_crew.length) refreshDutyBoard(); }
  if (id === 'settings') renderSettings();
};

function renderHandoverPage() {
  const root = $('supHandoversList');
  if (!root) return;
  const pendingCount = _handovers.filter((h) => h.status === 'submitted').length;
  const badge = $('supHandoverBadge');
  if (badge) {
    badge.textContent = String(pendingCount);
    badge.style.display = pendingCount ? 'inline-flex' : 'none';
  }

  if (_handoverLoadError) {
    root.innerHTML = `<div class="empty"><div class="empty-text">${t('sup.handover.load_error')}</div></div>`;
    return;
  }
  if (!_handovers.length) {
    root.innerHTML = `<div class="empty"><div class="empty-icon">${icon('repeat')}</div><div class="empty-text">${t('sup.handover.empty')}</div></div>`;
    return;
  }

  const eqKeys = {
    'All OK': 'handover.eq.all_ok',
    'Issues Noted': 'handover.eq.noted',
    'Critical Items Missing': 'handover.eq.critical',
  };
  const detail = (label, value) => value
    ? `<div class="sup-handover-detail"><span>${label}</span><div>${esc(value)}</div></div>`
    : '';

  root.innerHTML = `<div class="sup-handover-list">${_handovers.map((h) => {
    const submitted = h.status === 'submitted';
    const stationName = h.station?.name || h.station?.code || '—';
    const stationCode = h.station?.code && h.station?.name ? h.station.code : '';
    const outgoing = h.outgoing || {};
    const incoming = h.incoming || {};
    const equipKey = eqKeys[outgoing.equipStatus];
    const equipStatus = equipKey ? t(equipKey) : (outgoing.equipStatus || '—');
    return `<article class="sup-handover-card">
      <header class="sup-handover-card-head">
        <div class="sup-handover-station">${stationCode ? `<span class="sup-handover-station-code">${esc(stationCode)}</span>` : ''}<strong>${esc(stationName)}</strong></div>
        <span class="sup-handover-status ${submitted ? 'pending' : 'complete'}">${t(submitted ? 'sup.handover.status_pending' : 'sup.handover.status_acknowledged')}</span>
      </header>
      <div class="sup-handover-summary">
        <div><span>${t('sup.handover.outgoing')}</span><strong>${esc(outgoing.paramedicName || '—')}</strong></div>
        <div><span>${t('sup.handover.incoming')}</span><strong>${esc(incoming.paramedicName || (submitted ? t('sup.handover.awaiting') : '—'))}</strong></div>
        <div><span>${t('sup.handover.shift')}</span><strong>${esc(outgoing.shiftType || '—')}</strong></div>
        <div><span>${t('sup.handover.patients')}</span><strong>${Number(outgoing.patientsCount) || 0}</strong></div>
        <div><span>${t('sup.handover.equipment')}</span><strong>${esc(equipStatus)}</strong></div>
      </div>
      <div class="sup-handover-details">
        ${detail(t('sup.handover.issues'), outgoing.pendingIssues)}
        ${detail(t('sup.handover.medications'), outgoing.medicationsUsed)}
        ${detail(t('sup.handover.notes'), outgoing.notes)}
        ${detail(t('sup.handover.incoming_notes'), incoming.notes)}
      </div>
      <footer class="sup-handover-times">
        <span>${t('sup.handover.submitted')}: ${esc(fmtDateTime(h.createdAt))}</span>
        ${h.acknowledgedAt ? `<span>${t('sup.handover.acknowledged')}: ${esc(fmtDateTime(h.acknowledgedAt))}</span>` : ''}
      </footer>
    </article>`;
  }).join('')}</div>`;
}

window.refreshSupervisorHandovers = async function () {
  await refreshHandovers();
};

// ── Analytics (shared Reports Dashboard, scoped to managed units) ──
let supReportsDash = null;
function ensureAnalytics() {
  if (!supReportsDash) {
    supReportsDash = createReportsDashboard({
      rootId: 'supReports',
      getStations: async () => {
        const ids = stations.length ? [...stations] : Object.keys(_supData || {});
        return ids
          .map((id) => {
            const meta = _stationMeta.get(id) || _supData[id] || {};
            return { id, code: meta.code || '', name: meta.name || '' };
          })
          .filter((s) => s.id);
      },
    });
  }
  supReportsDash?.refresh();
  return supReportsDash;
}

function applyAll() {
  paintPageTitle();
  $('sidebarName') && ($('sidebarName').textContent = (_session?.user?.name || _session?.user?.email) || '-');
  $('sidebarZone') && ($('sidebarZone').textContent = _session?.user?.supervisorZone ? `${t('sup.zone')} ${_session.user.supervisorZone}` : '');
  renderSidebarStations();
  updateAlertBadge();
  updateTopbarPill();
  updateConnectionPill();
  const p = _currentPage;
  if (p === 'overview') renderOverview();
  else if (p === 'stations') renderStationsPage();
  else if (p === 'inspections') { if (_inspOverview) renderInspections(); }
  else if (p === 'handovers') renderHandoverPage();
  else if (p === 'reports') { renderReportSelector(); loadSavedReports(); }
  else if (p === 'analytics') { supReportsDash?.rerender(); }
  else if (p === 'audit') renderAudit();
  else if (p === 'manage') renderManage();
  else if (p === 'supply') renderSupplyReview();
  else if (p === 'duty') renderDuty();
  else if (p === 'settings') renderSettings();
}

/** Settings page: shows the signed-in supervisor and the password action. */
function renderSettings() {
  const name = $('settingsProfileName');
  const email = $('settingsProfileEmail');
  if (name) name.textContent = (_session?.user?.name || _session?.user?.displayName || _session?.user?.email) || '—';
  if (email) email.textContent = _session?.user?.email || '—';
  const zone = $('settingsSupervisorZone');
  if (zone) zone.value = _session?.user?.supervisorZone || '';
}

function wireSupervisorZone() {
  const input = $('settingsSupervisorZone');
  const button = $('saveSupervisorZone');
  if (!input || !button) return;
  button.addEventListener('click', saveSupervisorZone);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveSupervisorZone();
    }
  });
}

async function saveSupervisorZone() {
  const input = $('settingsSupervisorZone');
  const button = $('saveSupervisorZone');
  if (!input || !button || button.disabled) return;
  const supervisorZone = input.value.trim();
  if (supervisorZone.length > 100) return;

  button.disabled = true;
  try {
    const updated = await api.updateMySupervisorZone(supervisorZone);
    const user = { ...(_session?.user || {}), ...updated };
    _session = { ..._session, user };
    setSession(_session);
    renderSettings();
    const sidebarZone = $('sidebarZone');
    if (sidebarZone) sidebarZone.textContent = user.supervisorZone ? `${t('sup.zone')} ${user.supervisorZone}` : '';
    toast(t('sup.settings.zone_saved'), 'success');
  } catch (err) {
    toast(err?.message || String(err), 'error');
  } finally {
    button.disabled = false;
  }
}

function wireLangToggle() {
  const btn = $('supLangToggle');
  if (!btn) return;
  btn.addEventListener('click', () => { setLanguage(getCurrentLang() === 'en' ? 'ar' : 'en'); });
  onLanguageChanged(() => { applyAll(); });
}

function wireShiftControls() {
  const code = $('supShift');
  const period = $('supPeriod');
  const chip = $('supShiftChip');
  if (!code || !period) return;
  const paint = () => {
    if (!chip) return;
    const c = SHIFT_IDS.includes(code.value) ? code.value : '';
    const p = SHIFT_PERIODS.includes(period.value) ? period.value : '';
    if (c) {
      chip.textContent = `${t('app.settings.shift')} ${p ? shiftLabel(c, p) : c}`;
      chip.style.display = 'inline-block';
    } else {
      chip.style.display = 'none';
    }
  };
  const save = () => {
    try { localStorage.setItem('aems_sup_shift', JSON.stringify({ code: code.value || '', period: period.value || '' })); } catch { /* ignore */ }
    paint();
  };
  code.addEventListener('change', save);
  period.addEventListener('change', save);
  // The chip text is built from t(), so it must be rebuilt when the language
  // changes - otherwise it keeps the language it was painted in.
  onLanguageChanged(paint);
  try {
    const saved = JSON.parse(localStorage.getItem('aems_sup_shift') || 'null');
    if (saved) {
      if (SHIFT_IDS.includes(saved.code)) code.value = saved.code;
      if (SHIFT_PERIODS.includes(saved.period)) period.value = saved.period;
    }
  } catch { /* ignore */ }
  paint();
}

// ── Sidebar / status chrome ────────────────────────────────
function renderSidebarStations() {
  const el = $('stationList');
  if (!stations.length) {
    el.innerHTML = '<div style="padding:8px 10px;font-size:.75rem;color:var(--text3);">' + t('sup.empty.no_stations') + '</div>';
    return;
  }
  el.innerHTML = stations.map((id) => {
    const d = _supData[id];
    if (!d) return '';
    const st = stationStats(d.items);
    const dot = st.expired ? 'danger' : st.warning ? 'warn' : 'ok';
    return `<div class="st-item" onclick="goStation('${esc(d.code)}')">
      <span class="st-dot ${dot}"></span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(d.name)}</span>
      ${st.expired ? `<span style="font-size:.62rem;color:#FCA5A5;font-weight:700;">${st.expired}</span>` : ''}
    </div>`;
  }).join('');
}

function updateAlertBadge() {
  let total = 0;
  stations.forEach((id) => { const d = _supData[id]; if (d) total += stationStats(d.items).expired; });
  const badge = $('alertNavBadge');
  if (total > 0) { badge.textContent = total; badge.style.display = 'inline-block'; }
  else badge.style.display = 'none';
}

function updateTopbarPill() {
  let w = 0, e = 0;
  stations.forEach((id) => { const d = _supData[id]; if (d) { const st = stationStats(d.items); w += st.warning; e += st.expired; } });
  const pill = $('topbarPill');
  if (e > 0) {
    pill.className = 'pill red';
    pill.style.cssText = '';
    pill.textContent = `⚠ ${e} ${t('sup.status.expired')}`;
  } else if (w > 0) {
    pill.className = 'pill';
    pill.style.cssText = 'background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.25);color:#FDE68A;';
    pill.textContent = `⚠ ${w} ${t('sup.status.warning')}`;
  } else {
    pill.className = 'pill';
    pill.style.cssText = 'background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.25);color:#6EE7B7;';
    pill.textContent = '✓';
  }
}

function updateConnectionPill() {
  const el = $('supConnStatus');
  if (!el) return;
  el.className = 'conn-status live';
  $('supConnLabel').textContent = t('app.conn.live') || 'Live';
  $('supConnDetail').textContent = new Date().toLocaleTimeString();
}

window.goStation = function (code) {
  showPage('stations');
  setTimeout(() => {
    const el = document.getElementById(`st-expand-${esc(code)}`);
    if (el && !el.classList.contains('open')) toggleExpand(code);
  }, 50);
};

// ── Overview ───────────────────────────────────────────────
function renderOverview() {
  let totalItems = 0, totalExpired = 0, totalWarning = 0;
  const allAlerts = [];
  const ambCount = Array.isArray(_session?.ambulances) ? _session.ambulances.length : stations.length;

  stations.forEach((id) => {
    const d = _supData[id];
    if (!d) return;
    const st = stationStats(d.items);
    totalItems += st.total;
    totalExpired += st.expired;
    totalWarning += st.warning;
    d.items.forEach((i) => {
      const k = itemStatusKey(i);
      if (k === 'expired' || k === 'warning') allAlerts.push({ sev: k, item: i, stName: d.name });
    });
  });

  $('overviewStats').innerHTML = `
    <div class="stat-card blue"><div class="stat-icon">${icon('building')}</div><div class="stat-num">${stations.length}</div><div class="stat-label">${t('sup.stat.tracked')}</div></div>
    <div class="stat-card green"><div class="stat-icon">${icon('package')}</div><div class="stat-num">${totalItems}</div><div class="stat-label">${t('sup.stat.items')}</div></div>
    <div class="stat-card amber"><div class="stat-icon"><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg></div><div class="stat-num">${totalWarning}</div><div class="stat-label">${t('sup.stat.warning')}</div></div>
    <div class="stat-card red"><div class="stat-icon">${icon('xCircle')}</div><div class="stat-num">${totalExpired}</div><div class="stat-label">${t('sup.stat.expired')}</div></div>
    <div class="stat-card green" style="border-color:${ambCount ? 'rgba(110,231,183,.2)' : 'var(--border)'};">
      <div class="stat-icon">${icon('ambulance')}</div>
      <div class="stat-num" style="color:${ambCount ? '#6EE7B7' : 'var(--text3)'};">${ambCount}</div>
      <div class="stat-label">${t('sup.stat.ambulances')}</div>
    </div>`;

  $('overviewGrid').innerHTML = stations.length ? stations.map((id) => {
    const d = _supData[id]; if (!d) return '';
    const st = stationStats(d.items);
    const cls = st.expired ? 'has-expired' : st.warning ? 'has-warning' : '';
    return `<div class="st-card ${cls}" onclick="goStation('${esc(d.code)}')">
      <div class="st-card-head">
        <div>
          <div class="st-card-name">${esc(d.name)}</div>
          <div class="st-card-sub">${esc(d.code)} · ${st.total} ${t('sup.items')}</div>
        </div>
        <span class="st-dot ${st.expired ? 'danger' : st.warning ? 'warn' : 'ok'}" style="width:10px;height:10px;margin-top:4px;"></span>
      </div>
      <div class="st-chips">
        <span class="chip ok">${st.ok} ${t('sup.col.valid')}</span>
        ${st.warning ? `<span class="chip warn">${st.warning} <svg class="ic" aria-hidden="true"><use href="#i-alert"/></svg> ${t('sup.col.warning')}</span>` : ''}
        ${st.expired ? `<span class="chip exp">${st.expired} ${icon('xCircle')} ${t('sup.col.expired')}</span>` : ''}
      </div>
    </div>`;
  }).join('') : `<div class="empty"><div class="empty-icon">${icon('building')}</div><div class="empty-text">${t('sup.empty.no_stations')}</div></div>`;

  allAlerts.sort((a, b) => (a.sev === 'expired' ? -1 : 1));
  $('overviewAlerts').innerHTML = allAlerts.length ? allAlerts.slice(0, 30).map(({ sev, item, stName }) => {
    const color = sev === 'expired' ? '#FCA5A5' : '#FDE68A';
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border2);">
      <span>${sev === 'expired' ? '✕' : `<svg class="ic" aria-hidden="true"><use href="#i-alert"/></svg>`}</span>
      <div style="flex:1;">
        <div style="font-weight:600;font-size:.84rem;">${esc(item.name)}</div>
        <div style="font-size:.7rem;color:var(--text3);">${esc(stName)} · ${catLabel(item.category)} ${item.location ? '· ' + item.location : ''}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:.75rem;font-weight:700;color:${color};">${daysLabel(item.expiry)}</div>
        <div style="font-size:.68rem;color:var(--text3);">${fmtDate(item.expiry)}</div>
      </div>
    </div>`;
  }).join('') : `<div class="empty"><div class="empty-icon">${icon('checkCircle')}</div><div class="empty-text">${t('sup.empty.all_good')}</div></div>`;

  renderSupCharts();
}

// ── Charts ─────────────────────────────────────────────────
// Chart.js (loaded in supervisor.html before this module) gives us proper
// DPR-aware scaling and hover tooltips for free — no hand-rolled canvas.
const _supCharts = {};
if (typeof Chart !== 'undefined') {
  Chart.defaults.font.family = "'Cairo', 'Outfit', system-ui, sans-serif";
  Chart.defaults.color = '#94A3B8';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.07)';
  Chart.defaults.plugins.legend.display = false;
}
function _destroySupChart(id) {
  if (_supCharts[id]) { _supCharts[id].destroy(); delete _supCharts[id]; }
}
const _supChartColors = {
  expired: '#EF4444',
  warning: '#F59E0B',
  ok: '#10B981',
  border: '#161B22',
};
const supDonutCenter = {
  id: 'supDonutCenter',
  afterDatasetsUpdate(chart) {
    const seg = chart.data.datasets[0]?.data || [];
    const total = seg.reduce((a, b) => a + b, 0);
    if (!total) return;
    const meta = chart.getDatasetMeta(0)?.data?.[0];
    if (!meta) return;
    const pct = Math.round(((seg[0] || 0) / total) * 100);
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = '#F1F5F9';
    ctx.font = `700 ${Math.round(meta.outerRadius * 0.38)}px 'Outfit', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${pct}%`, meta.x, meta.y);
    ctx.restore();
  },
};
function renderSupCharts() {
  let ok = 0, warning = 0, expired = 0;
  stations.forEach((id) => { const st = stationStats(_supData[id]?.items || []); ok += st.ok; warning += st.warning; expired += st.expired; });
  const total = ok + warning + expired;

  const legend = $('supDonutLegend');
  if (legend) {
    const chunks = [
      [t('sup.col.valid'), ok, _supChartColors.ok],
      [t('sup.col.warning'), warning, _supChartColors.warning],
      [t('sup.col.expired'), expired, _supChartColors.expired],
    ];
    legend.innerHTML = total > 0
      ? chunks.map(([label, v, c]) => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:.72rem;color:var(--text2);"><span style="width:9px;height:9px;border-radius:2px;background:${c};flex-shrink:0;"></span>${label} <b style="color:var(--text);font-weight:800;">${v}</b></span>`).join('')
      : `<span style="font-size:.72rem;color:var(--text3);">${t('sup.chart.empty')}</span>`;
  }

  const donut = $('supStatusDonut');
  if (donut && typeof Chart !== 'undefined') {
    _destroySupChart('donut');
    if (total > 0) {
      _supCharts.donut = new Chart(donut, {
        type: 'doughnut',
        data: {
          labels: [t('sup.col.valid'), t('sup.col.warning'), t('sup.col.expired')],
          datasets: [{
            data: [ok, warning, expired],
            backgroundColor: [_supChartColors.ok, _supChartColors.warning, _supChartColors.expired],
            borderWidth: 3, borderColor: _supChartColors.border,
            hoverBorderColor: '#1C2230', hoverOffset: 6,
          }],
        },
        options: {
          cutout: '68%', responsive: true, maintainAspectRatio: false,
          animation: { animateRotate: true, duration: 900, easing: 'easeOutQuart' },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (ctx) => `  ${ctx.label}: ${ctx.raw}${total ? ` (${Math.round(ctx.raw / total * 100)}%)` : ''}` } },
          },
        },
        plugins: [supDonutCenter],
      });
    }
  }

  const cmp = $('supCompChart');
  if (cmp && typeof Chart !== 'undefined') {
    _destroySupChart('comp');
    if (!stations.length) return;
    const rows = stations.map((id) => ({ name: _supData[id]?.name || _supData[id]?.code || id, st: stationStats(_supData[id]?.items || []) }));
    _supCharts.comp = new Chart(cmp, {
      type: 'bar',
      data: {
        labels: rows.map((r) => truncate(r.name, 16)),
        datasets: [
          { label: t('sup.col.valid'), data: rows.map((r) => r.st.ok), stack: 'st', backgroundColor: _supChartColors.ok, borderWidth: 0, hoverBackgroundColor: '#34D399' },
          { label: t('sup.col.warning'), data: rows.map((r) => r.st.warning), stack: 'st', backgroundColor: _supChartColors.warning, borderWidth: 0, hoverBackgroundColor: '#FBBF24' },
          { label: t('sup.col.expired'), data: rows.map((r) => r.st.expired), stack: 'st', backgroundColor: _supChartColors.expired, borderWidth: 0, hoverBackgroundColor: '#F87171' },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 750, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10, padding: 12, font: { size: 10 }, usePointStyle: true } },
          tooltip: { callbacks: { label: (ctx) => `  ${ctx.dataset.label}: ${ctx.raw}` } },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: '#9CA3AF', font: { size: 10 }, maxRotation: 0, autoSkip: false } },
          y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { precision: 0, color: '#94A3B8', font: { size: 11 } } },
        },
      },
    });
  }
}

// ── Stations page ──────────────────────────────────────────
function renderStationsPage() {
  const search = ($('stationSearch')?.value || '').toLowerCase();
  const filter = $('stationAlertFilter')?.value || '';
  let list = stations.map((id) => _supData[id]).filter(Boolean).filter((d) => {
    if (search && !d.name.toLowerCase().includes(search) && !d.code.toLowerCase().includes(search)) return false;
    if (filter) {
      const st = stationStats(d.items);
      if (filter === 'expired' && !st.expired) return false;
      if (filter === 'warning' && !st.warning) return false;
      if (filter === 'low' && !st.low) return false;
      if (filter === 'ok' && (st.expired || st.warning || st.low)) return false;
    }
    return true;
  });

  const grid = $('stationsPageGrid');
  if (!list.length) {
    grid.innerHTML = `<div class="empty"><div class="empty-icon">${icon('building')}</div><div class="empty-text">${t('sup.empty.no_match')}</div></div>`;
    return;
  }

  grid.innerHTML = list.map((d) => {
    const items = d.items;
    const st = stationStats(items);
    const isOpen = _expanded.has(d.code);
    const cls = st.expired ? 'has-expired' : st.warning ? 'has-warning' : '';
    return `<div class="st-card ${cls}" id="stcard-${esc(d.code)}" style="margin-bottom:.75rem;">
      <div class="st-card-head">
        <div>
          <div class="st-card-name">${esc(d.name)}</div>
          <div class="st-card-sub">${esc(d.code)} · ${st.total} ${t('sup.items')}</div>
        </div>
        <span class="st-dot ${st.expired ? 'danger' : st.warning ? 'warn' : 'ok'}" style="width:10px;height:10px;margin-top:5px;"></span>
      </div>
      <div class="st-chips">
        <span class="chip ok">${st.ok} ${t('sup.col.valid')}</span>
        ${st.warning ? `<span class="chip warn">${st.warning} ${t('sup.col.warning')}</span>` : ''}
        ${st.expired ? `<span class="chip exp">${st.expired} ${t('sup.col.expired')}</span>` : ''}
      </div>
      <div class="st-card-foot">
        <button class="btn-sm primary" onclick="toggleExpand('${esc(d.code)}')" id="expandBtn-${esc(d.code)}">
          ${isOpen ? t('sup.btn.collapse') : t('sup.btn.expand')}
        </button>
        <button class="btn-sm" onclick="quickReport('${esc(d.code)}','${esc(d.name)}')">${t('sup.btn.report')}</button>
      </div>
      <div class="st-expand ${isOpen ? 'open' : ''}" id="st-expand-${esc(d.code)}">
        <div class="st-expand-head">
          <input class="filter-input" style="max-width:220px;padding:6px 10px;font-size:.78rem;" placeholder="${t('sup.search.items')}" id="itemSearch-${esc(d.code)}" oninput="renderItemsTable('${esc(d.code)}')">
          <select class="filter-select" id="itemExpFilt-${esc(d.code)}" onchange="renderItemsTable('${esc(d.code)}')">
            <option value="">${t('sup.filter.all_status')}</option>
            <option value="expired">${t('sup.col.expired')}</option>
            <option value="warning">⚠ ${t('sup.col.warning')}</option>
            <option value="ok">${t('sup.col.valid')}</option>
          </select>
          <select class="filter-select" id="itemCatFilt-${esc(d.code)}" onchange="renderItemsTable('${esc(d.code)}')">
            <option value="">${t('sup.all_categories')}</option>
            ${CATS.map(([v, k]) => `<option value="${v}">${t(k)}</option>`).join('')}
          </select>
          <span style="font-size:.72rem;color:var(--text3);margin-right:auto;" id="itemCount-${esc(d.code)}"></span>
        </div>
        <div class="st-expand-body">
          <div class="tbl-wrap" id="itemsTable-${esc(d.code)}">
            ${renderItemsTableHTML(d.code, items)}
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  $('stationSearch') && ($('stationSearch').oninput = renderStationsPage);
  $('stationAlertFilter') && ($('stationAlertFilter').onchange = renderStationsPage);
}

window.toggleExpand = function (code) {
  if (_expanded.has(code)) _expanded.delete(code);
  else _expanded.add(code);
  const panel = $(`st-expand-${esc(code)}`);
  const btn = $(`expandBtn-${esc(code)}`);
  if (!panel) return;
  panel.classList.toggle('open', _expanded.has(code));
  if (btn) btn.textContent = _expanded.has(code) ? t('sup.btn.collapse') : t('sup.btn.expand');
  if (_expanded.has(code)) renderItemsTable(code);
};

window.renderItemsTable = function (code) {
  const d = stationByCode(code);
  const el = $(`itemsTable-${esc(code)}`);
  if (el) el.innerHTML = renderItemsTableHTML(code, d ? d.items : []);
};

function renderItemsTableHTML(code, allItems) {
  const query = ($(`itemSearch-${esc(code)}`)?.value || '').toLowerCase();
  const expFilt = $(`itemExpFilt-${esc(code)}`)?.value || '';
  const catFilt = $(`itemCatFilt-${esc(code)}`)?.value || '';

  let items = allItems.filter((i) => {
    if (query && !i.name.toLowerCase().includes(query) && !i.batchNumber.toLowerCase().includes(query)) return false;
    if (expFilt && itemStatusKey(i) !== expFilt) return false;
    if (catFilt && i.category !== catFilt) return false;
    return true;
  });
  const ord = { expired: 0, warning: 1, ok: 2, none: 3 };
  items.sort((a, b) => (ord[itemStatusKey(a)] || 3) - (ord[itemStatusKey(b)] || 3));

  const countEl = $(`itemCount-${esc(code)}`);
  if (countEl) countEl.textContent = `${items.length} ${t('sup.items_count')}`;

  if (!items.length) return `<div class="empty" style="padding:1.5rem;"><div class="empty-text">${t('sup.empty.no_items')}</div></div>`;

  return `<table>
    <thead><tr>
      <th>${t('sup.tbl.item')}</th><th>${t('sup.tbl.category')}</th><th>${t('sup.tbl.qty')}</th><th>${t('sup.tbl.size')}</th><th>${t('sup.tbl.location')}</th><th>${t('sup.tbl.expiry')}</th><th>${t('sup.tbl.status')}</th><th>${t('sup.tbl.lastcheck')}</th><th></th>
    </tr></thead>
    <tbody>${items.map((item) => {
      const s = itemStatusKey(item);
      const rowStyle = s === 'expired' ? 'background:rgba(239,68,68,.04);' : s === 'warning' ? 'background:rgba(245,158,11,.03);' : '';
      const qty = item.quantity;
      return `<tr style="${rowStyle}">
        <td style="font-weight:600;max-width:180px;">
          <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(item.name)}</div>
          ${item.batchNumber ? `<div style="font-size:.68rem;color:var(--text3);">${esc(item.batchNumber)}</div>` : ''}
          ${item.notes ? `<div style="font-size:.68rem;color:var(--text3);margin-top:2px;">✎ ${esc(item.notes)}</div>` : ''}
        </td>
        <td style="font-size:.75rem;color:var(--text2);">${catLabel(item.category)}</td>
        <td>
          <span style="font-family:var(--font-display);font-size:1.1rem;font-weight:800;">${qty}</span>
        </td>
        <td style="font-size:.75rem;color:var(--text3);">${item.size ? esc(item.size) : '—'}</td>
        <td style="font-size:.75rem;color:var(--text3);">${item.location || '—'}</td>
        <td style="font-size:.78rem;">
          ${item.expiry ? `<div>${fmtDate(item.expiry)}</div><div style="font-size:.65rem;color:${s === 'expired' ? '#FCA5A5' : s === 'warning' ? '#FDE68A' : 'var(--text3)'};">${daysLabel(item.expiry)}</div>` : '<span style="color:var(--text3);">—</span>'}
        </td>
        <td><span class="badge ${s}">${s === 'ok' ? t('sup.status.valid') : s === 'expired' ? t('sup.status.expired') : s === 'warning' ? t('sup.status.warning') : t('sup.status.none')}</span></td>
        <td style="font-size:.72rem;color:var(--text3);">${fmtDate(item.lastCheck)}</td>
        <td><button class="btn-sm" onclick="openEdit('${esc(code)}','${esc(String(item.id))}')">${t('sup.btn.edit')}</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// ── Quick report ───────────────────────────────────────────
window.quickReport = function (code, name) {
  _reportSet = new Set();
  const d = stationByCode(code);
  if (d) _reportSet.add(d.id);
  showPage('reports');
  renderReportSelector();
  if (_reportSet.size) generateReport();
};

// ── Report generator ───────────────────────────────────────
function renderReportSelector() {
  const grid = $('reportCheckboxes');
  grid.innerHTML = stations.map((id) => {
    const d = _supData[id]; if (!d) return '';
    const st = stationStats(d.items);
    const checked = _reportSet.has(id);
    return `<label class="report-check-item ${checked ? 'selected' : ''}" data-code="${esc(d.code)}">
      <input type="checkbox" ${checked ? 'checked' : ''} value="${esc(id)}" onchange="window.reportStationToggled(this)">
      <div style="flex:1;">
        <div style="font-weight:600;">${esc(d.name)}</div>
        <div style="font-size:.68rem;color:var(--text3);">${st.total} ${t('sup.items')}${st.expired ? ` · <span style="color:#FCA5A5;">${st.expired} ${t('sup.col.expired')}</span>` : ''}${st.warning ? ` · <span style="color:#FDE68A;">${st.warning} ${t('sup.col.warning')}</span>` : ''}</div>
      </div>
    </label>`;
  }).join('') || `<div style="color:var(--text3);font-size:.84rem;">${t('sup.empty.no_stations')}</div>`;

  updateSelectAllLabel();
}

function updateSelectAllLabel() {
  const btn = $('reportSelectAll');
  if (!btn) return;
  const allSel = stations.length > 0 && _reportSet.size === stations.length;
  btn.textContent = t('sup.btn.' + (allSel ? 'deselect' : 'select_all'));
}

/**
 * Ticking a station box must update the selection SET — Generate reads the set,
 * not the DOM. (The old inline handler only toggled the CSS class, so ticking a
 * box by hand left the set empty and Generate wrongly said "select a unit".)
 */
window.reportStationToggled = function (input) {
  const id = input.value;
  if (input.checked) _reportSet.add(id);
  else _reportSet.delete(id);
  input.closest('.report-check-item')?.classList.toggle('selected', input.checked);
  updateSelectAllLabel();
};

window.toggleSelectAll = function () {
  if (stations.length && _reportSet.size === stations.length) _reportSet = new Set();
  else _reportSet = new Set(stations);
  renderReportSelector();
};

window.generateReport = async function () {
  const ids = [..._reportSet].filter((id) => _supData[id]);
  if (!ids.length) { toast(t('sup.toast.no_station'), 'error'); return; }
  const results = ids.map((id) => {
    const d = _supData[id];
    return { id, code: d.code, name: d.name, items: d.items || [] };
  });
  _reportData = results;
  renderReportOutput(results);
  $('reportActions').style.display = 'flex';
  toast(t('sup.toast.report_ready', { items: results.reduce((a, r) => a + r.items.length, 0), stations: results.length }), 'success');
  // Persist automatically so the report is in the system no matter when the
  // supervisor (or anyone else) looks at the unit later.
  await saveReportSnapshot(results);
};

function renderReportOutput(results) {
  const ts = new Date().toLocaleString();
  $('reportOutput').innerHTML = `
  <div style="margin-bottom:.75rem;font-size:.75rem;color:var(--text3);">
    ${ts} · ${results.length} ${t('sup.items_count')} · ${results.reduce((a, r) => a + r.items.length, 0)} ${t('sup.items')}
  </div>
  <div class="report-output">
    ${results.map((r) => {
      const st = stationStats(r.items);
      const ord = { expired: 0, warning: 1, ok: 2, none: 3 };
      const sorted = [...r.items].sort((a, b) => (ord[itemStatusKey(a)] || 3) - (ord[itemStatusKey(b)] || 3));
      return `<div class="report-station-block">
        <div class="report-station-head">
          <div>
            <div class="report-station-name">${esc(r.name)}</div>
            <div style="font-size:.72rem;color:var(--text3);margin-top:2px;">${esc(r.code)}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <span class="chip grey">${st.total} ${t('sup.items')}</span>
            ${st.expired ? `<span class="chip exp">${st.expired} ${t('sup.col.expired')}</span>` : ''}
            ${st.warning ? `<span class="chip warn">${st.warning} ${t('sup.col.warning')}</span>` : ''}
            ${!st.expired && !st.warning ? `<span class="chip ok">✓ ${t('sup.col.valid')}</span>` : ''}
          </div>
        </div>
        ${sorted.length ? `<div class="tbl-wrap">
          <table>
            <thead><tr><th>${t('sup.tbl.station')}</th><th>${t('sup.tbl.item')}</th><th>${t('sup.tbl.category')}</th><th>${t('sup.tbl.qty')}</th><th>${t('sup.tbl.size')}</th><th>${t('sup.tbl.location')}</th><th>${t('sup.tbl.expiry')}</th><th>${t('sup.tbl.status')}</th><th>${t('sup.tbl.lastcheck')}</th></tr></thead>
            <tbody>${sorted.map((item) => {
              const s = itemStatusKey(item);
              const rowStyle = s === 'expired' ? 'background:rgba(239,68,68,.06);' : s === 'warning' ? 'background:rgba(245,158,11,.04);' : '';
              return `<tr style="${rowStyle}">
                <td style="font-weight:600;">${esc(r.name)}</td>
                <td style="font-weight:600;">${esc(item.name)}</td>
                <td style="font-size:.75rem;color:var(--text2);">${catLabel(item.category)}</td>
                <td><span style="font-family:var(--font-display);font-size:1.05rem;font-weight:800;">${item.quantity}</span></td>
                <td style="font-size:.75rem;color:var(--text3);">${item.size ? esc(item.size) : '—'}</td>
                <td style="font-size:.75rem;color:var(--text3);">${item.location || '—'}</td>
                <td style="font-size:.78rem;">${item.expiry ? `${fmtDate(item.expiry)}<div style="font-size:.65rem;color:${s === 'expired' ? '#FCA5A5' : s === 'warning' ? '#FDE68A' : 'var(--text3)'};">${daysLabel(item.expiry)}</div>` : '—'}</td>
                <td><span class="badge ${s}">${s === 'ok' ? t('sup.status.valid') : s === 'expired' ? t('sup.status.expired') : s === 'warning' ? t('sup.status.warning') : '—'}</span></td>
                <td style="font-size:.72rem;color:var(--text3);">${fmtDate(item.lastCheck)}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>` : `<div style="padding:1rem 1.25rem;font-size:.82rem;color:var(--text3);">${t('sup.report.no_items')}</div>`}
      </div>`;
    }).join('')}
  </div>`;
}

window.exportReportCSV = function () {
  if (!_reportData) return;
  const headers = ['Station', 'Code', 'Item', 'Category', 'Quantity', 'Size', 'Location', 'Expiry', 'Status', 'Last Check'];
  let csv = '\ufeff' + headers.join(',') + '\n';
  _reportData.forEach((r) => {
    r.items.forEach((item) => {
      const s = itemStatusKey(item);
      const row = [
        r.name, r.code, item.name, item.category || '',
        item.quantity, item.size || '',
        item.vehicleNumber || '', fmtDate(item.expiry),
        s === 'expired' ? 'Expired' : s === 'warning' ? 'Warning' : 'Valid',
        fmtDate(item.lastCheck),
      ];
      csv += row.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',') + '\n';
    });
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  a.download = `AEMS_Report_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  toast(t('sup.toast.csv_exported'), 'success');
};

// ── Saved reports ──────────────────────────────────────────
// Every generated report is written to the system so it can be reopened at any
// time, independent of when the units were inspected or when the supervisor
// looks. The list is scoped server-side to the supervisor's own units.
let _savedReports = [];
let _viewReport = null;

function reportToText(results) {
  const lines = [];
  lines.push(t('sup.report.title'));
  lines.push(`${t('sup.report.generated')}: ${new Date().toLocaleString()}`);
  lines.push(`${t('sup.insp.units_title')}: ${results.map((r) => r.name).join(' · ')}`);
  lines.push('');
  results.forEach((r) => {
    const st = stationStats(r.items);
    lines.push(`■ ${r.name} (${r.code}) — ${st.total} ${t('sup.items')}`);
    const problems = r.items
      .map((i) => ({ i, k: itemStatusKey(i) }))
      .filter((x) => x.k === 'expired' || x.k === 'warning')
      .sort((a, b) => (a.k === 'expired' ? -1 : 1) - (b.k === 'expired' ? -1 : 1));
    if (!problems.length) {
      lines.push(`   ✓ ${t('sup.filter.ok')}`);
    } else {
      problems.forEach(({ i, k }) => {
        const bits = [
          k === 'expired' ? t('sup.status.expired') : t('sup.status.warning'),
          i.name,
          i.size || null,
          i.batchNumber ? `${t('sup.tbl.batch') || 'Batch'} ${i.batchNumber}` : null,
          i.expiry ? fmtDate(i.expiry) : null,
          `${t('sup.tbl.qty')} ${i.quantity}`,
        ].filter(Boolean);
        lines.push(`   • ${bits.join(' · ')}`);
      });
    }
    lines.push('');
  });
  lines.push(`${t('sup.items_count')}: ${results.reduce((a, r) => a + r.items.length, 0)}`);
  return lines.join('\n');
}

function reportSnapshot(results) {
  return {
    generatedAt: new Date().toISOString(),
    scope: results.map((r) => {
      const st = stationStats(r.items);
      return { stationId: r.id, code: r.code, name: r.name, ...st };
    }),
    items: results.flatMap((r) => r.items.map((i) => ({
      stationCode: r.code, stationName: r.name, name: i.name, category: i.category || '',
      quantity: i.quantity, size: i.size || '', batchNumber: i.batchNumber || '',
      expiry: i.expiry || null, vehicleNumber: i.vehicleNumber || '',
      status: itemStatusKey(i), lastCheck: i.lastCheck || null,
    }))),
  };
}

async function saveReportSnapshot(results) {
  const now = new Date();
  const units = results.map((r) => r.name).join(' · ') || '—';
  const rawTitle = t('sup.report.saved_title_fmt', { units, date: now.toLocaleDateString() });
  // Server caps: title <= 150, reportText <= 20 000.
  const title = rawTitle.length > 150 ? rawTitle.slice(0, 150) : rawTitle;
  let reportText = reportToText(results);
  if (reportText.length > 19_500) reportText = reportText.slice(0, 19_400) + '\n… (truncated)';
  try {
    await api.createReport({
      stationId: results[0]?.id ?? undefined,
      title,
      reportText,
      data: reportSnapshot(results),
    });
    toast(t('sup.report.saved'), 'success');
    loadSavedReports();
  } catch (err) {
    toast(err && err.message ? err.message : t('sup.report.save_failed'), 'error');
  }
}

async function loadSavedReports() {
  const host = $('savedReportList');
  if (!host) return;
  try {
    const res = await api.reports({ pageSize: 30 });
    _savedReports = res?.reports || res?.items || [];
  } catch {
    _savedReports = [];
  }
  renderSavedReports();
}

function savedReportTitle(r) {
  // Titles are stored in the language that was active when the report was
  // generated; rebuild them from the structured scope so they follow the
  // language the supervisor is reading in now.
  const names = (r?.data?.scope || []).map((s) => s.name).filter(Boolean);
  if (!names.length) return r?.title || '';
  const lang = getCurrentLang() === 'ar' ? 'ar-EG' : 'en-GB';
  const date = r.createdAt ? new Date(r.createdAt).toLocaleDateString(lang) : '';
  return t('sup.report.saved_title_fmt', { units: names.join(' · '), date });
}

function renderSavedReports() {
  const host = $('savedReportList');
  if (!host) return;
  if (!_savedReports.length) {
    host.innerHTML = `<div class="insp-empty">${t('sup.report.saved_empty')}</div>`;
    return;
  }
  host.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr>
      <th>${t('sup.report.col_title')}</th>
      <th>${t('sup.report.col_units')}</th>
      <th>${t('sup.report.col_generated')}</th>
      <th>${t('sup.report.col_by')}</th>
      <th></th>
    </tr></thead>
    <tbody>${_savedReports.map((r) => {
      const units = (r.data?.scope || []).map((s) => s.name).filter(Boolean).join(' · ');
      return `<tr>
        <td style="font-weight:600;">${esc(savedReportTitle(r) || '-')}</td>
        <td style="font-size:.75rem;color:var(--text2);">${esc(units || r.station?.name || '—')}</td>
        <td style="font-size:.74rem;color:var(--text3);">${esc(fmtDate(r.createdAt))}</td>
        <td style="font-size:.74rem;color:var(--text3);">${esc(r.createdBy?.displayName || '—')}</td>
        <td style="text-align:end;"><button class="btn-sm" onclick="window.openSavedReport('${esc(r.id)}')">${t('sup.report.open')}</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

window.openSavedReport = function (id) {
  const r = _savedReports.find((x) => x.id === id);
  if (!r) return;
  _viewReport = r;
  $('reportViewTitle').textContent = savedReportTitle(r) || t('sup.report.view_title');
  $('reportViewSub').textContent = `${t('sup.report.generated')}: ${new Date(r.createdAt).toLocaleString()}`;
  $('reportViewBody').textContent = r.reportText || '—';
  document.getElementById('reportViewModal')?.classList.add('open');
};

window.closeReportView = function () {
  document.getElementById('reportViewModal')?.classList.remove('open');
  _viewReport = null;
};
$('reportViewModal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) window.closeReportView();
});

window.exportSavedReportCsv = function () {
  const items = _viewReport?.data?.items;
  if (!Array.isArray(items) || !items.length) { toast(t('sup.report.no_snapshot'), 'error'); return; }
  const headers = ['Station', 'Code', 'Item', 'Category', 'Quantity', 'Size', 'Location', 'Expiry', 'Status', 'Last Check'];
  let csv = '\ufeff' + headers.join(',') + '\n';
  items.forEach((i) => {
    const row = [
      i.stationName, i.stationCode, i.name, i.category || '',
      i.quantity, i.size || '', i.vehicleNumber || '',
      i.expiry ? fmtDate(i.expiry) : '',
      i.status === 'expired' ? 'Expired' : i.status === 'warning' ? 'Warning' : 'Valid',
      i.lastCheck ? fmtDate(i.lastCheck) : '',
    ];
    csv += row.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',') + '\n';
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  a.download = `AEMS_Report_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  toast(t('sup.toast.csv_exported'), 'success');
};

// ── Inspection change overview ──────────────────────────────
// Supervisors see only the latest comparison per ambulance by default. Full
// item descriptions are fetched and shown only when they open a snapshot.
let _inspOverview = null;
let _inspRange = 30;
let _inspStationId = '';
let _inspLoading = false;
let _inspectionDetail = null;
let _inspectionFullDetails = false;

const INSP_COND_CLASS = {
  OK: 'ok', MISSING: 'exp', DAMAGED: 'exp', EXPIRED: 'exp',
  UNUSABLE: 'warn', EXTRA: 'low', NOT_CHECKED: 'grey',
};
function inspCondLabel(c) { return t('sup.insp.cond.' + c); }

window.setInspRange = function (v) {
  _inspRange = Number(v);
  refreshInspections();
};
window.setInspStation = function (v) {
  _inspStationId = v || '';
  refreshInspections();
};

window.refreshInspections = async function () {
  if (_inspLoading) return;
  _inspLoading = true;
  if ($('inspKpi')) $('inspKpi').innerHTML = `<div class="insp-empty">${t('sup.insp.loading')}</div>`;
  try {
    const res = await api.inspectionOverview({
      days: _inspRange,
      stationId: _inspStationId || undefined,
    });
    _inspOverview = res || null;
  } catch (err) {
    toast(err && err.message ? err.message : String(err), 'error');
    _inspOverview = null;
  } finally {
    _inspLoading = false;
  }
  renderInspections();
};

function fillInspStationFilter() {
  const sel = $('inspStationFilter');
  if (!sel) return;
  const current = _inspStationId;
  sel.innerHTML = `<option value="">${t('sup.filter.all_units')}</option>` + stations.map((id) => {
    const d = _supData[id] || _stationMeta.get(id) || {};
    const label = d.name || d.code || id;
    return `<option value="${esc(id)}" ${current === id ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

window.renderInspections = function () {
  fillInspStationFilter();
  const rangeSel = $('inspRange');
  if (rangeSel && Number(rangeSel.value) !== _inspRange) rangeSel.value = String(_inspRange);
  if (!$('inspKpi')) return;
  if (!_inspOverview) {
    $('inspKpi').innerHTML = `<div class="insp-empty">${t('sup.insp.empty')}</div>`;
    $('inspChanges').innerHTML = '';
    $('inspRecent').innerHTML = '';
    return;
  }
  const comparisons = _inspOverview.comparisons || [];
  renderInspKpi(comparisons);
  renderInspChanges(comparisons);
  renderInspRecent(_inspOverview.inspections || []);
};

function renderInspKpi(comparisons) {
  const rows = Array.isArray(comparisons) ? comparisons : [];
  const withBaseline = rows.filter((c) => c.previousInspectionId);
  const sum = (key) => withBaseline.reduce((n, c) => n + (Number(c[key]) || 0), 0);
  const changedChecks = withBaseline.filter((c) => c.changedItems > 0).length;
  const changedItems = sum('changedItems');
  const cards = [
    { n: rows.length, label: t('sup.insp.kpi.latest'), cls: 'blue', icon: 'clipboard' },
    { n: changedChecks, label: t('sup.insp.kpi.with_changes'), cls: changedChecks ? 'amber' : 'green', icon: 'activity' },
    { n: changedItems, label: t('sup.insp.kpi.changed_items'), cls: changedItems ? 'amber' : 'green', icon: 'repeat' },
    { n: sum('qtyDecreased'), label: t('sup.insp.kpi.qty_decreased'), cls: sum('qtyDecreased') ? 'red' : 'green', icon: 'trending' },
    { n: sum('qtyIncreased'), label: t('sup.insp.kpi.qty_increased'), cls: sum('qtyIncreased') ? 'blue' : 'green', icon: 'activity' },
    { n: rows.length - withBaseline.length, label: t('sup.insp.kpi.baselines'), cls: 'green', icon: 'grid' },
  ];
  $('inspKpi').innerHTML = cards.map((c) => `<div class="stat-card ${c.cls}">
    <div class="stat-icon">${icon(c.icon)}</div>
    <div class="stat-num">${Number(c.n) || 0}</div>
    <div class="stat-label">${esc(c.label)}</div>
  </div>`).join('');
}

function renderInspChanges(comparisons) {
  const host = $('inspChanges');
  if (!host) return;
  if (!comparisons.length) {
    host.innerHTML = `<div class="insp-empty">${t('sup.insp.no_recent_checks')}</div>`;
    return;
  }
  host.innerHTML = `<table><thead><tr>
    <th>${t('sup.insp.col_ambulance')}</th><th>${t('sup.insp.col_latest')}</th>
    <th>${t('sup.insp.col_previous')}</th><th>${t('sup.insp.kpi.changed_items')}</th>
    <th>${t('sup.insp.kpi.qty_decreased')}</th><th>${t('sup.insp.kpi.qty_increased')}</th><th></th>
  </tr></thead><tbody>${comparisons.map((c) => {
    const label = unitLabel(c.stationCode, c.unitName);
    const previous = c.previousInspectionId ? esc(fmtDateTime(c.previousPerformedAt)) : t('sup.insp.baseline');
    const changeCell = c.previousInspectionId
      ? `<span class="chip ${c.changedItems ? 'warn' : 'ok'}">${c.changedItems}</span>${c.addedItems ? ` <span class="chip low">+${c.addedItems} ${t('sup.insp.added')}</span>` : ''}${c.removedItems ? ` <span class="chip grey">−${c.removedItems} ${t('sup.insp.removed')}</span>` : ''}`
      : `<span class="chip grey">${t('sup.insp.baseline')}</span>`;
    return `<tr>
      <td style="font-weight:600;">${esc(label)}<div style="font-size:.7rem;color:var(--text3);">${esc(c.ambulanceNumber || '—')}</div></td>
      <td style="white-space:nowrap;">${esc(fmtDateTime(c.performedAt))}<div style="font-size:.68rem;color:var(--text3);">${esc(c.performedByName || '—')}</div></td>
      <td style="white-space:nowrap;color:var(--text2);">${esc(previous)}</td>
      <td>${changeCell}</td>
      <td>${c.previousInspectionId ? Number(c.qtyDecreased || 0) : '—'}</td>
      <td>${c.previousInspectionId ? Number(c.qtyIncreased || 0) : '—'}</td>
      <td style="text-align:end;"><button class="btn-sm" onclick="window.openInspectionDetails('${esc(c.inspectionId)}')">${t('sup.insp.details')}</button></td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

function renderInspRecent(inspections) {
  const host = $('inspRecent');
  if (!host) return;
  if (!inspections.length) { host.innerHTML = `<div class="insp-empty">${t('sup.insp.no_recent_checks')}</div>`; return; }
  host.innerHTML = `<table><thead><tr>
    <th>${t('sup.tbl.station')}</th><th>${t('sup.insp.col_ambulance')}</th>
    <th>${t('sup.insp.col_latest')}</th><th>${t('sup.insp.col_by')}</th>
    <th>${t('sup.tbl.status')}</th><th></th>
  </tr></thead><tbody>${inspections.slice(0, 100).map((i) => {
    const statusLabel = i.status === 'VOID' ? t('sup.insp.status_void') : t('sup.insp.status_complete');
    const statusClass = i.status === 'VOID' ? 'none' : 'ok';
    return `<tr>
      <td style="font-weight:600;">${esc(unitLabel(i.stationCode, i.unitName))}</td>
      <td>${esc(i.ambulanceNumber || '—')}</td>
      <td style="white-space:nowrap;">${esc(fmtDateTime(i.completedAt || i.performedAt))}</td>
      <td>${esc(i.performedByName || '—')}</td>
      <td><span class="badge ${statusClass}">${esc(statusLabel)}</span></td>
      <td style="text-align:end;"><button class="btn-sm" onclick="window.openInspectionDetails('${esc(i.id)}')">${t('sup.insp.details')}</button></td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

function inspectionItemReason(item) {
  const ar = getCurrentLang() === 'ar';
  const label = (r) => (ar ? (r?.labelAr || r?.labelEn) : (r?.labelEn || r?.labelAr)) || r?.code || '';
  const lines = item.reasonLines || [];
  if (lines.length) return lines.map((r) => `${label(r.reason) || r.reasonCode} (${r.quantity})`).join(' · ');
  return label(item.reason) || item.reasonCode || '';
}

function inspectionItemName(item) {
  return item.inventory?.batch?.medicine?.name || t('sup.insp.unknown_item');
}

function buildInspectionDiff(inspection) {
  const currentItems = inspection.items || [];
  const previous = inspection.previousInspection;
  const previousItems = previous?.items || [];
  const previousByInventory = new Map(previousItems.map((item) => [item.inventoryId, item]));
  const seen = new Set();
  const changes = [];
  let qtyDecreased = 0;
  let qtyIncreased = 0;
  let addedItems = 0;
  let removedItems = 0;

  for (const current of currentItems) {
    const old = previousByInventory.get(current.inventoryId) || null;
    seen.add(current.inventoryId);
    if (!old) {
      if (previous) addedItems += 1;
      changes.push({ current, previous: null, kind: previous ? 'ADDED' : 'BASELINE', delta: null });
      continue;
    }
    const delta = current.actualQuantity - old.actualQuantity;
    if (delta < 0) qtyDecreased += -delta;
    if (delta > 0) qtyIncreased += delta;
    if (delta !== 0 || current.condition !== old.condition) changes.push({ current, previous: old, kind: 'CHANGED', delta });
  }
  if (previous) {
    for (const old of previousItems) {
      if (seen.has(old.inventoryId)) continue;
      removedItems += 1;
      changes.push({ current: null, previous: old, kind: 'REMOVED', delta: null });
    }
  }
  return { previous, changes, qtyDecreased, qtyIncreased, addedItems, removedItems, currentItems };
}

function inspectionDetailsRow(row) {
  const item = row.current || row.previous;
  const medicine = item.inventory?.batch?.medicine;
  const oldQty = row.previous?.actualQuantity;
  const newQty = row.current?.actualQuantity;
  const qtyText = row.kind === 'REMOVED'
    ? `${oldQty} → —`
    : row.kind === 'ADDED' ? `— → ${newQty}`
      : row.previous ? `${oldQty} → ${newQty}` : `${newQty}`;
  const conditionText = row.previous && row.current
    ? `${inspCondLabel(row.previous.condition)} → ${inspCondLabel(row.current.condition)}`
    : inspCondLabel(item.condition);
  const delta = row.delta == null ? '' : `<span class="insp-delta ${row.delta < 0 ? 'neg' : row.delta > 0 ? 'pos' : ''}">${row.delta > 0 ? '+' : ''}${row.delta}</span>`;
  const badge = row.kind === 'ADDED' ? t('sup.insp.added') : row.kind === 'REMOVED' ? t('sup.insp.removed') : '';
  return `<tr>
    <td style="font-weight:600;">${esc(inspectionItemName(item))}<div style="font-size:.68rem;color:var(--text3);">${esc(item.inventory?.batch?.batchNumber || '')}${medicine?.size ? ` · ${esc(medicine.size)}` : ''}</div></td>
    <td style="white-space:nowrap;">${esc(qtyText)} ${delta}</td>
    <td>${esc(conditionText)}</td>
    <td>${esc(inspectionItemReason(row.current || item) || badge || '—')}${item.notes ? `<div style="font-size:.7rem;color:var(--text3);">${esc(item.notes)}</div>` : ''}</td>
  </tr>`;
}

function renderInspectionDetails() {
  if (!_inspectionDetail) return;
  const inspection = _inspectionDetail;
  const diff = buildInspectionDiff(inspection);
  const station = inspection.ambulance?.station;
  const unit = unitLabel(station?.code, station?.name);
  const previous = diff.previous;
  $('inspectionDetailsTitle').textContent = `${t('sup.insp.details_title')} · ${unit}`;
  $('inspectionDetailsMeta').textContent = `${inspection.ambulance?.vehicleNumber || '—'} · ${fmtDateTime(inspection.completedAt || inspection.performedAt)} · ${inspection.performedBy?.displayName || '—'}${previous ? ` · ${t('sup.insp.previous_check')}: ${fmtDateTime(previous.completedAt || previous.performedAt)}` : ''}`;
  $('inspectionDetailsSummary').innerHTML = previous ? [
    [diff.changes.length, t('sup.insp.kpi.changed_items')],
    [diff.qtyDecreased, t('sup.insp.kpi.qty_decreased')],
    [diff.qtyIncreased, t('sup.insp.kpi.qty_increased')],
    [diff.addedItems, t('sup.insp.added')],
    [diff.removedItems, t('sup.insp.removed')],
  ].map(([value, label]) => `<div class="insp-detail-metric"><b>${Number(value)}</b><span>${esc(label)}</span></div>`).join('')
    : `<div class="insp-empty">${t('sup.insp.baseline_description', { count: diff.currentItems.length })}</div>`;

  const rows = _inspectionFullDetails
    ? [
        ...diff.currentItems.map((current) => ({ current, previous: diff.previous && diff.previous.items.find((old) => old.inventoryId === current.inventoryId), kind: 'CURRENT', delta: diff.previous ? current.actualQuantity - (diff.previous.items.find((old) => old.inventoryId === current.inventoryId)?.actualQuantity ?? 0) : null })),
        ...diff.changes.filter((r) => r.kind === 'REMOVED'),
      ]
    : diff.changes.filter((r) => r.kind !== 'BASELINE');
  $('inspectionDetailsItems').innerHTML = rows.length ? `<table><thead><tr>
    <th>${t('sup.insp.item_label')}</th><th>${t('sup.insp.quantity_change')}</th>
    <th>${t('sup.insp.condition_label')}</th><th>${t('sup.insp.reason_label')}</th>
  </tr></thead><tbody>${rows.map(inspectionDetailsRow).join('')}</tbody></table>`
    : `<div class="insp-empty">${previous ? t('sup.insp.no_changes') : t('sup.insp.baseline_description', { count: diff.currentItems.length })}</div>`;

  $('inspectionDetailsToggle').textContent = t(_inspectionFullDetails ? 'sup.insp.show_changes' : 'sup.insp.show_full');
  $('inspectionVoidBtn').style.display = ['COMPLETED', 'ACKNOWLEDGED'].includes(inspection.status) ? '' : 'none';
}

window.openInspectionDetails = async function (id) {
  try {
    _inspectionDetail = await api.inspection(id);
    _inspectionFullDetails = false;
    renderInspectionDetails();
    $('inspectionDetailsModal').classList.add('open');
  } catch (err) {
    toast(err?.message || t('sup.insp.details_failed'), 'error');
  }
};
window.toggleInspectionFullDetails = function () {
  _inspectionFullDetails = !_inspectionFullDetails;
  renderInspectionDetails();
};
window.closeInspectionDetails = function () {
  $('inspectionDetailsModal')?.classList.remove('open');
  _inspectionDetail = null;
};
window.voidInspectionRecord = async function () {
  if (!_inspectionDetail || !['COMPLETED', 'ACKNOWLEDGED'].includes(_inspectionDetail.status)) return;
  const reason = await promptDialog({
    title: t('sup.insp.void_title'), message: t('sup.insp.void_prompt'),
    placeholder: t('sup.insp.void_reason_ph'), tone: 'danger',
  });
  if (reason === null) return;
  if (reason.trim().length < 3 || reason.trim().length > 500) {
    toast(t('sup.insp.void_reason_invalid'), 'error');
    return;
  }
  const ok = await confirmDialog({
    title: t('sup.insp.void_title'), message: t('sup.insp.void_confirm'),
    tone: 'danger', confirmLabel: t('sup.insp.void_record'), cancelLabel: t('sup.btn.cancel'),
  });
  if (!ok) return;
  try {
    await api.voidInspection(_inspectionDetail.id, reason.trim());
    toast(t('sup.insp.voided'), 'success');
    window.closeInspectionDetails();
    await refreshInspections();
  } catch (err) {
    toast(err?.message || String(err), 'error');
  }
};
$('inspectionDetailsModal')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) window.closeInspectionDetails();
});
// ── Audit log ──────────────────────────────────────────────
/**
 * Inspection audit entries render as TWO separate documents:
 *   1. Inspection report — what the crew found (conditions, not-checked).
 *   2. Adjustments applied — the reason-coded stock changes.
 * A supervisor reads the findings first, then the adjustment it produced.
 */
function inspectionAuditTable(e) {
  const m = e.metadata || {};
  if (!['INSPECTION', 'INSPECTION_COMPLETE', 'INSPECTION_VOID'].includes(e.action)) return '';
  const corrections = Array.isArray(m.corrections) ? m.corrections : [];
  const notChecked = Array.isArray(m.notChecked) ? m.notChecked : [];
  const cond = m.conditions && typeof m.conditions === 'object' ? m.conditions : {};
  const condKeys = ['missing', 'damaged', 'expired', 'unusable'].filter((k) => Array.isArray(cond[k]) && cond[k].length);
  const notCheckedHtml = notChecked.length
    ? `<div class="rpt-line"><span class="rpt-tag nc">${esc(t('ui.audit.not_checked'))}</span> ${esc(notChecked.join(', '))}</div>`
    : '';

  let inspBlock = '';
  if (condKeys.length || notCheckedHtml) {
    inspBlock = `<div class="rpt-block rpt-inspection">
      <div class="rpt-head">${icon('search')} ${esc(t('ui.report.inspection'))}</div>
      ${condKeys.map((k) => `<div class="rpt-line"><span class="rpt-tag ${k}">${esc(t('ui.report.cond_' + k))}</span> ${esc(cond[k].join(', '))}</div>`).join('')}
      ${notCheckedHtml}
    </div>`;
  }

  let adjBlock = '';
  if (corrections.length) {
    const rows = corrections.map((c) => {
      const diff = c.difference ?? ((c.to ?? 0) - (c.from ?? 0));
      const color = diff < 0 ? 'var(--danger)' : (diff > 0 ? 'var(--success)' : 'inherit');
      const sign = diff > 0 ? `+${diff}` : `${diff}`;
      const lines = Array.isArray(c.lines) ? c.lines.filter((l) => l && l.code) : [];
      const reasonCell = lines.length
        ? lines.map((l) => `${esc(l.code)} <span style="color:var(--text-muted);">×${esc(fmtMetaVal(l.quantity))}</span>`).join('<br>')
        : (c.reason ? esc(c.reason) : '—');
      return `<tr>
        <td>${esc(c.name || c.inventoryId || '—')}</td>
        <td style="text-align:center;">${esc(fmtMetaVal(c.from))}</td>
        <td style="text-align:center;">${esc(fmtMetaVal(c.to))}</td>
        <td style="text-align:center;color:${color};font-weight:700;">${esc(sign)}</td>
        <td>${reasonCell}</td>
      </tr>`;
    }).join('');
    adjBlock = `<div class="rpt-block rpt-adjust">
      <div class="rpt-head">${icon('fileText')} ${esc(t('ui.report.adjustments'))}</div>
      <div class="audit-table-wrap"><table class="audit-table">
        <thead><tr>
          <th>${esc(t('ui.audit.col_item'))}</th>
          <th style="text-align:center;">${esc(t('ui.audit.col_before'))}</th>
          <th style="text-align:center;">${esc(t('ui.audit.col_counted'))}</th>
          <th style="text-align:center;">${esc(t('ui.audit.col_change'))}</th>
          <th>${esc(t('ui.audit.col_reason'))}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  }

  if (!inspBlock && !adjBlock) return '';
  return `<div class="audit-table-wrap">${inspBlock}${adjBlock}</div>`;
}

function renderAudit() {
  const stFilt = $('auditStationFilter')?.value || '';
  const typeFilt = $('auditTypeFilter')?.value || '';
  const search = ($('auditSearch')?.value || '').toLowerCase();

  const stSel = $('auditStationFilter');
  if (stSel) {
    const current = stSel.value;
    // Offer every unit this supervisor can see: managed units plus any unit
    // that appears in the (historical) audit rows, even if it holds no stock.
    const ids = new Set(stations);
    _rawAudit.forEach((e) => { if (e.stationId) ids.add(e.stationId); });
    stSel.innerHTML = `<option value="">${t('sup.filter.all')}</option>` + [...ids].map((id) => {
      const d = _supData[id] || _stationMeta.get(id) || {};
      const label = d.name || d.code || id;
      return `<option value="${esc(id)}" ${current === id ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');
  }
  stSel.onchange = renderAudit;

  const actions = [...new Set(_rawAudit.map((e) => e.action))].sort();
  const tySel = $('auditTypeFilter');
  if (tySel) {
    const current = tySel.value;
    tySel.innerHTML = `<option value="">${t('sup.filter.all_actions')}</option>` + actions.map((a) =>
      `<option value="${esc(a)}" ${current === a ? 'selected' : ''}>${esc(auditActionLabel(a))}</option>`
    ).join('');
  }
  tySel.onchange = renderAudit;
  $('auditSearch').oninput = renderAudit;

  let entries = _rawAudit.filter((e) => {
    if (stFilt && e.stationId !== stFilt) return false;
    if (typeFilt && e.action !== typeFilt) return false;
    if (search && !JSON.stringify(e).toLowerCase().includes(search)) return false;
    return true;
  });

  $('auditCount').textContent = `${entries.length} ${t('sup.items_count')}`;

  $('auditList').innerHTML = entries.length ? entries.map((e) => {
    const d = e.stationId ? (_supData[e.stationId] || _stationMeta.get(e.stationId)) : null;
    const stName = d ? (d.name || d.code) : '—';
    const who = e.user?.displayName || e.user?.email || e.userName || e.userEmail || '—';
    let meta = '';
    try {
      if (e.metadata && typeof e.metadata === 'object') {
        const items = [];
        for (const [k, v] of Object.entries(e.metadata)) {
          if (INTERNAL_META_KEYS.has(k)) continue;
          if (k === 'changed' && v && typeof v === 'object') {
            for (const [field, diff] of Object.entries(v)) {
              items.push(`${field}: ${fmtMetaVal(diff.from)} → ${fmtMetaVal(diff.to)}`);
            }
            continue;
          }
          items.push(`${k}: ${fmtMetaVal(v)}`);
        }
        if (items.length) {
          meta = '<div style="font-size:.68rem;color:var(--text3);margin-top:2px;">' +
            items.map(i => `<span style="display:inline-block;margin-right:6px;">${esc(i)}</span>`).join('') + '</div>';
        }
      }
    } catch { meta = ''; }
    return `<div class="audit-row">
      <div>
        <div class="audit-time">${fmtDateTime(e.createdAt)}</div>
      </div>
      <div>
        <div class="audit-text"><strong>${esc(who)}</strong> — ${esc(auditActionLabel(e.action))} <span class="badge none" style="font-size:.6rem;color:#C4B5FD;border-color:#C4B5FD40;">${esc(e.action || '—')}</span></div>
        <div class="audit-station">${icon('pin')} ${esc(stName)}</div>
        ${(() => { const r = e.reason || (e.metadata && typeof e.metadata === 'object' ? e.metadata.reason : ''); return r ? `<div class="audit-reason">${icon('message')} "${esc(String(r))}"</div>` : ''; })()}
        ${meta}
        ${inspectionAuditTable(e)}
      </div>
    </div>`;
  }).join('') : `<div class="empty"><div class="empty-icon">${icon('list')}</div><div class="empty-text">${t('sup.audit.empty')}</div></div>`;

  const loadMore = $('auditLoadMore');
  loadMore.style.display = _rawAudit.length < _auditTotal ? 'block' : 'none';
}

window.loadMoreAudit = async function () {
  if (_rawAudit.length >= _auditTotal) return;
  try {
    const res = await api.auditLogs({ page: _auditPage + 1, pageSize: AUDIT_PAGE_SIZE });
    _rawAudit = _rawAudit.concat((res && res.logs) || []);
    _auditTotal = (res && res.total) || _auditTotal;
    _auditPage += 1;
    renderAudit();
  } catch (err) {
    toast(err && err.message || String(err), 'error');
  }
};

// ── Supply request review queue ────────────────────────────
async function loadSupply() {
  try {
    const res = await api.supplyRequests({ pageSize: 200 });
    _supplyRequests = Array.isArray(res) ? res : (res?.requests || []);
    _supplyPending = _supplyRequests.filter((r) => r.status === 'PENDING').length;
    renderSupplyBadge();
    return true;
  } catch (err) {
    console.error('loadSupply failed:', err);
    return false;
  }
}

function renderSupplyBadge() {
  const b = $('supSupplyBadge');
  if (!b) return;
  b.textContent = String(_supplyPending);
  b.style.display = _supplyPending ? 'inline-block' : 'none';
}

const SUPPLY_STATUS_COLOR = {
  PENDING: '#D97706', APPROVED: '#3B82F6', REJECTED: '#EF4444', FULFILLED: '#10B981', CANCELLED: '#64748B',
};
const SUPPLY_STATUS_KEY = {
  PENDING: 'supply.status.pending', APPROVED: 'supply.status.approved', REJECTED: 'supply.status.rejected',
  FULFILLED: 'supply.status.fulfilled', CANCELLED: 'supply.status.cancelled',
};

function renderSupplyReview() {
  const el = $('supSupplyList');
  if (!el) return;
  const rows = _supplyRequests || [];
  const countEl = $('supSupplyCount');
  if (countEl) countEl.textContent = `${rows.length} ${t('sup.items_count')}`;
  if (!rows.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">${icon('package')}</div><div class="empty-text">${t('sup.supply.empty')}</div></div>`;
    return;
  }
  const order = ['PENDING', 'APPROVED', 'FULFILLED', 'REJECTED', 'CANCELLED'];
  const sorted = [...rows].sort((a, b) =>
    order.indexOf(a.status) - order.indexOf(b.status) || new Date(b.createdAt) - new Date(a.createdAt));
  const stName = (r) => { const s = r.ambulance?.station; return s ? unitLabel(s.code, s.name) : '—'; };
  el.innerHTML = sorted.map((r) => {
    const color = SUPPLY_STATUS_COLOR[r.status] || '#999';
    const label = t(SUPPLY_STATUS_KEY[r.status] || '');
    const actions = [];
    if (r.status === 'PENDING') {
      actions.push(`<button class="btn-sm primary" onclick="reviewSupply('${r.id}','APPROVED')">${icon('check')} ${t('sup.supply.approve')}</button>`);
      actions.push(`<button class="btn-sm danger" onclick="reviewSupply('${r.id}','REJECTED')">${t('sup.supply.reject')}</button>`);
    } else if (r.status === 'APPROVED') {
      actions.push(`<button class="btn-sm primary" onclick="supplyDispatch('${r.id}','${r.medicineId}')">${icon('send')} ${t('sup.supply.dispatch')}</button>`);
    } else if (r.status === 'DISPATCHED' || r.status === 'IN_TRANSIT') {
      actions.push(`<span style="display:inline-flex;align-items:center;gap:5px;font-size:.72rem;color:var(--text3);padding:4px 2px;">${icon('clock')} ${t('sup.supply.awaiting_receipt')}</span>`);
    } else if (r.status === 'RECEIVED') {
      actions.push(`<button class="btn-sm success" onclick="supplyConfirmReceipt('${r.id}')">${icon('checkCircle')} ${t('sup.supply.confirm_receipt')}</button>`);
    } else if (r.status === 'FULFILLED') {
      actions.push(`<button class="btn-sm" onclick="supplyClose('${r.id}')">${icon('check')} ${t('sup.supply.close')}</button>`);
    }
    return `<div class="dir-item" style="align-items:start;">
      <span class="dir-dot tracked"></span>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
          <strong>${esc(r.medicine?.name || '—')} × ${r.quantity}</strong>
          <span style="font-size:.7rem;font-weight:800;color:${color};border:1px solid ${color}40;padding:2px 8px;border-radius:20px;">${esc(label)}</span>
        </div>
        <div style="font-size:.78rem;color:var(--text3);margin-top:6px;display:flex;gap:14px;flex-wrap:wrap;">
          <span>${icon('ambulance')} ${esc(r.ambulance?.vehicleNumber || '—')}</span>
          <span>${icon('building')} ${esc(stName(r))}</span>
          <span>${icon('user')} ${esc(r.createdBy?.displayName || '—')}</span>
          <span>${icon('clock')} ${fmtDateTime(r.createdAt)}</span>
        </div>
        ${r.reason ? `<div style="font-size:.78rem;color:var(--text2);margin-top:4px;">${icon('fileText')} ${esc(r.reason)}</div>` : ''}
        ${actions.length ? `<div style="display:flex;gap:8px;margin-top:10px;">${actions.join('')}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

/** Themed replacement for window.confirm(). Resolves true on Confirm, false on Cancel/backdrop. */
function showConfirm(message, { danger = false } = {}) {
  return new Promise((resolve) => {
    const m = $('confirmModal');
    if (!m) { confirmDialog({ message, tone: danger ? 'danger' : 'warning' }).then(resolve); return; }
    $('confirmMsg').textContent = message;
    const yes = $('confirmYes'), no = $('confirmNo');
    yes.classList.toggle('go', !danger);
    const done = (v) => {
      m.classList.remove('open');
      yes.onclick = no.onclick = m.onclick = null;
      resolve(v);
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    m.onclick = (e) => { if (e.target === m) done(false); };
    m.classList.add('open');
  });
}

window.reviewSupply = async function (id, status) {
  // The PATCH /status endpoint only accepts APPROVED | REJECTED. Any other
  // transition has its own endpoint (dispatch / receive / confirm / close),
  // so guard here instead of letting the server reject it with a 400.
  if (status !== 'APPROVED' && status !== 'REJECTED') {
    toast(t('sup.supply.bad_action'), 'error');
    return;
  }
  const confirmMsg = status === 'REJECTED' ? t('sup.supply.reject_confirm') : t('sup.supply.action_confirm');
  if (!await showConfirm(confirmMsg, { danger: status === 'REJECTED' })) return;
  try {
    await api.updateSupplyRequestStatus(id, status);
    toast(t('sup.supply.done'), 'success');
    await Promise.all([loadSupply(), refreshAudit()]);
    if (_currentPage === 'supply') renderSupplyReview();
    renderSupplyBadge();
  } catch (err) {
    toast(err && err.message || String(err), 'error');
  }
};

/** Runs the post-action refresh shared by every supply mutation. */
async function afterSupplyAction() {
  await Promise.all([loadSupply(), refreshAudit()]);
  if (_currentPage === 'supply') renderSupplyReview();
  renderSupplyBadge();
}

/**
 * Resolves a typed batch number to a batch id for the given medicine.
 * Returns the id, null when nothing was typed, or false when no batch matches
 * (so the caller can tell "not supplied" apart from "not found").
 */
async function resolveBatchId(medicineId, typed) {
  const q = String(typed || '').trim();
  if (!q) return null;
  const data = await api.batches({ medicineId, activeOnly: 'true', pageSize: 200 });
  const match = (data.batches || []).find(
    (b) => String(b.batchNumber || '').trim().toLowerCase() === q.toLowerCase(),
  );
  return match ? match.id : false;
}

/** APPROVED → DISPATCHED. Naming the batch is what lets the later
 *  confirmation credit the stock to the unit's inventory. */
window.supplyDispatch = async function (id, medicineId) {
  let typed;
  try {
    typed = await promptDialog({
      title: t('sup.supply.dispatch'),
      message: t('sup.supply.dispatch_hint'),
      placeholder: t('sup.supply.dispatch_placeholder'),
      confirmLabel: t('sup.supply.dispatch'),
    });
  } catch (err) {
    toast(err && err.message || String(err), 'error');
    return;
  }
  if (typed === null || typed === undefined) return; // cancelled

  try {
    const batchId = await resolveBatchId(medicineId, typed);
    if (batchId === false) { toast(t('sup.supply.batch_not_found'), 'error'); return; }
    await api.dispatchSupplyRequest(id, batchId ? { batchId } : {});
    toast(t('sup.supply.dispatched'), 'success');
    await afterSupplyAction();
  } catch (err) {
    toast(err && err.message || String(err), 'error');
  }
};

/** RECEIVED → FULFILLED. Credits the received quantity and lifts the hold. */
window.supplyConfirmReceipt = async function (id) {
  if (!await showConfirm(t('sup.supply.confirm_receipt_msg'), {})) return;
  try {
    await api.confirmSupplyRequest(id);
    toast(t('sup.supply.done'), 'success');
    await afterSupplyAction();
  } catch (err) {
    toast(err && err.message || String(err), 'error');
  }
};

/** FULFILLED → CLOSED. */
window.supplyClose = async function (id) {
  if (!await showConfirm(t('sup.supply.close_msg'), {})) return;
  try {
    await api.closeSupplyRequest(id);
    toast(t('sup.supply.done'), 'success');
    await afterSupplyAction();
  } catch (err) {
    toast(err && err.message || String(err), 'error');
  }
};

// ── Manage stations (self-service assign / unassign) ───────
function applyAssignment(user) {
  stations = [];
  const assigned = Array.isArray(user.managedStations) ? user.managedStations : [];
  const accessIds = _session.accessibleStationIds || [];
  assigned.forEach((m) => {
    if (accessIds.length && !accessIds.includes(m.id)) return;
    if (!_stationMeta.has(m.id)) _stationMeta.set(m.id, { code: m.code, name: m.name });
    stations.push(m.id);
  });
}

async function refreshAssignment() {
  try {
    const me2 = await api.me();
    _session = { ..._session, ...me2 };
    window.AEMS_PERMS = _session.permissions || [];
    setSession(_session);
    applyAssignment(me2.user || {});
    // Reload the audit too: the newly tracked unit brings its full history.
    await Promise.all([loadDirectory(), refreshInventory(), refreshAudit()]);
    applyAll();
  } catch (err) {
    toast(err && err.message || String(err), 'error');
  }
}
window.refreshAssignment = refreshAssignment;

// Supervisors manage their OWN unit list here (self-assignment, no admin
// approval). The endpoint always targets the caller, so it cannot be used to
// change anyone else's access.
function canAssignStations() {
  return !!window.AEMS_PERMS?.includes('station:selfAssign');
}

window.trackStation = async function (code) {
  if (!canAssignStations()) { toast(t('sup.manage.assign_admin_only'), 'error'); return; }
  const cur = Array.isArray(_session.user?.managedStations) ? _session.user.managedStations.map((m) => m.code) : [];
  if (cur.includes(code)) return;
  try {
    await api.setMyManagedStations([...cur, code]);
    await refreshAssignment();
    toast(t('sup.toast.changes_saved'), 'success');
  } catch (err) { toast(err && err.message || String(err), 'error'); }
};

window.untrackStation = async function (code) {
  if (!canAssignStations()) { toast(t('sup.manage.assign_admin_only'), 'error'); return; }
  const cur = Array.isArray(_session.user?.managedStations) ? _session.user.managedStations.map((m) => m.code) : [];
  try {
    await api.setMyManagedStations(cur.filter((c) => c !== code));
    await refreshAssignment();
    toast(t('sup.toast.changes_saved'), 'success');
  } catch (err) { toast(err && err.message || String(err), 'error'); }
};

function renderManage() {
  const trackedEl = $('trackedList');
  const assignable = canAssignStations();
  $('trackedCount').textContent = `${stations.length} ${t('sup.manage.units')}`;
  trackedEl.innerHTML = stations.length ? stations.map((id) => {
    const d = _supData[id]; if (!d) return '';
    const st = stationStats(d.items);
    return `<div class="dir-item">
      <span class="dir-dot tracked"></span>
      <div style="flex:1;">
        <div class="dir-item-name">${esc(d.name)}</div>
        <div class="dir-item-code">${esc(d.code)} · ${st.total} ${t('sup.items')}${st.expired ? ` · <span style="color:#FCA5A5;">${st.expired} ${t('sup.col.expired')}</span>` : ''}${st.warning ? ` · <span style="color:#FDE68A;">${st.warning} ${t('sup.col.warning')}</span>` : ''}</div>
      </div>
      ${assignable ? `<button class="btn-sm" onclick="untrackStation('${esc(d.code)}')">${t('sup.btn.untrack')}</button>` : ''}
    </div>`;
  }).join('') : `<div style="color:var(--text3);font-size:.82rem;padding:8px 0;">${t('sup.manage.no_tracked')}</div>`;

  $('dirCount').textContent = `${stations.filter((id) => _directory.some((s) => s.id === id)).length}/${_directory.length}`;
  renderDirectory();
  trackedEl.insertAdjacentHTML('beforeend', `<div style="margin-top:10px;font-size:.7rem;color:var(--text3);border-top:1px solid var(--border2);padding-top:10px;">${t(assignable ? 'sup.manage.note' : 'sup.manage.assign_admin_only')}</div>`);
}

window.renderDirectory = function () {
  const search = ($('dirSearch')?.value || '').toLowerCase();
  const assignable = canAssignStations();
  const filtered = _directory.filter((s) => !search || s.name?.toLowerCase().includes(search) || s.code?.toLowerCase().includes(search));
  const el = $('directoryList');
  if (!filtered.length) {
    el.innerHTML = `<div style="color:var(--text3);font-size:.82rem;padding:8px 0;">${t('sup.manage.no_stations')}</div>`;
    return;
  }
  el.innerHTML = filtered.map((s) => {
    const assigned = stations.includes(s.id);
    return `<div class="dir-item">
      <span class="dir-dot ${assigned ? 'tracked' : ''}"></span>
      <div style="flex:1;">
        <div class="dir-item-name">${esc(unitLabel(s.code, s.name))}</div>
        <div class="dir-item-code">${esc(s.location || '')}</div>
      </div>
      ${assigned
        ? `<span class="chip ok" style="font-size:.62rem;">✓ ${t('sup.manage.assigned')}</span>`
        : assignable
          ? `<button class="btn-sm" onclick="trackStation('${esc(s.code)}')">${t('sup.btn.track')}</button>`
          : ''}
    </div>`;
  }).join('');
};

// ── Edit modal (notes only → names / qty / expiry stay locked) ─
window.openEdit = function (code, itemId) {
  try {
    const d = stationByCode(code);
    if (!d) { toast(`Station ${code} not found`, 'error'); return; }
    const item = d.items.find((i) => String(i.id) === itemId);
    if (!item) { toast('Item not found', 'error'); return; }
    _editTarget = item;
    const fill = (el, prop, val) => { if (el) el[prop] = val; };
    fill($('editName'), 'value', item.name);
    fill($('editQtyLine'), 'textContent', `${item.quantity} ${t('sup.items')}${item.size ? ' · ' + t('sup.tbl.size') + ' ' + item.size : ''}`);
    fill($('editNotes'), 'value', item.notes || '');
    fill($('editReason'), 'value', '');
    if ($('reasonWarn')) $('reasonWarn').style.display = 'none';
    const m = $('editModal');
    if (!m) { toast('Edit window is missing from the page — please reload', 'error'); return; }
    m.classList.add('open');
  } catch (err) {
    console.error('openEdit failed:', err);
    toast(err && err.message || String(err), 'error');
  }
};

window.closeEditModal = function () { $('editModal').classList.remove('open'); _editTarget = null; };

$('editModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeEditModal(); });

window.confirmEdit = function () {
  if (!_editTarget) return;
  const notes = ($('editNotes') ? $('editNotes').value : '').trim();
  const reason = ($('editReason') ? $('editReason').value : '').trim();
  if (notes === (_editTarget.notes || '')) { closeEditModal(); toast(t('sup.toast.data_refreshed'), 'success'); return; }
  if (!reason) { const w = $('reasonWarn'); w.style.display = 'block'; w.textContent = t('sup.edit.reason_warn'); return; }

  api.updateItemNotes(_editTarget.id, notes, reason)
    .then(async () => {
      closeEditModal();
      toast(t('sup.toast.changes_saved'), 'success');
      await refreshData(false);
    })
    .catch(async (err) => {
      const m = String(err && err.message || err).toLowerCase();
      if (/sign in|401|session|unauthorized/.test(m)) { await renewSession(); await refreshData(false); return; }
      toast(err && err.message || String(err), 'error');
    });
};

// ── Refresh / logout ───────────────────────────────────────
window.refreshData = async function (showToast = true) {
  try {
    await Promise.all([refreshInventory(), refreshAudit(), refreshCrew(), loadDirectory(), loadSupply(), refreshHandovers()]);
    updateAlertBadge();
    updateTopbarPill();
    updateConnectionPill();
    renderSidebarStations();
    applyCurrent();
    if (showToast) toast(t('sup.toast.data_refreshed'), 'success');
  } catch (err) {
    toast(err && err.message || String(err), 'error');
  }
};
function applyCurrent() {
  const p = _currentPage;
  if (p === 'overview') renderOverview();
  else if (p === 'stations') renderStationsPage();
  else if (p === 'inspections') { if (_inspOverview) renderInspections(); else refreshInspections(); }
  else if (p === 'handovers') renderHandoverPage();
  else if (p === 'reports') { renderReportSelector(); loadSavedReports(); }
  else if (p === 'analytics') { supReportsDash?.rerender(); }
  else if (p === 'audit') renderAudit();
  else if (p === 'manage') renderManage();
  else if (p === 'supply') renderSupplyReview();
  else if (p === 'duty') renderDuty();
  else if (p === 'settings') renderSettings();
}

window.doLogout = async function () {
  await signOutAll();
  clearSession();
  window.location.href = '/login.html';
};

boot();
