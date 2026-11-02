// js/reports.js — shared Reports Dashboard for the admin and supervisor panels.
//
// One component, two hosts: the admin panel passes every station while the
// supervisor panel passes only the units they manage. All data comes from
// GET /api/reports/analytics, which also enforces that scope server-side.
//
// Usage:
//   const dash = createReportsDashboard({
//     rootId: 'adminReports',
//     getStations: async () => (await api.stations()).map(s => ({ id: s.id, code: s.code, name: s.name })),
//   });
//   dash.refresh();

import { api } from './api.js';
import { t, getCurrentLang, unitLabel } from './i18n.js';
import { icon } from './icons.js';
import { catLabel } from './ui.js';

const PERIODS = [7, 30, 90, 365];
const DAY_MS = 86_400_000;

const COLORS = {
  red: '#EF4444',
  amber: '#F59E0B',
  green: '#10B981',
  blue: '#4A9BDF',
  grey: '#6B7280',
  purple: '#8B5CF6',
  redSoft: 'rgba(239,68,68,.18)',
};

const SUPPLY_TONES = {
  PENDING: 'amber',
  APPROVED: 'blue',
  DISPATCHED: 'blue',
  IN_TRANSIT: 'blue',
  RECEIVED: 'green',
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

function num(value) {
  const n = Number(value || 0);
  const lang = getCurrentLang() === 'ar' ? 'ar-AE' : 'en-GB';
  try { return new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(n); }
  catch { return String(n); }
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const lang = getCurrentLang() === 'ar' ? 'ar-AE' : 'en-GB';
  try { return d.toLocaleDateString(lang, { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return d.toISOString().slice(0, 10); }
}

function familyLabel(family) {
  const key = `reports.family.${family}`;
  const label = t(key);
  return label === key ? family : label;
}

function statusLabel(status) {
  const key = `reports.status.${String(status).toLowerCase()}`;
  const label = t(key);
  return label === key ? status : label;
}

function reasonLabel(reason) {
  return getCurrentLang() === 'ar' ? (reason.labelAr || reason.labelEn) : (reason.labelEn || reason.labelAr);
}

function reduceMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

/** Renders a table or an empty state. `cols` are already-translated strings. */
function renderTable(cols, rows, emptyText) {
  if (!rows.length) {
    return `<div class="rp-empty">${icon('list')}<div>${esc(emptyText)}</div></div>`;
  }
  return `<div class="rp-table-wrap"><table class="rp-table">
    <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>`;
}

function section(title, hint, count, body, iconName = 'list') {
  return `<section class="rp-section">
    <div class="rp-section-head">
      <div class="rp-section-title">${icon(iconName)} <span>${esc(title)}</span>
        ${count != null ? `<span class="rp-count-chip">${num(count)}</span>` : ''}
      </div>
      ${hint ? `<div class="rp-section-hint">${esc(hint)}</div>` : ''}
    </div>
    ${body}
  </section>`;
}

function pill(text, tone) {
  return `<span class="rp-pill ${tone || 'grey'}">${esc(text)}</span>`;
}

/**
 * Mounts the dashboard. Returns `{ refresh, rerender, destroy }`.
 */
export function createReportsDashboard(options) {
  const { rootId, getStations } = options || {};
  const root = document.getElementById(rootId);
  if (!root) return null;

  const state = {
    days: 30,
    stationId: '',
    stations: [],
    stationsLoaded: false,
    data: null,
    loading: false,
    error: '',
    tab: 'stock',
  };
  let charts = {};
  let destroyed = false;

  function destroyCharts() {
    Object.values(charts).forEach((c) => { try { c.destroy(); } catch { /* already gone */ } });
    charts = {};
  }

  function makeChart(key, canvasId, config) {
    if (typeof window.Chart === 'undefined') return;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const animated = !reduceMotion();
    try {
      charts[key] = new window.Chart(canvas, {
        ...config,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: animated ? { duration: 450 } : false,
          plugins: {
            legend: { display: false, ...(config.options?.plugins?.legend || {}) },
            tooltip: { ...(config.options?.plugins?.tooltip || {}) },
          },
          ...config.options,
        },
      });
    } catch { /* chart rendering must never break the report */ }
  }

  function paintChartEmpty(id, isEmpty, message) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !isEmpty;
    el.textContent = message || '';
  }

  /** Fetch + render. Station list is loaded once. */
  async function refresh() {
    if (destroyed) return;
    state.loading = true;
    state.error = '';
    if (!state.data) render();
    else renderToolbarBusy(true);
    try {
      if (!state.stationsLoaded && typeof getStations === 'function') {
        const list = await getStations();
        state.stations = Array.isArray(list) ? list : [];
        state.stationsLoaded = true;
      }
      state.data = await api.reportAnalytics({
        days: state.days,
        stationId: state.stationId || undefined,
      });
    } catch (err) {
      state.error = err?.message || String(err);
    } finally {
      state.loading = false;
      if (!destroyed) render();
    }
  }

  /** Re-renders from the cached payload (used after a language switch). */
  function rerender() {
    if (!destroyed) render();
  }

  function renderToolbarBusy(busy) {
    const btn = root.querySelector('#rp-refresh');
    if (btn) {
      btn.disabled = busy;
      btn.innerHTML = `${icon(busy ? 'refresh' : 'refresh')} ${esc(t(busy ? 'reports.refreshing' : 'reports.refresh'))}`;
    }
    root.classList.toggle('rp-is-loading', busy);
  }

  function setTab(tab) {
    state.tab = tab;
    root.querySelectorAll('.rp-tab').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    root.querySelectorAll('.rp-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
  }

  function card(label, value, sub, tone, tab, iconName) {
    return `<div class="rp-card rp-tone-${tone || 'info'} ${tab ? 'clickable' : ''}" ${tab ? `data-tab="${tab}" role="button" tabindex="0"` : ''}>
      <div class="rp-card-label">${icon(iconName || 'chart')} <span>${esc(label)}</span></div>
      <div class="rp-card-num">${num(value)}</div>
      <div class="rp-card-sub">${sub || '&nbsp;'}</div>
    </div>`;
  }

  function renderToolbar() {
    const unit = t('reports.unit.station');
    const stationOptions = state.stations
      .map((s) => `<option value="${esc(s.id)}" ${state.stationId === s.id ? 'selected' : ''}>${esc(s.code ? unitLabel(s.code, s.name) : s.name)}</option>`)
      .join('');
    const periodOptions = PERIODS
      .map((d) => `<option value="${d}" ${state.days === d ? 'selected' : ''}>${esc(t(`reports.period.${d}`))}</option>`)
      .join('');
    const updated = state.data?.generatedAt
      ? `${t('reports.updated')} ${new Date(state.data.generatedAt).toLocaleTimeString(
        getCurrentLang() === 'ar' ? 'ar-AE' : 'en-GB', { hour: '2-digit', minute: '2-digit' },
      )}`
      : '';

    return `<div class="rp-toolbar">
      <div class="rp-filters">
        <span class="rp-field-label">${esc(t('reports.period.label'))}</span>
        <select class="rp-select" id="rp-period" aria-label="${esc(t('reports.period.label'))}">${periodOptions}</select>
        ${state.stations.length
          ? `<span class="rp-field-label">${esc(unit)}</span>
             <select class="rp-select" id="rp-station" aria-label="${esc(unit)}">
               <option value="">${esc(t('reports.station.all'))}</option>${stationOptions}
             </select>`
          : ''}
      </div>
      <div class="rp-filters">
        <span class="rp-updated">${esc(updated)}</span>
        <button class="rp-btn" id="rp-export" type="button">${icon('download')} ${esc(t('reports.export'))}</button>
        <button class="rp-btn primary" id="rp-refresh" type="button">${icon('refresh')} ${esc(t('reports.refresh'))}</button>
      </div>
    </div>`;
  }

  function renderCards(data) {
    const totals = data.totals;
    const supply = data.supply;
    const pending = supply.byStatus.PENDING || 0;
    const approved = supply.byStatus.APPROVED || 0;
    return `<div class="rp-grid">
      ${card(
        t('reports.card.units'), totals.units,
        `${num(totals.itemLines)} ${esc(t('reports.unit.lines'))} · ${num(totals.medicines)} ${esc(t('reports.unit.medicines'))}`,
        'info', 'consumption', 'package',
      )}
      ${card(
        t('reports.card.equipment'), totals.equipmentUnits,
        `${num(totals.equipmentLines)} ${esc(t('reports.unit.lines'))} · ${num(totals.ambulances)} ${esc(t('reports.unit.ambulances'))}`,
        'info', 'stock', 'wrench',
      )}
      ${card(
        t('reports.card.belowpar'), data.belowPar.count,
        data.belowPar.count
          ? esc(t('reports.card.belowpar.sub', { n: num(data.belowPar.shortfall) }))
          : esc(t('reports.card.belowpar.none')),
        'danger', 'stock', 'alert',
      )}
      ${card(
        t('reports.card.supply'), supply.outstanding,
        `${esc(t('reports.status.pending'))}: ${num(pending)} · ${esc(t('reports.status.approved'))}: ${num(approved)}`,
        'warning', 'supply', 'send',
      )}
      ${card(
        t('reports.card.expired'), data.health.expired,
        `${num(data.expiry.expiredUnits)} ${esc(t('reports.unit.units'))}`,
        'danger', 'stock', 'xCircle',
      )}
      ${card(
        t('reports.card.expiring'), data.health.warning,
        `${num(data.expiry.warningUnits)} ${esc(t('reports.unit.units'))}`,
        'warning', 'stock', 'clock',
      )}
      ${card(
        t('reports.card.repair'), data.repair.count,
        data.repair.count ? esc(t('reports.card.repair.sub')) : esc(t('reports.card.repair.none')),
        'info', 'repair', 'wrench',
      )}
      ${card(
        t('reports.card.consumption'), data.consumption.totalUnits,
        `${num(data.consumption.events)} ${esc(t('reports.unit.events'))}`,
        'success', 'consumption', 'trending',
      )}
    </div>`;
  }

  function renderCharts(data) {
    const health = data.health;
    const totalHealth = health.expired + health.warning + health.ok + health.noExpiry;
    return `<div class="rp-charts">
      <div class="rp-chart">
        <div class="rp-chart-title">${esc(t('reports.chart.health'))}</div>
        <div class="rp-canvas-wrap">
          <canvas id="rp-chart-health"></canvas>
          <div class="rp-chart-empty" id="rp-chart-health-empty" hidden>${esc(t('reports.empty'))}</div>
        </div>
      </div>
      <div class="rp-chart">
        <div class="rp-chart-title">${esc(t('reports.chart.consumption'))}</div>
        <div class="rp-canvas-wrap">
          <canvas id="rp-chart-consumption"></canvas>
          <div class="rp-chart-empty" id="rp-chart-consumption-empty" hidden>${esc(t('reports.empty.consumption'))}</div>
        </div>
      </div>
      <div class="rp-chart">
        <div class="rp-chart-title">${esc(t('reports.chart.reasons'))}</div>
        <div class="rp-canvas-wrap">
          <canvas id="rp-chart-reasons"></canvas>
          <div class="rp-chart-empty" id="rp-chart-reasons-empty" hidden>${esc(t('reports.empty'))}</div>
        </div>
      </div>
      <div class="rp-chart">
        <div class="rp-chart-title">${esc(t('reports.chart.discrepancies'))}</div>
        <div class="rp-canvas-wrap">
          <canvas id="rp-chart-discrepancies"></canvas>
          <div class="rp-chart-empty" id="rp-chart-discrepancies-empty" hidden>${esc(t('reports.empty'))}</div>
        </div>
      </div>
    </div>`;
  }

  function renderStockPanel(data) {
    const belowRows = data.belowPar.rows.map((r) => `<tr>
      <td class="strong">${esc(r.medicineName)}</td>
      <td class="muted">${esc(catLabel(r.category))}</td>
      <td>${esc(unitLabel(r.vehicleNumber))}</td>
      <td class="muted">${esc(unitLabel(r.stationCode, r.stationName))}</td>
      <td class="num">${num(r.onHand)}</td>
      <td class="num muted">${num(r.required)}</td>
      <td class="num danger strong">-${num(r.shortfall)}</td>
    </tr>`);
    const belowCols = [
      t('reports.col.item'), t('reports.col.category'), t('reports.col.unit'),
      t('reports.col.station'), t('reports.col.onhand'), t('reports.col.required'),
      t('reports.col.shortfall'),
    ];
    const belowBody = data.belowPar.count > data.belowPar.rows.length
      ? `${renderTable(belowCols, belowRows, t('reports.empty.belowpar'))}
         <div class="rp-section-hint" style="padding:8px 15px;">${esc(t('reports.showing', { shown: num(data.belowPar.rows.length), total: num(data.belowPar.count) }))}</div>`
      : renderTable(belowCols, belowRows, t('reports.empty.belowpar'));

    const expiryRows = data.expiry.rows.map((r) => `<tr>
      <td class="strong">${esc(r.medicineName)}</td>
      <td>${esc(unitLabel(r.vehicleNumber))}</td>
      <td class="muted">${esc(unitLabel(r.stationCode, r.stationName))}</td>
      <td class="num">${num(r.quantity)}</td>
      <td class="muted">${esc(fmtDate(r.expiryDate))}</td>
      <td class="num ${r.status === 'expired' ? 'danger' : 'warning'}">${r.daysLeft < 0 ? `-${num(Math.abs(r.daysLeft))}` : num(r.daysLeft)}</td>
      <td>${pill(t(r.status === 'expired' ? 'reports.status.expired' : 'reports.status.warning'), r.status === 'expired' ? 'red' : 'amber')}</td>
    </tr>`);
    const expiryCols = [
      t('reports.col.item'), t('reports.col.unit'), t('reports.col.station'),
      t('reports.col.qty'), t('reports.col.expiry'), t('reports.col.daysleft'), t('reports.col.status'),
    ];

    const reasonRows = data.reasons.map((r, idx) => `<tr>
      <td class="num muted">${idx + 1}</td>
      <td class="strong">${esc(reasonLabel(r))}</td>
      <td class="muted">${esc(familyLabel(r.family))}</td>
      <td class="num">${num(r.events)}</td>
      <td class="num strong">${num(r.units)}</td>
    </tr>`);
    const reasonCols = [
      '#', t('reports.col.reason'), t('reports.col.family'), t('reports.col.events'), t('reports.col.units'),
    ];

    return `
      ${section(
        t('reports.section.belowpar'), t('reports.section.belowpar.hint'),
        data.belowPar.count, belowBody, 'alert',
      )}
      ${section(
        t('reports.section.expiry'), t('reports.section.expiry.hint'),
        data.health.expired + data.health.warning, renderTable(expiryCols, expiryRows, t('reports.empty.expiry')), 'clock',
      )}
      ${section(
        t('reports.section.reasons'), t('reports.section.reasons.hint'),
        data.reasons.length, renderTable(reasonCols, reasonRows, t('reports.empty.reasons')), 'flag',
      )}`;
  }

  function renderSupplyPanel(data) {
    const rows = data.supply.rows.map((r) => `<tr>
      <td class="strong">${esc(r.medicineName)}</td>
      <td>${esc(unitLabel(r.vehicleNumber))}</td>
      <td class="muted">${esc(unitLabel(r.stationCode, r.stationName))}</td>
      <td class="num">${num(r.quantity)}</td>
      <td>${pill(statusLabel(r.status), SUPPLY_TONES[r.status] || 'grey')}</td>
      <td class="muted">${esc(fmtDate(r.createdAt))}</td>
      <td class="num">${num(r.ageDays)}</td>
      <td class="muted">${esc(r.expectedArrivalAt ? fmtDate(r.expectedArrivalAt) : '—')}</td>
    </tr>`);
    const cols = [
      t('reports.col.medicine'), t('reports.col.unit'), t('reports.col.station'),
      t('reports.col.qty'), t('reports.col.status'), t('reports.col.requested'),
      t('reports.col.age'), t('reports.col.expected'),
    ];
    return section(
      t('reports.section.supply'), t('reports.section.supply.hint'),
      data.supply.outstanding, renderTable(cols, rows, t('reports.empty.supply')), 'send',
    );
  }

  function renderRepairPanel(data) {
    const rows = data.repair.rows.map((r) => `<tr>
      <td class="strong">${esc(r.medicineName)}</td>
      <td class="muted">${esc(catLabel(r.category))}</td>
      <td class="muted">${esc(r.batchNumber || '—')}</td>
      <td>${esc(unitLabel(r.vehicleNumber))}</td>
      <td class="muted">${esc(unitLabel(r.stationCode, r.stationName))}</td>
      <td class="num">${num(r.daysOut)}</td>
      <td class="muted">${esc(fmtDate(r.sentAt))}</td>
    </tr>`);
    const cols = [
      t('reports.col.item'), t('reports.col.category'), t('reports.col.batch'),
      t('reports.col.unit'), t('reports.col.station'), t('reports.col.daysout'), t('reports.col.sent'),
    ];
    return section(
      t('reports.section.repair'), t('reports.section.repair.hint'),
      data.repair.count, renderTable(cols, rows, t('reports.empty.repair')), 'wrench',
    );
  }

  function renderConsumptionPanel(data) {
    const itemRows = data.consumption.byItem.map((r) => `<tr>
      <td class="strong">${esc(r.medicineName)}</td>
      <td class="muted">${esc(catLabel(r.category))}</td>
      <td class="num strong">${num(r.units)}</td>
      <td class="num muted">${num(r.events)}</td>
    </tr>`);
    const itemCols = [
      t('reports.col.medicine'), t('reports.col.category'), t('reports.col.units'), t('reports.col.events'),
    ];

    const stationRows = data.consumption.byStation.map((r) => `<tr>
      <td class="strong">${esc(unitLabel(r.stationCode, r.stationName))}</td>
      <td class="num strong">${num(r.units)}</td>
    </tr>`);
    const stationCols = [t('reports.col.station'), t('reports.col.units')];

    return `
      ${section(
        t('reports.section.byitem'), t('reports.section.consumption.hint'),
        data.consumption.byItem.length, renderTable(itemCols, itemRows, t('reports.empty.consumption')), 'trending',
      )}
      ${section(
        t('reports.section.bystation'), t('reports.section.consumption.hint'),
        data.consumption.byStation.length, renderTable(stationCols, stationRows, t('reports.empty.consumption')), 'building',
      )}`;
  }

  function renderDiscrepancyPanel(data) {
    const rows = data.discrepancies.rows.map((r) => `<tr>
      <td class="strong">${esc(unitLabel(r.vehicleNumber))}</td>
      <td class="muted">${esc(unitLabel(r.stationCode, r.stationName))}</td>
      <td class="num">${num(r.inspections)}</td>
      <td class="num warning">${num(r.flagged)}</td>
      <td class="num danger strong">${num(r.corrections)}</td>
      <td class="num">${num(r.unitsOff)}</td>
      <td class="muted">${esc(r.lastAt ? fmtDate(r.lastAt) : '—')}</td>
    </tr>`);
    const cols = [
      t('reports.col.unit'), t('reports.col.station'), t('reports.col.inspections'),
      t('reports.col.flagged'), t('reports.col.corrections'), t('reports.col.unitsOff'), t('reports.col.last'),
    ];

    const stationRows = data.discrepancies.byStation.map((r) => `<tr>
      <td class="strong">${esc(unitLabel(r.stationCode, r.stationName))}</td>
      <td class="num">${num(r.inspections)}</td>
      <td class="num warning">${num(r.flagged)}</td>
      <td class="num danger strong">${num(r.corrections)}</td>
    </tr>`);
    const stationCols = [
      t('reports.col.station'), t('reports.col.inspections'),
      t('reports.col.flagged'), t('reports.col.corrections'),
    ];

    return `
      ${section(
        t('reports.section.discrepancies'), t('reports.section.discrepancies.hint'),
        data.discrepancies.rows.length, renderTable(cols, rows, t('reports.empty.discrepancies')), 'clipboard',
      )}
      ${section(
        t('reports.section.discstations'), t('reports.section.discrepancies.hint'),
        data.discrepancies.byStation.length, renderTable(stationCols, stationRows, t('reports.empty.discrepancies')), 'building',
      )}`;
  }

  function renderTabs() {
    const tabs = [
      ['stock', t('reports.tab.stock'), 'package'],
      ['supply', t('reports.tab.supply'), 'send'],
      ['repair', t('reports.tab.repair'), 'wrench'],
      ['consumption', t('reports.tab.consumption'), 'trending'],
      ['discrepancies', t('reports.tab.discrepancies'), 'clipboard'],
    ];
    return `<div class="rp-tabs" role="tablist">
      ${tabs.map(([id, label, iconName]) => `<button class="rp-tab ${state.tab === id ? 'active' : ''}" data-tab="${id}" type="button" role="tab" aria-selected="${state.tab === id}">${icon(iconName)} ${esc(label)}</button>`).join('')}
    </div>`;
  }

  function renderPanels(data) {
    const panels = [
      ['stock', renderStockPanel(data)],
      ['supply', renderSupplyPanel(data)],
      ['repair', renderRepairPanel(data)],
      ['consumption', renderConsumptionPanel(data)],
      ['discrepancies', renderDiscrepancyPanel(data)],
    ];
    return `<div class="rp-panels">
      ${panels.map(([id, body]) => `<div class="rp-panel ${state.tab === id ? 'active' : ''}" data-panel="${id}" role="tabpanel">${body}</div>`).join('')}
    </div>`;
  }

  function render() {
    destroyCharts();
    if (!root) return;

    if (state.loading && !state.data) {
      root.className = 'reports-dashboard';
      root.innerHTML = `<div class="rp-loading"><span class="rp-spinner"></span><span>${esc(t('reports.loading'))}</span></div>`;
      return;
    }
    if (state.error && !state.data) {
      root.className = 'reports-dashboard';
      root.innerHTML = `${renderToolbar()}
        <div class="rp-error">${icon('alert')} ${esc(state.error)}</div>`;
      wire(root, null);
      return;
    }
    if (!state.data) return;

    root.className = 'reports-dashboard';
    root.innerHTML = `${renderToolbar()}
      ${state.error ? `<div class="rp-error">${icon('alert')} ${esc(state.error)}</div>` : ''}
      ${renderCards(state.data)}
      ${renderCharts(state.data)}
      ${renderTabs()}
      ${renderPanels(state.data)}
      <div class="rp-updated" style="text-align:end;">${esc(t('reports.period.shown', {
        from: fmtDate(state.data.period.from),
        to: fmtDate(state.data.period.to),
      }))}</div>`;

    wire(root, state.data);
    drawCharts(state.data);
  }

  function wire(container, data) {
    container.querySelector('#rp-period')?.addEventListener('change', (e) => {
      state.days = Number(e.target.value) || 30;
      refresh();
    });
    container.querySelector('#rp-station')?.addEventListener('change', (e) => {
      state.stationId = e.target.value || '';
      refresh();
    });
    container.querySelector('#rp-refresh')?.addEventListener('click', () => refresh());
    container.querySelector('#rp-export')?.addEventListener('click', () => exportCsv());
    container.querySelectorAll('.rp-tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    container.querySelectorAll('.rp-card.clickable').forEach((c) => {
      const go = () => { setTab(c.dataset.tab); c.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' }); };
      c.addEventListener('click', go);
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    if (data) renderToolbarBusy(false);
  }

  function drawCharts(data) {
    if (typeof window.Chart === 'undefined') return;
    const grid = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || 'rgba(255,255,255,.07)';
    const tick = getComputedStyle(document.documentElement).getPropertyValue('--text2').trim() || '#94A3B8';
    const baseScales = (horizontal) => ({
      x: {
        beginAtZero: true,
        grid: { color: grid, drawBorder: false },
        ticks: { color: tick, precision: 0, font: { size: 10 } },
      },
      y: {
        grid: { display: false, drawBorder: false },
        ticks: {
          color: tick,
          font: { size: 10 },
          autoSkip: false,
          callback: horizontal
            ? function (v) { return String(this.getLabelForValue(v)).slice(0, 22); }
            : undefined,
        },
      },
    });

    // 1. Stock health donut
    const h = data.health;
    const healthTotal = h.expired + h.warning + h.ok + h.noExpiry;
    paintChartEmpty('rp-chart-health-empty', healthTotal === 0, t('reports.empty'));
    if (healthTotal > 0) {
      makeChart('health', 'rp-chart-health', {
        type: 'doughnut',
        data: {
          labels: [t('reports.legend.expired'), t('reports.legend.warning'), t('reports.legend.ok'), t('reports.legend.none')],
          datasets: [{
            data: [h.expired, h.warning, h.ok, h.noExpiry],
            backgroundColor: [COLORS.red, COLORS.amber, COLORS.green, COLORS.grey],
            borderWidth: 0,
            hoverOffset: 4,
          }],
        },
        options: {
          cutout: '64%',
          plugins: {
            legend: {
              display: true,
              position: 'bottom',
              labels: { color: tick, boxWidth: 9, boxHeight: 9, font: { size: 10 }, usePointStyle: true },
            },
            tooltip: { callbacks: { label: (c) => ` ${c.label}: ${num(c.parsed)}` } },
          },
        },
      });
    }

    // 2. Consumption trend
    const trend = data.consumption.byDay;
    paintChartEmpty('rp-chart-consumption-empty', trend.length === 0, t('reports.empty.consumption'));
    if (trend.length) {
      makeChart('consumption', 'rp-chart-consumption', {
        type: 'bar',
        data: {
          labels: trend.map((p) => p.date.slice(5)),
          datasets: [{
            label: t('reports.col.units'),
            data: trend.map((p) => p.units),
            backgroundColor: 'rgba(74,155,223,.55)',
            borderColor: COLORS.blue,
            borderWidth: 1,
            borderRadius: 4,
            maxBarThickness: 26,
          }],
        },
        options: { scales: baseScales(false) },
      });
    }

    // 3. Top shortage reasons
    const reasons = data.reasons.slice(0, 6);
    paintChartEmpty('rp-chart-reasons-empty', reasons.length === 0, t('reports.empty.reasons'));
    if (reasons.length) {
      makeChart('reasons', 'rp-chart-reasons', {
        type: 'bar',
        data: {
          labels: reasons.map((r) => reasonLabel(r)),
          datasets: [{
            label: t('reports.col.units'),
            data: reasons.map((r) => r.units),
            backgroundColor: 'rgba(239,68,68,.5)',
            borderColor: COLORS.red,
            borderWidth: 1,
            borderRadius: 4,
            maxBarThickness: 22,
          }],
        },
        options: { indexAxis: 'y', scales: baseScales(true) },
      });
    }

    // 4. Discrepancies by station
    const disc = data.discrepancies.byStation.slice(0, 6);
    paintChartEmpty('rp-chart-discrepancies-empty', disc.length === 0, t('reports.empty.discrepancies'));
    if (disc.length) {
      makeChart('discrepancies', 'rp-chart-discrepancies', {
        type: 'bar',
        data: {
          labels: disc.map((r) => unitLabel(r.stationCode, r.stationName)),
          datasets: [{
            label: t('reports.col.corrections'),
            data: disc.map((r) => r.corrections),
            backgroundColor: 'rgba(245,158,11,.5)',
            borderColor: COLORS.amber,
            borderWidth: 1,
            borderRadius: 4,
            maxBarThickness: 22,
          }],
        },
        options: { indexAxis: 'y', scales: baseScales(true) },
      });
    }
  }

  // ── CSV export ─────────────────────────────────────────────
  function csvCell(value) {
    const s = String(value ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportCsv() {
    const data = state.data;
    if (!data) return;
    const lines = [];
    const push = (...cells) => lines.push(cells.map(csvCell).join(','));
    const blank = () => lines.push('');
    const heading = (label) => { blank(); push(label); };

    push(t('reports.export.title'), fmtDate(data.period.from), fmtDate(data.period.to));

    heading(t('reports.card.units'));
    push(t('reports.card.units'), data.totals.units, t('reports.unit.lines'), data.totals.itemLines);
    push(t('reports.card.equipment'), data.totals.equipmentUnits, t('reports.unit.lines'), data.totals.equipmentLines);
    push(t('reports.card.belowpar'), data.belowPar.count);
    push(t('reports.card.supply'), data.supply.outstanding);
    push(t('reports.card.expired'), data.health.expired, t('reports.unit.units'), data.expiry.expiredUnits);
    push(t('reports.card.expiring'), data.health.warning, t('reports.unit.units'), data.expiry.warningUnits);
    push(t('reports.card.repair'), data.repair.count);
    push(t('reports.card.consumption'), data.consumption.totalUnits, t('reports.unit.events'), data.consumption.events);

    heading(t('reports.section.belowpar'));
    push(t('reports.col.item'), t('reports.col.category'), t('reports.col.unit'), t('reports.col.station'), t('reports.col.onhand'), t('reports.col.required'), t('reports.col.shortfall'));
    data.belowPar.rows.forEach((r) => push(r.medicineName, catLabel(r.category), unitLabel(r.vehicleNumber), unitLabel(r.stationCode, r.stationName), r.onHand, r.required, r.shortfall));

    heading(t('reports.section.expiry'));
    push(t('reports.col.item'), t('reports.col.unit'), t('reports.col.station'), t('reports.col.qty'), t('reports.col.expiry'), t('reports.col.daysleft'), t('reports.col.status'));
    data.expiry.rows.forEach((r) => push(r.medicineName, unitLabel(r.vehicleNumber), unitLabel(r.stationCode, r.stationName), r.quantity, fmtDate(r.expiryDate), r.daysLeft, statusLabel(r.status)));

    heading(t('reports.section.supply'));
    push(t('reports.col.medicine'), t('reports.col.unit'), t('reports.col.station'), t('reports.col.qty'), t('reports.col.status'), t('reports.col.requested'), t('reports.col.age'));
    data.supply.rows.forEach((r) => push(r.medicineName, unitLabel(r.vehicleNumber), unitLabel(r.stationCode, r.stationName), r.quantity, statusLabel(r.status), fmtDate(r.createdAt), r.ageDays));

    heading(t('reports.section.repair'));
    push(t('reports.col.item'), t('reports.col.category'), t('reports.col.batch'), t('reports.col.unit'), t('reports.col.station'), t('reports.col.daysout'), t('reports.col.sent'));
    data.repair.rows.forEach((r) => push(r.medicineName, catLabel(r.category), r.batchNumber, unitLabel(r.vehicleNumber), unitLabel(r.stationCode, r.stationName), r.daysOut, fmtDate(r.sentAt)));

    heading(t('reports.section.byitem'));
    push(t('reports.col.medicine'), t('reports.col.category'), t('reports.col.units'), t('reports.col.events'));
    data.consumption.byItem.forEach((r) => push(r.medicineName, catLabel(r.category), r.units, r.events));

    heading(t('reports.section.bystation'));
    push(t('reports.col.station'), t('reports.col.units'));
    data.consumption.byStation.forEach((r) => push(unitLabel(r.stationCode, r.stationName), r.units));

    heading(t('reports.section.reasons'));
    push(t('reports.col.reason'), t('reports.col.family'), t('reports.col.events'), t('reports.col.units'));
    data.reasons.forEach((r) => push(reasonLabel(r), familyLabel(r.family), r.events, r.units));

    heading(t('reports.section.discrepancies'));
    push(t('reports.col.unit'), t('reports.col.station'), t('reports.col.inspections'), t('reports.col.flagged'), t('reports.col.corrections'), t('reports.col.unitsOff'), t('reports.col.last'));
    data.discrepancies.rows.forEach((r) => push(unitLabel(r.vehicleNumber), unitLabel(r.stationCode, r.stationName), r.inspections, r.flagged, r.corrections, r.unitsOff, fmtDate(r.lastAt)));

    heading(t('reports.section.discstations'));
    push(t('reports.col.station'), t('reports.col.inspections'), t('reports.col.flagged'), t('reports.col.corrections'));
    data.discrepancies.byStation.forEach((r) => push(unitLabel(r.stationCode, r.stationName), r.inspections, r.flagged, r.corrections));

    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aems-reports-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function destroy() {
    destroyed = true;
    destroyCharts();
  }

  return { refresh, rerender, destroy, get state() { return state; } };
}
