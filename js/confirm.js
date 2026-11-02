// js/confirm.js - AEMS-styled replacement for window.confirm() / window.prompt().
//
// The browser dialogs are un-themeable, untranslated and block the UI thread.
// These helpers render a dialog that matches the rest of the app and work the
// same way everywhere (admin, app, supervisor).
//
//   import { confirmDialog, promptDialog } from './confirm.js';
//
//   if (!(await confirmDialog({ message: '...', tone: 'danger' }))) return;
//   const reason = await promptDialog({ message: '...' });
//   const pick   = await choiceDialog({
//     message: '...',
//     choices: [
//       { value: 'merge',   label: '...', hint: '...', tone: 'primary' },
//       { value: 'separate',label: '...', hint: '...' },
//     ],
//   });
//
// Styling lives in css/main.css (.ams-dlg*), so every page that links
// main.css gets it for free.

import { t } from './i18n.js';
import { icon } from './icons.js';

const TONES = {
  warning: { ic: 'alert',       col: '#D97706' },
  danger:  { ic: 'alert',       col: '#EF4444' },
  info:    { ic: 'info',        col: '#4A9BDF' },
  success: { ic: 'checkCircle', col: '#10B981' },
};

let root = null;

/** HTML for the standard two-button action row (cancel + confirm). */
const STANDARD_ACTIONS = `
  <button type="button" class="ams-dlg-btn ghost" data-std></button>
  <button type="button" class="ams-dlg-btn primary" data-std></button>`;

/**
 * Repairs the shared dialog before use. choiceDialog() replaces the action
 * row with its own buttons, so confirm/prompt put the standard row back.
 * Detection is by data-std, not by class: a chooser's own first choice is
 * also .primary and its Cancel button is also .ghost.
 */
function ensureDialog() {
  if (root && document.body.contains(root)) {
    const actions = root.querySelector('.ams-dlg-actions');
    if (actions) {
      actions.classList.remove('stacked');
      if (!root.querySelector('.ams-dlg-btn[data-std]')) actions.innerHTML = STANDARD_ACTIONS;
    }
    return root;
  }
  const el = document.createElement('div');
  el.className = 'ams-dlg-overlay';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="ams-dlg" role="alertdialog" aria-modal="true">
      <div class="ams-dlg-ic"></div>
      <div class="ams-dlg-title"></div>
      <p class="ams-dlg-msg"></p>
      <div class="ams-dlg-field" hidden><input type="text" class="ams-dlg-input" autocomplete="off"></div>
      <div class="ams-dlg-actions">${STANDARD_ACTIONS}
      </div>
    </div>`;
  document.body.appendChild(el);
  root = el;
  return el;
}

/**
 * Opens the dialog and resolves once the user picks something.
 * Never throws - a dismissed dialog just resolves to "cancelled".
 */
function openDialog({
  title, message, confirmLabel, cancelLabel,
  tone = 'warning', withInput = false, placeholder = '', value = '',
} = {}) {
  const el = ensureDialog();
  const icEl      = el.querySelector('.ams-dlg-ic');
  const titleEl   = el.querySelector('.ams-dlg-title');
  const msgEl     = el.querySelector('.ams-dlg-msg');
  const fieldEl   = el.querySelector('.ams-dlg-field');
  const inputEl   = el.querySelector('.ams-dlg-input');
  const cancelBtn = el.querySelector('.ams-dlg-btn.ghost');
  const okBtn     = el.querySelector('.ams-dlg-btn.primary');

  const cfg = TONES[tone] || TONES.warning;
  el.style.setProperty('--dc', cfg.col);
  el.setAttribute('aria-hidden', 'false');
  icEl.innerHTML = icon(cfg.ic);
  titleEl.textContent = title || t('ui.dialog.title_confirm');
  msgEl.textContent = message || '';
  cancelBtn.textContent = cancelLabel || t('ui.dialog.cancel');
  okBtn.textContent = confirmLabel || (withInput ? t('ui.dialog.continue') : t('ui.dialog.confirm'));
  fieldEl.hidden = !withInput;
  inputEl.value = value || '';
  inputEl.placeholder = placeholder || '';
  inputEl.setAttribute('aria-label', title || t('ui.dialog.title_confirm'));

  const prevFocus   = document.activeElement;
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  return new Promise((resolve) => {
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      cancelBtn.removeEventListener('click', onConfirmNo);
      okBtn.removeEventListener('click', onConfirmYes);
      el.removeEventListener('mousedown', onBackdrop);
      inputEl.removeEventListener('keydown', onInputKey);

      el.classList.remove('open');
      el.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = prevOverflow;

      // Restore focus once the fade-out has finished.
      window.setTimeout(() => {
        if (prevFocus && prevFocus !== document.body && document.contains(prevFocus)) {
          try { prevFocus.focus(); } catch { /* element may be gone */ }
        }
      }, 180);

      resolve(result);
    };

    const onConfirmNo  = () => settle(withInput ? null : false);
    const onConfirmYes = () => settle(withInput ? inputEl.value : true);
    const onBackdrop   = (e) => { if (e.target === el) onConfirmNo(); };
    const onInputKey   = (e) => { if (e.key === 'Enter') { e.preventDefault(); onConfirmYes(); } };
    const onKey        = (e) => {
      if (e.key === 'Escape')      { e.preventDefault(); e.stopPropagation(); onConfirmNo(); }
      else if (e.key === 'Enter')  { e.preventDefault(); onConfirmYes(); }
    };

    cancelBtn.addEventListener('click', onConfirmNo);
    okBtn.addEventListener('click', onConfirmYes);
    el.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    if (withInput) inputEl.addEventListener('keydown', onInputKey);

    // Force a reflow first so the CSS transition actually plays.
    void el.offsetWidth;
    el.classList.add('open');

    // Safer default for destructive actions: land on Cancel, not Confirm.
    const focusTarget = withInput ? inputEl : (tone === 'danger' ? cancelBtn : okBtn);
    try { focusTarget.focus({ preventScroll: true }); } catch { /* noop */ }
    if (withInput) inputEl.select();
  });
}

/** boolean - "Are you sure?" replacement for window.confirm(). */
export function confirmDialog(opts = {}) {
  return openDialog({ ...opts, withInput: false });
}

/** string|null - text-entry replacement for window.prompt(). */
export function promptDialog(opts = {}) {
  return openDialog({ ...opts, withInput: true, tone: opts.tone || 'info' });
}

/**
 * Multi-choice dialog. Resolves to the chosen `value`, or `null` if dismissed.
 *
 * Used where a yes/no answer is too coarse — e.g. a lot number that already
 * exists can be merged into, created separately, or cancelled.
 *
 *   await choiceDialog({
 *     title: '...',
 *     message: '...',
 *     choices: [
 *       { value: 'merge',    label: '...', hint: '...', tone: 'primary' },
 *       { value: 'separate', label: '...', hint: '...' },
 *     ],
 *     cancelLabel: '...',
 *     tone: 'warning',
 *   });
 */
export function choiceDialog({
  title, message, choices = [], cancelLabel, tone = 'warning',
} = {}) {
  const el = ensureDialog();
  const icEl      = el.querySelector('.ams-dlg-ic');
  const titleEl   = el.querySelector('.ams-dlg-title');
  const msgEl     = el.querySelector('.ams-dlg-msg');
  const fieldEl   = el.querySelector('.ams-dlg-field');
  const actionsEl = el.querySelector('.ams-dlg-actions');

  const cfg = TONES[tone] || TONES.warning;
  el.style.setProperty('--dc', cfg.col);
  el.setAttribute('aria-hidden', 'false');
  icEl.innerHTML = icon(cfg.ic);
  titleEl.textContent = title || t('ui.dialog.title_confirm');
  msgEl.textContent = message || '';
  fieldEl.hidden = true;

  // Rebuild the action area: one button per choice, then Cancel.
  actionsEl.innerHTML = '';
  actionsEl.classList.add('stacked');
  const buttons = choices.map((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ams-dlg-btn ${c.tone === 'primary' ? 'primary' : 'choice'}`;
    const label = document.createElement('span');
    label.className = 'ams-dlg-choice-label';
    label.textContent = c.label || String(c.value);
    btn.appendChild(label);
    if (c.hint) {
      const hint = document.createElement('span');
      hint.className = 'ams-dlg-choice-hint';
      hint.textContent = c.hint;
      btn.appendChild(hint);
    }
    btn.dataset.value = c.value;
    actionsEl.appendChild(btn);
    return btn;
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ams-dlg-btn ghost';
  cancelBtn.textContent = cancelLabel || t('ui.dialog.cancel');
  actionsEl.appendChild(cancelBtn);

  const prevFocus = document.activeElement;
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  return new Promise((resolve) => {
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      cancelBtn.removeEventListener('click', onCancel);
      buttons.forEach((b) => b.removeEventListener('click', onPick));
      el.removeEventListener('mousedown', onBackdrop);

      el.classList.remove('open');
      el.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = prevOverflow;
      // Restore the shared action area for the next confirm/prompt dialog.
      actionsEl.classList.remove('stacked');

      window.setTimeout(() => {
        if (prevFocus && prevFocus !== document.body && document.contains(prevFocus)) {
          try { prevFocus.focus(); } catch { /* element may be gone */ }
        }
      }, 180);

      resolve(result);
    };

    const onPick     = (e) => settle(e.currentTarget.dataset.value);
    const onCancel   = () => settle(null);
    const onBackdrop = (e) => { if (e.target === el) onCancel(); };
    const onKey      = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        // Enter picks the first (usually safest primary) choice.
        if (buttons[0]) onPick({ currentTarget: buttons[0] });
      }
    };

    cancelBtn.addEventListener('click', onCancel);
    buttons.forEach((b) => b.addEventListener('click', onPick));
    el.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKey, true);

    void el.offsetWidth;
    el.classList.add('open');
    try { (buttons[0] || cancelBtn).focus({ preventScroll: true }); } catch { /* noop */ }
  });
}
