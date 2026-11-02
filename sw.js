/* ─────────────────────────────────────────────────────────────────────────────
   AEMS service worker — installable app shell + offline support.

   MAINTENANCE: bump VERSION below whenever you ship changes to any file that
   appears in CORE_ASSETS. Old caches are deleted on activate, so a version bump
   forces every client to refetch the new HTML/CSS/JS instead of serving stale
   files. The in-page update pill (js/pwa.js) tells the user to reload.
   ───────────────────────────────────────────────────────────────────────────── */

const VERSION = '1.0.0';
const CORE_CACHE = `aems-core-v${VERSION}`;
const RUNTIME_CACHE = `aems-runtime-v${VERSION}`;

// App shell: everything needed to boot the UI with no network.
// Individual failures are tolerated (see install handler) so a renamed file
// cannot break the whole install.
const CORE_ASSETS = [
  '/manifest.webmanifest',
  '/offline.html',
  '/index.html',
  '/login.html',
  '/signup.html',
  '/app.html',
  '/admin.html',
  '/supervisor.html',
  '/error.html',

  '/css/main.css',
  '/css/glass.css',
  '/css/lang-toggle.css',
  '/css/password.css',
  '/css/reports.css',

  '/js/api.js',
  '/js/app.js',
  '/js/auth.js',
  '/js/config.js',
  '/js/confirm.js',
  '/js/duty-calendar.js',
  '/js/duty-rotation.js',
  '/js/error-handler.js',
  '/js/health.js',
  '/js/i18n.js',
  '/js/icons.js',
  '/js/notifications.js',
  '/js/password.js',
  '/js/pwa.js',
  '/js/reasons.js',
  '/js/reports.js',
  '/js/sidebar-nav.js',
  '/js/supervisor.js',
  '/js/ui.js',
  '/js/data/initial-data.js',
  '/js/services/firebase.js',

  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/pictures/ECGLOGO.png'
];

// Third-party code the UI depends on. Cached on first use, never pre-fetched
// (they can be slow, and the app must not fail to install because of a CDN).
const CDN_HOSTS = new Set([
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.gstatic.com'
]);

const NAV_TIMEOUT_MS = 4000;

// ── install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    const results = await Promise.allSettled(
      CORE_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' })))
    );
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? CORE_ASSETS[i] : null))
      .filter(Boolean);
    if (failed.length) console.warn('[sw] precache missed:', failed.join(', '));
    // Take over as soon as possible; the page shows a reload prompt if a tab
    // was already open (see js/pwa.js).
    await self.skipWaiting();
  })());
});

// ── activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CORE_CACHE, RUNTIME_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.map((n) => (keep.has(n) ? null : caches.delete(n))));
    await self.clients.claim();
  })());
});

// ── helpers ──────────────────────────────────────────────────────────────────
function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function put(cacheName, request, response) {
  if (!response) return;
  // Opaque CDN responses are fine to cache; error responses are not.
  if (!response.ok && response.type !== 'opaque') return;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  } catch { /* quota / private mode — offline support is best-effort */ }
}

/** Cache lookup that also tries the cleanUrl → .html alias. */
async function matchPage(request) {
  const direct = await caches.match(request, { ignoreSearch: true });
  if (direct) return direct;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;

  const path = url.pathname;
  if (path === '/' || path.endsWith('/')) {
    return caches.match('/index.html', { ignoreSearch: true });
  }
  if (!path.includes('.')) {
    return caches.match(`${path}.html`, { ignoreSearch: true });
  }
  return null;
}

// ── navigation: network first, cache second, offline page last ───────────────
async function handleNavigate(request) {
  try {
    const response = await fetchWithTimeout(request, NAV_TIMEOUT_MS);
    if (response && response.ok) await put(RUNTIME_CACHE, request, response);
    return response;
  } catch {
    const cached = await matchPage(request);
    if (cached) return cached;
    const offline = await caches.match('/offline.html');
    if (offline) return offline;
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

// ── static assets: serve cache instantly, refresh in the background ──────────
async function handleStaleWhileRevalidate(request) {
  const cached = await caches.match(request, { ignoreSearch: true });

  if (cached) {
    // Refresh in the background; the cached copy is served right away.
    fetch(request)
      .then((response) => put(RUNTIME_CACHE, request, response))
      .catch(() => {});
    return cached;
  }

  const response = await fetch(request);
  await put(RUNTIME_CACHE, request, response);
  return response;
}

// ── router ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Never touch authenticated API traffic — equipment data must not be cached.
  if (request.headers.has('authorization')) return;
  if (request.headers.get('accept') === 'application/json' && request.mode === 'cors') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
    return;
  }

  if (url.origin === self.location.origin) {
    // Backend calls (dev server proxies /api) stay network-only.
    if (url.pathname.startsWith('/api/')) return;
    if (request.destination === 'video' || request.destination === 'audio') return;
    event.respondWith(handleStaleWhileRevalidate(request));
    return;
  }

  if (CDN_HOSTS.has(url.hostname)) {
    event.respondWith(handleStaleWhileRevalidate(request));
  }
});

// ── messages from js/pwa.js ──────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'CLEAR_RUNTIME') {
    event.waitUntil(caches.delete(RUNTIME_CACHE));
  }
});
