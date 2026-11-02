// js/app.js — AEMS paramedic app (REST API + inventory model)

import { initI18n, setLanguage, getCurrentLang, onLanguageChanged, t, unitLabel } from './i18n.js';
import { confirmDialog, promptDialog, choiceDialog } from './confirm.js';
import { FIREBASE_CONFIG } from './config.js';
import { initFirebase } from './services/firebase.js';
import { api } from './api.js';
import {
  loadReasonCatalog,
  mountReasonControl,
  onReasonChange,
  readReasonControl,
  reasonsFor,
  reasonLabel,
  reasonLabelFor,
  itemTypeForCategory,
} from './reasons.js';
import { initAppSession, signOutAll, getSession, setSession } from './auth.js';
import { startHealthMonitor } from './health.js';
import { initSidebarNavigation } from './sidebar-nav.js';
import { initNotificationCenter } from './notifications.js';
import {
  renderItemCard, renderItemRow, renderAlertCard, renderShiftNote, renderChangeItem, renderBatchItem, toggleTree,
  emptyState, toast, openModal, closeModal, closeAllModals,
  catIcon, catLabel, catColor, fmtDate, fmtDateTime, earliestExpiry, expiryStatus,
} from './ui.js';
import { CATEGORIES } from './data/initial-data.js';
import { icon, mountSprite } from './icons.js';
import { initDutyCalendar, renderDutyCalendar } from './duty-calendar.js';
import { openChangePasswordDialog } from './password.js';

mountSprite();
initSidebarNavigation();

// Shifts are fixed to A / B / C / D, each either morning or night.
const SHIFT_IDS = ['A', 'B', 'C', 'D'];
const SHIFT_PERIODS = ['Morning', 'Night'];
function shiftLabel(code, period) {
  const c = SHIFT_IDS.includes(code) ? code : '';
  const p = SHIFT_PERIODS.includes(period) ? period : '';
  if (c && p) return `${c} – ${p}`;
  return c || p || '';
}

// The API caps every list endpoint at pageSize 200 (see the zod schemas in
// server/src/validators). Asking for more is a 400, not a clamp, so oversized
// values silently break the caller. Use this for "fetch all lots" lookups.
const MAX_LIST_PAGE_SIZE = 200;
const ITEM_RENDER_BATCH_SIZE = 60;
const _itemRenderStates = new Map();

const S = {
  session: null,
  user: null,
  ready: false,
  permissions: [],
  ambulances: [],
  activeAmbulanceId: null, // car within the active unit (local pick)
  activeUnit: null,        // active duty unit (station): {id, code, name}
  dutyRoster: [],          // units (stations) the admin allows this user to hold
  stationId: null,
  stationName: '—',
  items: [],
  lastInspection: null, // inventoryId -> actualQuantity at last full inspection
  shiftNotes: [],
  handovers: [],
  history: [],
  medicines: [],
  supplyRequests: [],
  currentPage: 'dashboard',
  currentCat: 'medication',
  filterCat: '',
  filterExpiry: '',
  searchTerm: '',
  view: localStorage.getItem('aems_view') === 'list' ? 'list' : 'cards', // 'cards' | 'list' (ESO-style toggle)
  editMode: null, // 'add' | 'adjust'
  addMode: 'new', // 'new' | 'restock'
  tempBatches: [],
  editInventoryId: null,
  useId: null,
  reportText: '',
};

// ── Small helpers ──────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function me() {
  return { id: S.user?.id, name: S.user?.displayName || '—', empId: S.user?.empId || '' };
}
function can(perm) {
  return Array.isArray(S.permissions) && S.permissions.includes(perm);
}
function requireAmbulance() {
  if (!S.activeAmbulanceId) { toast(t('app.inspect.no_car'), 'error'); return false; }
  // A stale pick (car since removed, or one this user cannot choose) would pass
  // the truthiness check and only fail server-side with a bare 404. Catch it here
  // with a message that tells the user what to do.
  if (S.ambulances.length && !S.ambulances.some(a => a.id === S.activeAmbulanceId)) {
    S.activeAmbulanceId = null;
    localStorage.removeItem('aems_car_pick');
    pickActiveCar();
    if (!S.activeAmbulanceId) { toast(t('app.inspect.no_car'), 'error'); return false; }
    toast(t('app.inspect.car_reset'), 'info');
  }
  return true;
}
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function setConnection(label, online) {
  const el = document.getElementById('connectionStatus');
  const lb = document.getElementById('connLabel');
  if (!el || !lb) return;
  el.className = `conn-status ${online ? 'online' : 'offline'}`;
  lb.textContent = label;
}
function nowLocal() {
  const n = new Date();
  const p = v => String(v).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}T${p(n.getHours())}:${p(n.getMinutes())}`;
}

// ── Item normalization (backend InventoryDetail → ui item) ─────
function normalizeItem(row) {
  const m = row.batch?.medicine || {};
  return {
    id: row.id,                          // inventory id (UUID)
    medicineId: m.id,
    batchId: row.batch?.id,
    batchNumber: row.batch?.batchNumber,
    name: m.name || 'Unknown item',
    category: (m.category || 'MEDICATION').toLowerCase(),
    quantity: row.quantity ?? 0,
    size: m.size || null,
    expiry: row.batch?.expiryDate || null,
    receivedDate: row.batch?.receivedDate || null,
    hasLotOverride: !!row.hasLotOverride,
    unit: m.unit || '',
    strength: m.strength || '',
    supplier: row.batch?.supplier || '',
    location: m.location || null,
    notes: m.notes || null,
    technicalNotes: m.technicalNotes || null,
    serial: m.serialNumber || null,
    storeCode: m.barcode || null,
    barcode: m.barcode || null,
    genericName: m.genericName || null,
    dosageForm: m.dosageForm || null,
    ambulanceId: row.ambulanceId || null,
    batches: null,
    lastCheck: null,
    _inv: row,
  };
}

// Group the flat stock lines into ONE consolidated card per medicine. Every
// batch/LOT of the same medicine is listed inside its card.
function groupRows(rows) {
  const map = new Map();
  rows.forEach(item => {
    if (!map.has(item.medicineId)) {
      map.set(item.medicineId, {
        id: item.medicineId,
        medicineId: item.medicineId,
        name: item.name,
        category: item.category,
        unit: item.unit,
        strength: item.strength,
        size: item.size,
        location: item.location,
        notes: item.notes,
        technicalNotes: item.technicalNotes,
        serial: item.serial,
        storeCode: item.storeCode,
        barcode: item.barcode ?? item.storeCode,
        genericName: item.genericName,
        dosageForm: item.dosageForm,
        ambulanceId: item.ambulanceId,
        batches: [],
        quantity: 0,
      });
    }
    map.get(item.medicineId).batches.push(item);
  });
  const groups = Array.from(map.values());
  groups.forEach(g => {
    g.quantity = g.batches.reduce((sum, b) => sum + (b.quantity || 0), 0);
    g.batches.sort((a, b) => (a.expiry || '').localeCompare(b.expiry || ''));
  });
  return groups;
}

function groupedItems() {
  return groupRows(S.items);
}

function findGroup(medicineId) {
  return groupedItems().find(g => g.id === medicineId);
}

// Items re-mapped to their "last inspection" quantities for change badges.
function snapshotItems() {
  if (!S.lastInspection) return null;
  return S.items
    .filter(i => S.lastInspection[i.id] !== undefined)
    .map(i => ({ id: i.id, name: i.name, category: i.category, quantity: S.lastInspection[i.id] }));
}

// ── Data loaders ───────────────────────────────────────────────
async function loadInventory() {
  if (!S.stationId) { S.items = []; return; }
  // Inventory is scoped to the whole unit (station): every shift and every
  // car of this unit shares the same stock view; other units never see it.
  const rows = await api.inventoryAll({ stationId: S.stationId, includeEmpty: true });
  S.items = rows.map(normalizeItem);
  // Only fall back to a car that owns stock when the user has no pick yet AND
  // that car is actually one they can choose. Adopting an arbitrary car here
  // (e.g. one belonging to another shift) could hand a non-existent or
  // out-of-scope id to the inspection/use endpoints, which answer 404.
  if (rows.length && rows[0].ambulance && !S.activeAmbulanceId) {
    const candidate = rows[0].ambulance.id;
    if (!S.ambulances.length || S.ambulances.some(a => a.id === candidate)) {
      S.activeAmbulanceId = candidate;
    }
  }
}

async function loadShiftNotes() {
  if (!S.stationId) { S.shiftNotes = []; return; }
  // Supervisors also see removed notes so they can put them back.
  const params = { stationId: S.stationId, pageSize: 50 };
  if (can('shiftnote:restore')) params.includeDeleted = 'true';
  const data = await api.shiftNotes(params);
  S.shiftNotes = data.notes || [];
}

async function loadHandovers() {
  if (!S.stationId) { S.handovers = []; return; }
  const data = await api.handovers({ stationId: S.stationId, pageSize: 50 });
  S.handovers = data.handovers || [];
}

async function loadLastInspection() {
  S.lastInspection = null;
  if (!S.activeAmbulanceId) return;
  const data = await api.inspections({ ambulanceId: S.activeAmbulanceId, pageSize: 10 });
  const recent = data.inspections || [];
  if (!recent.length) return;
  // Prefer a recent full snapshot (several items) over a single quick check.
  const threshold = Math.min(25, Math.max(10, S.items.length));
  const best = recent.find(r => (r._count?.items || 0) >= threshold) || recent[0];
  const detail = await api.inspection(best.id);
  const map = {};
  (detail.items || []).forEach(it => { map[it.inventoryId] = it.actualQuantity; });
  S.lastInspection = map;
}

async function loadHistory() {
  try {
    const data = await api.auditLogs({ pageSize: 80 });
    S.history = data.logs || [];
  } catch {
    S.history = [];
  }
}

async function loadAll() {
  await Promise.all([
    loadInventory().catch(err => toast(err.message, 'error')),
    loadShiftNotes().catch(err => toast(err.message, 'error')),
    loadHandovers().catch(err => toast(err.message, 'error')),
    loadHistory().catch(() => {}),
    loadLastInspection().catch(() => {}),
    loadSupplyRequests().catch(() => {}),
    loadReasonCatalog().catch(() => {}),
  ]);
}

// ── Supply Requests ────────────────────────────────────────────
async function loadSupplyRequests() {
  if (!can('supply:read')) { S.supplyRequests = []; updateSupplyNavBadge(); return; }
  const data = await api.supplyRequests({ pageSize: 100 });
  S.supplyRequests = data.requests || [];
  updateSupplyNavBadge();
}

function updateSupplyNavBadge() {
  const el = document.getElementById('supply-nav');
  if (el) el.style.display = can('supply:read') ? '' : 'none';
  const badge = document.getElementById('supply-nav-badge');
  if (!badge) return;
  const pending = (S.supplyRequests || []).filter(r => r.status === 'PENDING').length;
  badge.textContent = String(pending);
  badge.style.display = pending ? 'inline-block' : 'none';
}

const SUPPLY_STATUS = {
  PENDING:     { color: '#D97706', key: 'supply.status.pending' },
  APPROVED:    { color: '#2563EB', key: 'supply.status.approved' },
  DISPATCHED:  { color: '#0EA5E9', key: 'supply.status.dispatched' },
  IN_TRANSIT:  { color: '#0EA5E9', key: 'supply.status.in_transit' },
  RECEIVED:    { color: '#059669', key: 'supply.status.received' },
  FULFILLED:   { color: '#059669', key: 'supply.status.fulfilled' },
  CLOSED:      { color: '#64748B', key: 'supply.status.closed' },
  REJECTED:    { color: '#DC2626', key: 'supply.status.rejected' },
  CANCELLED:   { color: '#64748B', key: 'supply.status.cancelled' },
};

function renderSupplyPage() {
  const el = document.getElementById('supplyList');
  if (!el) return;
  const rows = S.supplyRequests || [];
  if (!rows.length) {
    el.innerHTML = emptyState(icon('package'), t('app.supply.empty'));
    return;
  }
  el.innerHTML = rows.map(r => {
    const st = SUPPLY_STATUS[r.status] || { color: '#999', key: null };
    const label = st.key ? t(st.key) : r.status;
    const medicine = r.medicine?.name || t('ui.medicine');
    const vehicle = r.ambulance?.vehicleNumber || '—';
    const requester = r.createdBy?.displayName || '—';
    const when = fmtDateTime(r.createdAt);
    const canCancel = r.status === 'PENDING';
    const canReceive = r.status === 'DISPATCHED' || r.status === 'IN_TRANSIT';
    const rowActions = (canCancel || canReceive) ? `
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
          ${canReceive ? `<button class="btn btn-primary btn-sm" onclick="App.receiveSupply('${r.id}',${Number(r.quantity) || 0})">${icon('checkCircle')} ${t('supply.receive')}</button>` : ''}
          ${canCancel ? `<button class="btn btn-ghost btn-sm" onclick="App.cancelSupply('${r.id}')">${t('supply.cancel')}</button>` : ''}
        </div>` : '';
    return `
      <div class="history-item">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="background:${st.color};color:white;padding:2px 10px;border-radius:20px;font-size:0.72rem;font-weight:700;">${esc(label)}</span>
            <span style="font-size:0.9rem;font-weight:600;">${esc(medicine)} × ${r.quantity}</span>
          </div>
          <span style="font-size:0.72rem;color:var(--text-muted);white-space:nowrap;">${when}</span>
        </div>
        <div style="font-size:0.78rem;color:var(--text-muted);display:flex;gap:14px;flex-wrap:wrap;">
          <span>${icon('ambulance')} ${esc(vehicle)}</span>
          <span>${icon('user')} ${esc(requester)}</span>
          ${r.reason ? `<span>${icon('fileText')} ${esc(r.reason)}</span>` : ''}
        </div>
        ${canCancel || canReceive ? rowActions : ''}
      </div>`;
  }).join('');
}

function openSupplyModal(id) {
  if (!requireAmbulance()) return;
  const item = findGroup(id) || S.items.find(i => i.id === id) || S.items.find(i => i.medicineId === id);
  if (!item) { toast(t('supply.no_item'), 'error'); return; }
  S.supplyTargetItem = item;
  const el = document.getElementById('supplyItemInfo');
  if (el) {
    const active = S.ambulances.find(a => a.id === S.activeAmbulanceId);
    const vehicle = active?.vehicleNumber || t('supply.no_vehicle');
    el.innerHTML = `
      <div style="padding:12px 14px;background:var(--bg);border-radius:12px;border:1px solid var(--border);">
        <div style="font-weight:700;font-size:.95rem;">${esc(item.name)}${item.size ? ` <span style="font-weight:600;font-size:.8rem;color:var(--text-muted);">(${esc(item.size)})</span>` : ''}</div>
        <div style="font-size:.75rem;color:var(--text-muted);margin-top:4px;">
          ${icon('package')} ${catLabel(item.category)}
          &nbsp;·&nbsp; ${icon('ambulance')} ${esc(vehicle)}
          &nbsp;·&nbsp; ${icon('package')} ${t('supply.on_hand', { qty: item.quantity })}
        </div>
      </div>`;
  }
  document.getElementById('supply-qty').value = 1;
  document.getElementById('supply-reason').value = '';
  openModal('modal-supply');
}

async function confirmSupply() {
  if (!S.supplyTargetItem) { toast(t('supply.no_item'), 'error'); return; }
  if (!requireAmbulance()) return;
  const qty = Math.max(1, parseInt(document.getElementById('supply-qty').value, 10) || 1);
  const reason = document.getElementById('supply-reason').value.trim();
  const active = S.ambulances.find(a => a.id === S.activeAmbulanceId);
  if (!active) { toast(t('supply.no_vehicle'), 'error'); return; }
  try {
    await api.createSupplyRequest({
      ambulanceId: S.activeAmbulanceId,
      medicineId: S.supplyTargetItem.medicineId,
      quantity: qty,
      reason,
    });
    closeModal('modal-supply');
    toast(t('supply.sent'));
    await loadSupplyRequests();
    if (S.currentPage === 'supply') renderSupplyPage();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function cancelSupply(id) {
  if (!await confirmDialog({ message: t('supply.cancel_confirm'), tone: 'warning' })) return;
  try {
    await api.cancelSupplyRequest(id);
    toast(t('supply.cancelled'));
    await loadSupplyRequests();
    if (S.currentPage === 'supply') renderSupplyPage();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** DISPATCHED/IN_TRANSIT → RECEIVED. The crew's first confirmation; the
 *  supervisor still has to sign off before stock is credited. */
async function receiveSupply(id, requested) {
  let typed;
  try {
    typed = await promptDialog({
      title: t('supply.receive'),
      message: t('supply.receive_hint', { qty: requested }),
      value: String(requested),
      placeholder: t('supply.receive_qty'),
      confirmLabel: t('supply.receive'),
    });
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  if (typed === null || typed === undefined) return;

  const qty = Number.parseInt(String(typed).trim(), 10);
  if (!Number.isInteger(qty) || qty < 0) { toast(t('supply.receive_bad_qty'), 'error'); return; }

  try {
    await api.receiveSupplyRequest(id, { receivedQuantity: qty });
    toast(t('supply.received'), 'success');
    await loadSupplyRequests();
    if (S.currentPage === 'supply') renderSupplyPage();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Charts ─────────────────────────────────────────────────────
const _charts = {};
function _destroyChart(id) {
  if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
}
if (typeof Chart !== 'undefined') {
  Chart.defaults.font.family = "'Cairo', 'Outfit', system-ui, sans-serif";
  Chart.defaults.color = '#94A3B8';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.07)';
  Chart.defaults.plugins.legend.display = false;
}

function renderStatusDonut() {
  const canvas = document.getElementById('statusDonut');
  if (!canvas || typeof Chart === 'undefined') return;
  let expired = 0, warning = 0, ok = 0, none = 0;
  S.items.forEach(item => {
    const s = expiryStatus(earliestExpiry(item));
    if (s === 'expired') expired++;
    else if (s === 'warning') warning++;
    else if (s === 'ok') ok++;
    else none++;
  });
  const total = S.items.length;
  setText('donut-total', total);
  const legend = document.getElementById('donutLegend');
  if (legend) {
    legend.innerHTML = [
      { label: t('app.stat.expired'), val: expired, color: '#DC2626' },
      { label: t('app.stat.warning'), val: warning, color: '#D97706' },
      { label: t('app.stat.ok'), val: ok, color: '#059669' },
      { label: t('app.stat.no_expiry'), val: none, color: '#9CA3AF' },
    ].map(r => `<div class="legend-row">
      <div class="legend-dot" style="background:${r.color};"></div>
      <span class="legend-label">${r.label}</span>
      <span class="legend-val">${r.val}</span>
    </div>`).join('');
  }
  _destroyChart('donut');
  _charts.donut = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: [t('app.stat.expired'), t('app.stat.warning'), t('app.stat.ok'), t('app.stat.no_expiry')],
      datasets: [{
        data: [expired, warning, ok, none],
        backgroundColor: ['#EF4444', '#F59E0B', '#10B981', '#334155'],
        borderWidth: 3, borderColor: '#161B22', hoverBorderColor: '#1C2230', hoverOffset: 6,
      }],
    },
    options: {
      cutout: '68%', responsive: true, maintainAspectRatio: false,
      animation: { animateRotate: true, duration: 900, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `  ${ctx.label}: ${ctx.raw}${total ? ' (' + Math.round(ctx.raw / total * 100) + '%)' : ''}` } },
      },
    },
  });
}

function renderCatBars() {
  const canvas = document.getElementById('catBarsChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const counts = {};
  S.items.forEach(i => { const c = i.category || 'other'; counts[c] = (counts[c] || 0) + 1; });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  _destroyChart('catBars');
  if (!entries.length) return;
  _charts.catBars = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: entries.map(([c]) => catLabel(c)),
      datasets: [{
        data: entries.map(([, n]) => n),
        backgroundColor: entries.map(([c]) => catColor(c) + 'BB'),
        borderColor: entries.map(([c]) => catColor(c)),
        borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
        hoverBackgroundColor: entries.map(([c]) => catColor(c)),
      }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      animation: { duration: 750, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `  ${t('ui.chart.items', { n: ctx.raw })}` } },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { precision: 0, color: '#94A3B8', font: { size: 11 } } },
        y: { grid: { display: false }, ticks: { color: '#4B5563', font: { size: 11 } } },
      },
    },
  });
}

function renderExpiryTimeline() {
  const canvas = document.getElementById('expiryTimelineChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const now = new Date();
  const bucketKeys = ['past'];
  const labels = [`⚠ ${t('app.stat.expired')}`];
  const colors = ['#DC2626'];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    bucketKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    labels.push(d.toLocaleDateString(getCurrentLang() === 'ar' ? 'ar-EG' : 'en-GB', { month: 'short', year: '2-digit' }));
    colors.push(i === 0 ? '#D97706' : i <= 2 ? '#F59E0B' : '#059669');
  }
  const counts = Object.fromEntries(bucketKeys.map(k => [k, 0]));
  S.items.forEach(item => {
    const exp = earliestExpiry(item);
    if (!exp) return;
    const d = new Date(exp);
    if (d < now) { counts.past++; }
    else {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (counts[key] !== undefined) counts[key]++;
    }
  });
  _destroyChart('expiryTimeline');
  _charts.expiryTimeline = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: bucketKeys.map(k => counts[k]),
        backgroundColor: colors.map(c => c + 'BB'),
        borderColor: colors,
        borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
        hoverBackgroundColor: colors,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 750, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `  ${t('ui.chart.expiring', { n: ctx.raw })}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9CA3AF', font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { precision: 0, color: '#94A3B8', font: { size: 11 } } },
      },
    },
  });
}

// ── Dashboard renderers ────────────────────────────────────────
function renderStats() {
  let expired = 0, warning = 0, ok = 0;
  groupedItems().forEach(item => {
    const s = expiryStatus(earliestExpiry(item));
    if (s === 'expired') expired++;
    else if (s === 'warning') warning++;
    else if (s === 'ok') ok++;
  });
  setText('stat-expired', expired);
  setText('stat-warning', warning);
  setText('stat-ok', ok);
  setText('stat-total', groupedItems().length);
}

function getAlerts() {
  const expired = [], warning = [];
  groupedItems().forEach(item => {
    const s = expiryStatus(earliestExpiry(item));
    if (s === 'expired') expired.push(item);
    else if (s === 'warning') warning.push(item);
  });
  return { expired, warning };
}

function renderAlertsList() {
  const el = document.getElementById('alertsList');
  if (!el) return;
  const alerts = [];
  groupedItems().forEach(item => {
    const s = expiryStatus(earliestExpiry(item));
    if (s === 'expired') alerts.push(renderAlertCard(item, 'expired'));
    else if (s === 'warning') alerts.push(renderAlertCard(item, 'warning'));
  });
  el.innerHTML = alerts.length ? alerts.join('') : emptyState(icon('checkCircle'), t('app.empty.good'));
}

/** Mirrors the server rule: the author may remove their own note for 12h; a
 *  supervisor may remove anyone's. Purely cosmetic — the API enforces the same. */
const AUTHOR_DELETE_WINDOW_MS = 12 * 60 * 60 * 1000;

function canDeleteShiftNote(note) {
  if (!can('shiftnote:delete')) return false;
  const isReviewer = S.user?.role === 'ADMIN' || S.user?.role === 'SUPERVISOR';
  if (isReviewer) return true;
  const mine = note.createdById && note.createdById === S.user?.id;
  if (!mine) return false;
  return Date.now() - new Date(note.createdAt || note.date).getTime() < AUTHOR_DELETE_WINDOW_MS;
}

function renderShiftNotesList() {
  const el = document.getElementById('shiftNotesList');
  if (!el) return;
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = [...S.shiftNotes].sort((a, b) =>
    order[(a.priority || 'medium').toLowerCase()] - order[(b.priority || 'medium').toLowerCase()] ||
    new Date(b.createdAt || b.date) - new Date(a.createdAt || a.date)
  );
  const decorated = sorted.slice(0, 8).map((n) => ({
    ...n,
    _canDelete: !n.deletedAt && canDeleteShiftNote(n),
    _canRestore: !!n.deletedAt && can('shiftnote:restore'),
  }));
  el.innerHTML = sorted.length
    ? decorated.map(n => renderShiftNote(n)).join('')
    : `<p style="color:var(--text-muted);font-size:0.88rem;text-align:center;padding:16px;">${t('app.empty.no_notes')}</p>`;
}

function computeChanges() {
  if (!S.lastInspection) return [];
  return S.items.reduce((acc, item) => {
    const prev = S.lastInspection[item.id];
    if (prev !== undefined && prev !== item.quantity) {
      acc.push({ id: item.id, name: item.name, category: item.category, prevQty: prev, currQty: item.quantity, diff: item.quantity - prev });
    }
    return acc;
  }, []);
}

function renderChangesPanel() {
  const changes = computeChanges();
  const el = document.getElementById('changesList');
  const title = document.getElementById('changesPanelTitle');
  if (!el) return;
  if (!S.lastInspection) {
    if (title) title.textContent = t('app.empty.no_snapshot_title');
    el.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:0.88rem;">${t('app.empty.no_snapshot_desc')}</div>`;
    return;
  }
  if (title) title.textContent = t('app.empty.changes_title', { n: changes.length });
  el.innerHTML = changes.length
    ? changes.map(renderChangeItem).join('')
    : `<div style="padding:16px;text-align:center;color:var(--success);font-size:0.88rem;">${t('app.empty.changes_none')}</div>`;
}

function updateHandoverBanner() {
  const pending = S.handovers.find(h => h.status === 'submitted');
  const banner = document.getElementById('handover-dashboard-banner');
  if (!banner) return;
  if (pending) {
    const when = pending.createdAt ? fmtDateTime(pending.createdAt) : '—';
    const eqKey = { 'All OK': 'handover.eq.all_ok', 'Issues Noted': 'handover.eq.noted', 'Critical Items Missing': 'handover.eq.critical' }[pending.outgoing?.equipStatus] || '';
    const eqLabel = eqKey ? t(eqKey) : pending.outgoing?.equipStatus || '—';
    const statusColors = { 'All OK': '#059669', 'Issues Noted': '#D97706', 'Critical Items Missing': '#DC2626' };
    const sc = statusColors[pending.outgoing?.equipStatus] || '#64748B';
    banner.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:12px;">
          <span style="display:flex;color:#F59E0B;flex-shrink:0;">${icon('bell')}</span>
          <div>
            <div style="font-weight:800;font-size:.95rem;color:#FDE68A;">${t('handover.banner.title')}</div>
            <div style="font-size:.8rem;color:#FDBA74;margin-top:2px;">
              ${t('handover.banner.from')}: <strong>${esc(pending.outgoing?.paramedicName || '—')}</strong> · ${when}
              &nbsp;·&nbsp; <span style="color:${sc};font-weight:700;">${esc(eqLabel)}</span>
            </div>
          </div>
        </div>
        <button class="btn btn-sm" onclick="App.navigateTo('handover')"
          style="background:#D97706;color:#111827;border:none;font-weight:700;white-space:nowrap;cursor:pointer;">
          ${icon('check')} ${t('handover.banner.view_ack')}
        </button>
      </div>`;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
    banner.innerHTML = '';
  }
  const badge = document.getElementById('handover-nav-badge');
  if (badge) badge.style.display = pending ? 'inline-block' : 'none';
}

function renderDashboard() {
  renderDashboardClock();
  renderStats();
  renderCharts();
  renderAlertsList();
  renderShiftNotesList();
  renderChangesPanel();
  updateHandoverBanner();
}

// ── Dashboard greeting + live clock ───────────────────────────
let dashClockTimer = null;
function renderDashboardClock() {
  const greetEl = document.getElementById('dashGreetText');
  const timeEl = document.getElementById('dashClockTime');
  const dateEl = document.getElementById('dashClockDate');
  if (!greetEl || !timeEl || !dateEl) return;
  const lang = getCurrentLang() === 'ar' ? 'ar-EG' : 'en-GB';
  const tick = () => {
    const now = new Date();
    const h = now.getHours();
    const key = h < 12 ? 'app.greet.morning' : (h < 18 ? 'app.greet.afternoon' : 'app.greet.evening');
    greetEl.textContent = t(key, { name: me()?.name || '' }).replace(/[,،]\s*$/, '');
    timeEl.textContent = now.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    dateEl.textContent = now.toLocaleDateString(lang, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  };
  tick();
  if (!dashClockTimer) dashClockTimer = setInterval(tick, 1000);
}

function renderCharts() {
  if (typeof Chart !== 'undefined') {
    Chart.defaults.font.family = getCurrentLang() === 'ar' ? "'Cairo', system-ui, sans-serif" : "'Outfit', system-ui, sans-serif";
  }
  renderStatusDonut();
  renderCatBars();
  renderExpiryTimeline();
}

// ── Equipment / All pages ──────────────────────────────────────
function renderEquipmentPage() {
  renderCatTabs();
  renderItemsGrid(S.items.filter(i => i.category === S.currentCat), 'equipmentList');
  const titleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = t('app.nav_title.equipment', { cat: catLabel(S.currentCat) });
}

function renderCatTabs() {
  const container = document.getElementById('catTabs');
  if (!container) return;
  container.innerHTML = Object.entries(CATEGORIES).map(([key, cat]) => `
    <button class="cat-tab${S.currentCat === key ? ' active' : ''}" data-cat="${key}" onclick="App.selectCat('${key}')">
      ${icon(cat.icon)} ${catLabel(key)}
    </button>`).join('');
}

function renderAllPage() {
  let filtered = [...S.items];
  if (S.filterCat) filtered = filtered.filter(i => i.category === S.filterCat);
  if (S.filterExpiry) filtered = filtered.filter(i => expiryStatus(earliestExpiry(i)) === S.filterExpiry);
  if (S.searchTerm) filtered = applySearch(filtered, S.searchTerm);
  renderItemsGrid(filtered, 'allList');
}

function renderItemsGrid(items, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  _itemRenderStates.delete(containerId);
  if (!S.stationId) {
    el.className = `items-grid${containerId === 'equipmentList' ? ' is-empty' : ''}`;
    el.innerHTML = emptyState(icon('ambulance'), t('app.empty.no_unit'));
    return;
  }
  const groups = groupRows(items);
  if (!groups.length) {
    el.className = `items-grid${containerId === 'equipmentList' ? ' is-empty' : ''}`;
    el.innerHTML = emptyState(icon('package'), t('app.empty.no_equipment'));
    return;
  }
  const state = { groups, snapshot: snapshotItems(), shown: 0, view: S.view };
  _itemRenderStates.set(containerId, state);
  if (S.view === 'list') {
    el.className = 'inventory-list';
    el.innerHTML = `<div class="inv-list">${renderInventoryListHeader(groups)}<div class="inventory-load-more-content"></div></div>`;
  } else {
    el.className = 'items-grid';
    el.innerHTML = '';
  }
  loadNextInventoryBatch(containerId);
}

function renderInventoryListHeader(groups) {
  const totalUnits = groups.reduce((s, g) => s + (g.quantity || 0), 0);
  let expiring = 0, expired = 0;
  groups.forEach(g => {
    const s = expiryStatus(earliestExpiry(g));
    if (s === 'expired') expired++;
    else if (s === 'warning') expiring++;
  });

  const summary = `
    <div class="inv-l-summary">
      <span class="inv-sum-chip">${icon('package')} <strong>${groups.length}</strong> ${t('ui.table.items')}</span>
      <span class="inv-sum-chip">${icon('bag')} <strong>${totalUnits}</strong> ${t('ui.table.units')}</span>
      ${expiring ? `<span class="inv-sum-chip warn">${icon('clock')} <strong>${expiring}</strong> ${t('ui.table.expiring')}</span>` : ''}
      ${expired ? `<span class="inv-sum-chip danger">${icon('alert')} <strong>${expired}</strong> ${t('ui.table.expired')}</span>` : ''}
    </div>
    <div class="inv-l-head">
      <span></span>
      <span>${t('ui.table.name')}</span>
      <span>${t('ui.batch.lot')} / ${t('ui.batch.expiry')}</span>
      <span></span>
      <span>${t('ui.table.status')} &amp; ${t('ui.batch.qty')}</span>
      <span></span>
    </div>`;

  return summary;
}

function loadNextInventoryBatch(containerId) {
  const state = _itemRenderStates.get(containerId);
  const el = document.getElementById(containerId);
  if (!state || !el) return;
  el.querySelector('.inventory-load-more')?.remove();

  const next = state.groups.slice(state.shown, state.shown + ITEM_RENDER_BATCH_SIZE);
  if (!next.length) return;
  const html = state.view === 'list'
    ? next.map((group) => renderItemRow(group, state.snapshot)).join('')
    : next.map((group) => renderItemCard(group, state.snapshot)).join('');
  const target = state.view === 'list' ? el.querySelector('.inventory-load-more-content') : el;
  target?.insertAdjacentHTML('beforeend', html);
  state.shown += next.length;

  if (state.shown < state.groups.length) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'inventory-load-more';
    button.innerHTML = `${esc(t('sup.btn.load_more'))} <span>${state.shown} / ${state.groups.length}</span>`;
    button.addEventListener('click', () => loadNextInventoryBatch(containerId), { once: true });
    (state.view === 'list' ? el.querySelector('.inv-list') : el)?.appendChild(button);
  }
}

// ── View toggle (Cards ⇄ List, persisted) ──────────────────────
function syncViewToggle() {
  document.querySelectorAll('.view-toggle').forEach(tg => {
    tg.querySelectorAll('.view-btn').forEach(btn => {
      const on = btn.dataset.view === S.view;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.title = btn.dataset.view === 'cards' ? t('app.view.cards') : t('app.view.list');
    });
  });
}

function setView(view) {
  if (view !== 'cards' && view !== 'list') return;
  S.view = view;
  try { localStorage.setItem('aems_view', view); } catch { /* private mode */ }
  syncViewToggle();
  if (S.ready) renderAll();
}

function applySearch(items, term) {
  const q = term.toLowerCase();
  return items.filter(i =>
    i.name.toLowerCase().includes(q) ||
    (i.location || '').toLowerCase().includes(q) ||
    (i.batchNumber || '').toLowerCase().includes(q) ||
    (i.serial || '').toLowerCase().includes(q) ||
    (i.storeCode || '').toLowerCase().includes(q) ||
    (i.notes || '').toLowerCase().includes(q)
  );
}

// ── History (audit log) ────────────────────────────────────────
const AUDIT_STYLE = {
  INSPECTION: { key: 'ui.audit.inspection', color: 'var(--success)' },
  INSPECTION_DRAFT: { key: 'ui.audit.insp_draft', color: '#64748B' },
  INSPECTION_DRAFT_UPDATE: { key: 'ui.audit.insp_draft_update', color: '#64748B' },
  INSPECTION_DRAFT_DELETE: { key: 'ui.audit.insp_draft_delete', color: 'var(--danger)' },
  INSPECTION_COMPLETE: { key: 'ui.audit.insp_complete', color: 'var(--success)' },
  INSPECTION_ACKNOWLEDGE: { key: 'ui.audit.insp_ack', color: '#0D9488' },
  INSPECTION_VOID: { key: 'ui.audit.insp_void', color: 'var(--danger)' },
  USE_MEDICINE: { key: 'ui.audit.use', color: 'var(--warning)' },
  RESTOCK: { key: 'ui.audit.restock', color: 'var(--info)' },
  ADJUST: { key: 'ui.audit.adjust', color: '#7C3AED' },
  INVENTORY_TRANSFER: { key: 'ui.audit.transfer', color: '#2563EB' },
  CREATE_SHIFT_NOTE: { key: 'ui.audit.note', color: '#2563EB' },
  DELETE_SHIFT_NOTE: { key: 'ui.audit.note_deleted', color: 'var(--danger)' },
  SUBMIT_HANDOVER: { key: 'ui.audit.handover', color: '#D97706' },
  ACKNOWLEDGE_HANDOVER: { key: 'ui.audit.ack', color: '#0D9488' },
  CREATE_REPORT: { key: 'ui.audit.report', color: '#0D9488' },
  CREATE_SUPPLY_REQUEST: { key: 'ui.audit.supply_create', color: '#0D9488' },
  APPROVE_SUPPLY_REQUEST: { key: 'ui.audit.supply_approve', color: '#2563EB' },
  REJECT_SUPPLY_REQUEST: { key: 'ui.audit.supply_reject', color: 'var(--danger)' },
  FULFIL_SUPPLY_REQUEST: { key: 'ui.audit.supply_fulfil', color: 'var(--success)' },
  CANCEL_SUPPLY_REQUEST: { key: 'ui.audit.supply_cancel', color: '#64748B' },
  DISTRIBUTE_STOCK: { key: 'ui.audit.distribution', color: '#10B981' },
  DELETE_MEDICINE: { key: 'ui.audit.delete_medicine', color: 'var(--danger)' },
  CREATE_MEDICINE: { key: 'ui.audit.medicine_added', color: 'var(--success)' },
  UPDATE_MEDICINE: { key: 'ui.audit.medicine_updated', color: 'var(--info)' },
  CREATE_BATCH: { key: 'ui.audit.batch_added', color: 'var(--success)' },
  DELETE_STOCK: { key: 'ui.audit.delete_lot', color: 'var(--danger)' },
  LOGIN: { key: 'ui.audit.login', color: '#64748B' },
};

const PRIORITY_LBL = { HIGH: 'modal.note.prio.high', MEDIUM: 'modal.note.prio.med', LOW: 'modal.note.prio.low' };

function auditDetails(log) {
  const m = log.metadata || {};
  const name = m.medicineName || m.name || m.title || m.itemName || '';
  switch (log.action) {
    case 'USE_MEDICINE': return t('ui.audit.use_d', { name: name || t('ui.medicine'), qty: m.quantity ?? '' });
    case 'RESTOCK': return t('ui.audit.restock_d', { name: name || t('ui.item'), qty: m.quantity ?? '', batch: m.batchNumber ? ` (${m.batchNumber})` : '' });
    case 'ADJUST': return t('ui.audit.adjust_d', { name: name || t('ui.item'), to: m.to ?? m.newQuantity ?? '' });
    case 'INSPECTION': {
      let s = t('ui.audit.inspect_d', { n: m.itemCount ?? '' });
      if (m.corrections?.length) s += t('ui.audit.corrected_d', { n: m.corrections.length });
      return s.trim();
    }
    case 'INSPECTION_DRAFT': return t('ui.audit.insp_draft_d', { n: m.itemCount ?? 0 });
    case 'INSPECTION_DRAFT_UPDATE': return t('ui.audit.insp_draft_update_d', { n: m.itemCount ?? 0 });
    case 'INSPECTION_DRAFT_DELETE': return m.title || '';
    case 'INSPECTION_COMPLETE': {
      const total = m.itemCount ?? ((m.checkedCount ?? 0) + (m.notCheckedCount ?? 0));
      const corr = m.corrections?.length ?? 0;
      let s = t('ui.audit.insp_complete_d', { checked: m.checkedCount ?? 0, total });
      if (corr) s += t('ui.audit.corrected_d', { n: corr });
      return s.trim();
    }
    case 'INSPECTION_ACKNOWLEDGE': return m.reviewNotes || m.title || t('ui.audit.insp_ack_d');
    case 'INSPECTION_VOID': return m.voidReason || '';
    case 'CREATE_SHIFT_NOTE': return t('ui.audit.note_d', { name: name || t('ui.note'), priority: t(PRIORITY_LBL[(m.priority || 'medium').toUpperCase()]) || m.priority });
    case 'DELETE_SHIFT_NOTE': return `${name || t('ui.note')}`;
    case 'SUBMIT_HANDOVER': return t('ui.audit.ho_d', { outgoing: m.outgoingName || '', status: m.equipStatus || '' });
    case 'ACKNOWLEDGE_HANDOVER': return `${m.incomingName || ''}`;
    case 'CREATE_REPORT': return `${m.title || t('ui.report')}`;
    case 'CREATE_SUPPLY_REQUEST': return t('ui.audit.supply_create_d', { name: name || t('ui.item'), qty: m.quantity ?? '' });
    case 'APPROVE_SUPPLY_REQUEST': return t('ui.audit.supply_approve_d', { name: name || t('ui.item'), qty: m.quantity ?? '' });
    case 'REJECT_SUPPLY_REQUEST': return t('ui.audit.supply_reject_d', { name: name || t('ui.item'), qty: m.quantity ?? '' });
    case 'FULFIL_SUPPLY_REQUEST': return t('ui.audit.supply_fulfil_d', { name: name || t('ui.item'), qty: m.quantity ?? '' });
    case 'CANCEL_SUPPLY_REQUEST': return t('ui.audit.supply_cancel_d', { name: name || t('ui.item'), qty: m.quantity ?? '' });
    case 'DISTRIBUTE_STOCK': return t('ui.audit.distribution_d', { template: m.templateName || '', units: m.units ?? m.items ?? '' });
    case 'DELETE_MEDICINE': return t('ui.audit.delete_medicine_d', { name: name || t('ui.medicine'), batches: m.batches ?? '', stock: m.totalUnits ?? '' });
    case 'DELETE_STOCK': return t('ui.audit.delete_lot_d', { name: name || t('ui.item'), lot: m.batchNumber || '', qty: m.quantity ?? '' });
    case 'CREATE_MEDICINE': return name;
    case 'UPDATE_MEDICINE': return name;
    case 'CREATE_BATCH': return `${name}${m.batchNumber ? ` — ${m.batchNumber}` : ''}`.trim();
    case 'LOGIN': return t('ui.audit.login_d');
    default: return '';
  }
}

/** Small detail "chips" under the main line — the fields actually filled in. */
function auditChips(log) {
  const m = log.metadata || {};
  const chips = [];
  const add = (text) => { if (text) chips.push(esc(String(text))); };
  const d = (v) => (v == null || v === '' ? null : v);
  switch (log.action) {
    case 'CREATE_MEDICINE':
      add(d(m.category));
      add(d(m.strength && m.dosageForm ? `${m.strength} ${m.dosageForm}` : m.strength || m.dosageForm));
      add(d(m.size));
      add(d(m.barcode ? `${t('ui.pill.batch', { no: '' }).replace(/:?\s*$/, '')}: ${m.barcode}` : ''));
      add(d(m.location ? `${t('ui.pill.location')} ${m.location}` : ''));
      if (d(m.notes)) add(m.notes);
      break;
    case 'UPDATE_MEDICINE':
      for (const [field, diff] of Object.entries(m.changed || {})) {
        add(t('ui.audit.field_changed', { field, from: fmtVal(diff.from), to: fmtVal(diff.to) }));
      }
      break;
    case 'CREATE_BATCH':
      add(d(m.batchNumber));
      add(d(m.expiryDate ? `${t('ui.pill.expiry')} ${fmtDate(m.expiryDate)}` : ''));
      add(d(m.supplier ? `${t('ui.pill.supplier')} ${m.supplier}` : ''));
      add(d(m.receivedDate ? `${t('ui.pill.received')} ${fmtDate(m.receivedDate)}` : ''));
      break;
    case 'DELETE_MEDICINE':
      if (m.stockRows !== undefined) add(`${m.stockRows} stock rows`);
      if (m.totalUnits !== undefined) add(`${m.totalUnits} units`);
      if (m.expiredUnits) add(`${m.expiredUnits} expired`);
      if (m.affectedAmbulances) add(`${m.affectedAmbulances} ambulances`);
      break;
    case 'RESTOCK':
      add(d(m.batchNumber));
      if (m.quantity !== undefined) add(`+${m.quantity}`);
      add(d(m.reason));
      break;
    case 'USE_MEDICINE':
      if (m.quantity !== undefined) add(`−${m.quantity}`);
      add(d(m.reason));
      break;
    case 'ADJUST_INVENTORY':
    case 'ADJUST':
      if (m.field) add(t('ui.audit.field_changed', { field: m.field, from: fmtVal(m.from), to: fmtVal(m.to) }));
      else if (m.from !== undefined && m.to !== undefined) add(`${fmtVal(m.from)} → ${fmtVal(m.to)}`);
      add(d(m.reason));
      break;
    case 'INSPECTION':
      if (m.corrections?.length) add(`${m.corrections.length} corrected`);
      break;
  }
  return chips;
}

function fmtVal(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Inspection audit entries render as TWO separate documents:
 *   1. Inspection report — what the crew found (conditions, not-checked).
 *   2. Adjustments applied — the reason-coded stock changes.
 * They answer different questions, so they are never mixed in one table.
 */
function inspectionAuditTable(log) {
  const m = log.metadata || {};
  if (!['INSPECTION', 'INSPECTION_COMPLETE', 'INSPECTION_VOID'].includes(log.action)) return '';
  const corrections = Array.isArray(m.corrections) ? m.corrections : [];
  const notChecked = Array.isArray(m.notChecked) ? m.notChecked : [];
  const cond = m.conditions && typeof m.conditions === 'object' ? m.conditions : {};
  const condKeys = ['missing', 'damaged', 'expired', 'unusable', 'extra'].filter((k) => Array.isArray(cond[k]) && cond[k].length);
  const notCheckedHtml = notChecked.length
    ? `<div class="rpt-line"><span class="rpt-tag nc">${esc(t('ui.audit.not_checked'))}</span> ${esc(notChecked.join(', '))}</div>`
    : '';

  // 1 ▸ Inspection report — findings only, no quantities changed.
  let inspBlock = '';
  if (condKeys.length || notCheckedHtml) {
    inspBlock = `<div class="rpt-block rpt-inspection">
      <div class="rpt-head">${icon('search')} ${esc(t('ui.report.inspection'))}</div>
      ${condKeys.map((k) => `<div class="rpt-line"><span class="rpt-tag ${k}">${esc(t('ui.report.cond_' + k))}</span> ${esc(cond[k].join(', '))}</div>`).join('')}
      ${notCheckedHtml}
    </div>`;
  }

  // 2 ▸ Adjustments applied — the reason-coded stock corrections.
  let adjBlock = '';
  if (corrections.length) {
    const rows = corrections.map((c) => {
      const diff = c.difference ?? ((c.to ?? 0) - (c.from ?? 0));
      const cls = diff < 0 ? 'color:var(--danger);font-weight:700;' : (diff > 0 ? 'color:var(--success);font-weight:700;' : '');
      const sign = diff > 0 ? `+${diff}` : `${diff}`;
      const lines = Array.isArray(c.lines) ? c.lines.filter((l) => l && l.code) : [];
      const reasonCell = lines.length
        ? lines.map((l) => `${esc(reasonLabelFor(l.code))} <span style="color:var(--text-muted);">×${esc(fmtVal(l.quantity))}</span>`).join('<br>')
        : (c.reason ? esc(reasonLabelFor(c.reason)) : '—');
      return `<tr>
        <td>${esc(c.name || c.inventoryId || '—')}</td>
        <td style="text-align:center;">${esc(fmtVal(c.from))}</td>
        <td style="text-align:center;">${esc(fmtVal(c.to))}</td>
        <td style="text-align:center;${cls}">${esc(sign)}</td>
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

function renderAuditEvent(log) {
  const style = AUDIT_STYLE[log.action] || { key: null, color: '#999' };
  const when = fmtDateTime(log.createdAt);
  const who = log.user?.displayName || 'System';
  const station = log.station ? `<span>${icon('building')} ${esc(unitLabel(log.station.code, log.station.name))}</span>` : '';
  const vehicle = log.ambulance?.vehicleNumber ? `<span>${icon('ambulance')} ${esc(log.ambulance.vehicleNumber)}</span>` : '';
  const details = auditDetails(log);
  const label = style.key ? t(style.key) : log.action;
  return `
    <div class="history-item">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="background:${style.color};color:white;padding:2px 10px;border-radius:20px;font-size:0.72rem;font-weight:700;">${label}</span>
          ${details ? `<span style="font-size:0.9rem;font-weight:600;">${esc(details)}</span>` : ''}
        </div>
        <span style="font-size:0.72rem;color:var(--text-muted);white-space:nowrap;">${when}</span>
      </div>
      <div style="font-size:0.78rem;color:var(--text-muted);display:flex;gap:14px;flex-wrap:wrap;">
        <span>${icon('user')} ${esc(who)}</span>${station}${vehicle}
      </div>
      ${
        (() => {
          const chips = auditChips(log);
          return chips.length
            ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">${chips.map(c => `<span style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);padding:2px 8px;border-radius:6px;font-size:.68rem;color:var(--text-muted);">${c}</span>`).join('')}</div>`
            : '';
        })()
      }
      ${inspectionAuditTable(log)}
    </div>`;
}

function renderHistoryPage() {
  const el = document.getElementById('historyList');
  if (!el) return;
  el.innerHTML = S.history.length
    ? S.history.slice(0, 80).map(renderAuditEvent).join('')
    : emptyState(icon('clipboard'), t('app.empty.no_history'));
}

// ── Handover page ──────────────────────────────────────────────
function renderHandoverPage() {
  const el = document.getElementById('page-handover');
  if (!el) return;
  const pending = S.handovers.find(h => h.status === 'submitted');
  const station = getStation();
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:18px;">
      <div>
        <div style="font-size:1.2rem;font-weight:800;">${icon('repeat')} ${t('handover.page.hero_title')}</div>
        <div style="font-size:.8rem;color:var(--text-muted);margin-top:2px;">${t('handover.page.hero_sub')}</div>
      </div>
    </div>
    ${pending ? _renderPendingAck(pending) : _renderOutgoingForm(station)}
    <div class="card" style="margin-top:16px;">
      <div class="card-body">
        <div class="section-header" style="margin-bottom:14px;">
          <div class="section-title">${icon('fileText')} ${t('handover.history.head')}</div>
          <span style="font-size:.78rem;color:var(--text-muted);">${t('handover.history.sub')}</span>
        </div>
        <div id="handover-history-list">${_renderHandoverHistory()}</div>
      </div>
    </div>`;
}

function _renderPendingAck(h) {
  const when = h.createdAt ? fmtDateTime(h.createdAt) : '—';
  const eqKey = { 'All OK': 'handover.eq.all_ok', 'Issues Noted': 'handover.eq.noted', 'Critical Items Missing': 'handover.eq.critical' }[h.outgoing?.equipStatus] || '';
  const sc = { 'All OK': '#059669', 'Issues Noted': '#D97706', 'Critical Items Missing': '#DC2626' }[h.outgoing?.equipStatus] || '#64748B';
  const eqLabel = eqKey ? t(eqKey) : h.outgoing?.equipStatus || '—';
  const station = getStation();
  return `
  <div class="ho-pending-card">
    <div class="ho-pending-head">
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="ho-pulse-dot"></div>
        <div>
          <div style="font-weight:800;font-size:1rem;color:#FDE68A;">${icon('clock')} ${t('handover.pending.head')}</div>
          <div style="font-size:.8rem;color:#FDBA74;margin-top:2px;"> ${t('handover.pending.submitted')} ${when}</div>
        </div>
      </div>
      <span class="ho-equip-badge" style="background:${sc}18;color:${sc};border:1px solid ${sc}30;">${esc(eqLabel)}</span>
    </div>
    <div class="ho-info-grid">
      <div class="ho-info-cell">
        <div class="ho-info-label">${icon('user')} ${t('handover.pending.outgoing')}</div>
        <div class="ho-info-val">${esc(h.outgoing?.paramedicName || '—')}</div>
        <div class="ho-info-sub">ID: ${esc(h.outgoing?.paramedicId || '—')} · Shift: ${esc(h.outgoing?.shiftType || '—')}</div>
      </div>
      <div class="ho-info-cell">
        <div class="ho-info-label">${icon('users')} ${t('handover.pending.patients')}</div>
        <div class="ho-info-val">${h.outgoing?.patientsCount ?? '—'}</div>
        <div class="ho-info-sub">${t('handover.pending.responses')}</div>
      </div>
    </div>
    ${h.outgoing?.pendingIssues ? `
    <div class="ho-section-block ho-block-warn">
      <div class="ho-block-title" style="color:#F59E0B;">${icon('alert')} ${t('handover.pending.issues_head')}</div>
      <div class="ho-block-body">${esc(h.outgoing.pendingIssues)}</div>
    </div>` : ''}
    ${h.outgoing?.medicationsUsed ? `
    <div class="ho-section-block">
      <div class="ho-block-title">${icon('pill')} ${t('handover.pending.meds_head')}</div>
      <div class="ho-block-body">${esc(h.outgoing.medicationsUsed)}</div>
    </div>` : ''}
    ${h.outgoing?.notes ? `
    <div class="ho-section-block">
      <div class="ho-block-title">${icon('fileText')} ${t('handover.pending.summary_head')}</div>
      <div class="ho-block-body">${esc(h.outgoing.notes)}</div>
    </div>` : ''}
    <div class="ho-ack-form">
      <div style="font-size:.9rem;font-weight:700;margin-bottom:14px;color:var(--text);">${icon('checkCircle')} ${t('handover.pending.ack_head')}</div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${icon('user')} ${t('handover.pending.your_name')}</label>
          <input type="text" class="form-control" id="ack-name" value="${esc(station.paramedicName || '')}" placeholder="${t('handover.pending.name_ph')}">
        </div>
        <div class="form-group">
          <label class="form-label">${icon('idCard')} ${t('handover.pending.staff_id')}</label>
          <input type="text" class="form-control" id="ack-id" value="${esc(station.paramedicId || '')}" placeholder="${t('handover.pending.id_ph')}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${icon('fileText')} ${t('handover.pending.remarks')}</label>
        <textarea class="form-control" id="ack-notes" rows="2" placeholder="${t('handover.pending.remarks_ph')}"></textarea>
      </div>
      <div style="display:flex;gap:10px;margin-top:4px;">
        <button class="btn btn-success btn-lg" onclick="App.acknowledgeHandoverForm('${h.id}')">
          ${icon('checkCircle')} ${t('handover.pending.ack_btn')}
        </button>
      </div>
    </div>
  </div>`;
}

function _renderOutgoingForm(station) {
  return `
  <div class="card">
    <div class="card-body">
      <div class="section-header" style="margin-bottom:18px;">
        <div class="section-title">${icon('send')} ${t('handover.form.head')}</div>
        <span style="font-size:.78rem;color:var(--text-muted);">${t('handover.form.sub')}</span>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${icon('user')} ${t('handover.form.your_name')}</label>
          <input type="text" class="form-control" id="ho-name" value="${esc(station.paramedicName || '')}" placeholder="${t('handover.form.name_ph')}">
        </div>
        <div class="form-group">
          <label class="form-label">${icon('idCard')} ${t('handover.form.staff_id')}</label>
          <input type="text" class="form-control" id="ho-id" value="${esc(station.paramedicId || '')}" placeholder="${t('handover.form.id_ph')}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${icon('clock')} ${t('handover.form.shift_type')}</label>
          <select class="form-control" id="ho-shift">
            <option value="">—</option>
            ${SHIFT_IDS.map((c) => `<option value="${c}"${String(station.shiftType || '').startsWith(c) ? ' selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">${icon('users')} ${t('handover.form.patients')}</label>
          <input type="number" class="form-control" id="ho-patients" min="0" value="0">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${icon('building')} ${t('handover.form.equip_status')}</label>
        <select class="form-control" id="ho-equip-status">
          <option value="All OK"> ${t('handover.form.status_ok')}</option>
          <option value="Issues Noted"> ${t('handover.form.status_noted')}</option>
          <option value="Critical Items Missing"> ${t('handover.form.status_critical')}</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${icon('alert')} ${t('handover.form.pending_issues')}</label>
        <textarea class="form-control" id="ho-issues" rows="3" placeholder="${t('handover.form.issues_ph')}"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">${icon('pill')} ${t('handover.form.meds')}</label>
        <textarea class="form-control" id="ho-meds" rows="3" placeholder="${t('handover.form.meds_ph')}"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">${icon('fileText')} ${t('handover.form.summary')}</label>
        <textarea class="form-control" id="ho-notes" rows="3" placeholder="${t('handover.form.summary_ph')}"></textarea>
      </div>
      <div style="display:flex;align-items:center;gap:14px;margin-top:8px;padding-top:16px;border-top:1px solid var(--border);">
        <button class="btn btn-primary btn-lg" onclick="App.submitHandover()">${icon('send')} ${t('handover.form.submit')}</button>
        <button class="btn btn-ghost btn-lg" onclick="App.cancelHandoverForm()">${t('handover.form.cancel')}</button>
        <span style="font-size:.78rem;color:var(--text-muted);">${t('handover.form.sub_hint')}</span>
      </div>
    </div>
  </div>`;
}

function _renderHandoverHistory() {
  if (!S.handovers.length) {
    return `<div style="text-align:center;color:var(--text-muted);font-size:.88rem;padding:20px 0;">${t('handover.history.empty')}</div>`;
  }
  const eqKey = s => ({ 'All OK': 'handover.eq.all_ok', 'Issues Noted': 'handover.eq.noted', 'Critical Items Missing': 'handover.eq.critical' }[s] || '');
  return S.handovers.map(h => {
    const when = h.createdAt ? fmtDateTime(h.createdAt) : '—';
    const isPending = h.status === 'submitted';
    const ackWhen = h.acknowledgedAt ? fmtDateTime(h.acknowledgedAt) : null;
    const eqColor = { 'All OK': '#059669', 'Issues Noted': '#D97706', 'Critical Items Missing': '#DC2626' }[h.outgoing?.equipStatus] || '#64748B';
    const equKey = eqKey(h.outgoing?.equipStatus);
    const eqTxt = equKey ? t(equKey) : (h.outgoing?.equipStatus || '');
    return `
    <div class="ho-history-row">
      <div class="ho-history-icon ${isPending ? 'ho-icon-pending' : 'ho-icon-done'}">${icon(isPending ? 'clock' : 'check')}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:.9rem;">
          ${esc(h.outgoing?.paramedicName || '—')}
          <span style="color:var(--text-muted);font-weight:400;"> → </span>
          ${h.incoming?.paramedicName ? esc(h.incoming.paramedicName) : (isPending ? `<em style="color:#D97706;">${t('handover.history.awaiting')}</em>` : '—')}
        </div>
        <div style="font-size:.75rem;color:var(--text-muted);margin-top:2px;">
          ${when} · ${esc(h.outgoing?.shiftType || t('handover.history.shift'))}
          ${ackWhen ? ` · ${t('handover.history.ack')} ${ackWhen}` : ''}
        </div>
        ${eqTxt ? `<div style="font-size:.75rem;margin-top:3px;color:${eqColor}">${esc(eqTxt)}</div>` : ''}
      </div>
      <span class="badge ${isPending ? 'badge-warning' : 'badge-success'}">${isPending ? t('handover.status.pending') : t('handover.status.complete')}</span>
    </div>`;
  }).join('');
}

// ── Navigation / selection ─────────────────────────────────────
function navigateTo(page, cat) {
  S.currentPage = page;
  if (cat) S.currentCat = cat;
  if (page !== 'equipment') {
    _itemRenderStates.delete('equipmentList');
    const list = document.getElementById('equipmentList');
    if (list) list.innerHTML = '';
  }
  if (page !== 'all') {
    _itemRenderStates.delete('allList');
    const list = document.getElementById('allList');
    if (list) list.innerHTML = '';
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(`page-${page}`);
  if (el) el.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navEl = page === 'equipment'
    ? [...document.querySelectorAll('.nav-item[data-page="equipment"]')].find((item) => item.dataset.category === S.currentCat)
    : document.querySelector(`.nav-item[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');
  const titles = {
    dashboard: t('app.nav_title.dashboard'),
    equipment: t('app.nav_title.equipment', { cat: catLabel(S.currentCat) }),
    all: t('app.nav_title.all'),
    history: t('app.nav_title.history'),
    settings: t('app.nav_title.settings'),
    handover: t('app.nav_title.handover'),
    supply: t('app.nav_title.supply'),
  };
  const titleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = titles[page] || '';
  if (page === 'equipment') renderEquipmentPage();
  if (page === 'all') renderAllPage();
  if (page === 'history') renderHistoryPage();
  if (page === 'dashboard') renderDashboard();
  if (page === 'handover') renderHandoverPage();
  if (page === 'supply') renderSupplyPage();
  if (page === 'settings') renderDutyCalendar();
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebarOverlay')?.classList.remove('open');
}

// ── User / station UI ──────────────────────────────────────────
function updateUserUI() {
  const el = document.getElementById('userInfo');
  if (!el || !S.user) return;
  const u = S.user;
  const logoutLabel = t('app.user.logout');
  el.innerHTML = `
    <div class="user-name">${esc(u.displayName || t('app.user.paramedic'))}</div>
    <div class="user-email">${esc(u.email || '')}</div>
    <button class="btn-logout" type="button" onclick="App.logout()" title="${esc(logoutLabel)}" aria-label="${esc(logoutLabel)}">${icon('logout')}<span class="btn-logout-text">${esc(logoutLabel)}</span></button>`;
}

function updateSidebar() {
  const u = S.user;
  const unit = S.activeUnit || (u?.station?.id ? u.station : null);
  const stName = unit ? unitLabel(unit.code, unit.name) : '-';
  const callSign = unit?.code || u?.station?.code || '-';
  S.stationId = unit?.id || u?.station?.id || null;
  S.stationName = stName;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  document.getElementById('sidebarStationName').textContent = stName;
  document.getElementById('sidebarCallSign').textContent = callSign;
  updateSettingsUnit();
  updateDutyChip();
  updateSupplyNavBadge();
}

/** Fills the settings-page unit card: badge, label, roster note, car picker. */
function updateSettingsUnit() {
  const badge = document.getElementById('settingsUnitCode');
  if (!badge) return;
  const unit = currentUnit();
  badge.textContent = unit?.code || '—';
  const nameEl = document.getElementById('settingsUnitName');
  if (nameEl) nameEl.textContent = unit ? unitLabel(unit.code, unit.name) : t('app.settings.unit_none');
  const n = S.dutyRoster.length;
  const sub = document.getElementById('settingsUnitSub');
  if (sub) sub.textContent = n > 1 ? t('app.settings.unit_roster', { n }) : t('app.settings.unit_solo');
  const btn = document.getElementById('settingsUnitChange');
  if (btn) btn.disabled = n === 0;

  const wrap = document.getElementById('settingsCarsWrap');
  const sel = document.getElementById('s-car');
  if (wrap && sel) {
    const cars = S.ambulances || [];
    if (!cars.length) {
      wrap.style.display = 'none';
    } else {
      wrap.style.display = '';
      sel.innerHTML = cars.map((a) => {
        const label = a.vehicleNumber || a.id;
        const oos = a.status && a.status !== 'ACTIVE' ? ` — ${a.status}` : '';
        return `<option value="${esc(a.id)}" ${a.id === S.activeAmbulanceId ? 'selected' : ''}>${esc(label + oos)}</option>`;
      }).join('');
      if (!sel.dataset.wired) {
        sel.dataset.wired = '1';
        sel.addEventListener('change', onCarPicked);
      }
    }
  }
}

/** Local pick of the car inside the active unit (equipment/inspections follow it). */
function pickActiveCar() {
  const saved = localStorage.getItem('aems_car_pick');
  S.activeAmbulanceId = S.ambulances.find(a => a.id === saved)?.id
    || S.ambulances.find(a => a.status === 'ACTIVE')?.id
    || S.ambulances[0]?.id
    || null;
}

async function onCarPicked() {
  const sel = document.getElementById('s-car');
  if (!sel) return;
  S.activeAmbulanceId = sel.value || null;
  if (S.activeAmbulanceId) localStorage.setItem('aems_car_pick', S.activeAmbulanceId);
  else localStorage.removeItem('aems_car_pick');
  toast(t('app.settings.car_picked', { v: sel.selectedOptions[0]?.text || '' }), 'success');
  await loadAll();
  renderAll();
}

// ── Duty unit switching (unlimited, reason required, audited) ──
function currentUnit() {
  if (S.activeUnit) return S.activeUnit;
  return S.dutyRoster.find(s => s.id === S.stationId)
    || (S.user?.station?.id === S.stationId ? S.user.station : null)
    || null;
}

function updateDutyChip() {
  const el = document.getElementById('dutyUnitBtn');
  if (!el) return;
  const unit = currentUnit();
  el.innerHTML = `${icon('ambulance')}<span>${unit ? t('app.duty.chip', { v: unit.code }) : t('app.duty.no_unit')}</span>`;
  el.classList.toggle('unpicked', !unit);
}

function openDutySwitchModal(force = false) {
  if (!S.dutyRoster.length) { toast(t('app.duty.empty'), 'error'); return; }
  S.dutyForce = !!force;
  window.AEMS_DUTY_FORCE = S.dutyForce;
  const list = document.getElementById('dutyUnitList');
  const activeId = currentUnit()?.id;
  list.innerHTML = S.dutyRoster.map(s => {
    const oos = s.status !== 'ACTIVE';
    return `
    <label class="duty-unit ${s.id === activeId ? 'active' : ''} ${oos ? 'disabled' : ''}">
      <input type="radio" name="dutyUnit" value="${esc(s.id)}" ${s.id === activeId ? 'checked' : ''} ${oos ? 'disabled' : ''}>
      <span class="duty-num">${esc(s.code)}</span>
      <span class="duty-station">${esc(unitLabel(s.code))}</span>
      ${oos ? `<span class="duty-oos">${t('app.duty.out_of_service')}</span>` : ''}
    </label>`;
  }).join('');
  const reason = document.getElementById('dutyReason');
  if (reason) reason.value = '';
  const sub = document.getElementById('dutyModalSub');
  if (sub) sub.textContent = force ? t('app.duty.pick_first') : t('app.duty.pick');
  const closeBtn = document.getElementById('dutyModalClose');
  if (closeBtn) closeBtn.style.display = force ? 'none' : '';
  const cancelBtn = document.getElementById('dutyModalCancel');
  if (cancelBtn) cancelBtn.style.display = force ? 'none' : '';
  openModal('modal-duty-switch');
}

/** Re-pulls the session after a switch: active unit, cars, roster, permissions. */
async function refreshSessionState() {
  const payload = await api.me();
  S.session = { ...S.session, ...payload };
  S.user = payload.user;
  S.permissions = payload.permissions || [];
  window.AEMS_PERMS = S.permissions;
  S.ambulances = payload.ambulances || [];
  S.dutyRoster = payload.dutyRoster || [];
  S.activeUnit = payload.user?.station ? { ...payload.user.station } : null;
  S.stationId = S.activeUnit?.id || null;
  S.stationName = S.activeUnit ? unitLabel(S.activeUnit.code, S.activeUnit.name) : '-';
  pickActiveCar();
  const cached = getSession();
  if (cached) setSession({ ...cached, ...payload });
}

async function confirmDutySwitch() {
  const sel = document.querySelector('input[name="dutyUnit"]:checked');
  if (!sel) { toast(t('app.duty.pick_one'), 'error'); return; }
  const reason = (document.getElementById('dutyReason')?.value || '').trim();
  if (reason.length < 2) { toast(t('app.duty.need_reason'), 'error'); return; }
  try {
    const data = await api.switchDutyUnit({ stationId: sel.value, reason });
    await refreshSessionState();
    const unit = data.active;
    S.dutyForce = false;
    window.AEMS_DUTY_FORCE = false;
    closeModal('modal-duty-switch');
    updateUserUI();
    updateSidebar();
    loadStationInfo();
    toast(t('app.duty.switched', { v: unit?.code || '' }));
    await loadAll();
    renderAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function shiftSelection() {
  const code = document.getElementById('s-shift')?.value || '';
  const period = document.getElementById('s-period')?.value || '';
  return {
    shiftCode: SHIFT_IDS.includes(code) ? code : '',
    shiftPeriod: SHIFT_PERIODS.includes(period) ? period : '',
  };
}

/** Writes the current shift pick into stored station info (preserves other keys). */
function persistShiftSelection() {
  let local = {};
  try { local = JSON.parse(localStorage.getItem('aems_station_info') || 'null') || {}; } catch { /* ignore */ }
  const { shiftCode, shiftPeriod } = shiftSelection();
  local.shiftCode = shiftCode;
  local.shiftPeriod = shiftPeriod;
  local.shiftType = shiftLabel(shiftCode, shiftPeriod);
  localStorage.setItem('aems_station_info', JSON.stringify(local));
}

function loadStationInfo() {
  let local = null;
  try { local = JSON.parse(localStorage.getItem('aems_station_info') || 'null'); } catch { /* ignore */ }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('settingsParamedicName', S.user?.displayName || '');
  set('settingsParamedicId', S.user?.empId || '');
  const savedCode = [local?.shiftCode, local?.shiftType, String(local?.shiftType || '').slice(0, 1)]
    .find((v) => SHIFT_IDS.includes(v)) || '';
  set('s-shift', savedCode);
  set('s-period', SHIFT_PERIODS.includes(local?.shiftPeriod) ? local.shiftPeriod : '');
  if (local?.paramedicName) set('settingsParamedicName', local.paramedicName);
  if (local?.paramedicId) set('settingsParamedicId', local.paramedicId);
  ['s-shift', 's-period'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el.dataset.autosave) { el.dataset.autosave = '1'; el.addEventListener('change', persistShiftSelection); }
  });
  updateSettingsUnit();
}

function getStation() {
  const shiftCode = document.getElementById('s-shift')?.value || '';
  const shiftPeriod = document.getElementById('s-period')?.value || '';
  return {
    stationName: S.stationName || '—',
    stationCallSign: S.activeUnit?.code || '—',
    paramedicName: document.getElementById('settingsParamedicName')?.value || S.user?.displayName || '—',
    paramedicId: document.getElementById('settingsParamedicId')?.value || S.user?.empId || '—',
    shiftType: shiftLabel(shiftCode, shiftPeriod),
    shiftPeriod,
  };
}

function saveStationInfoAction() {
  const info = getStation();
  const { shiftCode, shiftPeriod } = shiftSelection();
  localStorage.setItem('aems_station_info', JSON.stringify({
    paramedicName: info.paramedicName,
    paramedicId: info.paramedicId,
    shiftCode,
    shiftType: info.shiftType,
    shiftPeriod,
  }));
  const status = document.getElementById('settingsSaveStatus');
  if (status) {
    status.textContent = t('app.settings.saved_status');
    status.style.opacity = '1';
    setTimeout(() => { status.style.opacity = '0'; }, 2500);
  }
  toast(t('app.toast.settings_saved'));
}

// ── Add / Restock / Adjust ─────────────────────────────────────
function setAddMode(mode) {
  S.addMode = mode;
  document.getElementById('mode-new').classList.toggle('active', mode === 'new');
  document.getElementById('mode-restock').classList.toggle('active', mode === 'restock');
  document.getElementById('newFields').style.display = mode === 'new' ? 'block' : 'none';
  document.getElementById('restockFields').style.display = mode === 'restock' ? 'block' : 'none';
  document.getElementById('qtyGroup').style.display = mode === 'restock' ? 'block' : 'none';
  document.getElementById('reasonGroup').style.display = mode === 'restock' ? 'block' : 'none';
  const arc = document.getElementById('adjustReasonControl');
  if (arc) arc.style.display = 'none';
  if (mode === 'restock') prepareRestockSelector();
  refreshItemModalText();
}

async function openAddModal() {
  if (!requireAmbulance()) return;
  S.editMode = 'add';
  S.addMode = 'new';
  S.editInventoryId = null;
  S.editBatchId = null;
  S.editGroup = null;
  S.tempBatches = [];
  document.getElementById('modal-item-title').textContent = t('modal.item.add');
  document.getElementById('f-form').reset();
  // Clear any edit-mode leftovers so the Add form never shows a previous
  // medicine's batch/LOT dropdown (stale #adjustFields leaked from Edit).
  const adjustFields = document.getElementById('adjustFields');
  if (adjustFields) adjustFields.style.display = 'none';
  const batchEditSel = document.getElementById('f-batch-edit');
  if (batchEditSel) batchEditSel.innerHTML = '';
  const batchCurrent = document.getElementById('batchCurrentInfo');
  if (batchCurrent) batchCurrent.innerHTML = '';
  const nameHint = document.getElementById('nameMatchHint');
  if (nameHint) { nameHint.style.display = 'none'; nameHint.textContent = ''; }
  const cat = (S.filterCat || S.currentCat || '').toUpperCase();
  document.getElementById('f-cat').value = cat;
  document.getElementById('addModeToggle').style.display = 'flex';
  document.getElementById('reasonLabel').textContent = t('modal.reason.label');
  updateBatchesUI();
  setAddMode('new');
  openModal('modal-item');
}

// Re-translates the JS-painted labels/placeholders in the item modal
// (labels carrying data-i18n are handled by i18n.js itself).
function refreshItemModalText() {
  const title = document.getElementById('modal-item-title');
  const reasonLabel = document.getElementById('reasonLabel');
  const qtyLabel = document.getElementById('qtyLabel');
  const reason = document.getElementById('f-reason');
  const fMed = document.getElementById('f-medicine');
  const fBatch = document.getElementById('f-batch');
  const batchInfo = document.getElementById('batchInfo');
  if (title) {
    title.textContent = S.editMode === 'adjust'
      ? t('modal.item.adjust')
      : (S.addMode === 'restock' ? t('modal.item.restock') : t('modal.item.add'));
  }
  if (reasonLabel) reasonLabel.textContent = t('modal.reason.label');
  if (qtyLabel) qtyLabel.textContent = S.editMode === 'adjust' ? t('modal.qty.new') : t('modal.qty.total');
  if (reason) reason.placeholder = S.editMode === 'adjust' || S.addMode === 'restock'
    ? t('app.adjust.reason_ph') : '';
  if (fMed && fMed.options.length) fMed.options[0].textContent = t('app.restock.select_medicine');
  if (fBatch) {
    if (fBatch.options.length) fBatch.options[0].textContent = t('app.restock.select_batch');
    Array.from(fBatch.options).forEach(opt => {
      const exp = opt.dataset.exp;
      if (exp && opt !== fBatch.options[0]) {
        opt.textContent = `${opt.dataset.lot || opt.textContent.split(' — ')[0]} — ${t('app.restock.exp')} ${exp}`;
      }
    });
  }
  if (batchInfo && batchInfo.dataset.exp) {
    batchInfo.textContent = t('app.restock.batch_expiry', { date: batchInfo.dataset.exp });
  }
}

async function prepareRestockSelector() {
  const fMed = document.getElementById('f-medicine');
  const fBatch = document.getElementById('f-batch');
  if (!fMed) return;
  fBatch.innerHTML = `<option value="">${t('app.restock.select_batch')}</option>`;
  const batchInfo = document.getElementById('batchInfo');
  if (batchInfo) { batchInfo.textContent = ''; delete batchInfo.dataset.exp; }

  if (!S.medicines.length) {
    try {
      const d = await api.medicines({ pageSize: 200, includeInactive: false });
      S.medicines = d.medicines || [];
    } catch (err) { toast(err.message, 'error'); }
  }
  // Scope the medicine list to the category tab the user is on, so restocking
  // a Responder/Lifepak never surfaces unrelated meds (e.g. Panadol). If the
  // category has no matches (or we're on "All"), fall back to the full list.
  const cat = (S.filterCat || S.currentCat || '').toUpperCase();
  const scoped = cat ? S.medicines.filter(m => (m.category || '').toUpperCase() === cat) : S.medicines;
  const list = scoped.length ? scoped : S.medicines;
  fMed.innerHTML = `<option value="">${t('app.restock.select_medicine')}</option>` +
    list.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');

  fMed.onchange = async () => {
    fBatch.innerHTML = `<option value="">${t('app.restock.select_batch')}</option>`;
    const batchInfo = document.getElementById('batchInfo');
    if (batchInfo) { batchInfo.textContent = ''; delete batchInfo.dataset.exp; }
    const mid = fMed.value;
    if (!mid) return;
    try {
      const d = await api.batches({ medicineId: mid, activeOnly: true, pageSize: 200 });
      const bs = d.batches || [];
      fBatch.innerHTML = `<option value="">${t('app.restock.select_batch')}</option>` + bs.map(b =>
        `<option value="${b.id}" data-exp="${esc(b.expiryDate || '')}" data-lot="${esc(b.batchNumber || b.id.slice(0, 8))}">${esc(b.batchNumber || b.id.slice(0, 8))} — ${t('app.restock.exp')} ${esc(b.expiryDate || '—')}</option>`
      ).join('');
      fBatch.onchange = () => {
        const opt = fBatch.selectedOptions[0];
        const info = document.getElementById('batchInfo');
        if (info) {
          if (opt?.dataset.exp) {
            info.textContent = t('app.restock.batch_expiry', { date: opt.dataset.exp });
            info.dataset.exp = opt.dataset.exp;
          } else {
            info.textContent = '';
            delete info.dataset.exp;
          }
        }
      };
      if (!bs.length) toast(t('app.restock.no_batches'), 'error');
    } catch (err) { toast(err.message, 'error'); }
  };
}

function openEditModal(medicineId, preferInventoryId) {
  const group = findGroup(medicineId);
  if (!group) return;
  S.editMode = 'adjust';
  S.editGroup = group;
  S.editQtyAllowed = can('inventory:adjust');
  S.editExpiryAllowed = can('inventory:update-expiry');
  S.editDeleteAllowed = can('inventory:adjust');
  if (!S.editQtyAllowed && !S.editExpiryAllowed && !S.editDeleteAllowed) { toast(t('app.toast.no_perm'), 'error'); return; }
  document.getElementById('modal-item-title').textContent = t('modal.item.adjust');
  document.getElementById('addModeToggle').style.display = 'none';
  document.getElementById('newFields').style.display = 'none';
  document.getElementById('restockFields').style.display = 'none';
  document.getElementById('adjustFields').style.display = 'block';
  document.getElementById('qtyGroup').style.display = S.editQtyAllowed ? 'block' : 'none';
  document.getElementById('reasonGroup').style.display = 'none';
  const arc = document.getElementById('adjustReasonControl');
  if (arc) {
    arc.style.display = S.editQtyAllowed ? 'block' : 'none';
    if (S.editQtyAllowed) {
      mountReasonControl('adjustReasonControl', {
        itemType: itemTypeForCategory(group.category),
        action: 'ADJUST',
      });
    }
  }

  const sel = document.getElementById('f-batch-edit');
  if (sel) {
    sel.innerHTML = group.batches.map(b => {
      const st = expiryStatus(b.expiry);
      const mark = st === 'expired' ? ' · Expired' : st === 'warning' ? ' · ⚠' : '';
      return `<option value="${b.id}">${esc(b.batchNumber || b.id.slice(0, 8))} — ${t('ui.pill.qty', {})} ${b.quantity} — ${b.expiry ? fmtDate(b.expiry) : '—'}${mark}</option>`;
    }).join('');
    sel.onchange = () => { S.editBatchId = sel.value; loadEditBatchFields(); };
    S.editBatchId = preferInventoryId && group.batches.some(b => b.id === preferInventoryId)
      ? preferInventoryId
      : group.batches[0]?.id || null;
    sel.value = S.editBatchId;
  }

  loadEditBatchFields();
  const delBtn = document.getElementById('btn-delete-med');
  if (delBtn) delBtn.style.display = S.editDeleteAllowed ? 'inline-flex' : 'none';
  openModal('modal-item');
}

function openEditBatch(medicineId, inventoryId) {
  openEditModal(medicineId, inventoryId);
}

// ── Per-unit lot edit (number, expiry, supplier, received date) ──
// Scoped to ONE ambulance's stock line: the shared batch the rest of the fleet
// points at is never touched. A reason is mandatory and the from→to diff is
// written to the audit log. `inventoryId` is the stock line (normalized item id).
async function openBatchEdit(medicineId, inventoryId) {
  if (!can('inventory:update-lot')) { toast(t('app.toast.no_perm'), 'error'); return; }
  const group = findGroup(medicineId);
  const item = group?.batches.find(b => b.id === inventoryId) || S.items.find(i => i.id === inventoryId);
  if (!group || !item) return;

  const orig = {
    batchNumber: item.batchNumber || '',
    expiryDate: item.expiry ? String(item.expiry).slice(0, 10) : '',
    supplier: item.supplier || '',
    receivedDate: item.receivedDate ? String(item.receivedDate).slice(0, 10) : '',
  };
  S.batchEditTarget = { inventoryId, medicineId, medicineName: group.name, orig };

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  const medEl = document.getElementById('bed-medicine');
  if (medEl) medEl.textContent = group.name;
  const unitEl = document.getElementById('bed-unit');
  if (unitEl) unitEl.textContent = S.ambulances.find(a => a.id === item.ambulanceId)?.vehicleNumber || '';
  setVal('bed-lot', orig.batchNumber);
  setVal('bed-expiry', orig.expiryDate);
  setVal('bed-supplier', orig.supplier);
  setVal('bed-received', orig.receivedDate);
  setVal('bed-reason', '');
  openModal('modal-batch-edit');
}

async function confirmBatchEdit(e) {
  if (e) e.preventDefault();
  const tgt = S.batchEditTarget;
  if (!tgt) return;
  const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const reason = val('bed-reason');
  if (reason.length < 2) { toast(t('app.batch_edit.error_reason'), 'error'); return; }

  const body = { reason };
  const lot = val('bed-lot');
  const expiry = val('bed-expiry');
  const supplier = val('bed-supplier');
  const received = val('bed-received');
  // Only send fields the user actually changed, so untouched lot data is never
  // accidentally cleared.
  if (lot !== tgt.orig.batchNumber) body.batchNumber = lot;
  if (expiry !== tgt.orig.expiryDate) body.expiryDate = expiry;
  if (supplier !== tgt.orig.supplier) body.supplier = supplier;
  if (received !== tgt.orig.receivedDate) body.receivedDate = received;

  if (Object.keys(body).length === 1) { closeModal('modal-batch-edit'); toast(t('sup.toast.data_refreshed'), 'success'); return; }

  try {
    await api.updateInventoryLot(tgt.inventoryId, body);
    closeModal('modal-batch-edit');
    toast(t('app.batch_edit.saved'));
    await loadInventory();
    renderAll();
  } catch (err) { toast(err.message, 'error'); }
}

function loadEditBatchFields() {
  const group = S.editGroup;
  const batch = group?.batches.find(b => b.id === S.editBatchId);
  if (!group || !batch) return;
  S.editItem = batch;
  S.editInventoryId = batch.id;
  refreshBatchCurrentInfo();
  document.getElementById('qtyLabel').textContent = t('modal.qty.new');
  const qty = document.getElementById('f-qty');
  if (qty) { qty.min = '0'; qty.value = batch.quantity; }
  const reason = document.getElementById('f-reason');
  if (reason) { reason.value = ''; reason.placeholder = t('app.adjust.reason_ph'); }
  const expFields = document.getElementById('expFields');
  if (expFields) expFields.style.display = S.editExpiryAllowed ? '' : 'none';
  const exp = document.getElementById('f-expiry');
  if (exp) { exp.value = batch.expiry ? batch.expiry.slice(0, 10) : ''; exp.disabled = !S.editExpiryAllowed; }
}

function refreshBatchCurrentInfo() {
  const el = document.getElementById('batchCurrentInfo');
  if (!el) return;
  const group = S.editGroup;
  const batch = group?.batches.find(b => b.id === S.editBatchId);
  if (!group || !batch) { el.innerHTML = ''; return; }
  const st = batch.expiry ? expiryStatus(batch.expiry) : 'ok';
  const stCls = st === 'expired' ? 'is-expired' : st === 'warning' ? 'is-warning' : '';
  el.innerHTML = `
    <span class="bci-chip bci-name">${icon('pill')} <strong>${esc(group.name)}</strong></span>
    <span class="bci-chip">${icon('tag')} <strong>${esc(batch.batchNumber || batch.id.slice(0, 8))}</strong></span>
    <span class="bci-chip">${icon('package')} ${t('ui.pill.qty')} <strong>${batch.quantity}</strong></span>
    <span class="bci-chip ${stCls}">${icon('clock')} ${t('ui.pill.expiry')} ${batch.expiry ? fmtDate(batch.expiry) : '—'}</span>`;
}

// ── Delete: stock line (default, safer) vs whole medicine ──
// Deletion is deliberately split in TWO scopes so a crew member can remove ONE
// lot without wiping the medicine and every other batch (the old behaviour).
//   - 'stock'     → DELETE /inventory/:id  (one lot on this vehicle)
//   - 'medicine'  → DELETE /medicines/:id  (whole medicine + all its lots)
// Whole-medicine deletion is reserved for senior roles (inventory:adjust).

async function openDeleteModal(mode = 'stock') {
  const titleEl = document.getElementById('modal-delete-title');
  const warnEl = document.getElementById('delWarningText');
  const btnEl = document.getElementById('btn-delete-confirm');
  if (!titleEl || !warnEl || !btnEl) return;

  if (mode === 'medicine') {
    const group = S.editGroup;
    if (!group || !(can('inventory:adjust') && can('medicine:delete'))) return;
    S.deleteTarget = { mode: 'medicine', medicineId: group.id, name: group.name };
    const today = new Date().setHours(0, 0, 0, 0);
    const hasActiveStock = group.batches.some(b => (b.quantity > 0) && (!b.expiry || new Date(b.expiry).getTime() >= today));
    const latestExpiry = earliestExpiry(group);
    const lotNumbers = group.batches.map(b => b.batchNumber).filter(Boolean).join(', ');
    document.getElementById('delItemInfo').innerHTML = `
      <div style="background:var(--bg);border-radius:10px;padding:14px 16px;">
        <div style="font-size:1rem;font-weight:700;margin-bottom:6px;">${esc(group.name)}${group.size ? ` <span style="font-weight:600;font-size:.8rem;color:var(--text-muted);">(${esc(group.size)})</span>` : ''}</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:0.85rem;color:var(--text-muted);">
          <span>${catIcon(group.category)} ${catLabel(group.category)}</span>
          ${lotNumbers ? `<span><strong>${esc(lotNumbers)}</strong></span>` : ''}
          <span>${group.batches.length === 1 ? t('ui.batch.count_one', { n: group.batches.length }) : t('ui.batch.count_other', { n: group.batches.length })}</span>
          <span>${t('modal.delete.qty')} <strong style="color:var(--text)">${group.quantity ?? 0}</strong></span>
          ${latestExpiry ? `<span>${t('app.expiry.current')} <strong style="color:var(--text)">${fmtDate(latestExpiry)}</strong></span>` : ''}
        </div>
        <div style="margin-top:10px;padding:9px 12px;border-radius:8px;font-size:.8rem;border:1px solid ${hasActiveStock ? 'rgba(250,204,21,.4)' : 'rgba(248,113,113,.35)'};color:${hasActiveStock ? '#FDE68A' : '#FCA5A5'};">
          ${esc(hasActiveStock ? t('modal.delete.active') : t('modal.delete.inactive'))}
        </div>
      </div>`;
    titleEl.innerHTML = `${icon('alert')} ${t('modal.delete.medicine_title')}`;
    warnEl.textContent = t('modal.delete.medicine_warning');
    btnEl.textContent = t('modal.delete.medicine_btn');
  } else {
    const item = S.items.find(i => i.id === S.editInventoryId);
    if (!item || !can('inventory:adjust')) return;
    S.deleteTarget = { mode: 'stock', inventoryId: item.id, name: item.name, lot: item.batchNumber, qty: item.quantity };
    document.getElementById('delItemInfo').innerHTML = `
      <div style="background:var(--bg);border-radius:10px;padding:14px 16px;">
        <div style="font-size:1rem;font-weight:700;margin-bottom:6px;">${esc(item.name)}${item.strength ? ` <span style="font-weight:600;font-size:.8rem;color:var(--text-muted);">${esc(item.strength)}</span>` : ''}</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:0.85rem;color:var(--text-muted);">
          <span>${catIcon(item.category)} ${catLabel(item.category)}</span>
          ${item.batchNumber ? `<span>${icon('tag')} <strong>${esc(item.batchNumber)}</strong></span>` : ''}
          <span>${t('ui.batch.qty')} <strong style="color:var(--text)">${item.quantity}</strong></span>
          ${item.expiry ? `<span>${t('ui.pill.expiry')} <strong>${fmtDate(item.expiry)}</strong></span>` : ''}
        </div>
      </div>`;
    titleEl.innerHTML = `${icon('trash')} ${t('modal.delete.stock_title')}`;
    warnEl.innerHTML = t('modal.delete.stock_warning', { lot: esc(item.batchNumber || t('ui.batch.lot')) });
    btnEl.textContent = t('modal.delete.stock_btn');
  }
  const drc = document.getElementById('deleteReasonControl');
  if (drc) {
    if (mode === 'medicine') {
      drc.style.display = 'none';
      drc.innerHTML = '';
    } else {
      drc.style.display = 'block';
      const cat = S.items.find(i => i.id === S.editInventoryId)?.category;
      mountReasonControl('deleteReasonControl', {
        itemType: itemTypeForCategory(cat),
        action: 'DELETE',
      });
    }
  }
  openModal('modal-delete');
}

/** Direct delete of one lot from a card/batch-list row. */
function deleteStockLine(inventoryId) {
  const item = S.items.find(i => i.id === inventoryId);
  if (!item || !can('inventory:adjust')) return;
  S.editItem = item;
  S.editInventoryId = inventoryId;
  openDeleteModal('stock');
}

/** Whole-medicine delete (senior-only), used from the batch list modal. */
function openMedicineDelete() {
  openDeleteModal('medicine');
}

async function confirmDelete() {
  const target = S.deleteTarget;
  if (!target) return;
  try {
    if (target.mode === 'stock') {
      let reason = '';
      let reasonCode = null;
      try {
        const rc = readReasonControl('deleteReasonControl');
        reason = rc.note || rc.code || '';
        reasonCode = rc.code;
      } catch (err) { toast(err.message, 'error'); return; }
      await api.deleteStock(target.inventoryId, { reason, reasonCode });
      closeModal('modal-delete');
      closeModal('modal-item');
      toast(t('app.toast.lot_deleted', { name: target.name || '' }));
    } else {
      // Fleet-wide removal: the API refuses while the item sits on more than one
      // ambulance, so the crew is asked to confirm the blast radius explicitly.
      let data;
      try {
        data = await api.deleteMedicine(target.medicineId, false);
      } catch (err) {
        if (err.code !== 'CONFLICT') throw err;
        if (!await confirmDialog({ message: t('app.confirm.delete_medicine_fleet', { name: target.name || '' }), tone: 'danger', title: t('ui.dialog.title_delete') })) return;
        data = await api.deleteMedicine(target.medicineId, true);
      }
      closeModal('modal-delete');
      closeModal('modal-item');
      toast(t('app.toast.deleted', { name: target.name || '' }));
    }
    await loadInventory();
    renderAll();
  } catch (err) { toast(err.message, 'error'); }
}

function addBatch() {
  const expiry = document.getElementById('b-expiry').value;
  const lot = document.getElementById('b-lot').value.trim();
  const qty = parseInt(document.getElementById('b-qty').value, 10) || 1;
  if (!expiry) { toast(t('batch.required_expiry') || 'Expiry date is required', 'error'); return; }
  S.tempBatches.push({ expiry, batchNumber: lot || null, quantity: qty });
  updateBatchesUI();
  document.getElementById('b-expiry').value = '';
  document.getElementById('b-lot').value = '';
  document.getElementById('b-qty').value = '1';
}

function removeBatch(idx) {
  S.tempBatches.splice(idx, 1);
  updateBatchesUI();
}

function toggleBatches(medicineId) { /* deprecated — use showAllBatches */ }

function showAllBatches(medicineId) {
  const group = findGroup(medicineId);
  if (!group || !group.batches.length) return;
  S.editGroup = group;
  const totalQty = group.batches.reduce((s, b) => s + (b.quantity || 0), 0);
  const canDel = window.AEMS_PERMS?.includes('inventory:adjust');
  const renderRow = b => {
    const bs = expiryStatus(b.expiry);
    return `
      <div class="batch-row">
        <span class="batch-lot"><svg class="ic" aria-hidden="true"><use href="#i-tag"/></svg> <strong>${esc(b.batchNumber || b.id.slice(0, 8))}</strong></span>
        <span class="batch-exp ${bs === 'expired' ? 'batch-exp-expired' : bs === 'warning' ? 'batch-exp-warning' : ''}"><span class="batch-dot"></span>${b.expiry ? fmtDate(b.expiry) : '—'}</span>
        <span class="batch-qty">${b.quantity}</span>
        <span class="batch-ops">
          <button type="button" class="batch-btn" onclick="App.openBatchEdit('${esc(group.medicineId)}','${esc(b.id)}')" title="${t('ui.btn.edit_lot')}"><svg class="ic" aria-hidden="true"><use href="#i-edit"/></svg></button>
          ${canDel ? `<button type="button" class="batch-btn danger" onclick="App.deleteStockLine('${esc(b.id)}')" title="${t('ui.btn.delete_lot')}"><svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg></button>` : ''}
        </span>
      </div>`;
  };
  document.getElementById('batchModalContent').innerHTML = `
    <div class="batch-modal-header">
      <div class="batch-modal-cat" style="--cat:${catColor(group.category)}">${catIcon(group.category)}</div>
      <div>
        <div class="batch-modal-title">${esc(group.name)}${group.strength ? `<span class="item-strength">${esc(group.strength)}</span>` : ''}</div>
        <div class="batch-modal-sub">${catLabel(group.category)}${group.size ? ` &middot; ${esc(group.size)}` : ''}</div>
      </div>
      <button class="modal-close" onclick="closeModal('modal-batches')" style="margin-inline-start:auto;">✕</button>
    </div>
    <div class="batch-modal-stats">
      <span class="batch-modal-stat"><svg class="ic" aria-hidden="true"><use href="#i-package"/></svg> ${t('ui.pill.qty')} <span class="pi">${totalQty}</span></span>
      <span class="batch-modal-stat"><svg class="ic" aria-hidden="true"><use href="#i-tag"/></svg> ${group.batches.length === 1 ? t('ui.batch.count_one', { n: group.batches.length }) : t('ui.batch.count_other', { n: group.batches.length })}</span>
    </div>
    <div class="batch-modal-list">
      <div class="batch-head">
        <span class="batch-lot">${t('ui.batch.lot')}</span>
        <span class="batch-exp">${t('ui.batch.expiry')}</span>
        <span class="batch-qty">${t('ui.batch.qty')}</span>
        <span class="batch-edit"></span>
      </div>
      ${group.batches.map(renderRow).join('')}
    </div>
    <div class="batch-modal-footer">
      ${(window.AEMS_PERMS?.includes('inventory:adjust') && window.AEMS_PERMS?.includes('medicine:delete'))
        ? `<button class="btn btn-danger btn-sm" style="margin-inline-end:auto;" onclick="App.openMedicineDelete()" title="${t('ui.btn.delete_medicine')}"><svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg> ${t('ui.btn.delete_medicine')}</button>` : ''}
      <button class="btn btn-ghost" onclick="closeModal('modal-batches')">${t('modal.close')}</button>
      ${(window.AEMS_PERMS?.includes('inventory:adjust') || window.AEMS_PERMS?.includes('inventory:update-expiry')) ? `<button class="btn btn-primary" onclick="closeModal('modal-batches');App.openEditModal('${esc(group.id)}')"><svg class="ic" aria-hidden="true"><use href="#i-edit"/></svg> ${t('ui.btn.edit')}</button>` : ''}
    </div>`;
  openModal('modal-batches');
}

function updateBatchesUI() {
  const el = document.getElementById('batchesList');
  if (!el) return;
  el.innerHTML = S.tempBatches.length
    ? S.tempBatches.map((b, i) => renderBatchItem(b, i)).join('')
    : `<p style="color:var(--text-muted);font-size:0.82rem;text-align:center;margin:8px 0;">${t('ui.batch.no_batches')}</p>`;
}

// Live "already exists" hint on the New-item name field. Debounced so typing
// doesn't hammer the API. Shows how many lots the matching medicine already has
// and makes clear that saving will simply add a new lot to it.
let _nameHintTimer = null;
function onNameInput() {
  const el = document.getElementById('f-name');
  const hint = document.getElementById('nameMatchHint');
  if (!el || !hint) return;
  const clear = () => { hint.style.display = 'none'; hint.textContent = ''; };
  clearTimeout(_nameHintTimer);
  const name = el.value.trim();
  if (name.length < 3) { clear(); return; }
  _nameHintTimer = setTimeout(async () => {
    const size = document.getElementById('f-size')?.value.trim() || '';
    const existing = await findExistingMedicine(name, size);
    if (!existing) { clear(); return; }
    let n = 0;
    try {
      const d = await api.batches({ medicineId: existing.id, activeOnly: true, pageSize: MAX_LIST_PAGE_SIZE });
      n = (d.batches || []).length;
    } catch {}
    hint.textContent = t('app.add.existing_hint', { name: existing.name, n });
    hint.style.display = 'block';
  }, 350);
}

async function findExistingMedicine(name, size) {
  const norm = s => (s || '').trim().toLowerCase();
  const nameN = norm(name);
  if (!nameN) return null;
  try {
    const d = await api.medicines({ search: name, includeInactive: true, pageSize: 200 });
    const sameName = (d.medicines || []).filter(m => norm(m.name) === nameN);
    if (!sameName.length) return null;
    const sizeN = size ? norm(size) : null;
    if (sizeN) return sameName.find(m => norm(m.size) === sizeN) || null;
    return sameName.length === 1 ? sameName[0] : null;
  } catch {
    return null;
  }
}

/**
 * Asks what to do about a typed lot number that already exists for the same
 * medicine. Resolves to 'merge', 'update' or 'cancel'.
 *
 * The database enforces one lot per (medicine, number), so a second lot with
 * the same number is not possible. The real choice is whether the stock joins
 * the existing lot, and whether the existing lot's details should be corrected
 * with what the crew just typed.
 *
 * `dup` is the existing lot (batchNumber, expiryDate, quantity); `b` is the
 * line the crew just typed (expiry, quantity).
 */
async function promptDuplicateLot({ lot, medicine, b, dup }) {
  const fmt = (d) => (d ? fmtDate(d) : t('common.not_available'));
  const existing = t('app.add.dup_existing_line', {
    expiry: fmt(dup.expiryDate),
    qty: dup.quantity ?? '—',
  });
  const incoming = t('app.add.dup_incoming_line', {
    expiry: fmt(b.expiry),
    qty: b.quantity ?? 0,
  });
  const expiryDiffers = !!(dup.expiryDate && b.expiry)
    && String(dup.expiryDate).slice(0, 10) !== String(b.expiry).slice(0, 10);

  const choices = [
    { value: 'merge', label: t('app.add.dup_merge'), hint: t('app.add.dup_merge_hint'), tone: 'primary' },
  ];
  // Only offer the expiry correction when the dates actually disagree AND the
  // crew may edit shared lots (batch:update gates the endpoint). Offering an
  // action that would be rejected is worse than not offering it.
  const canUpdateLot = typeof can === 'function' ? can('batch:update') : true;
  if (expiryDiffers && canUpdateLot) {
    choices.push({ value: 'update', label: t('app.add.dup_update'), hint: t('app.add.dup_update_hint', { old: fmt(dup.expiryDate), new: fmt(b.expiry) }) });
  }

  const pick = await choiceDialog({
    tone: 'warning',
    title: t('app.add.dup_title'),
    message: t('app.add.dup_message', { lot, name: medicine.name || '' })
      + `\n\n${existing}\n${incoming}`
      + (expiryDiffers ? `\n\n${t('app.add.dup_expiry_warning', { old: fmt(dup.expiryDate), new: fmt(b.expiry) })}` : ''),
    cancelLabel: t('common.cancel'),
    choices,
  });
  return pick || 'cancel';
}

async function onSaveItem(e) {
  e.preventDefault();
  if (S.editMode === 'adjust') {
    const item = S.items.find(i => i.id === S.editInventoryId);
    if (!item) return;
    const canQty = !!S.editQtyAllowed;
    const canExp = !!S.editExpiryAllowed;
    const qtyVal = canQty ? parseInt(document.getElementById('f-qty').value, 10) : null;
    const expVal = canExp ? document.getElementById('f-expiry').value : '';
    const qtyChanged = canQty && !isNaN(qtyVal) && qtyVal >= 0 && qtyVal !== item.quantity;
    const expChanged = canExp && !!expVal && expVal !== (item.expiry ? item.expiry.slice(0, 10) : '');
    if (!qtyChanged && !expChanged) { closeModal('modal-item'); toast(t('sup.toast.data_refreshed'), 'success'); return; }

    let reason = '';
    let reasonCode = null;
    if (qtyChanged) {
      try {
        const rc = readReasonControl('adjustReasonControl');
        reason = rc.note || rc.code || '';
        reasonCode = rc.code;
      } catch (err) { toast(err.message, 'error'); return; }
      if (reason.length < 2) { toast(t('app.adjust.error_reason'), 'error'); return; }
    }
    try {
      if (qtyChanged) await api.adjust({ inventoryId: S.editInventoryId, newQuantity: qtyVal, reason, reasonCode });
      if (expChanged) await api.updateItemExpiry(S.editInventoryId, expVal);
      closeModal('modal-item');
      toast(t('app.toast.adjusted'));
      await loadInventory();
      renderAll();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  if (S.addMode === 'new') {
    const name = document.getElementById('f-name').value.trim();
    const category = document.getElementById('f-cat').value;
    if (!name || !category) { toast(t('app.add.error_name_cat'), 'error'); return; }
    if (!S.tempBatches.length) { toast(t('app.add.error_no_batch'), 'error'); return; }
    const gv = id => document.getElementById(id).value.trim();
    const reason = t('app.reason.initial');
    try {
      const size = gv('f-size');
      const existing = await findExistingMedicine(name, size);
      const med = existing || await api.createMedicine({
        name,
        category,
        size,
        location: gv('f-location'),
        serialNumber: gv('f-serial'),
        notes: gv('f-notes'),
        technicalNotes: gv('f-technotes'),
        barcode: gv('f-storecode'),
      });
      // Lot numbers typed by the user are matched against the lots this
      // medicine already has ON THIS UNIT. A match is never merged silently:
      // the crew is asked whether the stock joins the existing lot and whether
      // its expiry should be corrected.
      let knownBatches = [];
      try {
        const bd = await api.batches({ medicineId: med.id, activeOnly: true, pageSize: MAX_LIST_PAGE_SIZE });
        knownBatches = (bd.batches || []).map(x => ({
          id: x.id,
          batchNumber: x.batchNumber,
          expiryDate: x.expiryDate || null,
          // The batches endpoint has no quantity (stock is per-unit), so take
          // the on-unit figure from the inventory already loaded for this unit.
          quantity: S.items.find(i => i.batchId === x.id)?.quantity ?? null,
        }));
      } catch {}
      for (let i = 0; i < S.tempBatches.length; i++) {
        const b = S.tempBatches[i];
        const lot = (b.batchNumber || '').trim();
        const dup = lot ? knownBatches.find(x => x.batchNumber === lot) : null;
        let batchId = dup ? dup.id : null;
        if (dup) {
          const pick = await promptDuplicateLot({ lot, medicine: med, b, dup });
          if (pick === 'cancel') return;
          if (pick === 'update') {
            // Same lot number, corrected expiry: fix the shared lot record
            // rather than creating a duplicate (which the DB forbids anyway).
            await api.updateBatch(dup.id, { expiryDate: b.expiry, reason: t('app.reason.initial') });
            dup.expiryDate = b.expiry;
          }
        }
        if (!batchId) {
          const batch = await api.createBatch({
            medicineId: med.id,
            batchNumber: lot || `LOT-${Date.now().toString(36).toUpperCase()}${i}`,
            expiryDate: b.expiry,
            receivedDate: nowLocal().slice(0, 10),
            supplier: b.supplier || '',
          });
          batchId = batch.id;
          knownBatches.push({ id: batch.id, batchNumber: lot, expiryDate: b.expiry, quantity: null });
        }
        if (b.quantity > 0) {
          await api.restock({ ambulanceId: S.activeAmbulanceId, batchId, quantity: b.quantity, reason });
        }
      }
      if (!existing) {
        S.medicines = S.medicines || [];
        S.medicines.push(med);
      }
      closeModal('modal-item');
      toast(existing ? t('app.toast.batch_added', { name }) : t('app.toast.added_name', { name }));
      await loadInventory();
      renderAll();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  // Restock existing
  const medicineId = document.getElementById('f-medicine').value;
  const batchId = document.getElementById('f-batch').value;
  const quantity = parseInt(document.getElementById('f-qty').value, 10);
  const reason = document.getElementById('f-reason').value.trim();
  if (!medicineId || !batchId || !quantity || quantity <= 0) {
    toast(t('app.restock.error_pick'), 'error');
    return;
  }
  try {
    await api.restock({
      ambulanceId: S.activeAmbulanceId,
      batchId,
      quantity,
      reason: reason || undefined,
    });
    closeModal('modal-item');
    toast(t('app.toast.quantity_added', { quantity }));
    await loadInventory();
    renderAll();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Inspections ────────────────────────────────────────────────
/**
 * Opens the count sheet. The crew types the quantity they actually counted
 * (a blank field keeps the current quantity); any difference is corrected on
 * the car the moment the sheet is submitted. `focusId` limits the sheet to a
 * single item (tap-to-check), `null` means the whole car.
 */
// ── Inspection wizard ──────────────────────────────────────────
// Counting, verdicts and stock corrections are kept apart on purpose:
//   1. Count  — one category at a time; only that category is in the DOM.
//   2. Review — ONLY lines that differ (or were flagged) ask for a reason.
//   3. Submit — saves the draft, completes it, stock reconciles server-side.
// Nothing changes on the car until the user confirms, and the draft is
// autosaved so a phone that dies mid-count resumes where it left off.
const INSP = {
  step: 'count',   // 'count' | 'review' | 'done'
  draftId: null,   // server DRAFT being autosaved
  saving: false,
  dirty: false,
  focusId: null,   // quick check of a single medicine
  cat: null,
  rows: new Map(), // inventoryId -> row state
};

const INSP_CONDITIONS = [
  { key: 'OK',       label: 'app.insp.wz.cond_ok',       col: '#22C55E' },
  { key: 'MISSING',  label: 'app.insp.wz.cond_missing',  col: '#EF4444' },
  { key: 'DAMAGED',  label: 'app.insp.wz.cond_damaged',  col: '#F59E0B' },
  { key: 'EXPIRED',  label: 'app.insp.wz.cond_expired',  col: '#8B5CF6' },
  { key: 'UNUSABLE', label: 'app.insp.wz.cond_unusable', col: '#F97316' },
  { key: 'EXTRA',    label: 'app.insp.wz.cond_extra',    col: '#14B8A6' },
];

/**
 * Stock lines that belong to the car currently being inspected.
 *
 * S.items is scoped to the whole station (every shift, every car of the unit
 * shares one stock view), but an inspection is filed against ONE car. Sending
 * another car's lines would be rejected by the server — "One or more lines do
 * not belong to this ambulance" — so the wizard only ever sees this car's rows.
 */
function inspScopedItems() {
  const car = S.activeAmbulanceId;
  if (!car) return S.items;
  const mine = S.items.filter((i) => !i.ambulanceId || i.ambulanceId === car);
  // If the car genuinely holds nothing, fall back to the full unit view rather
  // than showing an empty wizard — the server still validates on save.
  return mine.length ? mine : S.items;
}

/** Rows to inspect: this car's stock lines, or one medicine's lots for a quick check. */
function inspRowsFor(focusId) {
  const items = inspScopedItems();
  if (!focusId) return items;
  const group = groupRows(items).find((g) => g.id === focusId);
  if (group) return group.batches;
  const single = items.find((i) => i.id === focusId);
  return single ? [single] : [];
}

/** Small expiry tag: red when expired, amber inside the 90-day window. */
function inspExpiryTag(expiry) {
  if (!expiry) return '';
  const d = new Date(expiry);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.ceil((d - new Date()) / 86400000);
  const cls = days < 0 ? 'exp' : (days <= 90 ? 'soon' : '');
  return ` · <span class="iw-exp${cls ? ' ' + cls : ''}">${esc(fmtDate(expiry))}</span>`;
}

function inspCatKeys() {
  const order = Object.keys(CATEGORIES);
  const keys = [];
  for (const r of INSP.rows.values()) if (!keys.includes(r.category)) keys.push(r.category);
  return keys.sort((a, b) => {
    const ai = order.indexOf(a), bi = order.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

function inspCounted() {
  let n = 0;
  for (const r of INSP.rows.values()) if (r.qty !== null) n++;
  return n;
}

/** Lines the review step must show: a real difference, a flag, or a note. */
function inspReviewRows() {
  const out = [];
  for (const r of INSP.rows.values()) {
    const diff = r.qty === null ? 0 : r.qty - r.expected;
    const flagged = !!r.condition && r.condition !== 'OK';
    if (diff !== 0 || flagged || (r.note && r.note.trim())) out.push(r);
  }
  return out;
}

function inspTitle() { return (document.getElementById('inspType')?.value || 'daily').toUpperCase(); }
function inspNotesText() {
  const n = document.getElementById('inspNotes')?.value.trim();
  return n || t('app.inspect.quick_note', { name: me().name });
}

/** Opens the wizard. focusId → quick check of one medicine's lots. */
function startInspection(focusId = null) {
  if (!requireAmbulance()) return;
  const items = inspRowsFor(focusId || null);
  if (!items.length) { toast(t('app.inspect.no_items'), 'error'); return; }

  INSP.step = 'count';
  INSP.draftId = null;
  INSP.dirty = false;
  INSP.focusId = focusId || null;
  INSP.rows = new Map(items.map((i) => [i.id, {
    id: i.id, name: i.name, size: i.size, category: i.category,
    batchNumber: i.batchNumber, expiry: i.expiry, expected: i.quantity ?? 0,
    qty: null, condition: null, note: '', reasons: [],
    // Opt-in write-off for items found present but unusable (expired/damaged/
    // unusable). Never applied automatically - the crew must ask for it.
    removeRemaining: false,
  }]));
  INSP.cat = items[0].category;
  renderInspWizard();
  openModal('modal-inspect');
  if (!focusId) resumeInspDraft();
}

// ── Wizard rendering ───────────────────────────────────────────

function renderInspWizard() {
  renderInspHead();
  const cats = document.getElementById('iwCats');
  if (INSP.step === 'count') renderInspCount();
  else if (INSP.step === 'review') { if (cats) cats.innerHTML = ''; renderInspReview(); }
  renderInspFoot();
}

function renderInspHead() {
  const title = document.getElementById('iwTitle');
  if (title) title.textContent = INSP.focusId ? t('app.insp.wz.title_one') : t('app.insp.wz.title');

  const steps = document.getElementById('iwSteps');
  if (steps) {
    const defs = [['count', 'app.insp.wz.step1'], ['review', 'app.insp.wz.step2'], ['done', 'app.insp.wz.step3']];
    const at = defs.findIndex((d) => d[0] === INSP.step);
    steps.innerHTML = defs.map(([k, key], i) =>
      `<span class="iw-step${INSP.step === k ? ' active' : ''}${i < at ? ' done' : ''}">${i + 1}. ${esc(t(key))}</span>`
    ).join('<span class="iw-step-sep">›</span>');
  }
  renderInspProgress();
}

/** Cheap repaint used while typing — no step markup rebuild per keystroke. */
function renderInspProgress() {
  const bar = document.getElementById('iwProgress');
  if (!bar) return;
  const total = INSP.rows.size;
  const done = inspCounted();
  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.innerHTML = `<div class="iw-pbar"><i style="width:${pct}%"></i></div>` +
    `<span>${esc(t('app.insp.wz.progress', { done, total }))}</span>`;
}

function renderInspCount() {
  const cats = document.getElementById('iwCats');
  if (cats) {
    cats.innerHTML = inspCatKeys().map((k) => {
      const rows = [...INSP.rows.values()].filter((r) => r.category === k);
      const done = rows.filter((r) => r.qty !== null).length;
      const cat = CATEGORIES[k] || {};
      return `<button type="button" class="iw-cat${INSP.cat === k ? ' active' : ''}${done === rows.length ? ' full' : ''}" style="--cc:${cat.color || '#94A3B8'}" onclick="App.inspGoCat('${k}')">
        ${icon(cat.icon || 'package')} <span>${esc(catLabel(k))}</span> <b>${done}/${rows.length}</b>
      </button>`;
    }).join('');
  }

  const body = document.getElementById('iwBody');
  if (!body) return;
  const rows = [...INSP.rows.values()].filter((r) => r.category === INSP.cat);
  body.innerHTML = `<div class="iw-hint">${esc(t('app.insp.wz.hint_count'))}</div>` +
    rows.map(inspCountRow).join('');
  body.oninput = inspBodyInput;
}

function inspCountRow(r) {
  // The number the crew types is what they physically FOUND on the unit — not
  // what was used, and not what should remain. That is stated on the row itself
  // because the field is otherwise just an unlabelled box.
  const delta = r.qty === null ? null : r.qty - r.expected;
  return `<div class="iw-row${delta ? ' diff' : ''}" data-id="${esc(r.id)}">
    <div class="iw-info">
      <div class="iw-name">${esc(r.name)}${r.size ? ` <span class="iw-size">(${esc(r.size)})</span>` : ''}</div>
      <div class="iw-meta">${esc(t('app.insp.wz.expected'))} <strong>${r.expected}</strong>${r.batchNumber ? ` · <span class="iw-lot">#${esc(r.batchNumber)}</span>` : ''}${inspExpiryTag(r.expiry)}</div>
      <input class="iw-note form-control" type="text" maxlength="300" value="${esc(r.note)}" placeholder="${esc(t('app.insp.wz.note_ph'))}" aria-label="${esc(t('app.insp.wz.note_ph'))}">
    </div>
    <div class="iw-qtywrap">
      <label class="iw-qtylabel" for="qty-${esc(r.id)}">${esc(t('app.insp.wz.counted_label'))}</label>
      <input class="iw-qty" id="qty-${esc(r.id)}" type="number" min="0" step="1" inputmode="numeric" value="${r.qty === null ? '' : r.qty}" placeholder="—" aria-label="${esc(t('app.insp.wz.counted_label'))}" aria-describedby="delta-${esc(r.id)}">
      <span class="iw-deltahint" id="delta-${esc(r.id)}" data-delta="${delta === null ? '' : delta}">${inspDeltaText(delta)}</span>
    </div>
    <div class="iw-cond">
      ${INSP_CONDITIONS.map((c) => `<button type="button" class="iw-chip${r.condition === c.key ? ' active' : ''}" data-cond="${c.key}" style="--cc:${c.col}" onclick="App.inspCond(this)">${esc(t(c.label))}</button>`).join('')}
    </div>
  </div>`;
}

/**
 * Plain-language readout under the count box. Says out loud what the typed
 * number implies, so "did I enter what I found or what I used?" never has to be
 * guessed: the box is the shelf count, and this line translates it into a delta.
 */
function inspDeltaText(delta) {
  if (delta === null) return t('app.insp.wz.delta_awaiting');
  if (delta === 0) return t('app.insp.wz.delta_match');
  if (delta < 0) return t('app.insp.wz.delta_short', { n: Math.abs(delta) });
  return t('app.insp.wz.delta_over', { n: delta });
}

/** One delegated listener per render — no per-row handlers, no re-render per keystroke. */
function inspBodyInput(e) {
  const inp = e.target;
  const rowEl = inp.closest('.iw-row');
  if (!rowEl) return;
  const r = INSP.rows.get(rowEl.dataset.id);
  if (!r) return;
  if (inp.classList.contains('iw-qty')) {
    const v = inp.value.trim();
    r.qty = v === '' ? null : Math.max(0, parseInt(v, 10) || 0);
    const delta = r.qty === null ? null : r.qty - r.expected;
    rowEl.classList.toggle('diff', !!delta);
    // Keep the meaning of the number visible while typing (no re-render, so the
    // caret is never disturbed).
    const hint = rowEl.querySelector('.iw-deltahint');
    if (hint) {
      hint.textContent = inspDeltaText(delta);
      hint.dataset.delta = delta === null ? '' : String(delta);
    }
  } else if (inp.classList.contains('iw-note')) {
    r.note = inp.value;
  } else return;
  INSP.dirty = true;
  renderInspProgress();
  renderInspCatsProgress();
}

function renderInspCatsProgress() {
  const cats = document.getElementById('iwCats');
  if (!cats || INSP.step !== 'count') return;
  [...cats.querySelectorAll('.iw-cat')].forEach((btn, i) => {
    const k = inspCatKeys()[i];
    if (!k) return;
    const rows = [...INSP.rows.values()].filter((r) => r.category === k);
    const done = rows.filter((r) => r.qty !== null).length;
    btn.classList.toggle('full', done === rows.length);
    const b = btn.querySelector('b');
    if (b) b.textContent = `${done}/${rows.length}`;
  });
}

function inspCond(btn) {
  const rowEl = btn.closest('.iw-row');
  const r = INSP.rows.get(rowEl.dataset.id);
  if (!r) return;
  const key = btn.dataset.cond;
  r.condition = r.condition === key ? null : key;
  // MISSING means there are none left, so the count is driven to zero. EXTRA is
  // the opposite: more than the system knows, so the crew must type the higher
  // number themselves. Nothing is guessed in either direction.
  if (r.condition === 'MISSING') {
    r.qty = 0;
    const q = rowEl.querySelector('.iw-qty');
    if (q) q.value = '0';
    rowEl.classList.add('diff');
  } else if (r.condition === 'EXTRA') {
    const q = rowEl.querySelector('.iw-qty');
    if (q) { q.focus(); q.select?.(); }
  }
  // Keep the "found N" readout in step with any change made by the chips.
  const hint = rowEl.querySelector('.iw-deltahint');
  if (hint) {
    const delta = r.qty === null ? null : r.qty - r.expected;
    hint.textContent = inspDeltaText(delta);
    hint.dataset.delta = delta === null ? '' : String(delta);
    rowEl.classList.toggle('diff', !!delta);
  }
  rowEl.querySelectorAll('.iw-chip').forEach((c) => c.classList.toggle('active', c.dataset.cond === r.condition));
  INSP.dirty = true;
  renderInspProgress();
  renderInspCatsProgress();
}

function inspGoCat(k) {
  if (!k || k === INSP.cat) return;
  INSP.cat = k;
  renderInspCount();
  renderInspFoot();
  saveInspDraft();
}

// ── Review step (reasons live ONLY here) ───────────────────────

function inspReasonsFor(cat) {
  return reasonsFor(itemTypeForCategory(cat), 'INSPECTION');
}

function renderInspReview() {
  const body = document.getElementById('iwBody');
  if (!body) return;
  body.oninput = null;

  const diffs = inspReviewRows();
  const uncounted = [...INSP.rows.values()].filter((r) => r.qty === null);
  const head = `<div class="iw-hint">${esc(t('app.insp.wz.review_hint'))}</div>` +
    (uncounted.length ? `<div class="iw-uncounted">
        <span>${icon('alert')} ${esc(t('app.insp.wz.uncounted', { n: uncounted.length }))}</span>
        <span class="iw-uncounted-actions">
          <button type="button" class="btn btn-ghost btn-sm" onclick="App.inspMarkRest()">${esc(t('app.insp.wz.mark_ok'))}</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="App.inspFlagRest()">${esc(t('app.insp.wz.flag_nc'))}</button>
        </span>
      </div>` : '');

  if (!diffs.length) {
    body.innerHTML = head + `<div class="iw-empty">${icon('checkCircle')} ${esc(t('app.insp.wz.review_none'))}</div>`;
    return;
  }
  body.innerHTML = head + diffs.map(inspReviewRow).join('');
}

const WRITE_OFF_CONDITIONS = ['EXPIRED', 'DAMAGED', 'UNUSABLE'];

/** Reason code used when the crew writes off a flagged line. */
const WRITE_OFF_REASON = {
  EXPIRED: 'EXPIRED',
  DAMAGED: 'DAMAGED_PACKAGING',
  UNUSABLE: 'NO_LONGER_SERVICEABLE',
};

function inspReviewRow(r) {
  const diff = r.qty === null ? 0 : r.qty - r.expected;
  const dc = diff < 0 ? 'neg' : (diff > 0 ? 'pos' : '');
  const condTag = r.condition
    ? ` · <span class="iw-cond-tag" data-c="${esc(r.condition)}">${esc(t('app.insp.wz.cond_' + r.condition.toLowerCase()))}</span>`
    : '';
  // Stock found present but flagged unusable, and the count was left as-is:
  // the crew can choose to strike it off the books now. Never automatic.
  const remaining = r.qty === null ? 0 : r.qty;
  const canWriteOff = diff === 0 && remaining > 0 && WRITE_OFF_CONDITIONS.includes(r.condition);
  return `<div class="iw-rev${diff !== 0 ? ' needs' : ''}" data-id="${esc(r.id)}">
    <div class="iw-rev-head">
      <div>
        <div class="iw-name">${esc(r.name)}${r.size ? ` <span class="iw-size">(${esc(r.size)})</span>` : ''}</div>
        <div class="iw-meta">${r.expected} → <strong>${r.qty === null ? '—' : r.qty}</strong>${diff ? ` <span class="iw-delta ${dc}">Δ${diff > 0 ? '+' : ''}${diff}</span>` : ''}${condTag}</div>
      </div>
      ${r.note && r.note.trim() ? `<div class="iw-rev-note">${esc(r.note)}</div>` : ''}
    </div>
    ${canWriteOff ? `<div class="iw-writeoff">
        <label class="iw-writeoff-label">
          <input type="checkbox" class="iw-writeoff-box"${r.removeRemaining ? ' checked' : ''} onchange="App.inspWriteOff(this)">
          <span>${esc(t('app.insp.wz.writeoff_label', { n: remaining }))}</span>
        </label>
        <div class="iw-writeoff-hint">${esc(t('app.insp.wz.writeoff_hint'))}</div>
      </div>` : ''}
    ${diff !== 0 ? `<div class="iw-reasons">${inspReasonChips(r)}</div>` : ''}
  </div>`;
}

function inspReasonChips(r) {
  const opts = inspReasonsFor(r.category);
  const active = r.reasons[0]?.code;
  const splitOn = r.reasons.length > 1;
  // "We used these" is the most common reason a count drops, so it gets a
  // one-tap shortcut instead of hiding inside the generic reason list. It just
  // picks USED_PATIENT_CARE; the backend already treats that reason recorded
  // during an inspection as real consumption.
  const diff = (r.qty ?? r.expected) - r.expected;
  const usedCode = 'USED_PATIENT_CARE';
  const usedAvailable = diff < 0 && opts.some((o) => o.code === usedCode);
  const usedOn = !splitOn && active === usedCode;
  const usedQty = Math.abs(diff);
  return `<div class="iw-chiprow">
      ${usedAvailable ? `<button type="button" class="iw-chip used${usedOn ? ' active' : ''}" onclick="App.inspUsed(this)">${icon('checkCircle')} ${esc(t('app.insp.wz.used_chip', { n: usedQty }))}</button>` : ''}
      ${opts.map((o) => `<button type="button" class="iw-chip reason${active === o.code && !splitOn ? ' active' : ''}" onclick="App.inspReason(this,'${esc(o.code)}')">${esc(reasonLabel(o))}</button>`).join('')}
      <button type="button" class="iw-chip mix${splitOn ? ' active' : ''}" onclick="App.inspSplit(this)">${icon('plus')} ${esc(t('app.insp.wz.split'))}</button>
    </div>` +
    (splitOn ? inspSplitEditor(r) : '');
}

function inspSplitEditor(r) {
  const diff = Math.abs((r.qty ?? r.expected) - r.expected);
  const sum = r.reasons.reduce((s, x) => s + (x.quantity || 0), 0);
  const ok = sum === diff;
  return `<div class="iw-split" data-diff="${diff}">
    <div class="iw-split-hint">${esc(t('app.insp.wz.split_hint'))} <b class="${ok ? 'ok' : 'warn'}">${sum}/${diff}</b></div>
    ${r.reasons.map((x, i) => `<div class="iw-split-row">
      <select class="form-control iw-split-code" onchange="App.inspSplitCode(this,${i})">
        <option value="">${esc(t('reason.pick'))}</option>
        ${inspReasonsFor(r.category).map((o) => `<option value="${esc(o.code)}"${x.code === o.code ? ' selected' : ''}>${esc(reasonLabel(o))}</option>`).join('')}
      </select>
      <input type="number" class="form-control iw-split-qty" min="1" step="1" value="${x.quantity || ''}" oninput="App.inspSplitQty(this,${i})" aria-label="${esc(t('app.insp.wz.split_qty'))}">
      <button type="button" class="icon-btn danger" onclick="App.inspSplitDel(this,${i})" aria-label="${esc(t('ui.remove'))}">${icon('close')}</button>
    </div>`).join('')}
    <button type="button" class="btn btn-ghost btn-sm" onclick="App.inspSplitAdd(this)">${icon('plus')} ${esc(t('app.insp.wz.split_add'))}</button>
  </div>`;
}

function inspRowFromEl(el) {
  const rev = el.closest('.iw-rev');
  return rev ? INSP.rows.get(rev.dataset.id) : null;
}

function inspWriteOff(box) {
  const r = inspRowFromEl(box);
  if (!r) return;
  r.removeRemaining = !!box.checked;
  INSP.dirty = true;
}

function inspUsed(btn) {
  const r = inspRowFromEl(btn);
  if (!r) return;
  const diff = Math.abs((r.qty ?? r.expected) - r.expected);
  // Toggle off if it was already the chosen reason.
  const already = r.reasons.length === 1 && r.reasons[0].code === 'USED_PATIENT_CARE';
  r.reasons = already ? [] : [{ code: 'USED_PATIENT_CARE', quantity: diff }];
  INSP.dirty = true;
  renderInspReview();
}

function inspReason(btn, code) {
  const r = inspRowFromEl(btn);
  if (!r) return;
  const diff = Math.abs((r.qty ?? r.expected) - r.expected);
  r.reasons = [{ code, quantity: diff }];
  INSP.dirty = true;
  renderInspReview();
}

function inspSplit(btn) {
  const r = inspRowFromEl(btn);
  if (!r) return;
  const diff = Math.abs((r.qty ?? r.expected) - r.expected);
  r.reasons = r.reasons.length > 1
    ? [{ code: r.reasons[0]?.code || '', quantity: diff }]
    : [{ code: r.reasons[0]?.code || '', quantity: diff }, { code: '', quantity: 0 }];
  INSP.dirty = true;
  renderInspReview();
}

function inspSplitAdd(btn) {
  const r = inspRowFromEl(btn);
  if (!r) return;
  r.reasons.push({ code: '', quantity: 0 });
  renderInspReview();
}

function inspSplitDel(btn, i) {
  const r = inspRowFromEl(btn);
  if (!r) return;
  r.reasons.splice(i, 1);
  if (!r.reasons.length) r.reasons = [{ code: '', quantity: Math.abs((r.qty ?? r.expected) - r.expected) }];
  INSP.dirty = true;
  renderInspReview();
}

function inspSplitCode(sel, i) {
  const r = inspRowFromEl(sel);
  if (!r) return;
  r.reasons[i].code = sel.value;
  INSP.dirty = true;
}

function inspSplitQty(inp, i) {
  const r = inspRowFromEl(inp);
  if (!r) return;
  r.reasons[i].quantity = Math.max(0, parseInt(inp.value, 10) || 0);
  INSP.dirty = true;
  const split = inp.closest('.iw-split');
  const b = split?.querySelector('b');
  if (b) {
    const diff = parseInt(split.dataset.diff, 10) || 0;
    const sum = r.reasons.reduce((s, x) => s + (x.quantity || 0), 0);
    b.textContent = `${sum}/${diff}`;
    b.className = sum === diff ? 'ok' : 'warn';
  }
}

function inspMarkRest() {
  for (const r of INSP.rows.values()) if (r.qty === null) { r.qty = r.expected; r.condition = 'OK'; }
  INSP.dirty = true;
  renderInspReview();
  renderInspHead();
}

function inspFlagRest() {
  for (const r of INSP.rows.values()) if (r.qty === null) r.condition = 'NOT_CHECKED';
  INSP.dirty = true;
  renderInspReview();
}

// ── Footer + step navigation ───────────────────────────────────

function renderInspFoot() {
  const el = document.getElementById('iwFoot');
  if (!el) return;
  if (INSP.step === 'count') {
    const leftover = [...INSP.rows.values()].filter((r) => r.qty === null).length;
    const diffs = inspReviewRows().length;
    el.innerHTML = `
      <button type="button" class="btn btn-ghost btn-sm" onclick="App.inspClose()">${esc(t('ui.dialog.cancel'))}</button>
      <div class="iw-foot-spacer"></div>
      <span class="iw-foot-note">${diffs ? esc(t('app.insp.wz.foot_diffs', { n: diffs })) : (leftover ? esc(t('app.insp.wz.foot_left', { n: leftover })) : esc(t('app.insp.wz.foot_ready')))}</span>
      <button type="button" class="btn btn-primary" onclick="App.inspNext()">${esc(t('app.insp.wz.to_review'))} ›</button>`;
  } else if (INSP.step === 'review') {
    el.innerHTML = `
      <button type="button" class="btn btn-ghost btn-sm" onclick="App.inspBack()">‹ ${esc(t('app.insp.wz.back'))}</button>
      <div class="iw-foot-spacer"></div>
      <button type="button" class="btn btn-success btn-lg" onclick="App.inspSubmit()">${icon('checkCircle')} ${esc(t('app.insp.wz.submit'))}</button>`;
  } else {
    el.innerHTML = `<div class="iw-foot-spacer"></div><button type="button" class="btn btn-primary" onclick="App.inspClose()">${esc(t('app.insp.wz.done_btn'))}</button>`;
  }
}

async function inspNext() {
  if (INSP.step === 'count') {
    INSP.step = 'review';
    renderInspWizard();
    saveInspDraft();
  } else if (INSP.step === 'review') {
    await inspSubmit();
  }
}

function inspBack() {
  if (INSP.step === 'review') {
    INSP.step = 'count';
    renderInspWizard();
  }
}

async function inspClose() {
  if (INSP.step === 'count' && INSP.dirty) {
    const save = await confirmDialog({
      message: t('app.insp.wz.save_exit'),
      tone: 'info',
      confirmLabel: t('app.insp.wz.save_btn'),
      cancelLabel: t('app.insp.wz.exit_anyway'),
    });
    if (save) { await saveInspDraft(); toast(t('app.insp.wz.draft_saved'), 'success'); }
  }
  closeModal('modal-inspect');
}

// ── Submit (draft → complete) ──────────────────────────────────

/** Builds the API payload from the wizard state. Untouched lines are flagged, never guessed. */
function inspPayload() {
  const items = [];
  for (const r of INSP.rows.values()) {
    const notChecked = r.qty === null;
    const writeOff = !notChecked && r.removeRemaining && (r.qty ?? 0) > 0;
    // A write-off is expressed in the existing vocabulary: the counted quantity
    // becomes zero and the condition's own reason accounts for every unit. That
    // keeps one correction per line and stays reversible via void.
    const qty = notChecked ? r.expected : (writeOff ? 0 : r.qty);
    const condition = notChecked ? 'NOT_CHECKED' : (r.condition || 'OK');
    const line = {
      inventoryId: r.id,
      actualQuantity: qty,
      condition,
    };
    if (r.note && r.note.trim()) line.notes = r.note.trim();

    const diff = qty - r.expected;
    if (!notChecked && diff !== 0) {
      let lines = r.reasons
        .filter((x) => x.code && (x.quantity || 0) > 0)
        .map((x) => ({ code: x.code, quantity: x.quantity }));
      if (writeOff) {
        // Auto-picked write-off of the full remaining count.
        const code = WRITE_OFF_REASON[r.condition] || 'OTHER';
        lines = [{ code, quantity: Math.abs(diff) }];
      }
      if (lines.length) {
        line.reasonLines = lines;
        if (lines.length === 1) line.reasonCode = lines[0].code;
      }
    }
    items.push(line);
  }
  return {
    ambulanceId: S.activeAmbulanceId,
    title: inspTitle(),
    notes: inspNotesText(),
    items,
  };
}

/** Best-effort autosave; failures never block the count. */
async function saveInspDraft() {
  if (!INSP.dirty || !INSP.rows.size || INSP.saving) return;
  INSP.saving = true;
  try {
    const payload = inspPayload();
    if (INSP.draftId) {
      await api.updateInspection(INSP.draftId, payload);
    } else {
      const d = await api.createInspection(payload);
      INSP.draftId = d?.id || d?.inspection?.id || null;
    }
    INSP.dirty = false;
  } catch {
    // Draft is a convenience — the real save happens on submit.
  } finally {
    INSP.saving = false;
  }
}

async function inspSubmit() {
  if (!requireAmbulance()) return;
  // Every real difference must be fully explained before anything is corrected.
  for (const r of INSP.rows.values()) {
    const diff = r.qty === null ? 0 : r.qty - r.expected;
    if (diff === 0) continue;
    const sum = r.reasons.reduce((s, x) => s + (x.quantity || 0), 0);
    if (!r.reasons.length || r.reasons.some((x) => !x.code) || sum !== Math.abs(diff)) {
      INSP.step = 'review';
      renderInspWizard();
      toast(t('app.insp.wz.need_reason', { name: r.name }), 'error');
      const el = document.querySelector(`.iw-rev[data-id="${r.id}"]`);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
  }

  const btn = document.querySelector('#iwFoot .btn-success');
  if (btn) { btn.disabled = true; btn.textContent = t('app.insp.wz.submitting'); }

  try {
    await saveInspDraft();
    if (!INSP.draftId) {
      const d = await api.createInspection(inspPayload());
      INSP.draftId = d?.id || d?.inspection?.id || null;
      INSP.dirty = false;
    }
    const res = await api.completeInspection(INSP.draftId);
    const corrections = res?.corrections || [];
    renderInspDone(corrections);
    await Promise.all([loadInventory(), loadLastInspection()]);
    renderDashboard();
  } catch (err) {
    toast(err.message || 'Submit failed', 'error');
    renderInspFoot();
  }
}

function renderInspDone(corrections) {
  INSP.step = 'done';
  INSP.dirty = false;
  const cats = document.getElementById('iwCats');
  if (cats) cats.innerHTML = '';
  const rows = [...INSP.rows.values()];
  const checked = rows.filter((r) => r.qty !== null).length;
  const missing = rows.filter((r) => r.condition === 'MISSING').length;
  const body = document.getElementById('iwBody');
  if (body) {
    body.oninput = null;
    body.innerHTML = `<div class="iw-done">
      <div class="iw-done-ic">${icon('checkCircle')}</div>
      <div class="iw-done-title">${esc(t('app.insp.wz.done_title'))}</div>
      <div class="iw-done-stats">
        <span>${esc(t('app.insp.wz.done_counted', { n: checked, total: rows.length }))}</span>
        <span class="${corrections.length ? 'warn' : 'ok'}">${esc(t('app.insp.wz.done_corr', { n: corrections.length }))}</span>
        ${missing ? `<span class="neg">${esc(t('app.insp.wz.done_missing', { n: missing }))}</span>` : ''}
      </div>
    </div>`;
  }
  renderInspHead();
  renderInspFoot();
  toast(corrections.length ? t('app.inspect.started') : t('app.insp.sheet.same'), corrections.length ? 'success' : 'info');
}

/** Offers to resume an unfinished draft for this car (server-side, survives a crash). */
async function resumeInspDraft() {
  try {
    const data = await api.inspections({ ambulanceId: S.activeAmbulanceId, status: 'DRAFT', mine: true, pageSize: 5 });
    const draft = (data.inspections || [])[0];
    if (!draft) return;
    const ok = await confirmDialog({
      message: t('app.insp.wz.resume_q', { when: fmtDateTime(draft.performedAt || draft.createdAt) }),
      tone: 'info',
    });
    if (!ok) { api.deleteInspection(draft.id).catch(() => {}); return; }

    const detail = await api.inspection(draft.id);
    INSP.draftId = detail.id;
    let restored = 0;
    (detail.items || []).forEach((it) => {
      const r = INSP.rows.get(it.inventoryId);
      if (!r) return;
      r.condition = it.condition || null;
      r.note = it.notes || '';
      r.qty = it.condition === 'NOT_CHECKED' ? null : it.actualQuantity;
      r.reasons = (it.reasonLines || []).filter((l) => l.reasonCode).map((l) => ({ code: l.reasonCode, quantity: l.quantity }));
      // A saved write-off was already folded into actualQuantity=0, so the box
      // stays unticked on resume: re-ticking would double-count the write-off.
      r.removeRemaining = false;
      restored++;
    });
    INSP.dirty = false;
    renderInspWizard();
    if (restored) toast(t('app.insp.wz.draft_loaded', { n: restored }), 'info');
  } catch {
    // Resume is optional.
  }
}

function checkItem(id) { startInspection(id); }

// ── Use ────────────────────────────────────────────────────────
function openUseModal(id) {
  if (!requireAmbulance()) return;
  const item = findGroup(id) || S.items.find(i => i.id === id);
  if (!item) return;
  S.useId = item.medicineId;
  document.getElementById('use-qty').value = 1;
  document.getElementById('use-notes').value = '';
  mountReasonControl('useReasonControl', {
    itemType: itemTypeForCategory(item.category),
    action: 'USE',
    label: t('modal.use.reason'),
  });
  document.getElementById('useItemInfo').innerHTML = `
    <div style="background:var(--bg);border-radius:10px;padding:14px 16px;">
      <div style="font-size:1rem;font-weight:700;margin-bottom:6px;">${esc(item.name)}${item.size ? ` <span style="font-weight:600;font-size:.8rem;color:var(--text-muted);">(${esc(item.size)})</span>` : ''}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:0.85rem;color:var(--text-muted);">
        <span>${catIcon(item.category)} ${catLabel(item.category)}</span>
        <span>${t('app.use.current_qty')} <strong style="color:var(--text)">${item.quantity}</strong></span>
        ${item.expiry ? `<span>${t('ui.pill.expiry')} <strong>${fmtDate(item.expiry)}</strong></span>` : ''}
      </div>
    </div>`;
  openModal('modal-use');
}

async function confirmUse() {
  if (!requireAmbulance()) return;
  const item = findGroup(S.useId) || S.items.find(i => i.id === S.useId);
  if (!item) return;
  const qty = parseInt(document.getElementById('use-qty').value, 10);
  if (!qty || qty <= 0) { toast(t('app.use.error_qty'), 'error'); return; }
  if (qty > item.quantity) { toast(t('app.use.error_insufficient', { req: qty, avail: item.quantity }), 'error'); return; }
  let picked;
  try { picked = readReasonControl('useReasonControl', { required: true }); }
  catch (err) { toast(err.message, 'error'); return; }
  const extra = document.getElementById('use-notes')?.value.trim() || '';
  const reason = picked.note || extra || picked.code;
  try {
    await api.useMedicine({
      ambulanceId: S.activeAmbulanceId,
      medicineId: item.medicineId,
      quantity: qty,
      reason,
      reasonCode: picked.code,
    });
    closeModal('modal-use');
    toast(t('app.use.toast_used', { qty, name: item.name }));
    await loadInventory();
    renderAll();
  } catch (err) { toast(err.message || String(err), 'error'); }
}

// ── Shift Notes ────────────────────────────────────────────────
function openNoteModal() {
  document.getElementById('note-form').reset();
  openModal('modal-note');
}

async function saveNote(e) {
  e.preventDefault();
  const title = document.getElementById('note-title').value.trim();
  const priority = (document.getElementById('note-prio').value || 'medium').toUpperCase();
  const content = document.getElementById('note-content').value.trim();
  if (!title || !content) { toast(t('app.toast.fill_required'), 'error'); return; }
  try {
    await api.createShiftNote({
      stationId: S.stationId,
      title,
      content,
      priority,
      author: me().name,
    });
    closeModal('modal-note');
    toast(t('app.toast.note_added'));
    await loadShiftNotes();
    renderShiftNotesList();
  } catch (err) { toast(err.message, 'error'); }
}

/**
 * Removes a shift note. The server keeps it (soft delete) so a supervisor can
 * put it back — nothing is ever destroyed from here.
 */
async function deleteShiftNote(id) {
  const note = S.shiftNotes.find((n) => n.id === id);
  if (!note || !can('shiftnote:delete')) return;
  if (!await confirmDialog({ message: t('app.confirm.delete_note'), tone: 'danger', title: t('ui.dialog.title_delete') })) return;
  const reason = await promptDialog({ message: t('app.confirm.delete_note_reason'), tone: 'danger', title: t('ui.dialog.title_delete'), value: '' }) ?? null;
  if (reason === null) return;
  try {
    await api.deleteShiftNote(id, reason.trim() ? reason.trim() : undefined);
    toast(t('app.toast.note_deleted'));
    await loadShiftNotes();
    renderShiftNotesList();
  } catch (err) { toast(err.message, 'error'); }
}

/** Supervisor/admin undo of a removed shift note. */
async function restoreShiftNote(id) {
  if (!can('shiftnote:restore')) return;
  if (!await confirmDialog({ message: t('app.confirm.restore_note'), tone: 'info' })) return;
  try {
    await api.restoreShiftNote(id);
    toast(t('app.toast.note_restored'));
    await loadShiftNotes();
    renderShiftNotesList();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Reports ────────────────────────────────────────────────────
function buildReportText() {
  const station = getStation();
  const changes = computeChanges();
  const alerts = getAlerts();
  const used = changes.filter(c => c.diff < 0);
  let r = '══════════════════════════════════\n';
  r += `${t('app.report.title')}\n`;
  r += '══════════════════════════════════\n\n';
  r += `${t('app.report.station')}     ${station.stationName}\n`;
  r += `${t('app.report.callsign')} ${station.stationCallSign}\n`;
  r += `${t('app.report.paramedic')}     ${station.paramedicName}\n`;
  r += `${t('app.report.empid')} ${station.paramedicId}\n`;
  r += `${t('app.report.shift')}      ${station.shiftType}\n`;
  r += `${t('app.report.date')}    ${fmtDateTime(new Date().toISOString())}\n\n`;
  if (used.length) {
    r += `${t('app.report.used', { n: used.length })}:\n`;
    used.forEach(c => { r += `  • ${c.name}: ${c.prevQty} → ${c.currQty} (${t('app.report.used_unit', { n: Math.abs(c.diff) })})\n`; });
    r += '\n';
  }
  if (alerts.expired.length) {
    r += `${t('app.report.expired', { n: alerts.expired.length })}:\n`;
    alerts.expired.forEach(a => { r += `  ✕ ${a.name} (${catLabel(a.category)})\n`; });
    r += '\n';
  }
  if (S.shiftNotes.length) {
    r += `${t('app.report.notes')}\n`;
    S.shiftNotes.slice(0, 5).forEach(n => {
      const p = { high: '🔴', medium: '🟡', low: '🟢' };
      r += `  ${p[(n.priority || 'medium').toLowerCase()] || '•'} ${n.title}: ${n.content}\n`;
    });
    r += '\n';
  }
  r += '══════════════════════════════════\n';
  r += `${t('app.report.total', { n: groupedItems().length })}\n`;
  return r;
}

function openReportModal() {
  S.reportText = buildReportText();
  document.getElementById('reportPreview').textContent = S.reportText;
  openModal('modal-report');
}

async function sendReport() {
  const station = getStation();
  const changes = computeChanges();
  const alerts = getAlerts();
  const text = document.getElementById('reportPreview').textContent || S.reportText;
  try {
    await api.createReport({
      stationId: S.stationId,
      title: t('app.report.subject', { station: station.stationName, date: new Date().toISOString().slice(0, 10) }),
      reportText: text,
      data: {
        changes,
        alerts: {
          expired: alerts.expired.map(a => ({ name: a.name, category: a.category, expiry: earliestExpiry(a) })),
        },
        shiftNotes: S.shiftNotes.slice(0, 10),
        itemsSnapshot: S.items.map(i => ({ id: i.id, name: i.name, quantity: i.quantity, category: i.category, expiry: i.expiry })),
      },
    });
    closeModal('modal-report');
    toast(t('app.toast.report_sent'));
  } catch (err) { toast(err.message, 'error'); }
}

function copyReport() {
  const text = document.getElementById('reportPreview').textContent || S.reportText;
  navigator.clipboard?.writeText(text).then(() => toast(t('app.toast.report_copied')));
}

// ── Handovers (actions) ────────────────────────────────────────
function cancelHandoverForm() {
  const station = getStation();
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('ho-name', station.paramedicName || '');
  set('ho-id', station.paramedicId || '');
  const shift = document.getElementById('ho-shift');
  if (shift) shift.value = SHIFT_IDS.includes(String(station.shiftType || '').slice(0, 1)) ? String(station.shiftType).slice(0, 1) : '';
  set('ho-patients', '0');
  set('ho-equip-status', 'All OK');
  set('ho-issues', '');
  set('ho-meds', '');
  set('ho-notes', '');
}

async function submitHandover() {
  const name = document.getElementById('ho-name')?.value.trim();
  if (!name) { toast(t('app.toast.name_required'), 'error'); return; }
  if (S.handovers.some(h => h.status === 'submitted')) {
    toast(t('app.toast.handover_exists'), 'error');
    return;
  }
  const station = getStation();
  const hoShiftCode = document.getElementById('ho-shift')?.value.trim() || '';
  const outgoing = {
    paramedicName: name,
    paramedicId: document.getElementById('ho-id')?.value.trim() || station.paramedicId || undefined,
    shiftType: hoShiftCode ? shiftLabel(hoShiftCode, station.shiftPeriod) : station.shiftType || undefined,
    patientsCount: parseInt(document.getElementById('ho-patients')?.value, 10) || 0,
    equipStatus: document.getElementById('ho-equip-status')?.value || 'All OK',
    pendingIssues: document.getElementById('ho-issues')?.value.trim() || undefined,
    medicationsUsed: document.getElementById('ho-meds')?.value.trim() || undefined,
    notes: document.getElementById('ho-notes')?.value.trim() || undefined,
  };
  try {
    await api.createHandover({ stationId: S.stationId, outgoing });
    toast(t('app.toast.handover_sent'), 'success');
    await loadHandovers();
    renderAll();
  } catch (err) { toast(err.message, 'error'); }
}

async function acknowledgeHandoverForm(id) {
  const name = document.getElementById('ack-name')?.value.trim();
  if (!name) { toast(t('app.toast.name_required'), 'error'); return; }
  const empId = document.getElementById('ack-id')?.value.trim();
  const notes = document.getElementById('ack-notes')?.value.trim();
  try {
    await api.acknowledgeHandover(id, {
      incoming: {
        paramedicName: name,
        paramedicId: empId || undefined,
        notes: notes || undefined,
      },
    });
    toast(t('app.toast.handover_ack'), 'success');
    await loadHandovers();
    renderAll();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Export ─────────────────────────────────────────────────────
function exportCSV(cat) {
  const data = groupRows(cat === 'all' ? S.items : S.items.filter(i => i.category === cat));
  const headers = [
    t('ui.history.name'), t('ui.history.category'), t('ui.history.qty'),
    t('ui.pill.size'), t('ui.history.expiry'), t('ui.history.batch'), t('ui.history.supplier'),
  ];
  const rows = data.flatMap(group =>
    group.batches.map(b => [
      group.name, catLabel(group.category), b.quantity,
      group.size || '', b.expiry ? fmtDate(b.expiry) : '',
      b.batchNumber || '', b.supplier || '',
    ])
  );
  let csv = '\uFEFF' + headers.join(',') + '\n';
  rows.forEach(r => { csv += r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',') + '\n'; });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aems_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  toast(t('app.toast.exported'));
}

const EXPORT_FORMAT = 'aems-inventory';
const EXPORT_VERSION = 1;

function fmtISODate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const p = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Exports the current stock as a nested, human-readable JSON file
 * (items → batches → per-unit distribution). Re-importing the same file once
 * the units were deleted restores the exact same data (round-trip safe).
 */
function exportInventory(cat) {
  const rows = cat === 'all' ? S.items : S.items.filter(i => i.category === cat);
  const byMed = new Map();

  rows.forEach(item => {
    const raw = item._inv || {};
    const med = raw.batch?.medicine || {};
    if (!byMed.has(item.medicineId)) {
      byMed.set(item.medicineId, {
        name: med.name || item.name,
        category: med.category || (item.category || 'MEDICATION').toUpperCase(),
        size: med.size ?? item.size ?? null,
        strength: med.strength ?? null,
        dosageForm: med.dosageForm ?? null,
        genericName: med.genericName ?? null,
        unit: med.unit ?? item.unit ?? null,
        barcode: med.barcode ?? item.storeCode ?? null,
        serialNumber: med.serialNumber ?? item.serial ?? null,
        location: med.location ?? item.location ?? null,
        notes: med.notes ?? item.notes ?? null,
        technicalNotes: med.technicalNotes ?? item.technicalNotes ?? null,
        batches: new Map(),
      });
    }
    const g = byMed.get(item.medicineId);
    const key = (item.batchId || '') + '::' + (item.batchNumber || '');
    if (!g.batches.has(key)) {
      g.batches.set(key, {
        batchNumber: item.batchNumber || '',
        expiryDate: fmtISODate(item.expiry),
        receivedDate: raw.batch?.receivedDate ? fmtISODate(raw.batch.receivedDate) : null,
        supplier: item.supplier || null,
        quantity: 0,
        distribution: new Map(),
      });
    }
    const b = g.batches.get(key);
    b.quantity += item.quantity || 0;
    const vehicle = raw.ambulance?.vehicleNumber || null;
    if (vehicle) b.distribution.set(vehicle, (b.distribution.get(vehicle) || 0) + (item.quantity || 0));
  });

  const items = Array.from(byMed.values()).map(g => ({
    name: g.name,
    category: g.category,
    size: g.size,
    strength: g.strength,
    dosageForm: g.dosageForm,
    genericName: g.genericName,
    unit: g.unit,
    barcode: g.barcode,
    serialNumber: g.serialNumber,
    location: g.location,
    notes: g.notes,
    technicalNotes: g.technicalNotes,
    batches: Array.from(g.batches.values()).map(b => {
      const batch = {
        batchNumber: b.batchNumber,
        expiryDate: b.expiryDate,
        receivedDate: b.receivedDate,
        supplier: b.supplier,
      };
      if (b.distribution.size > 1) {
        batch.distribution = Array.from(b.distribution.entries()).map(([vehicle, quantity]) => ({ vehicle, quantity }));
      } else {
        batch.quantity = b.quantity;
      }
      return batch;
    }),
  }));

  const payload = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      station: S.stationName || '—',
      unit: S.ambulances.find(a => a.id === S.activeAmbulanceId)?.vehicleNumber || null,
    },
    stats: {
      items: items.length,
      batches: items.reduce((s, i) => s + i.batches.length, 0),
      units: items.reduce((s, i) => s + i.batches.reduce((x, b) => x + (b.quantity || 0), 0), 0),
    },
    items,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aems_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  toast(t('app.toast.exported'));
}

// ── Import (JSON) ─────────────────────────────────────────────
let importPayload = null;
let importResult = null;

function importItemUnits(it) {
  return (it.batches || []).reduce((sum, b) => {
    if (Array.isArray(b.distribution) && b.distribution.length) {
      return sum + b.distribution.reduce((s, d) => s + (d.quantity || 0), 0);
    }
    return sum + (b.quantity || 0);
  }, 0);
}

function openImportModal() {
  importPayload = null;
  importResult = null;
  ['import-drop', 'import-preview', 'import-result'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  document.getElementById('import-drop').hidden = false;
  document.getElementById('importFile').value = '';
  openModal('modal-import');
}

function readImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || data.format !== EXPORT_FORMAT || data.version !== EXPORT_VERSION) {
        throw new Error(t('modal.import.unsupported'));
      }
      if (!Array.isArray(data.items) || data.items.length === 0) {
        throw new Error(t('modal.import.empty'));
      }
      importPayload = data;
      renderImportPreview();
    } catch (err) {
      importPayload = null;
      openImportModal();
      toast(err.message, 'error');
    }
  };
  reader.onerror = () => toast(t('modal.import.read_failed'), 'error');
  reader.readAsText(file);
}

function onImportFile(input) {
  readImportFile(input.files && input.files[0]);
}

function onImportDrop(ev) {
  ev.preventDefault();
  const zone = document.getElementById('import-drop');
  if (zone) zone.classList.remove('dragover');
  readImportFile(ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]);
}

function renderImportPreview() {
  if (!importPayload) return;
  const items = importPayload.items;
  const batches = items.reduce((s, i) => s + (i.batches || []).length, 0);
  const units = items.reduce((s, i) => s + importItemUnits(i), 0);

  document.getElementById('import-summary-items').textContent = items.length;
  document.getElementById('import-summary-batches').textContent = batches;
  document.getElementById('import-summary-units').textContent = units;

  const unitName = S.ambulances.find(a => a.id === S.activeAmbulanceId)?.vehicleNumber
    || t('modal.import.first_unit');
  document.getElementById('import-target-unit').textContent = unitName;

  const list = document.getElementById('import-item-list');
  list.innerHTML = items.map(it => `
    <div class="imp-item">
      <div class="imp-item-main">
        <span class="imp-item-name">${esc(it.name)}</span>
        <span class="imp-item-cat">${esc(catLabel((it.category || '').toLowerCase()))}</span>
      </div>
      <span class="imp-item-meta">${(it.batches || []).length} ${t('modal.import.batches')} · ${importItemUnits(it)} ${t('modal.import.units')}</span>
    </div>`).join('');

  document.getElementById('import-preview').hidden = false;
}

async function confirmImport() {
  if (!importPayload) return;
  const btn = document.getElementById('importConfirmBtn');
  btn.disabled = true;
  try {
    const payload = { ambulanceId: S.activeAmbulanceId || null, items: importPayload.items };
    const res = await api.importInventory(payload);
    importResult = res.data;
    await loadInventory();
    renderAll();
    renderImportResult();
    toast(t('app.toast.imported'), 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function renderImportResult() {
  const r = importResult;
  if (!r) return;
  document.getElementById('import-drop').hidden = true;
  document.getElementById('import-preview').hidden = true;

  document.getElementById('import-res-created').textContent = r.items.created;
  document.getElementById('import-res-restored').textContent = r.items.restored;
  document.getElementById('import-res-merged').textContent = r.items.merged;
  document.getElementById('import-res-units').textContent = r.units;

  const list = document.getElementById('import-status-list');
  list.innerHTML = (r.statuses || []).map(st => `
    <div class="imp-item">
      <div class="imp-item-main">
        <span class="imp-item-name">${esc(st.name)}</span>
        <span class="imp-item-cat">${st.batches} ${t('modal.import.batches')} · ${st.units} ${t('modal.import.units')}</span>
      </div>
      <span class="imp-status imp-${st.status}">${t(`modal.import.status_${st.status}`)}</span>
    </div>`).join('');

  const warnBox = document.getElementById('import-warnings');
  const warns = r.warnings || [];
  if (warns.length) {
    warnBox.hidden = false;
    warnBox.innerHTML = warns.map(w => `<div class="import-warn-line">${esc(w)}</div>`).join('');
  } else {
    warnBox.hidden = true;
  }
  document.getElementById('import-result').hidden = false;
}

function resetImport() {
  importPayload = null;
  openImportModal();
}

// ── Render all ─────────────────────────────────────────────────
function renderAll() {
  if (S.currentPage === 'equipment') renderEquipmentPage();
  else if (S.currentPage === 'all') renderAllPage();
  else if (S.currentPage === 'history') renderHistoryPage();
  else if (S.currentPage === 'handover') renderHandoverPage();
  else renderDashboard();
}

// ── Static events ──────────────────────────────────────────────
function wireStaticEvents() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      // A forced duty pick (no unit yet) must not be dismissable.
      if (window.AEMS_DUTY_FORCE) return;
      closeAllModals();
    }
  });
  document.getElementById('catTabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.cat-tab');
    if (btn) {
      S.currentCat = btn.dataset.cat;
      navigateTo('equipment', S.currentCat);
    }
  });
  document.getElementById('searchAll')?.addEventListener('input', e => {
    S.searchTerm = e.target.value;
    renderAllPage();
  });
  document.getElementById('filterCat')?.addEventListener('change', e => {
    S.filterCat = e.target.value;
    renderAllPage();
  });
  document.getElementById('filterExpiry')?.addEventListener('change', e => {
    S.filterExpiry = e.target.value;
    renderAllPage();
  });
  document.getElementById('searchEquip')?.addEventListener('input', e => {
    const term = e.target.value.toLowerCase();
    const filtered = S.items.filter(i => i.category === S.currentCat &&
      (i.name.toLowerCase().includes(term) || (i.location || '').toLowerCase().includes(term) ||
       (i.serial || '').toLowerCase().includes(term) || (i.storeCode || '').toLowerCase().includes(term)));
    renderItemsGrid(filtered, 'equipmentList');
  });
  document.querySelectorAll('.view-toggle').forEach(tg => {
    tg.addEventListener('click', e => {
      const btn = e.target.closest('.view-btn');
      if (btn) setView(btn.dataset.view);
    });
  });
  syncViewToggle();
  document.querySelectorAll('.search-field').forEach(f => {
    const inp = f.querySelector('.search-input');
    const btn = f.querySelector('.search-clear');
    const upd = () => f.classList.toggle('has-text', !!(inp && inp.value));
    inp?.addEventListener('input', upd);
    btn?.addEventListener('click', () => {
      if (!inp) return;
      inp.value = '';
      upd();
      inp.dispatchEvent(new Event('input'));
      inp.focus();
    });
    upd();
  });
  document.getElementById('sidebarToggle')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('open');
    document.getElementById('sidebarOverlay')?.classList.toggle('open');
  });
  document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebarOverlay')?.classList.remove('open');
  });
  const inspEl = document.getElementById('inspDateTime');
  if (inspEl) inspEl.value = nowLocal();
  [document.getElementById('appLangToggle'), document.getElementById('settingsLangToggle')].forEach(btn => {
    btn?.addEventListener('click', () => {
      setLanguage(getCurrentLang() === 'en' ? 'ar' : 'en');
    });
  });
}

// ── Init ───────────────────────────────────────────────────────
async function init() {
  initFirebase(FIREBASE_CONFIG);
  initI18n();
  wireStaticEvents();
  setConnection(t('app.conn.live'), false);
  startHealthMonitor();

  const session = await initAppSession();
  if (!session) {
    window.location.href = '/login.html';
    return;
  }
  if (session.user.role === 'ADMIN' || session.user.role === 'SUPERVISOR') {
    window.location.href = session.user.role === 'ADMIN' ? '/admin.html' : '/supervisor.html';
    return;
  }

  S.session = session;
  S.user = session.user;
  S.permissions = session.permissions || [];
  window.AEMS_PERMS = S.permissions;
  initNotificationCenter();
  S.ambulances = session.ambulances || [];
  S.dutyRoster = session.dutyRoster || [];
  // The active unit is the user's station (server-managed, admin-set roster).
  S.activeUnit = session.user.station ? { ...session.user.station } : null;
  S.stationId = session.user.station?.id || null;
  S.stationName = session.user.station ? unitLabel(session.user.station.code, session.user.station.name) : '-';
  // The car within the unit is a local pick from the unit's vehicles.
  pickActiveCar();

  updateUserUI();
  updateSidebar();
  loadStationInfo();
  initDutyCalendar();

  if (!S.stationId && !S.dutyRoster.length) {
    setConnection(t('app.conn.no_unit'), false);
    renderAll();
    document.getElementById('pageLoader')?.classList.add('hide');
    return;
  }

  // No duty unit yet but a roster exists → force the pick before stock loads.
  if (!S.stationId) {
    openDutySwitchModal(true);
  }

  try {
    await loadAll();
    setConnection(t('app.conn.online'), true);
  } catch (err) {
    setConnection(t('app.conn.load_failed'), false);
    toast(err.message, 'error');
  }
  renderAll();
  document.getElementById('pageLoader')?.classList.add('hide');
  S.ready = true;
}

// Reactive i18n: when the language changes, every JS-rendered view is rebuilt
// from state and any open item modal is re-translated without losing input.
onLanguageChanged(() => {
  if (!S.ready) return;
  updateUserUI();
  updateSidebar();
  refreshItemModalText();
  renderDutyCalendar();
  if (S.currentPage) navigateTo(S.currentPage, S.currentCat);
});

window.App = {
  navigateTo,
  openDutySwitch: () => openDutySwitchModal(false),
  confirmDutySwitch,
  selectCat: (cat) => navigateTo('equipment', cat),
  setView,
  toggleTree,
  openAddModal,
  openEditModal,
  openEditBatch,
  onSaveItem,
  saveItem: onSaveItem,
  openDeleteModal,
  confirmDelete,
  deleteStockLine,
  openMedicineDelete,
  setAddMode,
  onNameInput,
  openBatchEdit,
  confirmBatchEdit,
  addBatch,
  removeBatch,
  toggleBatches,
  showAllBatches,
  checkItem,
  markChecked: checkItem,
  inspClose,
  inspGoCat,
  inspCond,
  inspUsed,
  inspWriteOff,
  inspNext,
  inspBack,
  inspReason,
  inspSplit,
  inspSplitAdd,
  inspSplitDel,
  inspSplitCode,
  inspSplitQty,
  inspMarkRest,
  inspFlagRest,
  inspSubmit,
  onReasonChange,
  openUseModal,
  confirmUse,
  openSupplyModal,
  confirmSupply,
  cancelSupply,
  receiveSupply,
  startInspection,
  openNoteModal,
  saveNote,
  deleteShiftNote,
  restoreShiftNote,
  openReportModal,
  sendReport,
  copyReport,
  exportCSV,
  exportCurrentCat: () => exportCSV(S.currentCat || 'medication'),
  exportInventory,
  exportInventoryCurrent: () => exportInventory(S.currentCat || 'medication'),
  exportInventoryAll: () => exportInventory('all'),
  openImportModal,
  onImportFile,
  onImportDrop,
  confirmImport,
  resetImport,
  saveStationInfoAction,
  openChangePassword: () => openChangePasswordDialog(),
  submitHandover,
  cancelHandoverForm,
  acknowledgeHandoverForm,
  hasPermission: can,
  get currentCat() { return S.currentCat; },
  filterByExpiry: (s) => { S.filterExpiry = s; navigateTo('all'); },
  logout: () => signOutAll(),
};

init();
