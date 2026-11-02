# AEMS as an installable app (PWA)

The site is now a Progressive Web App: it can be installed to a phone's home
screen (Android + iPhone) and keeps working with a dropped connection.

## Files that make it work

| File | Purpose |
|---|---|
| `manifest.webmanifest` | App name, colours, icons, start URL, app shortcuts |
| `sw.js` | Service worker: precaches the app shell, serves it offline |
| `js/pwa.js` | Registers the worker, shows the install / update prompts |
| `offline.html` | Fallback page when a page was never cached |
| `icons/*.png` | 192/512 icons, maskable variants and the iOS touch icon |

Every page (`index`, `login`, `signup`, `app`, `admin`, `supervisor`, `error`)
loads `js/pwa.js` and the manifest from its `<head>`.

## Installing it on a phone

The app must be served over **HTTPS** (Vercel and Firebase Hosting both do this).
`localhost` / `127.0.0.1` also count as secure, so it can be tested locally.

**Android (Chrome / Edge / Samsung Internet)**
Open the site → an "Install AEMS" pill appears at the bottom → tap it →
confirm. Or use the browser menu → *Install app / Add to Home screen*.

**iPhone / iPad (Safari)**
Open the site → tap the Share button → *Add to Home Screen*. iOS has no
install prompt, so the app shows these steps itself when the pill is tapped.

Once installed it launches full-screen (no browser bars), with its own icon, and
opens directly on `/app`.

## Offline behaviour

* Pages you have already opened are served from cache.
* A page you have never opened shows `offline.html` with a retry button.
* API calls, Firebase auth and anything with an `Authorization` header are
  **never** cached — equipment data stays out of the cache.
* CDN assets (Tailwind, Chart.js, Google Fonts, Firebase modules) are cached on
  first use so the UI still renders offline.

## When you change the site

`sw.js` refreshes JS/CSS/images in the background on every load, so ordinary
edits reach users on their next visit.

If you change the **app shell** (the list in `CORE_ASSETS`, `offline.html`, a
page's `<head>`, or the manifest), bump `VERSION` at the top of `sw.js`. The new
worker precaches everything fresh and deletes the old caches; users see a
"New version available — Reload" pill.

```js
const VERSION = '1.0.1';   // ← change this
```

## Deploy headers

`vercel.json` and `firebase.json` already set the right headers:

* `/sw.js` — never cached (`max-age=0` / `no-cache`), so updates are picked up.
* `/manifest.webmanifest` — served as `application/manifest+json`.
* `serve.mjs` (local dev) serves `.webmanifest` with the correct MIME type.

## Not included (yet)

This is a PWA, not a Play Store listing. To ship an APK/AAB later, wrap the same
web app with Capacitor — that step needs the Android SDK/JDK installed.
