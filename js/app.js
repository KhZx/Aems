// js/app.js — AEMS paramedic app (REST API + inventory model)

import { initI18n, setLanguage, getCurrentLang, onLanguageChanged, t, unitLabel } from './i18n.js';
import { FIREBASE_CONFIG } from './config.js';
import { initFirebase } from './services/firebase.js';
import { api } from './api.js';
import { initAppSession, signOutAll, getSession, setSession } from './auth.js';
import { startHealthMonitor } from './health.js';
import {
  renderItemCard, renderItemRow, renderAlertCard, renderShiftNote, renderChangeItem, renderBatchItem, toggleTree,
  emptyState, toast, openModal, closeModal, closeAllModals,
  catIcon, catLabel, catColor, fmtDate, fmtDateTime, earliestExpiry, expiryStatus,
} from './ui.js';
import { CATEGORIES } from './data/initial-data.js';
import { icon, mountSprite } from './icons.js';
import { initDutyCalendar, renderDutyCalendar } from './duty-calendar.js';

mountSprite();

// Shifts are fixed to A / B / C / D, each either morning or night.
const SHIFT_IDS = ['A', 'B', 'C', 'D'];
const SHIFT_PERIODS = ['Morning', 'Night'];
function shiftLabel(code, period) {
  const c = SHIFT_IDS.includes(code) ? code : '';
  const p = SHIFT_PERIODS.includes(period) ? period : '';
  if (c && p) return `${c} – ${p}`;
  return c || p || '';
}

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
  if (S.activeAmbulanceId) return true;
  toast(t('app.inspect.no_car'), 'error');
  return false;
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
  const data = await api.inventory({ stationId: S.stationId, includeEmpty: true });
  const rows = Array.isArray(data) ? data : (data.items || []);
  S.items = rows.map(normalizeItem);
  if (rows.length && rows[0].ambulance && !S.activeAmbulanceId) {
    S.activeAmbulanceId = rows[0].ambulance.id;
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
  PENDING:    { color: '#D97706', key: 'supply.status.pending' },
  APPROVED:   { color: '#2563EB', key: 'supply.status.approved' },
  REJECTED:   { color: '#DC2626', key: 'supply.status.rejected' },
  FULFILLED:  { color: '#059669', key: 'supply.status.fulfilled' },
  CANCELLED:  { color: '#64748B', key: 'supply.status.cancelled' },
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
        ${canCancel ? `
        <div style="margin-top:10px;">
          <button class="btn btn-ghost btn-sm" onclick="App.cancelSupply('${r.id}')">${t('supply.cancel')}</button>
        </div>` : ''}
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
  if (!confirm(t('supply.cancel_confirm'))) return;
  try {
    await api.cancelSupplyRequest(id);
    toast(t('supply.cancelled'));
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
  renderStats();
  renderCharts();
  renderAlertsList();
  renderShiftNotesList();
  renderChangesPanel();
  updateHandoverBanner();
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
  if (!S.stationId) {
    el.className = 'items-grid';
    el.innerHTML = emptyState(icon('ambulance'), t('app.empty.no_unit'));
    return;
  }
  const groups = groupRows(items);
  if (!groups.length) {
    el.className = 'items-grid';
    el.innerHTML = emptyState(icon('package'), t('app.empty.no_equipment'));
    return;
  }
  el.className = S.view === 'list' ? 'inventory-list' : 'items-grid';
  el.innerHTML = S.view === 'list'
    ? renderInventoryRows(groups)
    : groups.map(g => renderItemCard(g, snapshotItems())).join('');
}

function renderInventoryRows(groups) {
  const snapshot = snapshotItems();
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

  return `<div class="inv-list">${summary}${groups.map(g => renderItemRow(g, snapshot)).join('')}</div>`;
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
  DELETE_STOCK: { key: 'ui.audit.delete_lot', color: 'var(--danger)' },
  LOGIN: { key: 'ui.audit.login', color: '#64748B' },
};

const PRIORITY_LBL = { HIGH: 'modal.note.prio.high', MEDIUM: 'modal.note.prio.med', LOW: 'modal.note.prio.low' };

function auditDetails(log) {
  const m = log.metadata || {};
  const name = m.medicineName || m.title || m.itemName || '';
  switch (log.action) {
    case 'USE_MEDICINE': return t('ui.audit.use_d', { name: name || t('ui.medicine'), qty: m.quantity ?? '' });
    case 'RESTOCK': return t('ui.audit.restock_d', { name: name || t('ui.item'), qty: m.quantity ?? '', batch: m.batchNumber ? ` (${m.batchNumber})` : '' });
    case 'ADJUST': return t('ui.audit.adjust_d', { name: name || t('ui.item'), to: m.to ?? m.newQuantity ?? '' });
    case 'INSPECTION': {
      let s = t('ui.audit.inspect_d', { n: m.itemCount ?? '' });
      if (m.corrections?.length) s += t('ui.audit.corrected_d', { n: m.corrections.length });
      return s.trim();
    }
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
    case 'LOGIN': return t('ui.audit.login_d');
    default: return '';
  }
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
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(`page-${page}`);
  if (el) el.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
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
  el.innerHTML = `
    <div class="user-name">${esc(u.displayName || t('app.user.paramedic'))}</div>
    <div class="user-email">${esc(u.email || '')}</div>
    <button class="btn-logout" onclick="App.logout()">${t('app.user.logout')}</button>`;
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
  if (mode === 'restock') prepareRestockSelector();
  refreshItemModalText();
}

async function openAddModal() {
  if (!requireAmbulance()) return;
  S.editMode = 'add';
  S.addMode = 'new';
  S.editInventoryId = null;
  S.tempBatches = [];
  document.getElementById('modal-item-title').textContent = t('modal.item.add');
  document.getElementById('f-form').reset();
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
  fMed.innerHTML = `<option value="">${t('app.restock.select_medicine')}</option>` +
    S.medicines.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');

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
  document.getElementById('reasonGroup').style.display = S.editQtyAllowed ? 'block' : 'none';

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
      await api.deleteStock(target.inventoryId);
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
        if (!confirm(t('app.confirm.delete_medicine_fleet', { name: target.name || '' }))) return;
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
          <button type="button" class="batch-btn" onclick="App.openEditBatch('${esc(group.medicineId)}','${esc(b.id)}')" title="${t('ui.btn.edit')}"><svg class="ic" aria-hidden="true"><use href="#i-edit"/></svg></button>
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

async function onSaveItem(e) {
  e.preventDefault();
  if (S.editMode === 'adjust') {
    const item = S.items.find(i => i.id === S.editInventoryId);
    if (!item) return;
    const canQty = !!S.editQtyAllowed;
    const canExp = !!S.editExpiryAllowed;
    const qtyVal = canQty ? parseInt(document.getElementById('f-qty').value, 10) : null;
    const reason = canQty ? document.getElementById('f-reason').value.trim() : '';
    const expVal = canExp ? document.getElementById('f-expiry').value : '';
    const qtyChanged = canQty && !isNaN(qtyVal) && qtyVal >= 0 && qtyVal !== item.quantity;
    const expChanged = canExp && !!expVal && expVal !== (item.expiry ? item.expiry.slice(0, 10) : '');
    if (!qtyChanged && !expChanged) { closeModal('modal-item'); toast(t('sup.toast.data_refreshed'), 'success'); return; }
    if (qtyChanged && reason.length < 2) { toast(t('app.adjust.error_reason'), 'error'); return; }
    try {
      if (qtyChanged) await api.adjust({ inventoryId: S.editInventoryId, newQuantity: qtyVal, reason });
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
      let knownBatches = [];
      try {
        const bd = await api.batches({ medicineId: med.id, activeOnly: true, pageSize: 500 });
        knownBatches = (bd.batches || []).map(x => ({ id: x.id, batchNumber: x.batchNumber }));
      } catch {}
      for (let i = 0; i < S.tempBatches.length; i++) {
        const b = S.tempBatches[i];
        const lot = (b.batchNumber || '').trim();
        const dup = lot ? knownBatches.find(x => x.batchNumber === lot) : null;
        let batchId = dup ? dup.id : null;
        if (!batchId) {
          const batch = await api.createBatch({
            medicineId: med.id,
            batchNumber: lot || `LOT-${Date.now().toString(36).toUpperCase()}${i}`,
            expiryDate: b.expiry,
            receivedDate: nowLocal().slice(0, 10),
            supplier: b.supplier || '',
          });
          batchId = batch.id;
          knownBatches.push({ id: batch.id, batchNumber: lot });
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
async function checkItem(id) {
  if (!requireAmbulance()) return;
  const group = findGroup(id);
  const single = S.items.find(i => i.id === id);
  if (!group && !single) return;
  const name = group ? group.name : single.name;
  const items = group
    ? group.batches.map(b => ({ inventoryId: b.id, actualQuantity: b.quantity }))
    : [{ inventoryId: single.id, actualQuantity: single.quantity }];
  try {
    await api.createInspection({
      ambulanceId: S.activeAmbulanceId,
      notes: t('app.inspect.quick_note', { name: me().name }),
      items,
    });
    toast(t('app.toast.checked', { name }));
  } catch (err) { toast(err.message, 'error'); }
}

async function startInspection() {
  if (!S.activeAmbulanceId) { toast(t('app.inspect.no_car'), 'error'); return; }
  if (!S.items.length) { toast(t('app.inspect.no_items'), 'error'); return; }
  const inspType = document.getElementById('inspType')?.value || 'daily';
  const inspNotes = document.getElementById('inspNotes')?.value.trim() || null;
  const notes = [inspType.toUpperCase(), inspNotes].filter(Boolean).join(' — ');
  const items = S.items.map(i => ({ inventoryId: i.id, actualQuantity: i.quantity }));
  try {
    for (let i = 0; i < items.length; i += 400) {
      await api.createInspection({
        ambulanceId: S.activeAmbulanceId,
        notes: i === 0 ? notes : null,
        items: items.slice(i, i + 400),
      });
    }
    await loadLastInspection();
    renderDashboard();
    toast(t('app.inspect.started'), 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// ── Use ────────────────────────────────────────────────────────
function openUseModal(id) {
  if (!requireAmbulance()) return;
  const item = findGroup(id) || S.items.find(i => i.id === id);
  if (!item) return;
  S.useId = item.medicineId;
  document.getElementById('use-qty').value = 1;
  document.getElementById('use-reason').value = '';
  document.getElementById('use-notes').value = '';
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
  const item = findGroup(S.useId) || S.items.find(i => i.id === S.useId);
  if (!item) return;
  const qty = parseInt(document.getElementById('use-qty').value, 10);
  const reason = document.getElementById('use-reason').value.trim();
  if (!qty || qty <= 0) { toast(t('app.use.error_qty'), 'error'); return; }
  if (qty > item.quantity) { toast(t('app.use.error_insufficient', { req: qty, avail: item.quantity }), 'error'); return; }
  if (reason.length < 2) { toast(t('app.adjust.error_reason'), 'error'); return; }
  try {
    await api.useMedicine({
      ambulanceId: S.activeAmbulanceId,
      medicineId: item.medicineId,
      quantity: qty,
      reason,
    });
    closeModal('modal-use');
    toast(t('app.use.toast_used', { qty, name: item.name }));
    await loadInventory();
    renderAll();
  } catch (err) { toast(err.message, 'error'); }
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
  if (!confirm(t('app.confirm.delete_note'))) return;
  const reason = window.prompt(t('app.confirm.delete_note_reason'), '') ?? null;
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
  if (!confirm(t('app.confirm.restore_note'))) return;
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
  addBatch,
  removeBatch,
  toggleBatches,
  showAllBatches,
  checkItem,
  markChecked: checkItem,
  openUseModal,
  confirmUse,
  openSupplyModal,
  confirmSupply,
  cancelSupply,
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
  submitHandover,
  cancelHandoverForm,
  acknowledgeHandoverForm,
  hasPermission: can,
  get currentCat() { return S.currentCat; },
  filterByExpiry: (s) => { S.filterExpiry = s; navigateTo('all'); },
  logout: () => signOutAll(),
};

init();
