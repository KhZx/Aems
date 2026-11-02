// js/password.js — shared password dialogs.
//
//  • openChangePasswordDialog()          → a user changes their OWN password.
//        Re-authenticates with the current password through the Firebase
//        client SDK, then updates it. The current session is kept.
//  • openAdminPasswordDialog({ userId }) → an administrator sets a NEW
//        password for another user. Routed through the backend, which uses the
//        Firebase Admin SDK and revokes the target's refresh tokens.
//
//  Both dialogs are built on demand and self-mount, so any page can use them
//  by importing this module (the two entry points are also exposed on window
//  for the inline `onclick` handlers the panels already use).

import { t } from './i18n.js';
import { toast } from './ui.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { changeOwnPassword } from './services/firebase.js';

const MIN_LEN = 8;
const MAX_LEN = 128;

let activeDialog = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Uses the page's own toast when it has one, else the shared ui toast. */
function notify(message, type = 'success') {
  try {
    if (typeof window.toast === 'function') window.toast(message, type);
    else toast(message, type);
  } catch {
    toast(message, type);
  }
}

function closeActive() {
  if (activeDialog) activeDialog.close();
}

function field(id, labelKey, autocomplete) {
  return `
    <label class="pwd-field" for="${id}">
      <span class="pwd-label">${esc(t(labelKey))}</span>
      <input id="${id}" class="pwd-input" type="password" autocomplete="${autocomplete}"
             maxlength="${MAX_LEN}" required>
    </label>`;
}

function buildDialog({ mode, userId, name }) {
  const self = mode === 'self';

  const overlay = document.createElement('div');
  overlay.className = 'pwd-overlay';
  overlay.innerHTML = `
    <div class="pwd-dialog" role="dialog" aria-modal="true" aria-labelledby="pwdTitle">
      <div class="pwd-head">
        <div class="pwd-badge">${icon('lock')}</div>
        <div class="pwd-titles">
          <h2 class="pwd-title" id="pwdTitle">${esc(self ? t('pwd.title') : t('pwd.reset.title'))}</h2>
          <p class="pwd-sub">${esc(self ? t('pwd.subtitle') : t('pwd.reset.subtitle', { name: name || t('pwd.reset.this_user') }))}</p>
        </div>
        <button type="button" class="pwd-x" data-pwd-close aria-label="${esc(t('common.close'))}">${icon('close')}</button>
      </div>
      <form class="pwd-form" novalidate>
        ${self ? field('pwdCurrent', 'pwd.current', 'current-password') : ''}
        ${field('pwdNew', 'pwd.new', 'new-password')}
        ${field('pwdConfirm', 'pwd.confirm', 'new-password')}
        <p class="pwd-hint">${esc(t('pwd.hint', { n: MIN_LEN }))}</p>
        <div class="pwd-note pwd-note-warn" data-pwd-warn ${self ? 'hidden' : ''}>
          ${icon('alert')}<span>${esc(t('pwd.reset.warning'))}</span>
        </div>
        <div class="pwd-note pwd-note-error" data-pwd-error role="alert" hidden></div>
        <div class="pwd-note pwd-note-success" data-pwd-success role="status" hidden></div>
        <div class="pwd-actions">
          <button type="button" class="pwd-btn pwd-btn-ghost" data-pwd-close>${esc(t('common.cancel'))}</button>
          <button type="submit" class="pwd-btn pwd-btn-primary">
            ${icon('key')}<span>${esc(self ? t('pwd.submit') : t('pwd.reset.submit'))}</span>
          </button>
        </div>
      </form>
    </div>`;

  const form = overlay.querySelector('.pwd-form');
  const inputs = [...overlay.querySelectorAll('.pwd-input')];
  const submit = overlay.querySelector('.pwd-btn-primary');
  const errorBox = overlay.querySelector('[data-pwd-error]');
  const successBox = overlay.querySelector('[data-pwd-success]');
  const previousFocus = document.activeElement;
  let busy = false;
  let closed = false;
  let onKey;

  const showError = (msg) => {
    successBox.hidden = true;
    errorBox.textContent = msg;
    errorBox.hidden = false;
  };
  const clearError = () => { errorBox.hidden = true; errorBox.textContent = ''; };

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.classList.remove('open');
    setTimeout(() => {
      overlay.remove();
      if (activeDialog && activeDialog.overlay === overlay) activeDialog = null;
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    }, 190);
  }

  onKey = (e) => {
    if (e.key === 'Escape' && !busy) { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      // Simple focus trap.
      const focusables = overlay.querySelectorAll('button:not(:disabled), input:not(:disabled)');
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !busy) close(); });
  overlay.querySelectorAll('[data-pwd-close]').forEach((b) => b.addEventListener('click', () => { if (!busy) close(); }));
  document.addEventListener('keydown', onKey);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    clearError();

    const current = self ? overlay.querySelector('#pwdCurrent').value : '';
    const next = overlay.querySelector('#pwdNew').value;
    const confirm = overlay.querySelector('#pwdConfirm').value;

    if (self && !current) { showError(t('pwd.err.needs_current')); return; }
    if (next.length < MIN_LEN) { showError(t('pwd.err.short', { n: MIN_LEN })); return; }
    if (next.length > MAX_LEN) { showError(t('pwd.err.long')); return; }
    if (next !== confirm) { showError(t('pwd.err.match')); return; }
    if (self && next === current) { showError(t('pwd.err.same')); return; }

    busy = true;
    submit.disabled = true;
    inputs.forEach((i) => { i.disabled = true; });

    try {
      if (self) {
        await changeOwnPassword(current, next);
        // Audit the change (the password is already updated; never let an
        // audit hiccup show a failure to the user).
        try { await api.recordPasswordChange(); } catch { /* non-fatal */ }
      } else {
        await api.setUserPassword(userId, next);
      }

      successBox.textContent = self
        ? t('pwd.success')
        : t('pwd.reset.success', { name: name || t('pwd.reset.this_user') });
      successBox.hidden = false;
      setTimeout(() => {
        close();
        notify(self ? t('pwd.success') : t('pwd.reset.success', { name: name || '' }), 'success');
      }, 900);
    } catch (err) {
      busy = false;
      submit.disabled = false;
      inputs.forEach((i) => { i.disabled = false; });
      showError(mapError(err));
      form.querySelector('#pwdCurrent')?.focus();
    }
  });

  return { overlay, close, focus: () => (overlay.querySelector(self ? '#pwdCurrent' : '#pwdNew')?.focus()) };
}

/** Turns Firebase / API errors into a friendly, localised message. */
function mapError(err) {
  const code = err?.code || '';
  const status = err?.status;

  if (code === 'auth/wrong-password' || code === 'auth/invalid-credential' || code === 'auth/invalid-login-credentials') {
    return t('pwd.err.current');
  }
  if (code === 'auth/weak-password') return t('pwd.err.short', { n: MIN_LEN });
  if (code === 'auth/too-many-requests') return t('pwd.err.toomany');
  if (code === 'auth/network-request-failed') return t('pwd.err.network');
  if (code === 'auth/requires-recent-login') return t('pwd.err.reauth');
  if (code === 'auth/not-signed-in') return t('pwd.err.auth');
  if (status === 403) return t('pwd.err.forbidden');
  if (status === 404) return t('pwd.err.notfound');
  if (status === 429) return t('pwd.err.toomany');
  if (status === 400) return t('pwd.err.generic');
  return t('pwd.err.generic');
}

/** Opens the self-service "change my password" dialog. */
export function openChangePasswordDialog() {
  closeActive();
  const dialog = buildDialog({ mode: 'self' });
  activeDialog = dialog;
  mount(dialog);
}

/**
 * Opens the admin "set password" dialog for another user.
 * Accepts `{ userId, name }` — `name` is optional and only used for display.
 */
export function openAdminPasswordDialog(target) {
  const userId = typeof target === 'string' ? target : target?.userId;
  const name = typeof target === 'object' ? target?.name : '';
  if (!userId) return;
  closeActive();
  const dialog = buildDialog({ mode: 'admin', userId, name });
  activeDialog = dialog;
  mount(dialog);
}

function mount(dialog) {
  document.body.appendChild(dialog.overlay);
  // Force a reflow so the transition plays.
  void dialog.overlay.offsetWidth;
  dialog.overlay.classList.add('open');
  setTimeout(() => dialog.focus(), 40);
}

// Exposed for inline onclick handlers used across the panels.
window.openChangePasswordDialog = openChangePasswordDialog;
window.openAdminPasswordDialog = openAdminPasswordDialog;
