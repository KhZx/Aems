# AEMS — Ambulance Equipment Management System

AEMS is an equipment management platform for ambulance services. Field crews track
per-ambulance inventory, run inspections, submit shift notes and handovers, and
generate reports; supervisors and admins manage stations, users, and the audit log.

## Architecture

```
aems/
├── index.html          # Public landing page
├── login.html          # Sign in (Firebase auth → backend session)
├── signup.html         # Access request (pending-approval flow)
├── app.html            # Field crew / paramedic dashboard
├── supervisor.html     # Supervisor dashboard
├── admin.html          # Admin dashboard
├── error.html          # 404 fallback
├── css/                # main.css (shared styling + design system)
├── js/                 # Frontend modules
│   ├── api.js          #   REST client for the backend
│   ├── auth.js         #   Session handling (Firebase → backend)
│   ├── app.js          #   Main app page logic
│   ├── supervisor.js   #   Supervisor page logic
│   ├── ui.js           #   Shared UI helpers / permission gating
│   ├── i18n.js         #   English / Arabic translations
│   ├── icons.js        #   Inline SVG sprite
│   ├── health.js       #   Connection health monitor
│   ├── config.js       #   Firebase (client) config
│   ├── error-handler.js#   Global error handler (non-module)
│   ├── services/       #   firebase.js (SDK bootstrap)
│   └── data/           #   initial-data.js (shared constants)
├── pictures/           # Brand assets (favicon)
├── serve.mjs           # Dev static server (port 3000)
└── server/             # Node/TS REST API (see server/README)
    ├── prisma/         #   Schema + migrations + seed
    ├── src/            #   Express app (layered architecture)
    └── tests/          #   Vitest unit + integration tests
```

## Tech stack

- **Backend:** Node.js, Express 5, TypeScript, Prisma 6, PostgreSQL, Firebase Admin SDK
- **Auth:** Firebase Authentication (ID tokens) + role-based access control (RBAC)
- **Frontend:** Static HTML + vanilla JS modules (no build step)
- **Validation:** Zod schema validators
- **Testing:** Vitest
- **Logging:** pino + pino-http

## Getting started

Requirements: Node.js >= 20, PostgreSQL 16, and a Firebase project.

### 1. Backend

```bash
cd server
npm install
cp .env.example .env      # fill in DATABASE_URL + Firebase Admin credentials
npx prisma migrate deploy
npx prisma db seed
npm run dev               # API on http://localhost:4000
```

### 2. Frontend

```bash
node serve.mjs            # from the project root → http://localhost:3000
```

## Useful commands (run from `server/`)

```bash
npm run dev               # start API (watch mode)
npm run typecheck         # tsc --noEmit (lint/type check)
npm test                  # vitest run
npm run build             # prisma generate + tsc build
npm run db:migrate        # prisma migrate dev
npm run db:deploy         # prisma migrate deploy
npm run db:seed           # prisma db seed
npm run db:studio         # prisma studio
```

## Environment variables (`server/.env`)

See `server/.env.example` for the full list with comments. Key values:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | Firebase Admin SDK credentials |
| `FRONTEND_ORIGIN` | Comma-separated allowed CORS origins for the API |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | Global API rate limit |
| `BOOTSTRAP_ADMIN_UID` | Firebase UID auto-promoted to ACTIVE ADMIN on first use |

### Security notes

- `server/.env` and all service-account/private-key files are git-ignored — never commit them.
- The Firebase **web** `apiKey` in `js/config.js` is public by design (client config), not a secret.
- For any deployment beyond localhost, terminate TLS at a reverse proxy and set
  `NODE_ENV=production` (enables `trust proxy` + stricter `helmet` behavior).
- Known accepted advisories: `deepmerge-ts` (via Prisma config parser) and `uuid` (via
  google-cloud chain) — fixes are breaking downgrades of Prisma/Firebase Admin; neither
  vulnerable code path is used by this app.

## Deployment (GitHub ▸ Railway ▸ Vercel)

One-time flow:

### 1. GitHub
Create an empty **private** repo at github.com/new, then:
```powershell
git remote add origin https://github.com/<you>/aems.git
git push -u origin main
```

### 2. Railway — backend + PostgreSQL
1. New project ▸ **Database ▸ PostgreSQL** (name it `aems-db`). Railway provisions the DB and adds `DATABASE_URL` automatically to the project environment.
2. New service ▸ **Deploy from GitHub repo** ▸ pick `aems`, and set **Root Directory = `server`**.
3. Service ▸ **Variables** — set these (same names as `server/.env.example`):

   | Variable | Value |
   |----------|-------|
   | `NODE_ENV` | `production` |
   | `FRONTEND_ORIGIN` | `https://<your-project>.vercel.app` (step 3's URL; comma-separated if multiple) |
   | `FIREBASE_PROJECT_ID` | from your Firebase service-account JSON |
   | `FIREBASE_CLIENT_EMAIL` | from service-account JSON |
   | `FIREBASE_PRIVATE_KEY` | from service-account JSON — **keep it on one line with `\n` escapes**, wrapped in quotes |
   | `BOOTSTRAP_ADMIN_UID` | your Firebase UID (activates the first admin) |

   Leave `DATABASE_URL` as the one Railway injected (`${Postgres.DATABASE_URL}` reference).
4. `server/railway.json` handles the rest: build (`npm run build` → prisma generate + tsc),
   start (`npx prisma migrate deploy && node dist/index.js`), and the `/api/health` check.
5. After first deploy, get the **public domain** (Service ▸ Settings ▸ Networking ▸ Generate
   domain), e.g. `https://aems-api.up.railway.app`.
6. *(optional, seeded data)* apply the demo seed from your machine:
   ```powershell
   cd server
   $env:DATABASE_URL='<railway postgres external URL>'   # from Railway ▸ Postgres ▸ Settings ▸ Internal/External Database URL
   npx prisma db seed
   ```

### 3. Vercel — static frontend
1. Import the same GitHub repo. Framework: **Other**. Build command: *(empty)*,
   Output: repo root. `vercel.json` + `.vercelignore` handle routing and keep `server/`
   out of the deploy.
2. **One required code step before it talks to the API**: put your Railway URL into
   `js/config.js` → `RAILWAY_API_ORIGIN = "https://aems-api.up.railway.app"`, commit, push.
   (Local `localhost:4000` dev keeps working — the switch only happens on non-localhost hosts.)

### 4. Firebase Console — required for login from the Vercel domain
Firebase ▸ Authentication ▸ Settings ▸ **Authorized domains** ▸ add
`<your-project>.vercel.app`. Without it, the browser SDK refuses to sign in from that origin.

### 5. Post-deploy checklist
- [ ] `https://<railway>/api/health` → `{"success":true, ... "database":"ok"}`
- [ ] `https://<railway>/api/public/stations` → station list (also drives the landing-page live stat)
- [ ] Landing page hero counters animate; "Active Stations" shows the real DB count
- [ ] Signup on Vercel ▸ station dropdown populated ▸ account lands PENDING
- [ ] Admin login ▸ approve user ▸ activate/deactivate round-trips work
- [ ] Logout ▸ login again ▸ session renews (401 auto-reauth)
- [ ] Railway ▸ `FRONTEND_ORIGIN` exactly matches the Vercel URL (CORS fails silently otherwise)
