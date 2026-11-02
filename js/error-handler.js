// js/error-handler.js — Global error boundary + session hardening
// Include BEFORE any other scripts in every HTML page.
//
// Policy: an error must never throw the user away from their work. Only a
// genuinely expired/revoked session sends them to the login page. Everything
// else (network blips, a failed widget, a stray script error) shows a small
// dismissable notice and leaves the page intact.

(function() {

  const SESSION_CODES = new Set([
    'auth/id-token-expired',
    'auth/user-token-expired',
    'auth/user-disabled',
    'auth/user-not-found',
    'auth/invalid-user-token',
    'auth/requires-recent-login',
  ]);

  function isSessionError(err) {
    if (!err) return false;
    if (err.code === 'PERMISSION_DENIED') return true;
    return SESSION_CODES.has(err.code);
  }

  function isNetworkError(err) {
    if (!err) return false;
    if (err.code === 'NETWORK_ERROR' || err.code === 'auth/network-request-failed') return true;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    return typeof err.message === 'string' && /network|failed to fetch/i.test(err.message);
  }

  function goToLogin() {
    window.location.href = '/login.html?expired=1';
  }

  // ── Non-blocking notice (never navigates) ──────────────────
  let noticeEl = null;
  let noticeTimer = null;

  function showNotice(text) {
    if (!document.body) return;
    if (!noticeEl) {
      noticeEl = document.createElement('div');
      noticeEl.setAttribute('role', 'alert');
      noticeEl.style.cssText =
        'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:99999;' +
        'max-width:min(90vw,460px);padding:10px 16px;border-radius:10px;' +
        'background:#1f2937;color:#fff;font:600 13px/1.4 system-ui,sans-serif;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer;';
      noticeEl.title = 'Dismiss';
      noticeEl.addEventListener('click', () => noticeEl.remove());
      document.body.appendChild(noticeEl);
    }
    noticeEl.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => noticeEl && noticeEl.remove(), 6000);
  }

  function report(err, context) {
    const detail = context ? context + ': ' + (err?.message || String(err)) : (err?.message || String(err));
    console.error('[AEMS Error]', detail, err);
    if (isNetworkError(err)) {
      showNotice('Connection problem — your work is still here. Check your connection and try again.');
    } else {
      showNotice('Something went wrong. Your work is still here — please try the action again.');
    }
  }

  // Kept for code that wants to report a handled error explicitly.
  window.AEMS_onFatalError = function(err, context) {
    if (!err) return;
    if (isSessionError(err)) return goToLogin();
    report(err, context);
  };

  window.onerror = function(msg, source, line, col, err) {
    console.error('[AEMS Error]', msg, source, line, col);
    if (String(msg).includes('ResizeObserver') || source?.includes('extension://')) return;
    if (isSessionError(err)) return goToLogin();
    showNotice('Something went wrong. Your work is still here — please try the action again.');
  };

  window.onunhandledrejection = function(e) {
    const err = e.reason;
    if (!err) return;
    if (isSessionError(err)) return goToLogin();
    report(err);
  };

  // ── Inject slide animations if not present ─────────────────
  if (!document.getElementById('aems-error-styles')) {
    var style = document.createElement('style');
    style.id = 'aems-error-styles';
    style.textContent =
      '@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }' +
      '@keyframes slideDown { from { transform: translateY(-100%); } to { transform: translateY(0); } }';
    document.head.appendChild(style);
  }

})();
