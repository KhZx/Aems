# AEMS — Work Notes (Oct 6, 2026 session)

> Local-only working notes. **Nothing has been pushed** to GitHub / Railway /
> Vercel / Firebase — everything below was committed **locally** this session.
> Previous session: `WORK_NOTES_2026-10-04.md`. Handoff context: `SESSION_STATE.md`.

---

## 1. Session scope

Visual / landing-page session (no backend logic changes). In order:

1. Hero redesign — banner `Banner1.jpg` at full strength, transparent header,
   text sits on the image (no glass panel).
2. Interactive CSS ambulance (idle / rev / Drive Test button).
3. Logo pipeline → final static `assets/DubaiAmbulance.svg` on all 6 pages.
4. `assets/` folder reorg (banner + logo SVG), root cleaned.
5. User corrections: site-wide square grid restored (only absent over the hero
   picture); demo window nudged right to reveal the banner car.

---

## 2. Hero (index.html inline CSS)

- `.hero-banner` inside `.hero-atm`: `url('assets/Banner1.jpg') center/cover`,
  `opacity: 1`, `bannerDrift` 46s alternate.
- `.hero-banner::after` cinematic grade: top wash + left falloff + bottom fade
  to `#06080F` + vignette + two red radial glows.
- Header: `.hdr` transparent over hero → `.hdr.solid` (dark glass, blur 20px)
  when `scrollY > 40` — `hdrScroll` passive listener in inline JS.
- `.hero-l` glass panel **removed** (user request); `.h-title`
  `clamp(3.1rem,5.4vw,6rem)` + big text-shadow; `.h-sub` / `.btn-outline` /
  `.h-ops` all shadow-hardened for readability on the image.
- Hero grid overlay (`.hero-atm::after`) removed — see §6 correction.

## 3. Interactive ambulance (rear-sec demo)

- `.ambu` motion: `ambuIdle` 3.6s bob; `.ambu:hover` → `ambuRev` one-shot +
  faster LEDs; `.ambu.driving` → `ambuDrive` 2.4s (squat, recede `scale(.6)`,
  return), `pointer-events:none` while driving.
- **Drive Test** button: `.ambu-actions` / `.drive-btn`, icon `#i-ambulance`
  via `mountSprite()` (js/icons.js); `window.driveAmbu` auto-closes doors,
  2400ms timeout, debounced.
- i18n key `ambu.drive` — js/i18n.js EN `Drive Test` / AR `اختبار القيادة`.
- `prefers-reduced-motion` disables banner drift + idle bob.

## 4. Logo → `assets/` reorg

- Final logo: **`assets/DubaiAmbulance.svg`** (user-provided, static,
  viewBox `0 0 259.04 46.52`, aspect ≈ 5.57, tight crop, no animation).
- `logo.svg` (old animated one) **deleted**; zero stale references (verified).
- All 10 instances repointed: index ×3 (header/drawer/footer), app ×1,
  login ×2, signup ×2, admin ×1, supervisor ×1.
- Sizes: index header `.dca-logo` **38px**, admin **34px** (reduced from
  40/36 so widths fit the header/sidebar with the wider 5.57 aspect);
  footer 34, app 34 (sidebar 260px), supervisor 32, login 40/56,
  signup 40/52 — all verified to fit.
- `assets/Banner1.jpg` — hero background now referenced from `assets/`.
  Favicon stays `pictures/small logo for tab view and other things.jpg`
  (wired on all 7 html pages, incl. error.html).
- `assets/` + dated notes files are in the local commit.

## 5. Demo window nudge (reveal banner car)

```css
@media (min-width:1200px){
  .app-win { right: -64px; }
  .radar   { transform: translate(calc(-52% + 64px), -50%); }
}
```

- `right` offset (NOT transform) so it can't fight the `winRise` animation.
- Desktop only — phone/tablet (≤1199) untouched, still centered/stacked.
- **Tuning knob: `64px` in both lines** — user hasn't eyeballed it yet.

## 6. User corrections this session (important)

1. **Square grid pattern is site-wide again** — my earlier edit wrongly removed
   it from the whole page; user only wanted it gone *over the picture*.
   `body::before` 60px grid restored at index.html top; the hero picture hides
   it naturally because `.hero-atm` is opaque. `.hero-atm::after` grid stays
   removed.
2. **Animated logo dropped** — replaced by static `DubaiAmbulance.svg` (§4).

## 7. Verification (all green)

- 6 pages + both assets serve 200 on `:3000`; new-logo counts
  3/1/2/2/1/1, stale refs 0.
- index inline `<script>` passes `node --check`.
- **Backend: `npm run typecheck` clean, `npx vitest run` 96/96 pass** (covers
  the uncommitted Oct-4 backend work being committed now).

## 8. Committed locally this session

Everything in the working tree (this session's visual work + Oct-4 session's
uncommitted backend: security/scoping, duty rotation, unit switching,
distribution/import APIs) — **one local commit, NOT pushed**. See `git log`.

## 9. Open items / tomorrow

- **Push + deploy still pending**: Railway → Vercel steps live in
  `SESSION_STATE.md` §6–7 (started: none). Frontend needs
  `js/config.js RAILWAY_API_ORIGIN` filled in once the Railway URL exists.
- Eyeball tuning (user): demo-window nudge `64px`; logo heights (38/34) if
  alignment needs a nudge on their screen.
- Duty-rotation known discrepancy (from Oct-4, unresolved by design): user's
  example "00:51 Oct 7 → C on Day" conflicts with exact 05:00/16:00
  boundaries (C is active then, but it's still Night of Oct 6) — exact times
  were implemented as instructed.
- Test commands (in `server/`):
  `npm run typecheck` ·
  `$env:TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aems_test?schema=public'; npx vitest run`
- Git identity is the repo-local placeholder `AEMS <aems@localhost>` (accepted).
