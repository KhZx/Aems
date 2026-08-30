// js/ui.js — UI rendering helpers (pure functions, no side effects)

import { CATEGORIES } from './data/initial-data.js';
import { t } from './i18n.js';
import { icon } from './icons.js';

const WARN_DAYS = 30;

// ── Date helpers ─────────────────────────────────────────────
export function expiryStatus(dateStr) {
  if (!dateStr) return 'none';
  const expiry = new Date(dateStr);
  const today  = new Date();
  today.setHours(0,0,0,0);
  expiry.setHours(0,0,0,0);
  const diff = Math.ceil((expiry - today) / 86400000);
  if (diff < 0)         return 'expired';
  if (diff <= WARN_DAYS) return 'warning';
  return 'ok';
}

export function earliestExpiry(item) {
  let e = item.expiry || null;
  (item.batches || []).forEach(b => {
    if (b.expiry && (!e || new Date(b.expiry) < new Date(e))) e = b.expiry;
  });
  return e;
}

export function fmtDate(d) {
  if (!d) return t('common.not_available');
  const lang = localStorage.getItem('aems_lang') === 'ar' ? 'ar-EG' : 'en-GB';
  return new Date(d).toLocaleDateString(lang, { year:'numeric', month:'long', day:'numeric' });
}

export function fmtDateTime(d) {
  if (!d) return t('common.not_available');
  const lang = localStorage.getItem('aems_lang') === 'ar' ? 'ar-EG' : 'en-GB';
  return new Date(d).toLocaleString(lang, { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

// ── Category helpers ─────────────────────────────────────────
// CATEGORIES carries static label/icon/color; labels must be translated, so we
// map each enum key to its dictionary entry (matches the form options).
const CAT_I18N = {
  medication: 'modal.item.cat.medication',
  lifepak: 'modal.item.cat.lifepak',
  responder: 'modal.item.cat.responder',
  suction: 'modal.item.cat.suction',
  carevent: 'modal.item.cat.carevent',
  station_store: 'modal.item.cat.store',
  car_contents: 'modal.item.cat.car',
  other: 'modal.item.cat.other',
};
export const catIcon  = (c) => icon((CATEGORIES[c] && CATEGORIES[c].icon) || 'package');
export const catLabel = (c) => t(CAT_I18N[(c || '').toLowerCase()]) || CATEGORIES[c]?.label || c;
export const catColor = (c) => CATEGORIES[c]?.color || '#6B7280';

// ── Item Card ─────────────────────────────────────────────────
export function renderItemCard(item, snapshot) {
  const expDate  = earliestExpiry(item);
  const status   = expiryStatus(expDate);
  const prevItem = snapshot?.find(s => s.id === item.id);
  const isChanged = prevItem && prevItem.quantity !== item.quantity;
  const diff      = isChanged ? item.quantity - prevItem.quantity : null;
  const lowStock  = item.minimal != null && item.quantity < item.minimal;

  const badges = [];
  if (status === 'expired') badges.push(`<span class="badge badge-expired">${t('ui.badge.expired')}</span>`);
  else if (status === 'warning') badges.push(`<span class="badge badge-warning">${t('ui.badge.warning')}</span>`);
  else if (status === 'ok') badges.push(`<span class="badge badge-ok">${t('ui.badge.ok')}</span>`);
  if (isChanged) badges.push(`<span class="badge badge-changed">${t('ui.badge.changed')}</span>`);

  const pills = [
    `<span class="meta-pill${lowStock ? ' danger' : ''}">${t('ui.pill.qty')} <span class="pi">${item.quantity}</span></span>`,
  ];
  if (item.minimal != null) pills.push(`<span class="meta-pill">${t('ui.pill.min')} <span class="pi">${item.minimal}</span></span>`);
  if (item.maximal != null) pills.push(`<span class="meta-pill">${t('ui.pill.max')} <span class="pi">${item.maximal}</span></span>`);
  if (expDate) pills.push(`<span class="meta-pill ${status === 'expired' ? 'danger' : status === 'warning' ? 'warning' : ''}">${t('ui.pill.expiry')} <span class="pi">${fmtDate(expDate)}</span></span>`);
  if (item.location)  pills.push(`<span class="meta-pill">${icon('pin')} ${item.location}</span>`);
  if (item.batchNumber) pills.push(`<span class="meta-pill">${icon('tag')} ${t('ui.pill.batch', { no: item.batchNumber })}</span>`);
  if (item.serial)    pills.push(`<span class="meta-pill">${icon('key')} ${t('ui.pill.serial')}: ${item.serial}</span>`);
  if (item.storeCode) pills.push(`<span class="meta-pill">${icon('tag')} ${item.storeCode}</span>`);

  const changePill = isChanged && prevItem
    ? `<span class="meta-pill" style="background:${diff < 0 ? 'rgba(239,68,68,.14)' : 'rgba(16,185,129,.14)'};color:${diff < 0 ? '#FCA5A5' : '#6EE7B7'};font-weight:700;">
         ${prevItem.quantity} → ${item.quantity} (${diff > 0 ? '+' : ''}${diff})
       </span>`
    : '';

  let stockMeter = '';
  if (item.minimal != null && item.maximal != null && item.maximal > 0) {
    const pct = Math.max(0, Math.min(100, (item.quantity / item.maximal) * 100));
    stockMeter = `
      <div class="stock-meter ${lowStock ? 'low' : pct < 50 ? 'mid' : 'good'}">
        <div class="stock-meter-bar"><span style="width:${pct}%"></span></div>
        <div class="stock-meter-lbl">${t('ui.stock.level', { q: item.quantity, m: item.maximal })}</div>
      </div>`;
  }

  const catHex = catColor(item.category);
  const catTint = /^#([0-9a-f]{6})$/i.test(catHex)
    ? `rgba(${parseInt(catHex.slice(1, 3), 16)},${parseInt(catHex.slice(3, 5), 16)},${parseInt(catHex.slice(5, 7), 16)},.16)`
    : 'rgba(255,255,255,.05)';

  return `
    <div class="item-card cat-${item.category} ${status === 'expired' ? 'is-expired' : ''} ${isChanged ? 'is-changed' : ''}" data-id="${item.id}" data-cat="${item.category}">
      <div class="item-body">
        <div class="item-head">
          <span class="item-cat-ico" style="background:${catTint};color:${catHex};">${catIcon(item.category)}</span>
          <div class="item-name">${item.name}</div>
          <div class="item-badges">${badges.join('')}</div>
        </div>
        <div class="item-meta">${pills.join('')}${changePill}</div>
        ${stockMeter}
        ${item.notes || item.technicalNotes ? `
          <div class="item-notes">
            ${item.notes ? `${icon('fileText')} ${item.notes}` : ''}
            ${item.technicalNotes ? `<div style="margin-top:4px;">${icon('wrench')} ${item.technicalNotes}</div>` : ''}
          </div>` : ''}
        ${item.lastCheck ? `<div class="item-lastcheck">${t('ui.last_check', { date: fmtDateTime(item.lastCheck) })}</div>` : ''}
      </div>
      <div class="item-actions">
        <button class="btn btn-success btn-sm" onclick="App.checkItem('${item.id}')">${t('ui.btn.check')}</button>
        ${window.AEMS_PERMS?.includes('inventory:use') ? `<button class="btn btn-warning btn-sm" onclick="App.openUseModal('${item.id}')">${t('ui.btn.use')}</button>` : ''}
        ${window.AEMS_PERMS?.includes('supply:request') ? `<button class="btn btn-ghost btn-sm" onclick="App.openSupplyModal('${item.id}')">${t('ui.btn.request')}</button>` : ''}
        ${window.AEMS_PERMS?.includes('inventory:restock') ? `<button class="btn btn-ghost btn-sm" onclick="App.openAddModal()">${t('ui.btn.add_restock')}</button>` : ''}
        ${(window.AEMS_PERMS?.includes('inventory:adjust') || window.AEMS_PERMS?.includes('inventory:update-expiry') || window.AEMS_PERMS?.includes('medicine:delete')) ? `<button class="btn btn-ghost btn-sm" onclick="App.openEditModal('${item.id}')">${t('ui.btn.edit')}</button>` : ''}
      </div>
    </div>`;
}

// ── Alert Card ────────────────────────────────────────────────
export function renderAlertCard(item, alertType) {
  const expDate = earliestExpiry(item);
  const msgs = {
    expired:   t('ui.alert.expired', { name: item.name, date: fmtDate(expDate) }),
    warning:   t('ui.alert.warning', { name: item.name, date: fmtDate(expDate) }),
    low_stock: t('ui.alert.low_stock', { name: item.name, qty: item.quantity, min: item.minimal }),
  };
  return `
    <div class="alert-card ${alertType === 'expired' ? 'danger' : 'warning'}" onclick="App.openEditModal('${item.id}')" title="${catLabel(item.category)}">
      <div style="font-size:0.88rem;line-height:1.5;">${msgs[alertType] || ''}</div>
      <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px;">${catIcon(item.category)} ${catLabel(item.category)}</div>
    </div>`;
}

// ── History Event ─────────────────────────────────────────────
export function renderHistoryEvent(ev) {
  const names  = { check:t('ui.history.check'), use:t('ui.history.use'), add:t('ui.history.add'), edit:t('ui.history.edit'), delete:t('ui.history.delete'), report:t('ui.history.report') };
  const colors = { check:'var(--success)', use:'var(--warning)', add:'var(--info)', edit:'#7C3AED', delete:'var(--danger)', report:'#0D9488' };
  return `
    <div class="history-item" data-type="${ev.type}">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="background:${colors[ev.type]||'#999'};color:white;padding:2px 10px;border-radius:20px;font-size:0.72rem;font-weight:700;">${names[ev.type] || ev.type}</span>
          <span style="font-size:0.9rem;font-weight:600;">${ev.details}</span>
        </div>
        <span style="font-size:0.72rem;color:var(--text-muted);white-space:nowrap;">${fmtDateTime(ev.timestamp)}</span>
      </div>
      <div style="font-size:0.78rem;color:var(--text-muted);display:flex;gap:14px;flex-wrap:wrap;">
        ${ev.station?.stationName ? `<span>${icon('building')} ${ev.station.stationName} (${ev.station.stationCallSign || '—'})</span>` : ''}
        ${ev.station?.paramedicName ? `<span>${icon('user')} ${ev.station.paramedicName}</span>` : ''}
        ${ev.station?.shiftType ? `<span>${icon('clock')} ${ev.station.shiftType}</span>` : ''}
      </div>
      ${ev.changes?.length ? `
        <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:5px;">
          ${ev.changes.map(c => `
            <span style="background:${c.diff<0?'rgba(239,68,68,.14)':'rgba(16,185,129,.14)'};color:${c.diff<0?'#FCA5A5':'#6EE7B7'};padding:2px 9px;border-radius:6px;font-size:0.72rem;font-weight:700;">
              ${c.name}: ${c.prevQty}→${c.currQty}
            </span>`).join('')}
        </div>` : ''}
    </div>`;
}

// ── Shift Note ────────────────────────────────────────────────
export function renderShiftNote(note) {
  const prioCol  = { high:'#EF4444', medium:'#F59E0B', low:'#10B981' };
  const prio  = (note.priority || 'medium').toLowerCase();
  return `
    <div class="shift-note prio-${prio}">
      <div class="note-header">
        <div class="note-title"><span class="prio-dot" style="background:${prioCol[prio] || '#94A3B8'};"></span> ${note.title}</div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="note-meta">${fmtDateTime(note.createdAt || note.date)}</span>
          <button class="btn btn-ghost btn-sm" onclick="App.deleteShiftNote('${note.id}')" style="padding:3px 7px;font-size:0.7rem;">${icon('trash')}</button>
        </div>
      </div>
      <div class="note-content">${note.content}</div>
      ${note.author ? `<div style="margin-top:5px;font-size:0.7rem;color:var(--text-muted);">${icon('edit')} ${note.author}</div>` : ''}
    </div>`;
}

// ── Change Item ───────────────────────────────────────────────
export function renderChangeItem(c) {
  return `
    <div class="change-item ${c.diff > 0 ? 'inc' : 'dec'}">
      <div>
        <div class="change-name">${c.name}</div>
        <div class="change-cat">${catIcon(c.category)} ${catLabel(c.category)}</div>
      </div>
      <div class="change-qty">${c.diff > 0 ? '▲' : '▼'} ${Math.abs(c.diff)}&ensp;(${c.prevQty} → ${c.currQty})</div>
    </div>`;
}

// ── Batch Item ────────────────────────────────────────────────
export function renderBatchItem(batch, idx) {
  const s = expiryStatus(batch.expiry);
  return `
    <div class="batch-item ${s === 'expired' ? 'expired' : s === 'warning' ? 'warning' : ''}">
      <div>
        <strong>${batch.quantity}×</strong>
        &nbsp;${t('ui.batch.expiry', { date: fmtDate(batch.expiry) })}
        ${batch.batchNumber ? `&nbsp;| ${batch.batchNumber}` : ''}
      </div>
      <button type="button" class="btn btn-danger btn-sm" style="padding:3px 8px;" onclick="App.removeBatch(${idx})">${icon('close')}</button>
    </div>`;
}

// ── Toast ─────────────────────────────────────────────────────
export function toast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Modal ─────────────────────────────────────────────────────
export function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('active');
  document.body.style.overflow = 'hidden';
}

export function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('active');
  document.body.style.overflow = '';
}

export function closeAllModals() {
  document.querySelectorAll('.modal-overlay.active')
    .forEach(m => m.classList.remove('active'));
  document.body.style.overflow = '';
}

// ── Empty State ───────────────────────────────────────────────
export function emptyState(icon, text) {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><div class="empty-text">${text}</div></div>`;
}
