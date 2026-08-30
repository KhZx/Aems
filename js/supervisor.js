// js/supervisor.js — Supervisor dashboard backed by the REST API (no Firebase RTDB).
// Multi-station: shows ONLY the units assigned to the caller (ManagedStation).

import { initI18n, setLanguage, getCurrentLang, t, onLanguageChanged } from './i18n.js';
import { initAppSession, setSession, renewSession, roleRedirectPath, clearSession, signOutAll } from './auth.js';
import { api } from './api.js';
import { icon, mountSprite } from './icons.js';

mountSprite();

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
let _auditPage = 0;
const AUDIT_PAGE_SIZE = 50;
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
  let expired = 0, warning = 0, ok = 0, low = 0;
  (items || []).forEach((i) => {
    const k = itemStatusKey(i);
    if (k === 'expired') expired++;
    else if (k === 'warning') warning++;
    else ok++;
    if (i.lowStock) low++;
  });
  const total = (items || []).length;
  return { expired, warning, ok, low, total };
}

function normalizeItem(r) {
  const b = r.batch || {};
  const amb = r.ambulance || {};
  const st = amb.station || {};
  return {
    id: r.id,
    name: b.medicine?.name || 'Unknown',
    category: b.medicine?.category || '',
    quantity: Number(r.quantity) || 0,
    notes: r.notes || '',
    minimal: b.medicine?.minimumStock ?? null,
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
    lowStock: !!r.lowStock,
  };
}

function stationById(id) { return _supData[id] || null; }
function stationByCode(code) {
  if (!code) return null;
  return Object.values(_supData).find((d) => d && (d.code === code || d.name === code)) || null;
}

// ── Fetchers ───────────────────────────────────────────────
async function refreshInventory() {
  _rawInventory = await api.inventory({ pageSize: 1000 });
  rebuildStations();
}
async function refreshAudit() {
  const res = await api.auditLogs({ pageSize: 200 });
  _rawAudit = Array.isArray(res) ? res : (res?.logs || []);
  _auditPage = 0;
}
async function loadDirectory() {
  try {
    _directory = await api.publicStations();
    _directory.forEach((s) => _stationMeta.set(s.id, { code: s.code, name: s.name }));
  } catch { _directory = []; }
}

function rebuildStations() {
  _supData = {};
  stations.forEach((id) => {
    const meta = _stationMeta.get(id) || {};
    _supData[id] = {
      id,
      code: meta.code || id,
      name: meta.name || meta.code || id,
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

    await Promise.all([loadDirectory(), refreshInventory(), refreshAudit(), loadSupply()]);
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
window.showPage = function (id) {
  _currentPage = id;
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
  $('page-' + id)?.classList.add('active');
  document.querySelector(`.nav-item[onclick="showPage('${id}')"]`)?.classList.add('active');
  const titles = {
    overview: t('sup.page.overview'), stations: t('sup.page.stations'),
    reports: t('sup.page.reports'), audit: t('sup.page.audit'), manage: t('sup.page.manage'),
    supply: t('sup.page.supply'),
  };
  $('pageTitle').textContent = titles[id] || id;
  if (id === 'overview') renderOverview();
  if (id === 'stations') renderStationsPage();
  if (id === 'reports') renderReportSelector();
  if (id === 'audit') renderAudit();
  if (id === 'manage') renderManage();
  if (id === 'supply') renderSupplyReview();
};

function applyAll() {
  $('sidebarName') && ($('sidebarName').textContent = (_session?.user?.name || _session?.user?.email) || '—');
  $('sidebarZone') && ($('sidebarZone').textContent = _session?.user?.supervisorZone ? `${t('sup.zone')} ${_session.user.supervisorZone}` : '');
  renderSidebarStations();
  updateAlertBadge();
  updateTopbarPill();
  updateConnectionPill();
  const p = _currentPage;
  if (p === 'overview') renderOverview();
  else if (p === 'stations') renderStationsPage();
  else if (p === 'reports') renderReportSelector();
  else if (p === 'audit') renderAudit();
  else if (p === 'manage') renderManage();
  else if (p === 'supply') renderSupplyReview();
}

function wireLangToggle() {
  const btn = $('supLangToggle');
  if (!btn) return;
  const paint = () => (btn.textContent = getCurrentLang() === 'en' ? 'عربي' : 'EN');
  btn.addEventListener('click', () => { setLanguage(getCurrentLang() === 'en' ? 'ar' : 'en'); });
  onLanguageChanged(() => { paint(); applyAll(); });
  paint();
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
  let totalItems = 0, totalExpired = 0, totalWarning = 0, totalLow = 0;
  const allAlerts = [];
  const lowStockItems = [];
  const ambCount = Array.isArray(_session?.ambulances) ? _session.ambulances.length : stations.length;

  stations.forEach((id) => {
    const d = _supData[id];
    if (!d) return;
    const st = stationStats(d.items);
    totalItems += st.total;
    totalExpired += st.expired;
    totalWarning += st.warning;
    totalLow += st.low;
    d.items.forEach((i) => {
      const k = itemStatusKey(i);
      if (k === 'expired' || k === 'warning') allAlerts.push({ sev: k, item: i, stName: d.name });
      if (i.lowStock) lowStockItems.push({ item: i, stName: d.name });
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
        ${st.low ? `<span class="chip low">${st.low} ${t('sup.col.low')}</span>` : ''}
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

  renderLowStock(lowStockItems);
  renderSupCharts();
}

function renderLowStock(lowStockItems) {
  const lsSection = $('lowStockSection');
  if (!lsSection) return;
  const lsList = $('lowStockList');
  const lsCount = $('lowStockCount');
  if (lowStockItems.length) {
    lsSection.style.display = 'block';
    if (lsCount) lsCount.textContent = `${lowStockItems.length} ${t('sup.items_count')}`;
    const ratio = (item) => (item.minimal > 0 ? item.quantity / item.minimal : item.quantity === 0 ? Infinity : 1);
    const sorted = lowStockItems.slice().sort((a, b) => ratio(a.item) - ratio(b.item));
    lsList.innerHTML = sorted.slice(0, 25).map(({ item, stName }) => {
      const pct = item.minimal > 0 ? Math.max(0, Math.round(item.quantity / item.minimal * 100)) : 0;
      const barW = Math.min(pct, 100);
      return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border2);">
        <span style="font-size:1rem;">${icon('trending')}</span>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <div style="font-size:.83rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(item.name)}</div>
            <div style="font-size:.8rem;font-weight:700;color:#FDE68A;flex-shrink:0;margin-left:8px;">${item.quantity} <span style="font-size:.65rem;font-weight:400;color:var(--text3);">/ min ${item.minimal}</span></div>
          </div>
          <div style="font-size:.68rem;color:var(--text3);margin:.2rem 0 .4rem;">${esc(stName)} · ${catLabel(item.category)}</div>
          <div style="height:4px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden;">
            <div style="height:100%;width:${barW}%;background:${pct < 25 ? '#EF4444' : pct < 50 ? '#F59E0B' : '#D97706'};border-radius:2px;transition:width .4s;"></div>
          </div>
        </div>
      </div>`;
    }).join('');
  } else {
    lsSection.style.display = 'none';
  }
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
        ${st.low ? `<span class="chip low">${st.low} ${t('sup.col.low')}</span>` : ''}
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
      <th>${t('sup.tbl.item')}</th><th>${t('sup.tbl.category')}</th><th>${t('sup.tbl.qty')}</th><th>${t('sup.tbl.min')}</th><th>${t('sup.tbl.location')}</th><th>${t('sup.tbl.expiry')}</th><th>${t('sup.tbl.status')}</th><th>${t('sup.tbl.lastcheck')}</th><th></th>
    </tr></thead>
    <tbody>${items.map((item) => {
      const s = itemStatusKey(item);
      const rowStyle = s === 'expired' ? 'background:rgba(239,68,68,.04);' : s === 'warning' ? 'background:rgba(245,158,11,.03);' : '';
      const qty = item.quantity;
      const isLow = item.lowStock;
      return `<tr style="${rowStyle}">
        <td style="font-weight:600;max-width:180px;">
          <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(item.name)}</div>
          ${item.batchNumber ? `<div style="font-size:.68rem;color:var(--text3);">${esc(item.batchNumber)}</div>` : ''}
          ${item.notes ? `<div style="font-size:.68rem;color:var(--text3);margin-top:2px;">✎ ${esc(item.notes)}</div>` : ''}
        </td>
        <td style="font-size:.75rem;color:var(--text2);">${catLabel(item.category)}</td>
        <td>
          <span style="font-family:var(--font-display);font-size:1.1rem;font-weight:800;${isLow ? 'color:#FCA5A5;' : ''}">${qty}</span>
          ${isLow && item.minimal != null ? `<div style="font-size:.62rem;color:#FCA5A5;">${t('sup.items_low')} ${item.minimal})</div>` : ''}
        </td>
        <td style="font-size:.75rem;color:var(--text3);">${item.minimal ?? '—'}</td>
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
    const checked = _reportSet.has(id) || !stations.length;
    return `<label class="report-check-item ${checked ? 'selected' : ''}" data-code="${esc(d.code)}">
      <input type="checkbox" ${checked ? 'checked' : ''} value="${esc(id)}" onchange="this.closest('.report-check-item').classList.toggle('selected', this.checked)">
      <div style="flex:1;">
        <div style="font-weight:600;">${esc(d.name)}</div>
        <div style="font-size:.68rem;color:var(--text3);">${st.total} ${t('sup.items')}${st.expired ? ` · <span style="color:#FCA5A5;">${st.expired} ${t('sup.col.expired')}</span>` : ''}${st.warning ? ` · <span style="color:#FDE68A;">${st.warning} ${t('sup.col.warning')}</span>` : ''}</div>
      </div>
    </label>`;
  }).join('') || `<div style="color:var(--text3);font-size:.84rem;">${t('sup.empty.no_stations')}</div>`;

  const allSel = stations.length > 0 && _reportSet.size === stations.length;
  const btn = $('reportSelectAll');
  if (btn) btn.textContent = t('sup.btn.' + (allSel ? 'deselect' : 'select_all'));
}

window.toggleSelectAll = function () {
  if (stations.length && _reportSet.size === stations.length) _reportSet = new Set();
  else _reportSet = new Set(stations);
  renderReportSelector();
};

window.generateReport = function () {
  const ids = [..._reportSet];
  if (!ids.length) { toast(t('sup.toast.no_station'), 'error'); return; }
  const results = ids.map((id) => { const d = _supData[id]; return { code: d.code, name: d.name, items: d.items || [] }; });
  _reportData = results;
  renderReportOutput(results);
  $('reportActions').style.display = 'flex';
  toast(t('sup.toast.report_ready', { items: results.reduce((a, r) => a + r.items.length, 0), stations: results.length }), 'success');
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
            ${st.low ? `<span class="chip low">${st.low} ${t('sup.col.low')}</span>` : ''}
            ${!st.expired && !st.warning ? `<span class="chip ok">✓ ${t('sup.col.valid')}</span>` : ''}
          </div>
        </div>
        ${sorted.length ? `<div class="tbl-wrap">
          <table>
            <thead><tr><th>${t('sup.tbl.station')}</th><th>${t('sup.tbl.item')}</th><th>${t('sup.tbl.category')}</th><th>${t('sup.tbl.qty')}</th><th>${t('sup.tbl.min')}</th><th>${t('sup.tbl.location')}</th><th>${t('sup.tbl.expiry')}</th><th>${t('sup.tbl.status')}</th><th>${t('sup.tbl.lastcheck')}</th></tr></thead>
            <tbody>${sorted.map((item) => {
              const s = itemStatusKey(item);
              const rowStyle = s === 'expired' ? 'background:rgba(239,68,68,.06);' : s === 'warning' ? 'background:rgba(245,158,11,.04);' : '';
              return `<tr style="${rowStyle}">
                <td style="font-weight:600;">${esc(r.name)}</td>
                <td style="font-weight:600;">${esc(item.name)}</td>
                <td style="font-size:.75rem;color:var(--text2);">${catLabel(item.category)}</td>
                <td><span style="font-family:var(--font-display);font-size:1.05rem;font-weight:800;">${item.quantity}</span></td>
                <td style="font-size:.75rem;color:var(--text3);">${item.minimal ?? '—'}</td>
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
  const headers = ['Station', 'Code', 'Item', 'Category', 'Quantity', 'Min', 'Location', 'Expiry', 'Status', 'Last Check'];
  let csv = '\ufeff' + headers.join(',') + '\n';
  _reportData.forEach((r) => {
    r.items.forEach((item) => {
      const s = itemStatusKey(item);
      const row = [
        r.name, r.code, item.name, item.category || '',
        item.quantity, item.minimal == null ? '' : item.minimal,
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

// ── Audit log ──────────────────────────────────────────────
function renderAudit() {
  const stFilt = $('auditStationFilter')?.value || '';
  const typeFilt = $('auditTypeFilter')?.value || '';
  const search = ($('auditSearch')?.value || '').toLowerCase();

  const stSel = $('auditStationFilter');
  if (stSel) {
    const current = stSel.value;
    stSel.innerHTML = `<option value="">${t('sup.filter.all')}</option>` + stations.map((id) => {
      const d = _supData[id]; if (!d) return '';
      return `<option value="${esc(id)}" ${current === id ? 'selected' : ''}>${esc(d.name)}</option>`;
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
  const page = entries.slice(0, (_auditPage + 1) * AUDIT_PAGE_SIZE);

  $('auditList').innerHTML = page.length ? page.map((e) => {
    const d = e.stationId ? _supData[e.stationId] : null;
    const stName = d ? d.name : '—';
    const who = e.userName || e.userEmail || '—';
    let meta = '';
    try {
      if (e.metadata && typeof e.metadata === 'object') {
        meta = '<div style="font-size:.68rem;color:var(--text3);margin-top:2px;">' +
          Object.entries(e.metadata).filter(([k]) => !['userId', 'userEmail'].includes(k)).map(([k, v]) =>
            `<span style="display:inline-block;margin-right:6px;">${esc(k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span>`
          ).join('') + '</div>';
      }
    } catch { meta = ''; }
    return `<div class="audit-row">
      <div>
        <div class="audit-time">${fmtDateTime(e.createdAt)}</div>
      </div>
      <div>
        <div class="audit-text"><strong>${esc(who)}</strong> — ${esc(auditActionLabel(e.action))} <span class="badge none" style="font-size:.6rem;color:#C4B5FD;border-color:#C4B5FD40;">${esc(e.action || '—')}</span></div>
        <div class="audit-station">${icon('pin')} ${esc(stName)}</div>
        ${e.reason ? `<div class="audit-reason">${icon('message')} "${esc(e.reason)}"</div>` : ''}
        ${meta}
      </div>
    </div>`;
  }).join('') : `<div class="empty"><div class="empty-icon">${icon('list')}</div><div class="empty-text">${t('sup.audit.empty')}</div></div>`;

  const loadMore = $('auditLoadMore');
  loadMore.style.display = entries.length > (_auditPage + 1) * AUDIT_PAGE_SIZE ? 'block' : 'none';
}

window.loadMoreAudit = function () { _auditPage++; renderAudit(); };

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
  const stName = (r) => { const s = r.ambulance?.station; return s ? `${s.name} (${s.code})` : '—'; };
  el.innerHTML = sorted.map((r) => {
    const color = SUPPLY_STATUS_COLOR[r.status] || '#999';
    const label = t(SUPPLY_STATUS_KEY[r.status] || '');
    const actions = [];
    if (r.status === 'PENDING') {
      actions.push(`<button class="btn-sm primary" onclick="reviewSupply('${r.id}','APPROVED')">${icon('check')} ${t('sup.supply.approve')}</button>`);
      actions.push(`<button class="btn-sm danger" onclick="reviewSupply('${r.id}','REJECTED')">${t('sup.supply.reject')}</button>`);
    } else if (r.status === 'APPROVED') {
      actions.push(`<button class="btn-sm success" onclick="reviewSupply('${r.id}','FULFILLED')">${icon('checkCircle')} ${t('sup.supply.fulfil')}</button>`);
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
    if (!m) { resolve(window.confirm(message)); return; }
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
    setSession(_session);
    applyAssignment(me2.user || {});
    await Promise.all([loadDirectory(), refreshInventory()]);
    applyAll();
  } catch (err) {
    toast(err && err.message || String(err), 'error');
  }
}
window.refreshAssignment = refreshAssignment;

window.trackStation = async function (code) {
  const cur = Array.isArray(_session.user?.managedStations) ? _session.user.managedStations.map((m) => m.code) : [];
  if (cur.includes(code)) return;
  try {
    await api.setManagedStations([...cur, code]);
    await refreshAssignment();
    toast(t('sup.toast.changes_saved'), 'success');
  } catch (err) { toast(err && err.message || String(err), 'error'); }
};

window.untrackStation = async function (code) {
  const cur = Array.isArray(_session.user?.managedStations) ? _session.user.managedStations.map((m) => m.code) : [];
  try {
    await api.setManagedStations(cur.filter((c) => c !== code));
    await refreshAssignment();
    toast(t('sup.toast.changes_saved'), 'success');
  } catch (err) { toast(err && err.message || String(err), 'error'); }
};

function renderManage() {
  const trackedEl = $('trackedList');
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
      <button class="btn-sm" onclick="untrackStation('${esc(d.code)}')">${t('sup.btn.untrack')}</button>
    </div>`;
  }).join('') : `<div style="color:var(--text3);font-size:.82rem;padding:8px 0;">${t('sup.manage.no_tracked')}</div>`;

  $('dirCount').textContent = `${stations.filter((id) => _directory.some((s) => s.id === id)).length}/${_directory.length}`;
  renderDirectory();
  trackedEl.insertAdjacentHTML('beforeend', `<div style="margin-top:10px;font-size:.7rem;color:var(--text3);border-top:1px solid var(--border2);padding-top:10px;">${t('sup.manage.note')}</div>`);
}

window.renderDirectory = function () {
  const search = ($('dirSearch')?.value || '').toLowerCase();
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
        <div class="dir-item-name">${esc(s.name || s.code)}</div>
        <div class="dir-item-code">${esc(s.code)}</div>
      </div>
      ${assigned ? `<span class="chip ok" style="font-size:.62rem;">✓ ${t('sup.manage.assigned')}</span>` : `<button class="btn-sm" onclick="trackStation('${esc(s.code)}')">${t('sup.btn.track')}</button>`}
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
    fill($('editQtyLine'), 'textContent', `${item.quantity} ${t('sup.items')} · ${t('sup.tbl.min')} ${item.minimal ?? '—'}`);
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
    await Promise.all([refreshInventory(), refreshAudit(), loadDirectory(), loadSupply()]);
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
  else if (p === 'reports') renderReportSelector();
  else if (p === 'audit') renderAudit();
  else if (p === 'manage') renderManage();
  else if (p === 'supply') renderSupplyReview();
}

window.doLogout = async function () {
  await signOutAll();
  clearSession();
  window.location.href = '/login.html';
};

boot();