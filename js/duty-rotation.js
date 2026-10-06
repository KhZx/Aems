/**
 * 4-team rotating duty schedule (A/B/C/D) — 8-day cycle, teams staggered.
 *
 * Per-team repeating pattern:  D D N N X X X X
 *   D = Day   05:00 → 16:00 (same calendar date)
 *   N = Night 16:00 → 05:00 (crosses midnight, ends next date)
 *   X = Off
 *
 * The four offsets below reproduce the verified October 2026 reference
 * schedule exactly (Oct 5 → A=D, B=X, C=X, D=N, etc.).
 *
 * Pure module: no DOM, no i18n — safe to unit-test from Node/vitest.
 */

export const TEAMS = ['A', 'B', 'C', 'D'];
export const CYCLE = ['D', 'D', 'N', 'N', 'X', 'X', 'X', 'X'];

/**
 * Cycle position each team holds on the anchor date (2026-10-05), from the
 * verified October 2026 table: Oct 5 → A=D(1), B=X(5), C=X(7), D=N(3).
 */
export const TEAM_OFFSET = { A: 1, B: 5, C: 7, D: 3 };

/** Anchor date the offsets are measured from: 2026-10-05. */
const ANCHOR_DAY = Math.floor(Date.UTC(2026, 9, 5) / 86400000);

export const DAY_START_MIN = 5 * 60; // 05:00
export const DAY_END_MIN = 16 * 60;  // 16:00 — day ends / night starts

/** Local calendar date (midnight) for a Date. */
export function dateOf(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Shift a date by n days (calendar-safe across DST). */
export function addDays(d, n) {
  const x = dateOf(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Date at local midnight from a 'YYYY-MM-DD' key. */
export function fromDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 'YYYY-MM-DD' key for a Date (local). */
export function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Days since 1970-01-01 counted on the local calendar (DST-safe). */
function dayNumber(d) {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

/** Date at local time `minutes` past midnight. */
function atTime(d, minutes) {
  const x = dateOf(d);
  x.setHours(0, minutes, 0, 0);
  return x;
}

/**
 * The shift a team STARTS on a calendar date: 'D' | 'N' | 'X'.
 * Rotation position = (dayNumber - anchor + positionOnAnchor) mod 8.
 */
export function shiftOn(team, date) {
  const offset = TEAM_OFFSET[team];
  if (offset === undefined) return 'X';
  const p = (((dayNumber(date) - ANCHOR_DAY + offset) % 8) + 8) % 8;
  return CYCLE[p];
}

/**
 * Exact { start, end } window of the shift a team begins on `date`,
 * or null when off. Night windows cross midnight (16:00 → 05:00 next day).
 */
export function shiftWindow(team, date) {
  const s = shiftOn(team, date);
  if (s === 'X') return null;
  if (s === 'D') return { start: atTime(date, DAY_START_MIN), end: atTime(date, DAY_END_MIN) };
  return { start: atTime(date, DAY_END_MIN), end: atTime(addDays(date, 1), DAY_START_MIN) };
}

/**
 * Answers duty questions for an exact instant.
 *
 * Night shifts are attributed to the date they STARTED: before 05:00 the
 * governing date is yesterday, so "00:51 on Oct 7" is answered from Oct 6's
 * pattern (its night runs 16:00 Oct 6 → 05:00 Oct 7).
 *
 * Boundaries: day occupies [05:00, 16:00), night occupies [16:00, 05:00).
 * Exactly one team works at any instant — the day team by day, the night
 * team by night.
 *
 * Returns:
 *   ownerDate  — the calendar date whose pattern governs this instant
 *   teams      — { A: { state, window, active }, ... } (state/window from ownerDate)
 *   active     — array of teams actually working right now (0 or 1 in practice)
 */
export function dutyAt(instant) {
  const mins = instant.getHours() * 60 + instant.getMinutes() + instant.getSeconds() / 60;
  const ownerDate = mins < DAY_START_MIN ? addDays(dateOf(instant), -1) : dateOf(instant);

  const teams = {};
  const active = [];
  for (const team of TEAMS) {
    const state = shiftOn(team, ownerDate);
    const window = shiftWindow(team, ownerDate);
    const isActive = !!window && instant >= window.start && instant < window.end;
    teams[team] = { state, window, active: isActive };
    if (isActive) active.push(team);
  }
  return { ownerDate, teams, active };
}

/**
 * Live status of one team at an instant:
 *   { kind: 'on', state, window }        — working right now
 *   { kind: 'next', state, window }      — next shift starts later (within 5 days)
 *   { kind: 'off' }                      — no upcoming shift found (defensive)
 */
export function dutyStatusFor(team, instant) {
  const now = dutyAt(instant);
  const info = now.teams[team];
  if (info && info.active) return { kind: 'on', state: info.state, window: info.window };

  const base = dateOf(instant);
  for (let i = 0; i <= 5; i++) {
    const date = addDays(base, i);
    const state = shiftOn(team, date);
    if (state === 'X') continue;
    const window = shiftWindow(team, date);
    if (window && window.start > instant) return { kind: 'next', state, window };
  }
  return { kind: 'off' };
}

/** Every team's assignment on a calendar date: { A:'D', B:'X', ... }. */
export function scheduleOn(date) {
  const out = {};
  for (const team of TEAMS) out[team] = shiftOn(team, date);
  return out;
}
