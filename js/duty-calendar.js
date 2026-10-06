// AEMS — Settings add-ons: live "my duty" widget, rotation calendar and the
// real-time duty checker. Logic lives in ./duty-rotation.js (unit-tested);
// this file only renders. Pure ES module, no DOM access until initDutyCalendar().
import { t, getCurrentLang } from './i18n.js';
import {
  TEAMS,
  shiftOn,
  shiftWindow,
  dutyAt,
  dutyStatusFor,
  dateOf,
  addDays,
  dateKey,
  fromDateKey,
} from './duty-rotation.js';

const S = { ready: false, viewY: 0, viewM: 0, selected: null, timer: null };

const $ = (id) => document.getElementById(id);
const locale = () => (getCurrentLang() === 'ar' ? 'ar' : 'en');
const fmtTime = (d) => d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = (d) => d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = (d) => d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
const fmtDateTime = (d) => `${fmtShort(d)} ${fmtTime(d)}`;
const weekStart = () => (getCurrentLang() === 'ar' ? 6 : 1);

function toInputValue(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Current team: live select value, falling back to the persisted pick. */
function getTeam() {
  const sel = $('s-shift');
  if (sel && TEAMS.includes(sel.value)) return sel.value;
  try {
    const info = JSON.parse(localStorage.getItem('aems_station_info') || '{}');
    if (TEAMS.includes(info.shiftCode)) return info.shiftCode;
  } catch { /* ignore */ }
  return '';
}

function hoursLabel(state) {
  return state === 'D' ? t('app.dutycal.hours_D') : state === 'N' ? t('app.dutycal.hours_N') : '';
}

// ── Live widget ────────────────────────────────────────────────
function renderMini() {
  const chip = $('dutyMiniChip');
  if (!chip) return;
  const team = getTeam();
  const badge = $('dutyMiniBadge');
  const title = $('dutyMiniTitle');
  const sub = $('dutyMiniSub');
  const strip = $('dutyNowStrip');
  if (!badge || !title || !sub || !strip) return;

  if (!team) {
    chip.style.display = 'none';
    badge.textContent = '—';
    title.textContent = t('app.dutycal.pick_team');
    sub.textContent = '';
    strip.innerHTML = '';
    return;
  }

  const now = new Date();
  const st = dutyStatusFor(team, now);
  badge.textContent = team;
  chip.style.display = '';
  chip.classList.toggle('on', st.kind === 'on');

  if (st.kind === 'on') {
    chip.textContent = `${t('app.dutycal.on')} · ${t('app.dutycal.until', { v: fmtTime(st.window.end) })}`;
    title.textContent = t(`app.dutycal.shift_${st.state}`);
    sub.textContent = `${fmtDateTime(st.window.start)} → ${fmtDateTime(st.window.end)}`;
  } else {
    chip.textContent = t('app.dutycal.off');
    title.textContent = t('app.dutycal.shift_X');
    sub.textContent = st.kind === 'next'
      ? t('app.dutycal.next', { shift: t(`app.dutycal.shift_${st.state}`), when: fmtDateTime(st.window.start) })
      : t('app.dutycal.no_window');
  }

  const live = dutyAt(now);
  strip.innerHTML = TEAMS.map((tm) => {
    const on = live.active.includes(tm);
    const state = on ? t(`app.dutycal.short_${live.teams[tm].state}`) : '—';
    return `<span class="duty-now-team${on ? ' on' : ''}"><b>${tm}</b>${state}</span>`;
  }).join('');
}

// ── Calendar grid ──────────────────────────────────────────────
function dowHeaders() {
  const ws = weekStart();
  let base = new Date(2026, 0, 4); // any Sunday
  while (base.getDay() !== ws) base = addDays(base, 1);
  const out = [];
  for (let i = 0; i < 7; i++) {
    out.push(`<div class="duty-dow">${base.toLocaleDateString(locale(), { weekday: 'short' })}</div>`);
    base = addDays(base, 1);
  }
  return out.join('');
}

function renderGrid() {
  const grid = $('dutyCalGrid');
  const label = $('dutyCalMonth');
  if (!grid || !label) return;
  const team = getTeam() || 'A';

  label.textContent = new Date(S.viewY, S.viewM, 1).toLocaleDateString(locale(), { month: 'long', year: 'numeric' });

  const first = new Date(S.viewY, S.viewM, 1);
  const offset = (first.getDay() - weekStart() + 7) % 7;
  const days = new Date(S.viewY, S.viewM + 1, 0).getDate();
  const todayKey = dateKey(dateOf(new Date()));

  const cells = [];
  for (let i = 0; i < offset; i++) cells.push('<div class="duty-cell duty-cell-blank"></div>');
  for (let d = 1; d <= days; d++) {
    const date = new Date(S.viewY, S.viewM, d);
    const key = dateKey(date);
    const state = shiftOn(team, date);
    const cls = [
      'duty-cell',
      key === todayKey ? 'today' : '',
      S.selected === key ? 'sel' : '',
    ].filter(Boolean).join(' ');
    cells.push(
      `<div class="${cls}" data-date="${key}" title="${t(`app.dutycal.shift_${state}`)}">` +
      `<span class="duty-cell-num">${d}</span>` +
      `<span class="duty-cell-chip c-${state}">${state}</span></div>`
    );
  }

  grid.innerHTML = dowHeaders() + cells.join('');
}

// ── Selected-day detail ───────────────────────────────────────
function renderDetail() {
  const box = $('dutyDetail');
  if (!box || !S.selected) return;
  const team = getTeam();
  if (!team) { box.innerHTML = `<div class="duty-empty">${t('app.dutycal.pick_team')}</div>`; return; }

  const date = fromDateKey(S.selected);
  const state = shiftOn(team, date);
  const win = shiftWindow(team, date);
  const rows = [
    `<div class="duty-detail-row"><span>${t('app.dutycal.l_date')}</span><b>${fmtDate(date)}</b></div>`,
    `<div class="duty-detail-row"><span>${t('app.dutycal.l_shift')}</span><b>${t(`app.dutycal.shift_${state}`)}</b></div>`,
  ];
  if (win) {
    rows.push(`<div class="duty-detail-row"><span>${t('app.dutycal.l_hours')}</span><b>${hoursLabel(state)}</b></div>`);
    rows.push(`<div class="duty-detail-row"><span>${t('app.dutycal.l_start')}</span><b>${fmtDateTime(win.start)}</b></div>`);
    rows.push(`<div class="duty-detail-row"><span>${t('app.dutycal.l_end')}</span><b>${fmtDateTime(win.end)}</b></div>`);
  }
  box.innerHTML = `<div class="duty-detail-head"><span class="duty-cell-chip c-${state}">${state}</span></div>${rows.join('')}`;
}

// ── Real-time duty checker ─────────────────────────────────────
function renderChecker() {
  const list = $('dutyCheckList');
  const input = $('dutyCheckAt');
  if (!list || !input) return;
  const instant = input.value ? new Date(input.value) : new Date();
  if (Number.isNaN(instant.getTime())) return;

  const d = dutyAt(instant);
  const isNow = Math.abs(Date.now() - instant.getTime()) < 60_000;
  const rows = TEAMS.map((tm) => {
    const info = d.teams[tm];
    if (info.active) {
      return `<div class="duty-checker-row on"><b>${tm}</b>` +
        `<span class="duty-checker-state">${t('app.dutycal.on')}</span>` +
        `<span class="duty-checker-win">${t(`app.dutycal.shift_${info.state}`)} · ${fmtDateTime(info.window.start)} → ${fmtDateTime(info.window.end)}</span></div>`;
    }
    return `<div class="duty-checker-row"><b>${tm}</b>` +
      `<span class="duty-checker-state">${t('app.dutycal.off')}</span></div>`;
  }).join('');

  list.innerHTML =
    `<div class="duty-checker-when"><b>${fmtDate(instant)} ${fmtTime(instant)}</b>` +
    `${isNow ? `<span class="duty-checker-now">${t('app.dutycal.checker_now')}</span>` : ''}</div>${rows}`;
}

function renderAll() {
  if (!$('dutyCalGrid')) return;
  renderMini();
  renderGrid();
  renderDetail();
  renderChecker();
  document.querySelectorAll('.duty-team-pill').forEach((p) => {
    p.classList.toggle('on', p.dataset.team === getTeam());
  });
}

/** Full re-render — safe to call on language change / navigation. */
export function renderDutyCalendar() {
  if (!S.ready) return;
  renderAll();
}

/** One-time wiring. Call once after the settings markup exists. */
export function initDutyCalendar() {
  if (S.ready || !$('dutyCalGrid')) return;
  S.ready = true;
  const now = dateOf(new Date());
  S.viewY = now.getFullYear();
  S.viewM = now.getMonth();
  S.selected = dateKey(now);

  const checker = $('dutyCheckAt');
  if (checker && !checker.value) checker.value = toInputValue(new Date());

  $('dutyPrevMonth')?.addEventListener('click', () => {
    S.viewM -= 1;
    if (S.viewM < 0) { S.viewM = 11; S.viewY -= 1; }
    renderGrid();
  });
  $('dutyNextMonth')?.addEventListener('click', () => {
    S.viewM += 1;
    if (S.viewM > 11) { S.viewM = 0; S.viewY += 1; }
    renderGrid();
  });
  $('dutyTodayBtn')?.addEventListener('click', () => {
    const d = dateOf(new Date());
    S.viewY = d.getFullYear();
    S.viewM = d.getMonth();
    S.selected = dateKey(d);
    renderGrid();
    renderDetail();
  });

  $('dutyCalGrid')?.addEventListener('click', (e) => {
    const cell = e.target.closest('.duty-cell[data-date]');
    if (!cell) return;
    S.selected = cell.dataset.date;
    renderGrid();
    renderDetail();
  });

  $('dutyTeamPills')?.addEventListener('click', (e) => {
    const pill = e.target.closest('.duty-team-pill');
    const sel = $('s-shift');
    if (!pill || !sel) return;
    sel.value = pill.dataset.team;
    sel.dispatchEvent(new Event('change', { bubbles: true })); // persists + re-renders
    renderAll();
  });

  $('s-shift')?.addEventListener('change', renderAll);
  $('dutyCheckAt')?.addEventListener('input', renderChecker);

  // Keep the live widget and "right now" strip fresh.
  S.timer = setInterval(renderMini, 30_000);

  renderAll();
}
