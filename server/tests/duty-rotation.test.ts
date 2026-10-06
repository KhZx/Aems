import { describe, expect, it } from 'vitest';
import {
  CYCLE,
  TEAM_OFFSET,
  TEAMS,
  addDays,
  dateKey,
  dutyAt,
  dutyStatusFor,
  fromDateKey,
  scheduleOn,
  shiftOn,
  shiftWindow,
} from '../../js/duty-rotation.js';

// The verified October 2026 reference schedule (Excel spec): date → A, B, C, D
const REFERENCE: Array<[string, string, string, string, string]> = [
  ['2026-10-05', 'D', 'X', 'X', 'N'],
  ['2026-10-06', 'N', 'X', 'D', 'X'],
  ['2026-10-07', 'N', 'X', 'D', 'X'],
  ['2026-10-08', 'X', 'D', 'N', 'X'],
  ['2026-10-09', 'X', 'D', 'N', 'X'],
  ['2026-10-10', 'X', 'N', 'X', 'D'],
  ['2026-10-11', 'X', 'N', 'X', 'D'],
  ['2026-10-12', 'D', 'X', 'X', 'N'],
  ['2026-10-13', 'D', 'X', 'X', 'N'],
  ['2026-10-14', 'N', 'X', 'D', 'X'],
  ['2026-10-15', 'N', 'X', 'D', 'X'],
  ['2026-10-16', 'X', 'D', 'N', 'X'],
  ['2026-10-17', 'X', 'D', 'N', 'X'],
  ['2026-10-18', 'X', 'N', 'X', 'D'],
  ['2026-10-19', 'X', 'N', 'X', 'D'],
];

const at = (key: string, h: number, m: number) => {
  const d = fromDateKey(key);
  d.setHours(h, m, 0, 0);
  return d;
};

describe('duty-rotation — October 2026 reference schedule', () => {
  it.each(REFERENCE)('%s → A=%s B=%s C=%s D=%s', (key, a, b, c, d) => {
    const date = fromDateKey(key);
    expect(shiftOn('A', date)).toBe(a);
    expect(shiftOn('B', date)).toBe(b);
    expect(shiftOn('C', date)).toBe(c);
    expect(shiftOn('D', date)).toBe(d);
  });

  it('has the exact D D N N X X X X cycle shape', () => {
    expect(CYCLE).toEqual(['D', 'D', 'N', 'N', 'X', 'X', 'X', 'X']);
    expect(TEAM_OFFSET).toEqual({ A: 1, B: 5, C: 7, D: 3 });
    expect(TEAMS).toEqual(['A', 'B', 'C', 'D']);
  });

  it('always has exactly one day team, one night team, two off', () => {
    for (let i = 0; i < 60; i++) {
      const date = addDays(fromDateKey('2026-10-01'), i);
      const s = scheduleOn(date);
      const states = TEAMS.map((t) => s[t]);
      expect(states.filter((x) => x === 'D')).toHaveLength(1);
      expect(states.filter((x) => x === 'N')).toHaveLength(1);
      expect(states.filter((x) => x === 'X')).toHaveLength(2);
    }
  });
});

describe('duty-rotation — exact shift windows', () => {
  it('day shift is 05:00 → 16:00 on the same date', () => {
    const win = shiftWindow('C', fromDateKey('2026-10-07'))!;
    expect(win.start).toEqual(at('2026-10-07', 5, 0));
    expect(win.end).toEqual(at('2026-10-07', 16, 0));
  });

  it('night shift crosses midnight: 16:00 → 05:00 next day', () => {
    const win = shiftWindow('A', fromDateKey('2026-10-06'))!;
    expect(win.start).toEqual(at('2026-10-06', 16, 0));
    expect(win.end).toEqual(at('2026-10-07', 5, 0));
  });

  it('off days have no window', () => {
    expect(shiftWindow('B', fromDateKey('2026-10-07'))).toBeNull();
  });
});

describe('duty-rotation — real-time duty checker', () => {
  it('00:51 on Oct 7 → Team A is working its night from Oct 6 (ends 05:00 Oct 7)', () => {
    const d = dutyAt(at('2026-10-07', 0, 51));
    expect(d.active).toEqual(['A']);
    expect(d.teams.A.state).toBe('N');
    expect(d.teams.A.window!.start).toEqual(at('2026-10-06', 16, 0));
    expect(d.teams.A.window!.end).toEqual(at('2026-10-07', 5, 0));
    expect(dateKey(d.ownerDate)).toBe('2026-10-06');
    expect(d.teams.C.active).toBe(false);
  });

  it('05:00 on Oct 7 → Team A night has ended, Team C starts Day at exactly 05:00', () => {
    const d = dutyAt(at('2026-10-07', 5, 0));
    expect(d.active).toEqual(['C']);
    expect(d.teams.A.active).toBe(false);
    expect(d.teams.C.window!.start).toEqual(at('2026-10-07', 5, 0));
    expect(d.teams.C.window!.end).toEqual(at('2026-10-07', 16, 0));
  });

  it('16:00 on Oct 7 → Team C day ended, Team A starts Night at exactly 16:00', () => {
    const d = dutyAt(at('2026-10-07', 16, 0));
    expect(d.active).toEqual(['A']);
    expect(d.teams.C.active).toBe(false);
    expect(d.teams.A.window!.start).toEqual(at('2026-10-07', 16, 0));
    expect(d.teams.A.window!.end).toEqual(at('2026-10-08', 5, 0));
  });

  it('02:00 on Oct 15 → Team A works the night that started Oct 14', () => {
    const d = dutyAt(at('2026-10-15', 2, 0));
    expect(d.active).toEqual(['A']);
    expect(dateKey(d.ownerDate)).toBe('2026-10-14');
  });

  it('exactly one team works at every sampled instant (day/night tile the clock)', () => {
    for (let day = 5; day <= 12; day++) {
      for (let h = 0; h < 24; h++) {
        for (const m of [0, 30, 59]) {
          const d = dutyAt(at(`2026-10-${String(day).padStart(2, '0')}`, h, m));
          expect(d.active).toHaveLength(1);
        }
      }
    }
  });
});

describe('duty-rotation — per-team live status', () => {
  it('reports "on" with the exact window while working', () => {
    const st = dutyStatusFor('C', at('2026-10-07', 10, 0));
    expect(st.kind).toBe('on');
    expect(st.state).toBe('D');
    expect(st.window!.end).toEqual(at('2026-10-07', 16, 0));
  });

  it('reports the next upcoming shift when off', () => {
    const st = dutyStatusFor('B', at('2026-10-07', 12, 0)); // B off, Day starts Oct 8 05:00
    expect(st.kind).toBe('next');
    expect(st.state).toBe('D');
    expect(st.window!.start).toEqual(at('2026-10-08', 5, 0));
  });

  it('night worker before their night starts reports the upcoming night', () => {
    const st = dutyStatusFor('A', at('2026-10-07', 10, 0)); // A night starts 16:00 Oct 7
    expect(st.kind).toBe('next');
    expect(st.state).toBe('N');
    expect(st.window!.start).toEqual(at('2026-10-07', 16, 0));
  });
});

describe('duty-rotation — helpers', () => {
  it('round-trips date keys', () => {
    expect(dateKey(fromDateKey('2026-10-07'))).toBe('2026-10-07');
    expect(dateKey(addDays(fromDateKey('2026-10-31'), 1))).toBe('2026-11-01');
  });
});
