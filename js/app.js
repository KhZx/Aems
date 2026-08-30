// js/app.js — AEMS paramedic app (REST API + inventory model)

import { initI18n, setLanguage, getCurrentLang, onLanguageChanged, t } from './i18n.js';
import { FIREBASE_CONFIG } from './config.js';
import { initFirebase } from './services/firebase.js';
import { api } from './api.js';
import { initAppSession, signOutAll, getSession, setSession } from './auth.js';
import { startHealthMonitor } from './health.js';
import {
  renderItemCard, renderAlertCard, renderShiftNote, renderChangeItem, renderBatchItem,
  emptyState, toast, openModal, closeModal, closeAllModals,
  catIcon, catLabel, catColor, fmtDate, fmtDateTime, earliestExpiry, expiryStatus,
} from './ui.js';
import { CATEGORIES } from './data/initial-data.js';
import { icon, mountSprite } from './icons.js';

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
  activeAmbulanceId: null,
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
    minimal: m.minimumStock ?? null,
    maximal: m.maximumStock ?? null,
    expiry: row.batch?.expiryDate || null,
    unit: m.unit || '',
    strength: m.strength || '',
    supplier: row.batch?.supplier || '',
    location: m.location || null,
    notes: m.notes || null,
    technicalNotes: m.technicalNotes || null,
    serial: m.serialNumber || null,
    storeCode: m.barcode || null,
    batches: null,
    lastCheck: null,
    _inv: row,
  };
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
  const data = await api.shiftNotes({ stationId: S.stationId, pageSize: 50 });
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
  const item = S.items.find(i => i.id === id) || S.items.find(i => i.medicineId === id);
  if (!item) { toast(t('supply.no_item'), 'error'); return; }
  S.supplyTargetItem = item;
  const el = document.getElementById('supplyItemInfo');
  if (el) {
    const active = S.ambulances.find(a => a.id === S.activeAmbulanceId);
    const vehicle = active?.vehicleNumber || t('supply.no_vehicle');
    el.innerHTML = `
      <div style="padding:12px 14px;background:var(--bg);border-radius:12px;border:1px solid var(--border);">
        <div style="font-weight:700;font-size:.95rem;">${esc(item.name)}</div>
        <div style="font-size:.75rem;color:var(--text-muted);margin-top:4px;">
          ${icon('package')} ${catLabel(item.category)}
          &nbsp;·&nbsp; ${icon('ambulance')} ${esc(vehicle)}
          &nbsp;·&nbsp; ${icon('package')} ${t('supply.on_hand', { qty: item.quantity })}
        </div>
      </div>`;
  }
  document.getElementById('supply-qty').value = Math.max(1, (item.minimal || 0) - (item.quantity || 0));
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

function renderStockLevels() {
  const canvas = document.getElementById('stockLevelsChart');
  const card = document.getElementById('stockLevelsCard');
  if (!canvas || typeof Chart === 'undefined') return;
  const atRisk = S.items
    .filter(i => i.minimal != null)
    .sort((a, b) => (a.quantity / Math.max(a.minimal, 1)) - (b.quantity / Math.max(b.minimal, 1)))
    .slice(0, 15);
  if (!atRisk.length) {
    if (card) card.style.display = 'none';
    _destroyChart('stockLevels');
    return;
  }
  if (card) card.style.display = 'block';
  canvas.parentElement.style.minHeight = `${Math.max(120, atRisk.length * 28)}px`;
  const barColors = atRisk.map(i =>
    i.quantity === 0 ? '#DC2626' :
    i.quantity < i.minimal ? '#D97706' :
    i.quantity < i.minimal * 1.5 ? '#F59E0B' : '#059669'
  );
  _destroyChart('stockLevels');
  _charts.stockLevels = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: atRisk.map(i => i.name.length > 22 ? i.name.slice(0, 20) + '…' : i.name),
      datasets: [
        {
          label: t('ui.chart.current'),
          data: atRisk.map(i => i.quantity),
          backgroundColor: barColors.map(c => c + 'BB'),
          borderColor: barColors,
          borderWidth: 1.5, borderRadius: 4, borderSkipped: false,
        },
        {
          label: t('ui.chart.min'),
          data: atRisk.map(i => i.minimal),
          type: 'line',
          backgroundColor: 'transparent',
          borderColor: '#9CA3AF',
          borderWidth: 1.5,
          borderDash: [4, 3],
          pointRadius: 3,
          pointBackgroundColor: '#9CA3AF',
          order: 0,
        },
      ],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      animation: { duration: 700, easing: 'easeOutQuart' },
      plugins: {
        legend: {
          display: true, position: 'top', align: 'end',
          labels: { font: { size: 10 }, color: '#94A3B8', boxWidth: 12, padding: 14 },
        },
        tooltip: {
          callbacks: {
            afterLabel: ctx => {
              const item = atRisk[ctx.dataIndex];
              return item ? `  ${t('ui.chart.min_tip', { n: item.minimal })}  |  ${item.quantity < item.minimal ? t('ui.chart.below') : t('ui.chart.ok')}` : '';
            },
          },
        },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { precision: 0, color: '#94A3B8', font: { size: 11 } } },
        y: { grid: { display: false }, ticks: { color: '#4B5563', font: { size: 11 } } },
      },
    },
  });
}

// ── Dashboard renderers ────────────────────────────────────────
function renderStats() {
  let expired = 0, warning = 0, ok = 0;
  S.items.forEach(item => {
    const s = expiryStatus(earliestExpiry(item));
    if (s === 'expired') expired++;
    else if (s === 'warning') warning++;
    else if (s === 'ok') ok++;
  });
  setText('stat-expired', expired);
  setText('stat-warning', warning);
  setText('stat-ok', ok);
  setText('stat-total', S.items.length);
}

function getAlerts() {
  const expired = [], warning = [], lowStock = [];
  S.items.forEach(item => {
    const s = expiryStatus(earliestExpiry(item));
    if (s === 'expired') expired.push(item);
    else if (s === 'warning') warning.push(item);
    if (item.minimal != null && item.quantity < item.minimal) lowStock.push(item);
  });
  return { expired, warning, lowStock };
}

function renderAlertsList() {
  const el = document.getElementById('alertsList');
  if (!el) return;
  const alerts = [];
  S.items.forEach(item => {
    const s = expiryStatus(earliestExpiry(item));
    if (s === 'expired') alerts.push(renderAlertCard(item, 'expired'));
    else if (s === 'warning') alerts.push(renderAlertCard(item, 'warning'));
    if (item.minimal != null && item.quantity < item.minimal) alerts.push(renderAlertCard(item, 'low_stock'));
  });
  el.innerHTML = alerts.length ? alerts.join('') : emptyState(icon('checkCircle'), t('app.empty.good'));
}

function renderShiftNotesList() {
  const el = document.getElementById('shiftNotesList');
  if (!el) return;
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = [...S.shiftNotes].sort((a, b) =>
    order[(a.priority || 'medium').toLowerCase()] - order[(b.priority || 'medium').toLowerCase()] ||
    new Date(b.createdAt || b.date) - new Date(a.createdAt || a.date)
  );
  el.innerHTML = sorted.length
    ? sorted.slice(0, 8).map(n => renderShiftNote(n)).join('')
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
  renderStockLevels();
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
    el.innerHTML = emptyState(icon('ambulance'), t('app.empty.no_unit'));
    return;
  }
  el.innerHTML = items.length
    ? items.map(item => renderItemCard(item, snapshotItems())).join('')
    : emptyState(icon('package'), t('app.empty.no_equipment'));
}

function applySearch(items, term) {
  const q = term.toLowerCase();
  return items.filter(i =>
    i.name.toLowerCase().includes(q) ||
    (i.location || '').toLowerCase().includes(q) ||
    (i.batchNumber || '').toLowerCase().includes(q) ||
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
    case 'LOGIN': return t('ui.audit.login_d');
    default: return '';
  }
}

function renderAuditEvent(log) {
  const style = AUDIT_STYLE[log.action] || { key: null, color: '#999' };
  const when = fmtDateTime(log.createdAt);
  const who = log.user?.displayName || 'System';
  const station = log.station ? `<span>${icon('building')} ${esc(log.station.name)} (${esc(log.station.code)})</span>` : '';
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
  const stName = u?.station?.name || '—';
  const callSign = u?.station?.code || '—';
  S.stationName = stName;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  document.getElementById('sidebarStationName').textContent = stName;
  document.getElementById('sidebarCallSign').textContent = callSign;
  set('settingsStationName', stName);
  set('s-callsign', callSign);
  updateSupplyNavBadge();
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
}

function getStation() {
  const shiftCode = document.getElementById('s-shift')?.value || '';
  const shiftPeriod = document.getElementById('s-period')?.value || '';
  return {
    stationName: document.getElementById('settingsStationName')?.value || S.stationName || '—',
    stationCallSign: document.getElementById('s-callsign')?.value || '—',
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

function openEditModal(id) {
  const item = S.items.find(i => i.id === id);
  if (!item) return;
  S.editMode = 'adjust';
  S.editInventoryId = id;
  S.editItem = item;
  S.editQtyAllowed = can('inventory:adjust');
  S.editExpiryAllowed = can('inventory:update-expiry');
  S.editDeleteAllowed = can('medicine:delete');
  if (!S.editQtyAllowed && !S.editExpiryAllowed && !S.editDeleteAllowed) { toast(t('app.toast.no_perm'), 'error'); return; }
  document.getElementById('modal-item-title').textContent = t('modal.item.adjust');
  document.getElementById('addModeToggle').style.display = 'none';
  document.getElementById('newFields').style.display = 'none';
  document.getElementById('restockFields').style.display = 'none';
  document.getElementById('adjustFields').style.display = 'block';
  document.getElementById('qtyGroup').style.display = S.editQtyAllowed ? 'block' : 'none';
  document.getElementById('reasonGroup').style.display = S.editQtyAllowed ? 'block' : 'none';
  document.getElementById('f-medname').value = item.name;
  document.getElementById('f-current').value = item.quantity;
  document.getElementById('qtyLabel').textContent = t('modal.qty.new');
  const qty = document.getElementById('f-qty');
  if (qty) { qty.min = '0'; qty.value = item.quantity; }
  document.getElementById('f-reason').value = '';
  document.getElementById('f-reason').placeholder = t('app.adjust.reason_ph');
  const exp = document.getElementById('f-expiry');
  if (exp) { exp.value = item.expiry ? item.expiry.slice(0, 10) : ''; exp.disabled = !S.editExpiryAllowed; }
  const expCur = document.getElementById('f-expirycurrent');
  if (expCur) expCur.value = item.expiry ? fmtDate(item.expiry) : '—';
  const delBtn = document.getElementById('btn-delete-med');
  if (delBtn) delBtn.style.display = S.editDeleteAllowed ? 'inline-flex' : 'none';
  openModal('modal-item');
}

// ── Delete medicine (soft delete: medicine + batches + stock) ──

function openDeleteModal() {
  const item = S.editItem;
  if (!item || !S.editDeleteAllowed) return;
  const today = new Date().setHours(0, 0, 0, 0);
  const expDate = item.expiry ? new Date(item.expiry).getTime() : null;
  const hasActiveStock = item.quantity > 0 && (!expDate || expDate >= today);
  const qtyLine = item.expiry
    ? `${t('app.expiry.current')} <strong style="color:var(--text)">${fmtDate(item.expiry)}</strong>`
    : '—';
  document.getElementById('delItemInfo').innerHTML = `
    <div style="background:var(--bg);border-radius:10px;padding:14px 16px;">
      <div style="font-size:1rem;font-weight:700;margin-bottom:6px;">${esc(item.name)}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:0.85rem;color:var(--text-muted);">
        <span>${catIcon(item.category)} ${catLabel(item.category)}</span>
        ${item.batchNumber ? `<span><strong>${esc(item.batchNumber)}</strong></span>` : ''}
        <span>${t('modal.delete.qty')} <strong style="color:var(--text)">${item.quantity ?? 0}</strong></span>
        <span>${qtyLine}</span>
      </div>
      <div style="margin-top:10px;padding:9px 12px;border-radius:8px;font-size:.8rem;border:1px solid ${hasActiveStock ? 'rgba(250,204,21,.4)' : 'rgba(248,113,113,.35)'};color:${hasActiveStock ? '#FDE68A' : '#FCA5A5'};">
        ${esc(hasActiveStock ? t('modal.delete.active') : t('modal.delete.inactive'))}
      </div>
    </div>`;
  openModal('modal-delete');
}

async function confirmDelete() {
  if (!S.editDeleteAllowed || !S.editInventoryId) return;
  try {
    await api.deleteMedicine(S.editItem.medicineId);
    const name = S.editItem?.name || '';
    closeModal('modal-delete');
    closeModal('modal-item');
    toast(t('app.toast.deleted', name ? { name } : {}));
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

function updateBatchesUI() {
  const el = document.getElementById('batchesList');
  if (!el) return;
  el.innerHTML = S.tempBatches.length
    ? S.tempBatches.map((b, i) => renderBatchItem(b, i)).join('')
    : `<p style="color:var(--text-muted);font-size:0.82rem;text-align:center;margin:8px 0;">${t('ui.batch.no_batches')}</p>`;
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
    const num = id => { const v = document.getElementById(id).value; return v === '' ? null : parseInt(v, 10); };
    const reason = t('app.reason.initial');
    try {
      const med = await api.createMedicine({
        name,
        category,
        location: gv('f-location'),
        serialNumber: gv('f-serial'),
        notes: gv('f-notes'),
        technicalNotes: gv('f-technotes'),
        barcode: gv('f-storecode'),
        minimumStock: num('f-min') ?? undefined,
        maximumStock: num('f-max') ?? undefined,
      });
      for (let i = 0; i < S.tempBatches.length; i++) {
        const b = S.tempBatches[i];
        const batch = await api.createBatch({
          medicineId: med.id,
          batchNumber: b.batchNumber || `LOT-${Date.now().toString(36).toUpperCase()}${i}`,
          expiryDate: b.expiry,
          receivedDate: nowLocal().slice(0, 10),
          supplier: b.supplier || '',
        });
        if (b.quantity > 0) {
          await api.restock({ ambulanceId: S.activeAmbulanceId, batchId: batch.id, quantity: b.quantity, reason });
        }
      }
      S.medicines = S.medicines || [];
      S.medicines.push(med);
      closeModal('modal-item');
      toast(t('app.toast.added_name', { name }));
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
  const item = S.items.find(i => i.id === id);
  if (!item) return;
  try {
    await api.createInspection({
      ambulanceId: S.activeAmbulanceId,
      notes: t('app.inspect.quick_note', { name: me().name }),
      items: [{ inventoryId: id, actualQuantity: item.quantity }],
    });
    toast(t('app.toast.checked', { name: item.name }));
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
  const item = S.items.find(i => i.id === id);
  if (!item) return;
  S.useId = id;
  document.getElementById('use-qty').value = 1;
  document.getElementById('use-reason').value = '';
  document.getElementById('use-notes').value = '';
  document.getElementById('useItemInfo').innerHTML = `
    <div style="background:var(--bg);border-radius:10px;padding:14px 16px;">
      <div style="font-size:1rem;font-weight:700;margin-bottom:6px;">${esc(item.name)}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:0.85rem;color:var(--text-muted);">
        <span>${catIcon(item.category)} ${catLabel(item.category)}</span>
        <span>${t('app.use.current_qty')} <strong style="color:var(--text)">${item.quantity}</strong></span>
        ${item.minimal != null ? `<span>${t('app.use.min_qty')} <strong>${item.minimal}</strong></span>` : ''}
        ${item.expiry ? `<span>${t('ui.pill.expiry')} <strong>${fmtDate(item.expiry)}</strong></span>` : ''}
      </div>
    </div>`;
  openModal('modal-use');
}

async function confirmUse() {
  const item = S.items.find(i => i.id === S.useId);
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

async function deleteShiftNote(id) {
  if (!confirm(t('app.confirm.delete_note'))) return;
  try {
    await api.deleteShiftNote(id);
    toast(t('app.toast.note_deleted'));
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
  if (alerts.lowStock.length) {
    r += `${t('app.report.low_stock', { n: alerts.lowStock.length })}:\n`;
    alerts.lowStock.forEach(a => { r += `  ⚠ ${a.name}: ${a.quantity} (${t('app.report.min_label', { n: a.minimal })})\n`; });
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
  r += `${t('app.report.total', { n: S.items.length })}\n`;
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
          lowStock: alerts.lowStock.map(a => ({ name: a.name, quantity: a.quantity, minimal: a.minimal, category: a.category })),
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
  const data = cat === 'all' ? S.items : S.items.filter(i => i.category === cat);
  const headers = [
    t('ui.history.name'), t('ui.history.category'), t('ui.history.qty'),
    t('ui.history.min'), t('ui.history.max'), t('ui.history.expiry'),
    t('ui.history.batch'), t('ui.history.supplier'),
  ];
  const rows = data.map(item => [
    item.name, catLabel(item.category), item.quantity,
    item.minimal || '', item.maximal || '',
    item.expiry ? fmtDate(item.expiry) : '',
    item.batchNumber || '', item.supplier || '',
  ]);
  let csv = '\uFEFF' + headers.join(',') + '\n';
  rows.forEach(r => { csv += r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',') + '\n'; });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aems_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  toast(t('app.toast.exported'));
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
    if (e.key === 'Escape') closeAllModals();
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
      (i.name.toLowerCase().includes(term) || (i.location || '').toLowerCase().includes(term)));
    renderItemsGrid(filtered, 'equipmentList');
  });
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
  S.stationId = session.user.station?.id || null;
  S.stationName = session.user.station?.name || '—';

  updateUserUI();
  updateSidebar();
  loadStationInfo();

  // A unit normally has a single car. Pick it automatically (preferring an
  // active car); the manual ambulance switcher has been removed.
  const active = S.ambulances.find(a => a.status === 'ACTIVE') || S.ambulances[0];
  S.activeAmbulanceId = active?.id || null;

  if (!S.activeAmbulanceId && !S.stationId) {
    setConnection(t('app.conn.no_unit'), false);
    renderAll();
    document.getElementById('pageLoader')?.classList.add('hide');
    return;
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
  if (S.currentPage) navigateTo(S.currentPage, S.currentCat);
});

window.App = {
  navigateTo,
  selectCat: (cat) => navigateTo('equipment', cat),
  openAddModal,
  openEditModal,
  onSaveItem,
  saveItem: onSaveItem,
  openDeleteModal,
  confirmDelete,
  setAddMode,
  addBatch,
  removeBatch,
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
  openReportModal,
  sendReport,
  copyReport,
  exportCSV,
  exportCurrentCat: () => exportCSV(S.currentCat || 'medication'),
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
