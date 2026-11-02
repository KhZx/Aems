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

// ── Detail spec strip ──────────────────────────────────────────
// "Filled-in only" chips: whatever detail exists on the medicine is printed
// right on the card so crews can read it at a glance. Empty fields vanish —
// the strip only renders what was actually written.
function hasSpec(group) {
  return !!(group.size || group.location || group.serial || group.barcode || group.storeCode || group.genericName || group.dosageForm);
}
function specChips(group) {
  if (!hasSpec(group)) return '';
  const chips = [];
  const push = (ic, key, val) => {
    const v = val;
    if (v === null || v === undefined || String(v).trim() === '') return;
    chips.push(`
      <span class="spec-chip" title="${esc(t(key))}: ${esc(v)}">
        <span class="spec-chip-ic">${icon(ic)}</span>
        <span class="spec-chip-lbl">${t(key)}</span>
        <span class="spec-chip-val">${esc(v)}</span>
      </span>`);
  };
  push('ruler', 'ui.pill.size', group.size);
  push('pin', 'ui.pill.location', group.location);
  push('key', 'ui.pill.serial', group.serial);
  push('tag', 'ui.pill.store', group.barcode ?? group.storeCode);
  push('pill', 'ui.pill.generic', group.genericName);
  push('package', 'ui.pill.dosage', group.dosageForm);
  return `<div class="spec-strip">${chips.join('')}</div>`;
}

// ── Item Card (ONE consolidated card per medicine, batches inside) ──
export function renderItemCard(group, snapshot) {
  const expDate  = earliestExpiry(group);
  const status   = expiryStatus(expDate);
  const prevTotal = snapshot
    ? group.batches.reduce((sum, b) => sum + (snapshot.find(s => s.id === b.id)?.quantity ?? 0), 0)
    : null;
  const isChanged = prevTotal != null && prevTotal !== group.quantity;
  const diff      = isChanged ? group.quantity - prevTotal : null;
  const single    = group.batches.length === 1;
  const catHex    = catColor(group.category);

  const badges = [];
  if (status === 'expired') badges.push(`<span class="badge badge-expired">${t('ui.badge.expired')}</span>`);
  else if (status === 'warning') badges.push(`<span class="badge badge-warning">${t('ui.badge.warning')}</span>`);
  else if (status === 'ok') badges.push(`<span class="badge badge-ok">${t('ui.badge.ok')}</span>`);
  if (isChanged) badges.push(`<span class="badge badge-changed">${t('ui.badge.changed')}</span>`);
  if (!single) badges.push(`<span class="badge badge-lots">${t('ui.batch.count_other', { n: group.batches.length })}</span>`);

  const changePill = isChanged
    ? `<span class="meta-pill" style="background:${diff < 0 ? 'rgba(239,68,68,.14)' : 'rgba(16,185,129,.14)'};color:${diff < 0 ? '#FCA5A5' : '#6EE7B7'};font-weight:700;">
         ${prevTotal} → ${group.quantity} (${diff > 0 ? '+' : ''}${diff})
       </span>`
    : '';

  const head = `
    <div class="item-body">
      <div class="item-head">
        <span class="item-cat-ico">${catIcon(group.category)}</span>
        <div class="item-name">${esc(group.name)}${group.strength ? `<span class="item-strength">${esc(group.strength)}</span>` : ''}</div>
        <div class="item-badges">${badges.join('')}</div>
      </div>
    </div>`;

  const actions = renderActions(group);

  const notes = (group.notes || group.technicalNotes) ? `
    <div class="item-notes">
      ${group.notes ? `${icon('fileText')} ${esc(group.notes)}` : ''}
      ${group.technicalNotes ? `<div style="margin-top:4px;">${icon('wrench')} ${esc(group.technicalNotes)}</div>` : ''}
    </div>` : '';

  const MAX_BATCHES_VISIBLE = 3;
  const renderLotRow = b => {
    const bs = expiryStatus(b.expiry);
    const canDel = window.AEMS_PERMS?.includes('inventory:adjust');
    return `
      <div class="batch-row">
        <span class="batch-lot" title="${t('ui.pill.batch', { no: b.batchNumber || '' })}">${icon('tag')} <strong>${esc(b.batchNumber || b.id.slice(0, 8))}</strong>${b.hasLotOverride ? ` <span class="batch-override-tag">${t('app.batch_edit.override_tag')}</span>` : ''}</span>
        <span class="batch-exp ${bs === 'expired' ? 'batch-exp-expired' : bs === 'warning' ? 'batch-exp-warning' : ''}"><span class="batch-dot"></span>${b.expiry ? fmtDate(b.expiry) : '—'}</span>
        <span class="batch-qty">${b.quantity}</span>
        <span class="batch-ops">
          <button type="button" class="batch-btn" onclick="App.openBatchEdit('${group.medicineId}','${b.id}')" title="${t('ui.btn.edit_lot')}">${icon('edit')}</button>
          ${canDel ? `<button type="button" class="batch-btn danger" onclick="App.deleteStockLine('${b.id}')" title="${t('ui.btn.delete_lot')}">${icon('trash')}</button>` : ''}
        </span>
      </div>`;
  };

  const hiddenCount = Math.max(0, group.batches.length - MAX_BATCHES_VISIBLE);
  const visibleRows = group.batches.slice(0, MAX_BATCHES_VISIBLE).map(renderLotRow).join('');

  const badgesMini = `
    <div class="item-meta">
      <span class="meta-pill pill-qty">${t('ui.pill.qty')} <span class="pi">${group.quantity}</span></span>
      ${!single ? `<span class="meta-pill pill-lots">${icon('list')} ${t('ui.batch.count_other', { n: group.batches.length })}</span>` : ''}
      <div>${changePill}</div>
    </div>`;

  if (single) {
    const b = group.batches[0];
    const bs = expiryStatus(b.expiry);
    const strip = specChips(group);
    return `
      <div class="item-card is-single cat-${group.category} ${status === 'expired' ? 'is-expired' : ''} ${isChanged ? 'is-changed' : ''}" data-id="${group.id}" data-cat="${group.category}" style="--cat:${catHex}">
        ${head}
        <div class="item-body">
          <div class="single-layout">
            <div class="qty-hero">
              <div class="qty-num">${group.quantity}</div>
              ${group.unit ? `<div class="qty-unit">${esc(group.unit)}</div>` : ''}
            </div>
            <div class="single-info">
              <div class="sline"><span class="sline-ic">${icon('tag')}</span><span class="sline-lbl">${t('ui.batch.lot')}</span><strong>${esc(b.batchNumber || b.id.slice(0, 8))}</strong></div>
              <div class="sline"><span class="sline-ic">${icon('clock')}</span><span class="sline-lbl">${t('ui.pill.expiry')}</span><span class="sline-exp ${bs === 'expired' ? 'exp-red' : bs === 'warning' ? 'exp-amber' : 'exp-green'}">${b.expiry ? fmtDate(b.expiry) : '—'}</span></div>
            </div>
          </div>
          ${strip}
          ${changePill ? `<div class="item-meta">${changePill}</div>` : ''}
          ${notes}
        </div>
        ${actions}
      </div>`;
  }

  return `
    <div class="item-card cat-${group.category} ${status === 'expired' ? 'is-expired' : ''} ${isChanged ? 'is-changed' : ''}" data-id="${group.id}" data-cat="${group.category}" style="--cat:${catHex}">
      ${head}
      <div class="item-body">
        ${badgesMini}
        ${specChips(group)}
        <div class="batch-list">
          <div class="batch-head">
            <span class="batch-lot">${t('ui.batch.lot')}</span>
            <span class="batch-exp">${t('ui.batch.expiry')}</span>
            <span class="batch-qty">${t('ui.batch.qty')}</span>
            <span class="batch-edit"></span>
          </div>
          ${visibleRows}
          ${hiddenCount ? `
          <button type="button" class="batch-toggle" onclick="App.showAllBatches('${group.id}')">
            <span class="batch-toggle-label">${t('ui.batch.show_more', { n: hiddenCount })}</span>
            <span class="batch-toggle-ic">${icon('chevronDown')}</span>
          </button>` : ''}
        </div>
        ${notes}
      </div>
      ${actions}
    </div>`;
}

function renderActions(group) {
  return `
    <div class="item-actions">
      <button class="btn btn-success btn-sm" onclick="App.checkItem('${group.id}')">${t('ui.btn.check')}</button>
      ${window.AEMS_PERMS?.includes('inventory:use') ? `<button class="btn btn-warning btn-sm" onclick="App.openUseModal('${group.id}')">${t('ui.btn.use')}</button>` : ''}
      ${window.AEMS_PERMS?.includes('supply:request') ? `<button class="btn btn-ghost btn-sm" onclick="App.openSupplyModal('${group.id}')">${t('ui.btn.request')}</button>` : ''}
      ${window.AEMS_PERMS?.includes('inventory:restock') ? `<button class="btn btn-ghost btn-sm" onclick="App.openAddModal()">${t('ui.btn.add_restock')}</button>` : ''}
      ${(window.AEMS_PERMS?.includes('inventory:adjust') || window.AEMS_PERMS?.includes('inventory:update-expiry') || window.AEMS_PERMS?.includes('medicine:delete')) ? `<button class="btn btn-ghost btn-sm" onclick="App.openEditModal('${group.id}')">${t('ui.btn.edit')}</button>` : ''}
    </div>`;
}

// ── Tree list — medicine row with nested, branch-connected batches ──
const closedTreeIds = new Set();

export function toggleTree(id) {
  if (closedTreeIds.has(id)) closedTreeIds.delete(id);
  else closedTreeIds.add(id);
  const row = document.getElementById('tree-' + id);
  if (row) {
    row.classList.toggle('is-open', !closedTreeIds.has(id));
    const btn = row.querySelector('.inv-tree-toggle');
    if (btn) btn.setAttribute('aria-expanded', String(!closedTreeIds.has(id)));
  }
}

function treeStatusBadge(status) {
  return status === 'expired'
    ? `<span class="badge badge-expired inv-badge-pulse">${t('ui.badge.expired')}</span>`
    : status === 'warning'
      ? `<span class="badge badge-warning">${t('ui.badge.warning')}</span>`
      : `<span class="badge badge-ok">${t('ui.badge.ok')}</span>`;
}

export function renderItemRow(group, snapshot) {
  const expDate  = earliestExpiry(group);
  const status   = expiryStatus(expDate);
  const catHex   = catColor(group.category);
  const prevTotal = snapshot
    ? group.batches.reduce((sum, b) => sum + (snapshot.find(s => s.id === b.id)?.quantity ?? 0), 0)
    : null;
  const isChanged = prevTotal != null && prevTotal !== group.quantity;
  const diff      = isChanged ? group.quantity - prevTotal : null;
  const canUse    = window.AEMS_PERMS?.includes('inventory:use');
  const canRestock = window.AEMS_PERMS?.includes('inventory:restock');
  const canSupply = window.AEMS_PERMS?.includes('supply:request');
  const canEdit   = window.AEMS_PERMS?.includes('inventory:adjust') || window.AEMS_PERMS?.includes('inventory:update-expiry') || window.AEMS_PERMS?.includes('medicine:delete');
  const open      = !closedTreeIds.has(group.id);

  const batchRows = group.batches.map(b => {
    const bs = expiryStatus(b.expiry);
    return `
      <div class="inv-tree-batch ${bs === 'expired' ? 'is-expired' : bs === 'warning' ? 'is-warning' : ''}">
        <span class="inv-tree-node" aria-hidden="true"></span>
        <span class="inv-batch-dot ${bs === 'expired' ? 'd-expired' : bs === 'warning' ? 'd-warning' : ''}"></span>
        <span class="inv-batch-num">${esc(b.batchNumber || b.id.slice(0, 8))}${b.hasLotOverride ? ` <span class="batch-override-tag">${t('app.batch_edit.override_tag')}</span>` : ''}</span>
        <span class="inv-batch-qty">${b.quantity}${group.unit ? `<small> ${esc(group.unit)}</small>` : ''}</span>
        ${b.expiry
          ? `<span class="inv-batch-exp ${bs === 'expired' ? 'e-expired' : bs === 'warning' ? 'e-warning' : ''}">${fmtDate(b.expiry)}</span>`
          : '<span class="inv-batch-exp muted">' + t('common.not_available') + '</span>'}
        <span class="inv-batch-actions">
          <button type="button" class="inv-bact" onclick="App.openBatchEdit('${group.medicineId}','${b.id}')" title="${t('ui.btn.edit_lot')}">${icon('edit')}</button>
        </span>
      </div>`;
  }).join('');

  return `
    <div id="tree-${group.id}" class="inv-tree-row ${open ? 'is-open' : ''} ${status === 'expired' ? 'is-expired' : ''} ${isChanged ? 'is-changed' : ''}" style="--cat:${catHex}" data-id="${group.id}">
      <div class="inv-tree-head">
        <span class="inv-l-rail" aria-hidden="true"></span>
        <button type="button" class="inv-l-tile" onclick="App.openEditModal('${group.id}')" title="${t('ui.btn.edit')}">${catIcon(group.category)}</button>
        <div class="inv-l-main">
          <span class="inv-l-title">${esc(group.name)}${group.strength ? `<span class="item-strength">${esc(group.strength)}</span>` : ''}</span>
        </div>
        <div class="inv-tree-status">
          ${treeStatusBadge(status)}
          ${group.batches.length > 1 ? `<span class="inv-tree-lots">${icon('list')} ${group.batches.length}</span>` : ''}
          ${isChanged ? `<span class="inv-changed ${(diff ?? 0) > 0 ? 'up' : 'down'}">${(diff ?? 0) > 0 ? '▲' : '▼'} ${Math.abs(diff ?? 0)}</span>` : ''}
        </div>
        <div class="inv-tree-stock">
          <span class="inv-l-qty ${isChanged ? 'qty-flash' : ''}">${group.quantity}</span>
          ${group.unit ? `<span class="inv-l-unit">${esc(group.unit)}</span>` : ''}
        </div>
        <div class="inv-tree-exp">
          <span class="batch-dot ${status === 'expired' ? 'st-expired' : status === 'warning' ? 'st-warning' : ''}"></span>
          <span class="inv-tree-exp-txt">${expDate ? fmtDate(expDate) : '—'}</span>
        </div>
        <div class="inv-tree-actions">
          <button type="button" class="inv-l-act act-check" onclick="App.checkItem('${group.id}')" title="${t('ui.btn.check')}">${icon('checkCircle')}</button>
          ${canUse ? `<button type="button" class="inv-l-act act-use" onclick="App.openUseModal('${group.id}')" title="${t('ui.btn.use')}">${icon('zap')}</button>` : ''}
          ${canSupply ? `<button type="button" class="inv-l-act" onclick="App.openSupplyModal('${group.id}')" title="${t('ui.btn.request')}">${icon('send')}</button>` : ''}
          ${canRestock ? `<button type="button" class="inv-l-act" onclick="App.openAddModal()" title="${t('ui.btn.add_restock')}">${icon('plus')}</button>` : ''}
          ${canEdit ? `<button type="button" class="inv-l-act act-edit" onclick="App.openEditModal('${group.id}')" title="${t('ui.btn.edit')}">${icon('edit')}</button>` : ''}
        </div>
        <button type="button" class="inv-tree-toggle" onclick="App.toggleTree('${group.id}')" aria-expanded="${String(open)}" aria-label="${open ? t('ui.collapse') : t('ui.expand')}" title="${open ? t('ui.collapse') : t('ui.expand')}">${icon('chevronDown')}</button>
      </div>
      <div class="inv-tree-body">
        <div class="inv-tree-batches">
          ${batchRows}
        </div>
      </div>
    </div>`;
}

// ── Alert Card ────────────────────────────────────────────────
export function renderAlertCard(item, alertType) {
  const expDate = earliestExpiry(item);
  const msgs = {
    expired: t('ui.alert.expired', { name: item.name, date: fmtDate(expDate) }),
    warning: t('ui.alert.warning', { name: item.name, date: fmtDate(expDate) }),
  };
  return `
    <div class="alert-card ${alertType === 'expired' ? 'danger' : 'warning'}" onclick="App.openEditModal('${item.id}')" title="${catLabel(item.category)}">
      <div style="font-size:0.88rem;line-height:1.5;">${msgs[alertType] || ''}</div>
      <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px;">${catIcon(item.category)} ${catLabel(item.category)}${item.size ? ` · ${esc(item.size)}` : ''}</div>
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
        ${ev.station?.stationName ? `<span>${icon('building')} ${esc(ev.station.stationName)} (${esc(ev.station.stationCallSign || '—')})</span>` : ''}
        ${ev.station?.paramedicName ? `<span>${icon('user')} ${esc(ev.station.paramedicName)}</span>` : ''}
        ${ev.station?.shiftType ? `<span>${icon('clock')} ${esc(ev.station.shiftType)}</span>` : ''}
      </div>
      ${ev.changes?.length ? `
        <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:5px;">
          ${ev.changes.map(c => `
            <span style="background:${c.diff<0?'rgba(239,68,68,.14)':'rgba(16,185,129,.14)'};color:${c.diff<0?'#FCA5A5':'#6EE7B7'};padding:2px 9px;border-radius:6px;font-size:0.72rem;font-weight:700;">
              ${esc(c.name)}: ${esc(c.prevQty)}→${esc(c.currQty)}
            </span>`).join('')}
        </div>` : ''}
    </div>`;
}

// ── Shift Note ────────────────────────────────────────────────
/**
 * `note._canDelete` / `note._canRestore` are set by the caller (app.js) from the
 * session: an author may remove their own note while it is fresh, a supervisor
 * may remove anyone's, and only a supervisor can undo a removal.
 */
export function renderShiftNote(note) {
  const prioCol  = { high:'#EF4444', medium:'#F59E0B', low:'#10B981' };
  const prio  = (note.priority || 'medium').toLowerCase();
  const removed = !!note.deletedAt;
  const action = removed
    ? (note._canRestore
        ? `<button class="btn btn-ghost btn-sm" onclick="App.restoreShiftNote('${note.id}')" style="padding:3px 7px;font-size:0.7rem;" title="${esc(t('app.toast.note_restored'))}">${icon('refresh')}</button>`
        : '')
    : (note._canDelete
        ? `<button class="btn btn-ghost btn-sm" onclick="App.deleteShiftNote('${note.id}')" style="padding:3px 7px;font-size:0.7rem;" title="${esc(t('app.confirm.delete_note'))}">${icon('trash')}</button>`
        : '');
  return `
    <div class="shift-note prio-${prio}"${removed ? ' style="opacity:.55;border-style:dashed;"' : ''}>
      <div class="note-header">
        <div class="note-title"><span class="prio-dot" style="background:${prioCol[prio] || '#94A3B8'};"></span> ${esc(note.title)}${removed ? ` <span class="chip" style="font-size:.6rem;">${esc(t('ui.note.removed'))}</span>` : ''}</div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="note-meta">${fmtDateTime(note.createdAt || note.date)}</span>
          ${action}
        </div>
      </div>
      <div class="note-content">${esc(note.content)}</div>
      ${note.author ? `<div style="margin-top:5px;font-size:0.7rem;color:var(--text-muted);">${icon('edit')} ${esc(note.author)}</div>` : ''}
      ${removed && note.deleteReason ? `<div style="margin-top:5px;font-size:0.7rem;color:var(--danger);">${icon('info')} ${esc(note.deleteReason)}</div>` : ''}
    </div>`;
}

// ── Change Item ───────────────────────────────────────────────
export function renderChangeItem(c) {
  return `
    <div class="change-item ${c.diff > 0 ? 'inc' : 'dec'}">
      <div>
        <div class="change-name">${esc(c.name)}</div>
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
        ${batch.batchNumber ? `&nbsp;| ${esc(batch.batchNumber)}` : ''}
      </div>
      <button type="button" class="btn btn-danger btn-sm" style="padding:3px 8px;" onclick="App.removeBatch(${idx})">${icon('close')}</button>
    </div>`;
}

// ── Toast ─────────────────────────────────────────────────────
const TOAST_ICONS = { success: 'check', error: 'xCircle', warning: 'alert', info: 'info' };
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
export function toast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.title = 'Click to dismiss';
  el.innerHTML = `${icon(TOAST_ICONS[type] || 'info')}<span>${esc(message)}</span>`;
  container.appendChild(el);
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  el.addEventListener('click', dismiss);
  // Keep errors/warnings on screen longer so the text can be copied.
  const linger = (type === 'error' || type === 'warning') ? 6000 : 3000;
  setTimeout(dismiss, linger);
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
