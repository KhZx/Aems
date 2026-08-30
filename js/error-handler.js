// js/error-handler.js — Global error boundary + session hardening
// Include BEFORE any other scripts in every HTML page.

(function() {

  const ERROR_PAGE = '/error.html';

  function goToLogin(expired) {
    const params = expired ? '?expired=1' : '';
    window.location.href = '/login.html' + params;
  }

  // ── Global error handler ───────────────────────────────────
  function getErrorCode(err) {
    if (!err) return 500;
    if (err.code === 'PERMISSION_DENIED') return 403;
    if (err.code === 'NETWORK_ERROR' || err.message?.includes('network')) return 503;
    if (err.code?.startsWith('auth/')) return 401;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 408;
    return 500;
  }

  function goToError(code, detail) {
    const params = new URLSearchParams({ code: String(code) });
    if (detail) params.set('detail', String(detail).slice(0, 300));
    window.location.href = ERROR_PAGE + '?' + params.toString();
  }

  window.AEMS_onFatalError = function(err, context) {
    if (!err) return;
    if (window.location.pathname === ERROR_PAGE) return;
    if (err.code === 'PERMISSION_DENIED' || err.code?.startsWith('auth/')) {
      goToLogin(true);
      return;
    }
    const code = getErrorCode(err);
    const msg = context ? context + ': ' + (err.message || err) : (err.message || String(err));
    goToError(code, msg);
  };

  window.onerror = function(msg, source, line, col, err) {
    console.error('[AEMS Error]', msg, source, line, col);
    if (String(msg).includes('ResizeObserver') || source?.includes('extension://')) return;
    goToError(500, msg + (source ? ' at ' + source.replace(location.origin, '') : ''));
  };

  window.onunhandledrejection = function(e) {
    console.error('[AEMS Error] Unhandled rejection:', e.reason);
    const err = e.reason;
    if (!err) return;
    if (err.code === 'PERMISSION_DENIED' || err.code?.startsWith('auth/')) {
      goToLogin(true);
      return;
    }
    goToError(getErrorCode(err), err.message || String(err));
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
