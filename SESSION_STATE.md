# AEMS — Session State & Handoff

> Full progress save so a future session can resume without re-discovery.
> Last updated: Aug 30, 2026 (local, +04). **GitHub is set up and current — resume at Railway.**

## 1. What this project is

**AEMS — Ambulance Equipment Management System.** (Dubai Corporation of Ambulance Services)
- Root — frontend (static HTML + vanilla JS, EN/AR, no build step): `index.html` (landing), `login/signup`, `app.html` (field crew), `supervisor.html`, `admin.html`
- `server/` — Node/TypeScript backend: Express 5 + Prisma 6 + PostgreSQL 16 + Firebase Admin (auth only) + RBAC + Zod + pino + rate limiting. Package `aems-api`, **version 1.0.0** (aligned everywhere today).

## 2. Deployment plan (agreed)

| Piece | Platform | Status |
|---|---|---|
| Code repo (PRIVATE) | **github.com/KhZx/Aems** | ✅ pushed, branch `main`, HEAD `a20a185` |
| Backend API + PostgreSQL | **Railway** | ⏳ NOT STARTED — this is where we resume |
| Static frontend | **Vercel** | ⏳ NOT STARTED (config files ready in repo) |
| Firebase | auth only (login) | creds work locally; needs Authorized-domains step after Vercel |

## 3. Where exactly we stopped — RESUME HERE

**Tonight's remaining plan is all Railway (see §6 for the click-by-step). Nothing is blocked.**

One code edit waits for Railway's public URL:
- `js/config.js` line: `export const RAILWAY_API_ORIGIN = "";` ← paste e.g. `https://aems-xxxx.up.railway.app` (no trailing slash needed; code appends `/api`), then commit+push. Until then, any deployed frontend throws "AEMS API URL is not configured" (by design).

## 4. What was done this session (chronological)

1. **Cleanup pass** — deleted dead files (`js/db.js`, `js/mount-icons.js`, unused logo, stray Arabic html, duplicate `pictures/New folder/`, `_archive/`, logs, empty `server/src/repositories/`, `server/listusers.mjs`, root `node_modules` vite cache). Removed old-system `database.rules.json` + its dangling `database` block in `firebase.json`. Added `README.md`.
2. **Security audit** — baseline solid (helmet, CORS allowlist, token verify + RBAC, rate limits incl. auth, 1MB body cap, safe error handler, `.env` git-ignored). Firebase Admin creds + `BOOTSTRAP_ADMIN_UID` (28-char UID) are set in `server/.env`.
3. **Bug fixes**:
   - **Medicine P2002**: empty-string barcode violated `@unique` → `medicine.service.ts` now normalizes blank barcode → `NULL` (create+update); legacy `''` row fixed in DB via SQL.
   - **Supervisor Edit modal didn't open**: page CSS uses `.modal-overlay.open` (opacity) pattern, JS toggled `style.display` → switched to `classList.add/remove('open')` + backdrop-click close. Modal is notes-only by design (name/qty/expiry locked) = intended behavior.
   - **Admin reactivate no-op**: `toggleUser` treated `suspended` as "deactivating" → one-line fix (`deactivating = u.status === 'active'`); suspended users now reactivate via approve flow. Test subject: user **dedo** (was left SUSPENDED on purpose).
   - **Shift not remembered**: saved combined label `"A – Morning"` but validated against `['A','B']` → `app.js` now stores raw `shiftCode` + **auto-persists on change** (also reads legacy combined format). Period was always fine.
4. **Landing page overhaul**: version → **v1.0 everywhere**; SEO/OG/theme-color meta; deleted dead zone/hotspot CSS+JS; **NEW "Try It Like You're On Shift" patient-monitor simulator** (canvas ECG/pleth/EtCO₂, rhythms NSR/Tach/VFib/Asystole, charge→shock defib with correct ACLS logic, opt-in WebAudio sound, i18n EN/AR, reduced-motion aware); rear doors rebuilt as a **realistic CSS ambulance bay** (perspective walls/ceiling/LED light-on, stretcher, equipment objects, two-faced 3D doors swinging past frame); live station count from `/api/public/stations` (graceful fallback); hero-counter freeze fixed.
5. **Accidental duplicates**: user pasted copies named `* - Copy*` (13 items, ~169 MB) — all deleted; `* - Copy*` now git-ignored.
6. **Deploy prep (all committed)**: hostname-aware API base (`config.js RAILWAY_API_ORIGIN` + `api.js`/`health.js` + clear unconfigured error); `vercel.json` + `.vercelignore` + `404.html` stub; `server/railway.json` (Nixpacks, start = `npx prisma migrate deploy && node dist/index.js`, healthcheck `/api/health`); `prisma` moved to **dependencies** (lockfile updated); `.gitattributes` (LF); `.gitignore` refreshed for current stack. **git init → 3 commits → pushed to GitHub** ✓. Verified twice: zero secrets tracked (`server/.env`, `node_modules` ignored). 30 vitest pass + tsc clean after changes.

## 5. Known accepted issues (do not chase)

- `npm audit`: 9 transitive advisories (deepmerge-ts via Prisma config, uuid via google-cloud) — "fixes" are breaking downgrades; not exploitable in this app. Documented in README.
- git identity is a **placeholder**: `AEMS <aems@localhost>` (repo-local). If commits should show KhZx on GitHub: `git config user.name "Khali"; git config user.email "<github noreply email>"` then `git commit --amend --reset-author` (×3 or just accept).
- `SESSION_STATE.md` (this file) contains only the local dev `postgres/postgres` credential — fine for the private repo.
- Old `postgresql-x64-18` Windows service + `C:\Users\khali\AppData\Local\PostgreSQL\16` fallback copy are still on the machine (harmless).

## 6. TOMORROW — Railway, exact steps

1. railway.com → login **with GitHub** (needs a card for the $5 trial).
2. New Project (empty, name `aems`) → New+ → **Database → PostgreSQL** (wait for green).
3. New+ → **Deploy from GitHub repo** → pick **KhZx/Aems** (if missing: "Configure GitHub App" → grant that repo).
4. Service → Settings → Source → **Root Directory = `server`** ← the classic miss.
5. Variables tab → add: `NODE_ENV=production`, `FRONTEND_ORIGIN=http://localhost:3000` (temporarily), `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (copy each from local `server\.env` — private key stays ONE line with `\n` escapes), `BOOTSTRAP_ADMIN_UID` (from same file). Do NOT add `DATABASE_URL` (Railway injects).
6. Deploy → watch logs → expect migrate step then `listening …`. If build fails: 9/10 Root Directory wrong → paste the log.
7. Settings → Networking → **Generate Domain** → open `https://<domain>/api/health` (want `database:"ok"`) and `/api/public/stations`.
8. Paste `js/config.js` RAILWAY_API_ORIGIN = that domain → commit+push (I can do this).
9. *(optional)* seed demo data: Railway Postgres → Settings → **External** Database URL → from local `server/`: set `$env:DATABASE_URL` then `npx prisma db seed`.

## 7. Then Vercel (5 min)

1. vercel.com → login with GitHub → Import **KhZx/Aems** → Framework **"Other"**, build/output **empty** → Deploy (configs are in repo).
2. Railway → Variables → `FRONTEND_ORIGIN` = `https://<project>.vercel.app` → redeploy (auto on env change? if not: trigger deploy).
3. **Firebase Console → Authentication → Settings → Authorized domains → ADD the vercel.app domain** ← without this, login silently fails.

## 8. Post-deploy smoke checklist

- [ ] Landing: hero counters animate, "Active Stations" = real count, ambulance doors + monitor sim work
- [ ] `/api/health` → db ok · signup on Vercel → station dropdown → PENDING
- [ ] Admin login → approve → deactivate → **Activate** round-trips (dedo test) · supervisor Edit-notes modal saves + audit-logs · shift picker persists across logout (app)
- [ ] AR mode (عربي) on landing + supervisor confirm popups

## 9. Useful commands

```powershell
# frontend dev (root)                       # backend dev (server/)
node serve.mjs         # :3000              npx tsx src/index.ts   # :4000
# after any change:
git add -A; git commit -m "…"; git push origin main
# backend checks (server/):
npm run typecheck ; npx vitest run
# local psql:
$env:PGPASSWORD='postgres'; & 'C:\Program Files\PostgreSQL\16\bin\psql.exe' -h localhost -U postgres -d aems
```
