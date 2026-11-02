// js/reasons.js — structured stock-reason catalog: client cache + picker controls.
//
// The backend owns the catalog (GET /stock-reasons). This module caches it once,
// exposes helpers to filter it by item type + action, and mounts a reusable
// reason control (select + conditional note) into any container element.

import { api } from './api.js';
import { t, getCurrentLang } from './i18n.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let _all = null;
let _loading = null;

/** Loads (and caches) the full reason catalog. Pass force=true to refresh. */
export async function loadReasonCatalog(force = false) {
  if (_all && !force) return _all;
  if (_loading && !force) return _loading;
  _loading = api.stockReasons({ includeInactive: true })
    .then((d) => {
      _all = Array.isArray(d) ? d : (d?.reasons || []);
      _loading = null;
      return _all;
    })
    .catch((err) => {
      _loading = null;
      throw err;
    });
  return _loading;
}

export function reasonCatalogLoaded() {
  return Array.isArray(_all);
}

export function reasonLabel(r) {
  if (!r) return '';
  return getCurrentLang() === 'ar' ? (r.labelAr || r.labelEn) : (r.labelEn || r.labelAr);
}

export function reasonFamilyLabel(family) {
  const key = `reason.family.${String(family || '').toLowerCase()}`;
  const v = t(key);
  return v && !/^reason\./.test(v) ? v : (family || '');
}

export function reasonByCode(code) {
  return (_all || []).find((r) => r.code === code) || null;
}

/** Active reasons valid for the given item type and/or action, in catalog order. */
export function reasonsFor(itemType, action) {
  if (!_all) return [];
  return _all
    .filter((r) => r.isActive !== false)
    .filter((r) => !itemType || (r.itemTypes || []).includes(itemType))
    .filter((r) => !action || (r.actions || []).includes(action))
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || String(a.code).localeCompare(b.code));
}

/** Maps a UI category (lowercase) to the backend item type. */
export function itemTypeForCategory(category) {
  return String(category || '').toUpperCase() === 'MEDICATION' ? 'MEDICATION' : 'EQUIPMENT';
}

function optionHtml(r, selected) {
  const label = getCurrentLang() === 'ar' ? (r.labelAr || r.labelEn) : (r.labelEn || r.labelAr);
  return `<option value="${esc(r.code)}" data-note="${r.requiresNote ? 1 : 0}" data-review="${r.requiresReview ? 1 : 0}" data-effect="${esc(r.effect)}"${selected === r.code ? ' selected' : ''}>${esc(label)}</option>`;
}

/**
 * Renders a full reason control (labelled select + conditional note + review
 * hint) into the element with id `containerId`. The selected code is read back
 * with readReasonControl(containerId).
 */
export function mountReasonControl(containerId, { itemType, action, selected, label } = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const list = reasonsFor(itemType, action);
  el.innerHTML = `
    <div class="form-group">
      <label class="form-label">${esc(label || t('reason.label'))}</label>
      <select class="form-control reason-select" id="${containerId}-code" onchange="App.onReasonChange('${containerId}')">
        <option value="">${esc(t('reason.pick'))}</option>
        ${list.map((r) => optionHtml(r, selected)).join('')}
      </select>
    </div>
    <div class="form-group" id="${containerId}-notewrap" style="display:none;">
      <label class="form-label">${esc(t('reason.note_label'))}</label>
      <input type="text" class="form-control" id="${containerId}-note" maxlength="300" placeholder="${esc(t('reason.note_ph'))}">
    </div>
    <div class="reason-review-hint" id="${containerId}-review" style="display:none;">${esc(t('reason.review_hint'))}</div>`;
}

/** Toggles the conditional note field / review hint for a mounted control. */
export function onReasonChange(containerId) {
  const sel = document.getElementById(`${containerId}-code`);
  if (!sel) return;
  const opt = sel.selectedOptions[0];
  const noteWrap = document.getElementById(`${containerId}-notewrap`);
  const review = document.getElementById(`${containerId}-review`);
  if (noteWrap) noteWrap.style.display = opt?.dataset.note === '1' ? '' : 'none';
  if (review) review.style.display = opt?.dataset.review === '1' ? '' : 'none';
}

/**
 * Reads the mounted control. Throws a localized Error when a reason is required
 * but missing, or when the chosen reason requires a note that was left blank.
 */
export function readReasonControl(containerId, { required = true } = {}) {
  const sel = document.getElementById(`${containerId}-code`);
  const noteEl = document.getElementById(`${containerId}-note`);
  const code = sel ? sel.value : '';
  const opt = sel?.selectedOptions?.[0];
  const note = noteEl ? noteEl.value.trim() : '';
  if (required && !code) throw new Error(t('reason.required'));
  if (opt?.dataset.note === '1' && !note) throw new Error(t('reason.note_required'));
  return {
    code: code || null,
    note: note || null,
    label: opt && code ? opt.textContent : null,
    requiresReview: opt?.dataset.review === '1',
    effect: opt?.dataset.effect || null,
  };
}

/** Best human-readable text for a chosen reason (note when present, else label). */
export function reasonText(read) {
  if (!read) return '';
  return read.note || read.label || read.code || '';
}

export function reasonLabelFor(code) {
  const r = _all?.find((x) => x.code === code);
  if (!r) return code || '';
  return getCurrentLang() === 'ar' ? (r.labelAr || r.labelEn) : (r.labelEn || r.labelAr);
}
