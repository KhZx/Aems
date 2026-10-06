# AEMS — Work Notes (Oct 4, 2026 session)

> Local-only working notes. **Nothing has been pushed** to GitHub / Railway /
> Vercel / Firebase — ALL changes are LOCAL ONLY, uncommitted.
> Previous session: `WORK_NOTES_2026-09-15.md`. Handoff context: `SESSION_STATE.md`.

---

## 1. Goal for this session

1. Close the security holes in inventory/station scoping (crew must only touch
   their **own unit's** stock).
2. Audit the rest of the codebase for similar holes.
3. Then: implement **FIXED / FLOAT duty-unit switching**.

Items 1 and 2 are **done**. Item 3 has **not been started** — see §5.

Policy decisions confirmed by the user this session:

- Crew may still **create** catalogue medicines/batches (it is a shared
  catalogue); what an admin controls is **what stock each unit holds**.
- Admin needs **"add my list to all my ~20 cars"** in one action.
- Out-of-service cars are **not** stocked by a bulk apply (reported as skipped).
- A distribution list stays **reusable** (no auto-archive after use).

---

## 2. Access-control changes (`server/src/utils/rbac.ts`)

| Permission | Change |
|---|---|
| `medicine:delete` | **Removed** from PARAMEDIC / EMT / TECHNICIAN / DOCTOR (SUPERVISOR + ADMIN keep it) |
| `inventory:adjust` | **Added** to PARAMEDIC + EMT (own unit only) |
| `station:assign` | New, **ADMIN only** — supervisor self-assignment removed |
| `shiftnote:restore` | New, SUPERVISOR + ADMIN |

---

## 3. Holes found and fixed

### 3.1 Whole-medicine deletion from the fleet
- `medicine.service.ts` — deleting a medicine that sits on **more than one
  ambulance** is refused with 409 unless the caller passes `{ force: true }`.
  Audited with `forcedFleetWide`.
- `medicine.controller.ts` reads `req.body.force`; `js/api.js` +
  `js/app.js` show an explicit second confirmation.

### 3.2 Shift notes were hard-deleted
- `schema.prisma` + migration
  `server/prisma/migrations/20260916000000_shift_note_soft_delete/migration.sql`
  add `deletedAt`, `deletedById`, `deleteReason`.
- Rules now: **author** may delete their own note within **12h**; otherwise a
  supervisor/admin must. Crew can never delete someone else's note.
- Removed notes are hidden from the normal list; supervisors/admins get
  `?includeDeleted=true` and `POST /shift-notes/:id/restore`.
- **Applied locally** with `npx prisma db push` + `prisma generate`.

### 3.3 Supply requests — anyone could cancel anyone's request
- Non-reviewers can now only cancel requests they created themselves.

### 3.4 Ambulance create / update / delete had **no unit check at all**
- `ambulance.controller.ts` now scopes all three (supervisors are read-only on
  vehicles; a non-admin can only add a car to a unit they belong to).

### 3.5 Supervisor self-escalation (found while testing)
- `PUT /auth/me/managed-stations` was locked to ADMIN by the permission — which
  left the route **dead** (admins were rejected by a SUPERVISOR-only role check).
- Removed it; replaced with **`PUT /api/users/:id/managed-stations`**
  (`station:assign`, ADMIN only, targets another user).
  `js/api.js` + `js/supervisor.js` updated; the supervisor page is read-only.

### 3.6 `includeDeleted` was silently dropped
- `validate()` replaces `req.query` with the Zod result, and
  `listShiftNotesQuerySchema` had no `includeDeleted` key → supervisors could
  never see removed notes. Added to the schema.

### 3.7 Firebase was a second, unprotected database
- `js/services/firebase.js` is now **auth-only** (only the pure `stationKey`
  helper remains); no Realtime Database reads/writes.
- Added `database.rules.json` (deny all) and wired it into `firebase.json`.
- Removed the admin "Clear Test Data" button/function; connection indicator
  now uses the API `/health`.

### 3.8 Two cheap safeguards
- Authenticated 401/403 → audit entry `SECURITY_SCOPE_DENIED`
  (`middleware/errorHandler.ts`).
- `destructiveRateLimiter` — 40/hour per user or IP on all DELETE routes.

---

## 4. Admin bulk stocking (the "add my list to all 20 cars" fix)

`applyTemplate` in `server/src/services/distribution.service.ts` used to stock
**only the first ACTIVE ambulance per station** and then **archived the
template** (single use). Both were wrong for a standard fleet load-out.

Now:
- every **ACTIVE** ambulance in each selected station is stocked;
- out-of-service cars are returned in `skipped` with a reason
  (`Vehicle is maintenance`, …);
- the template stays active and can be applied again (quantities stack);
- result shape: `applied[]`/`skipped[]` now carry `vehicleNumber`, and
  `totals` gained `ambulances` (alongside `stations`, `items`, `units`);
- the audit entity is now the ambulance, not the station;
- `admin.html` shows a per-vehicle breakdown; EN/AR strings updated.

Verified live: 3 active cars across 2 units → 12 units; second apply → 8 per car.

---

## 5. Still to do

- [ ] **FIXED / FLOAT duty-unit switching** (the next task). Design agreed so far:
      - `FIXED` = permanent home unit + optional temporary duty unit.
      - `FLOAT` = no home unit; must pick a duty unit; reason + audit; expiry.
      - Still open: who sets the mode (admin only, or self-declared at signup?)
        and whether the duty unit expires (12h? end of shift?).
      - Current model: a single `User.stationId`.
- [ ] Optional / not requested: hash-chained audit records, and a supervisor
      alert card for denied requests (only the audit rows exist today).
- [ ] Before anything is ever deployed: the four `server/prisma/migrations/`
      folders must be applied to the Railway Postgres (`migrate deploy`).

---

## 6. Verification status

```
server/  npm run typecheck          → clean
server/  npx vitest run             → 4 files, 59 passed, 0 failed
frontend node --check (app/ui/api/supervisor/i18n/firebase + admin.html module) → clean
```

New live tests in `server/tests/api.integration.test.ts` ("cross-unit and
privilege boundaries") cover: crew blocked from fleet-wide medicine delete,
cross-unit shift note / inventory / ambulance access, supervisor self-escalation,
soft-delete + restore rules, cancelling someone else's supply request, denial
audit rows, bulk distribution to all cars, and crew being locked out of
distribution routes.

**Those tests only run when a test database is provided** — they force-reset it,
so never point them at the dev database:

```powershell
cd server
$env:PGPASSWORD = 'postgres'
& 'C:\Program Files\PostgreSQL\16\bin\createdb.exe' -h localhost -U postgres aems_sectest
$base = (Get-Content .env | ? { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=',''
$env:DATABASE_URL = $base -replace '/aems\?', '/aems_sectest?'
$env:TEST_DATABASE_URL = $env:DATABASE_URL
npx vitest run
# clean up when done
& 'C:\Program Files\PostgreSQL\16\bin\dropdb.exe' -h localhost -U postgres aems_sectest
```

---

## 7. Housekeeping

- Deleted the accidental scratch file
  `UserskhaliAppDataLocalTempopencodeaems-checkadmin-inline.mjs`.
- `WORK_NOTES_2026-09-15.md` §1A still says the distribution list auto-archives
  after apply — **superseded** by §4 of this file.
- git identity is still the placeholder `AEMS <aems@localhost>` (see
  `SESSION_STATE.md` §5) — nothing has been committed this session anyway.