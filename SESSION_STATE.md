# AEMS — Session State & Handoff

> Full progress save so a future session can resume without re-discovery.
> Last updated: Aug 12, 2026 (local, +04).

## 1. What this project is

**AEMS — Ambulance Equipment Management System.**
- `/` — frontend (static HTML + vanilla JS), previously Firebase Realtime DB, being moved to a self-hosted REST backend.
- `server/` — Node/TypeScript backend: Express 5 + Prisma 6 + PostgreSQL 16 + Firebase Admin + RBAC + Zod + pino + rate limiting. Package name `aems-api`, version 1.0.0.

## 2. The big recap — what was done in the last session

The whole frontend was rewired from Firebase Realtime Database to the new REST API (the large block below is the faithful recap).

### 2.1 Backend changes
- **RBAC** — `server/src/utils/rbac.ts`: added `audit:read` to 4 roles (`PARAMEDIC`, `EMT`, `TECHNICIAN`, `DOCTOR`) so field crews can view the audit log.
- **Public stations route** — `server/src/routes/index.ts:77` adds `GET /api/public/stations` (no auth) for the signup form's station directory.

### 2.2 Frontend changes
- **`js/api.js`** (new) — REST client. Base `http://localhost:4000/api`, `Authorization: Bearer <token>`, parses `{ success, data | error }` envelopes, auto re-auth on 401.
- **`js/auth.js`** (new) — session helper: `initAppSession`, `waitForAuthUser`, `loginWithBackend`, `registerWithBackend`, `roleRedirectPath`, `signOutAll`.
- **`login.html`** — Firebase sign-in → `POST /api/auth/login` via `loginWithBackend` → role-based redirect.
- **`signup.html`** — station directory from `GET /api/public/stations`; register via `POST /api/auth/register`; pending-approval screen.
- **`app.html`** — old Firebase RTDB guard module removed (auth now owned by `js/app.js`); ambulance selector in the topbar; add/edit modal replaced with restock/adjust form.
- **`js/ui.js`** — UUID-safe quoted element ids; permission-gated buttons (Check/Use/Restock/Adjust); delete removed; shift-note priority/date/id fixed for the backend shape.
- **`js/app.js`** (full rewrite, ~52 KB) — session-driven init, ambulance selector, per-ambulance inventory list, use/restock/adjust, inspections (quick check + full snapshot), changes-vs-last-inspection, shift notes, handovers (submit/acknowledge), audit-log history, reports, CSV export, Chart.js dashboard preserved.

### 2.3 Files changed/created
| File | Status |
|------|--------|
| `server/src/utils/rbac.ts` | edited (audit:read) |
| `server/src/routes/index.ts` | edited (public/stations) |
| `js/api.js` | created |
| `js/auth.js` | created |
| `login.html` | rewritten |
| `signup.html` | rewritten |
| `app.html` | edited (guard removed, ambulance selector, restock/adjust modal) |
| `js/ui.js` | edited (permission-gated buttons, uuid-safe ids) |
| `js/app.js` | full rewrite |
| `server/prisma/migrations/0_init/migration.sql` | BOM removed (see §4) |

### 2.4 Previously verified (static)
- Backend `tsc --noEmit` clean.
- Unit tests green: `npx vitest run` → exit 0 (24 passed, 12 skipped = integration suite skipped without `TEST_DATABASE_URL`).
- All frontend files present (api.js/auth.js/app.js/ui.js/login.html/signup.html/app.html verified present, sizes checked).
- `audit:read` confirmed in 4 roles; public route confirmed; login/signup use the REST client.

## 3. Todo list (current state)

1. ✅ Install PostgreSQL 16 via winget — **done** (see §4 for details).
2. ✅ Create `aems` + `aems_test` databases, confirm `postgres` user auth — **done**.
3. ✅ Apply Prisma migrations and seed data — **done**.
4. ⏸️ Wire Firebase service account credentials into `server/.env` — **BLOCKED: user will provide a service account key** (see §5).
5. ✅ Start backend, smoke test public routes — **done** (see §4.6).
6. ⏳ Run integration tests with `TEST_DATABASE_URL` — pending Firebase-free but needs DB (DB ready; just needs `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/aems_test?schema=public npx vitest run`).
7. ⏳ Start frontend (`node serve.mjs`, port 3000) and smoke test login/signup — pending Firebase creds for login; signup page + public stations can be checked without.

## 4. Environment state (verified this session)

### 4.1 PostgreSQL 16.14 — INSTALLED AND RUNNING
- Service **`postgresql-x64-16`** = **Running**, StartType Automatic (EDB install finished in the background).
- Superuser `postgres`, password **`postgres`** — matches `server/.env` `DATABASE_URL`.
- `psql` at `C:\Program Files\PostgreSQL\16\bin\psql.exe`.
- Databases created: **`aems`** and **`aems_test`**.
- pg_hba uses scram-sha-256; connections work from `localhost`.
- Also present: a **complete PG16 extracted to user space** at `C:\Users\khali\AppData\Local\PostgreSQL\16` (binaries zip downloaded from `https://get.enterprisedb.com/postgresql/postgresql-16.14-1-windows-x64-binaries.zip`). Used as a fallback while the EDB installer hung; can be ignored/deleted.
- **Leftover to clean up later:** service **`postgresql-x64-18`** = Stopped, from an earlier incomplete PG18 install (`C:\Program Files\PostgreSQL\18` is incomplete). Needs `sc delete postgresql-x64-18` (elevated) or uninstall.
- Install story: winget install hung >15 min (two installer processes, both stuck elevated and unkillable from non-elevated shell). Binaries for PG16 finished installing to Program Files in the background; the `lib` folder was missing mid-way, which broke `initdb` (`$libdir/dict_snowball`). Fixed by downloading the official EDB binaries zip (user-space copy) — then the service install completed on its own. The `0_init` migration SQL had a UTF-8 BOM that Postgres rejected (`syntax error at or near "\ufeff"`); BOM removed, `migrate resolve --rolled-back 0_init`, then `migrate deploy` succeeded.

### 4.2 Prisma migrated + seeded
- `npx prisma migrate deploy` → applied `0_init`.
- `npx prisma db seed` → **3 stations (CEN-01, ST-002, ST-003), 4 ambulances, 5 medicines, 10 batches, ~20 initial stock rows.**

### 4.3 Backend RUNNING
- Started via `npx tsx src/index.ts` (dev) → listening on **http://localhost:4000** (development).
- **Smoke-tested:** `GET /api/public/stations` → 200, returns the 3 seeded stations. ✓

### 4.4 API surface (from `server/src/routes/index.ts`)
- Auth: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`.
- Users: list/get/approve/reject/status/role/delete (permission-gated).
- Public: `GET /api/public/stations`.
- Stations / Ambulances / Medicines / Batches / Inventory (use/restock/adjust/remove/return/initial-stock) / Transfers / Inspections / Audit / Dashboard / Shift Notes / Handovers / Reports.
- Frontend API base: `http://localhost:4000/api` (hardcoded in `js/api.js`); CORS allows `http://localhost:3000`.

## 5. Next session — what to do first

1. **Firebase credentials (blocker).** User is providing a Firebase service-account key. Once available:
   - Add `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (multiline, escaped `\n`) to `server/.env`.
   - Optionally set `BOOTSTRAP_ADMIN_UID=<the user's Firebase UID>` to auto-activate the first admin.
   - Restart the backend, run `POST /api/auth/login` end-to-end.
2. **Integration tests:** `cd server; $env:TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aems_test?schema=public'; npx vitest run` (currently they `describe.skipIf(!HAS_DB)`).
3. **Frontend smoke test:** `node serve.mjs` at project root → http://localhost:3000; test signup page + station dropdown (works now), then login once Firebase is wired.
4. **Cleanup:** delete stopped `postgresql-x64-18` service (elevated `sc delete`); optionally remove `C:\Users\khali\AppData\Local\PostgreSQL\16` fallback copy and `C:\Users\khali\AppData\Local\Temp\opencode\pg16.zip` (~326 MB).

## 6. Useful commands (run from `server/`)

```powershell
npx tsc --noEmit        # typecheck / lint
npx vitest run          # unit tests (integration auto-skips without TEST_DATABASE_URL)
npx prisma migrate deploy
npx prisma db seed
npx prisma studio
npm run dev             # backend on :4000
```

Frontend static server (project root):
```powershell
node serve.mjs          # http://localhost:3000
```

DB access:
```powershell
$env:PGPASSWORD='postgres'; & 'C:\Program Files\PostgreSQL\16\bin\psql.exe' -h localhost -U postgres -d aems
```
