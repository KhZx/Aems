/* ─────────────────────────────────────────────────────────────────────────────
   js/pwa.js — service-worker registration, install prompt and update prompt.

   Loaded on every page with `defer`. Two things it can add to the screen:

     • "Install AEMS" pill  — only when the browser says the app is installable
                              (or on iOS, where we show Add-to-Home-Screen steps).
     • "Update available"   — when a new service worker has finished installing
                              while this tab was open.

   Both are dismissible and never appear when the app is already running
   standalone. Nothing here is required for the site to work; it is progressive
   enhancement only.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var SW_URL = '/sw.js';
  var DISMISS_KEY = 'aems_pwa_install_dismissed_at';
  var DISMISS_DAYS = 7;

  var isSecure = location.protocol === 'https:' ||
    location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!('serviceWorker' in navigator) || !isSecure) return;

  // ── helpers ────────────────────────────────────────────────────────────────
  function isArabic() {
    try {
      return (localStorage.getItem('aems_lang') ||
        document.documentElement.lang || 'en').toLowerCase().indexOf('ar') === 0;
    } catch (e) { return false; }
  }

  function isStandalone() {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        window.matchMedia('(display-mode: fullscreen)').matches ||
        window.navigator.standalone === true;
    } catch (e) { return false; }
  }

  function isiOS() {
    var ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS 13+ reports itself as a Mac
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  }

  function t(key) {
    var ar = isArabic();
    var strings = {
      install: ar ? 'تثبيت AEMS' : 'Install AEMS',
      installAria: ar ? 'تثبيت التطبيق على هذا الجهاز' : 'Install this app on your device',
      update: ar ? 'يتوفر إصدار جديد' : 'New version available',
      reload: ar ? 'تحديث' : 'Reload',
      later: ar ? 'لاحقاً' : 'Later',
      iosTitle: ar ? 'إضافة إلى الشاشة الرئيسية' : 'Add AEMS to your home screen',
      iosBody: ar
        ? 'اضغط زر المشاركة في سفاري، ثم اختر «إضافة إلى الشاشة الرئيسية».'
        : 'Tap the Share button in Safari, then choose “Add to Home Screen”.',
      iosOk: ar ? 'فهمت' : 'Got it',
      close: ar ? 'إغلاق' : 'Close'
    };
    return strings[key] || key;
  }

  function dismissedRecently() {
    try {
      var at = Number(localStorage.getItem(DISMISS_KEY) || 0);
      return at && (Date.now() - at) < DISMISS_DAYS * 864e5;
    } catch (e) { return false; }
  }

  function rememberDismiss() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) { /* noop */ }
  }

  // ── styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('aems-pwa-style')) return;
    var css = ''
      + '.aems-pwa-stack{position:fixed;z-index:9998;left:50%;transform:translateX(-50%);'
      + 'bottom:calc(1.25rem + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;'
      + 'align-items:center;gap:.5rem;width:max-content;max-width:94vw;pointer-events:none;font-family:Outfit,system-ui,sans-serif}'
      + '.aems-pwa-pill{pointer-events:auto;display:flex;align-items:center;gap:.6rem;border:1px solid rgba(255,255,255,.12);'
      + 'background:rgba(12,14,24,.94);backdrop-filter:blur(14px);color:#E8EAF2;border-radius:100px;'
      + 'padding:.55rem .7rem .55rem .85rem;font-size:.82rem;font-weight:600;line-height:1;'
      + 'box-shadow:0 12px 34px rgba(0,0,0,.6);animation:aemsPwaIn .35s cubic-bezier(.22,1,.36,1)}'
      + '@keyframes aemsPwaIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}'
      + '.aems-pwa-pill svg{width:16px;height:16px;flex-shrink:0}'
      + '.aems-pwa-main{display:flex;align-items:center;gap:.55rem;background:none;border:none;color:inherit;'
      + 'font:inherit;cursor:pointer;padding:.2rem .1rem}'
      + '.aems-pwa-main:hover{color:#fff}'
      + '.aems-pwa-x{background:none;border:none;color:#7c8199;cursor:pointer;padding:.15rem;line-height:0;'
      + 'border-radius:50%}'
      + '.aems-pwa-x:hover{color:#E8EAF2}'
      + '.aems-pwa-x svg{width:14px;height:14px}'
      + '.aems-pwa-accent{color:#E52030}'
      + '.aems-pwa-update{border-color:rgba(200,16,46,.4);background:rgba(30,10,16,.95)}'
      + '.aems-pwa-reload{margin-inline-start:.15rem;background:#C8102E;color:#fff;border:none;border-radius:100px;'
      + 'padding:.4rem .8rem;font:inherit;font-size:.76rem;font-weight:700;cursor:pointer}'
      + '.aems-pwa-reload:hover{background:#E52030}'
      + '.aems-pwa-sheet{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;'
      + 'justify-content:center;background:rgba(3,4,8,.72);backdrop-filter:blur(4px);padding:1rem;'
      + 'font-family:Outfit,system-ui,sans-serif}'
      + '.aems-pwa-box{width:100%;max-width:420px;background:#0C0E18;border:1px solid rgba(255,255,255,.1);'
      + 'border-radius:16px;padding:1.4rem 1.3rem 1.1rem;box-shadow:0 24px 60px rgba(0,0,0,.7);'
      + 'animation:aemsPwaIn .3s cubic-bezier(.22,1,.36,1)}'
      + '.aems-pwa-box h3{margin:0 0 .5rem;font-size:1rem;font-weight:700;color:#E8EAF2}'
      + '.aems-pwa-box p{margin:0 0 1rem;font-size:.85rem;line-height:1.6;color:#9AA0B8}'
      + '.aems-pwa-box button{width:100%;padding:.7rem 1rem;border:none;border-radius:9px;background:#C8102E;'
      + 'color:#fff;font:inherit;font-size:.86rem;font-weight:700;cursor:pointer}'
      + '[dir="rtl"] .aems-pwa-pill,[dir="rtl"] .aems-pwa-box{font-family:Cairo,system-ui,sans-serif}'
      + '@media (prefers-reduced-motion: reduce){.aems-pwa-pill,.aems-pwa-box{animation:none}}';

    var style = document.createElement('style');
    style.id = 'aems-pwa-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function stack() {
    injectStyles();
    var el = document.getElementById('aems-pwa-stack');
    if (!el) {
      el = document.createElement('div');
      el.id = 'aems-pwa-stack';
      el.className = 'aems-pwa-stack';
      document.body.appendChild(el);
    }
    return el;
  }

  function remove(id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    var container = document.getElementById('aems-pwa-stack');
    if (container && !container.children.length) container.remove();
  }

  var ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  // ── install ────────────────────────────────────────────────────────────────
  var deferredPrompt = null;
  var installed = false;

  function hideInstall() { remove('aems-pwa-install'); }

  function showInstall(onClick) {
    if (installed || isStandalone() || dismissedRecently()) return;
    var el = document.getElementById('aems-pwa-install');
    if (el) return;

    var pill = document.createElement('div');
    pill.id = 'aems-pwa-install';
    pill.className = 'aems-pwa-pill';

    var main = document.createElement('button');
    main.type = 'button';
    main.className = 'aems-pwa-main';
    main.setAttribute('aria-label', t('installAria'));
    main.innerHTML = '<span class="aems-pwa-accent">' + ICON_DOWNLOAD + '</span><span>' + t('install') + '</span>';
    main.addEventListener('click', onClick);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'aems-pwa-x';
    close.setAttribute('aria-label', t('close'));
    close.innerHTML = ICON_CLOSE;
    close.addEventListener('click', function () {
      rememberDismiss();
      hideInstall();
    });

    pill.appendChild(main);
    pill.appendChild(close);
    stack().appendChild(pill);
  }

  function showIosSheet() {
    injectStyles();
    if (document.getElementById('aems-pwa-sheet')) return;

    var sheet = document.createElement('div');
    sheet.id = 'aems-pwa-sheet';
    sheet.className = 'aems-pwa-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');

    var box = document.createElement('div');
    box.className = 'aems-pwa-box';

    var h = document.createElement('h3');
    h.textContent = t('iosTitle');

    var p = document.createElement('p');
    p.textContent = t('iosBody');

    var ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = t('iosOk');
    ok.addEventListener('click', function () {
      rememberDismiss();
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      hideInstall();
    });

    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(ok);
    sheet.appendChild(box);
    sheet.addEventListener('click', function (e) {
      if (e.target === sheet) {
        if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      }
    });
    document.body.appendChild(sheet);
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    showInstall(function () {
      var prompt = deferredPrompt;
      if (!prompt) return;
      deferredPrompt = null;
      hideInstall();
      prompt.prompt();
      prompt.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'dismissed') rememberDismiss();
      }).catch(function () { /* noop */ });
    });
  });

  window.addEventListener('appinstalled', function () {
    installed = true;
    deferredPrompt = null;
    hideInstall();
    remove('aems-pwa-sheet');
  });

  // iOS never fires beforeinstallprompt — offer manual instructions instead.
  if (isiOS() && !isStandalone()) {
    var startIos = function () { showInstall(showIosSheet); };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startIos);
    } else {
      startIos();
    }
  }

  // ── updates ────────────────────────────────────────────────────────────────
  var reloading = false;

  function showUpdate(worker) {
    if (document.getElementById('aems-pwa-update')) return;

    var pill = document.createElement('div');
    pill.id = 'aems-pwa-update';
    pill.className = 'aems-pwa-pill aems-pwa-update';

    var text = document.createElement('span');
    text.textContent = t('update');

    var reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'aems-pwa-reload';
    reload.textContent = t('reload');
    reload.addEventListener('click', function () {
      reloading = true;
      reload.disabled = true;
      if (worker) worker.postMessage({ type: 'SKIP_WAITING' });
      else location.reload();
    });

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'aems-pwa-x';
    close.setAttribute('aria-label', t('close'));
    close.innerHTML = ICON_CLOSE;
    close.addEventListener('click', function () { remove('aems-pwa-update'); });

    pill.appendChild(text);
    pill.appendChild(reload);
    pill.appendChild(close);
    stack().appendChild(pill);
  }

  // ── registration ───────────────────────────────────────────────────────────
  function register() {
    navigator.serviceWorker.register(SW_URL, { scope: '/', updateViaCache: 'none' })
      .then(function (registration) {
        window.AEMS_PWA.registration = registration;

        // A worker is already waiting (e.g. update installed in a previous tab).
        if (registration.waiting && navigator.serviceWorker.controller) {
          showUpdate(registration.waiting);
        }

        registration.addEventListener('updatefound', function () {
          var worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', function () {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdate(worker);
            }
          });
        });

        // Check for a new version when the tab comes back into focus, at most
        // once every 30 minutes.
        var lastCheck = Date.now();
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState !== 'visible') return;
          if (Date.now() - lastCheck < 30 * 60 * 1000) return;
          lastCheck = Date.now();
          registration.update().catch(function () { /* offline — ignore */ });
        });
      })
      .catch(function (err) {
        console.warn('[pwa] service worker registration failed:', err);
      });

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!reloading) return;
      reloading = false;
      location.reload();
    });
  }

  window.AEMS_PWA = {
    registration: null,
    isStandalone: isStandalone,
    promptInstall: function () { if (deferredPrompt) deferredPrompt.prompt(); }
  };

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
})();
