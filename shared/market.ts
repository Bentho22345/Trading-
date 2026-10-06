// Market-structure calendar: closes, exchange holidays, expiries, rolls, month/quarter ends, DST.
// Pure functions shared by the worker (briefs) and the browser (session clock markers).
import { zonedParts, zonedToUtc } from './sessions';
import type { StructureEvent } from './v2';

const DAY = 86400_000;
const NY = 'America/New_York';

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** weekday of a calendar date (0 = Sunday), independent of time zone */
const wdOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** n-th weekday (wd) of a month; n = -1 for the last one */
export function nthWeekday(y: number, m: number, wd: number, n: number): number {
  if (n > 0) {
    const first = wdOf(y, m, 1);
    return 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
  }
  const last = daysIn(y, m);
  return last - ((wdOf(y, m, last) - wd + 7) % 7);
}

/** Western Easter Sunday (Anonymous Gregorian algorithm) */
export function easter(y: number): { m: number; d: number } {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return { m: month, d: day };
}

function shift(y: number, m: number, d: number, days: number) {
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** US federal-style observance: Saturday → Friday, Sunday → Monday */
function observed(y: number, m: number, d: number) {
  const wd = wdOf(y, m, d);
  return wd === 6 ? shift(y, m, d, -1) : wd === 0 ? shift(y, m, d, 1) : { y, m, d };
}

export interface Holiday { date: string; venue: 'NYSE' | 'LSE' | 'TSE' | 'CME'; label: string; half?: boolean }

export function nyseHolidays(y: number): Holiday[] {
  const e = easter(y);
  const gf = shift(y, e.m, e.d, -2);
  const out: Holiday[] = [];
  const add = (p: { y: number; m: number; d: number }, label: string, half = false) => out.push({ date: ymd(p.y, p.m, p.d), venue: 'NYSE', label, half });
  const ny = observed(y, 1, 1);
  if (ny.y === y) add(ny, "New Year's Day");
  add({ y, m: 1, d: nthWeekday(y, 1, 1, 3) }, 'Martin Luther King Jr. Day');
  add({ y, m: 2, d: nthWeekday(y, 2, 1, 3) }, "Washington's Birthday");
  add(gf, 'Good Friday');
  add({ y, m: 5, d: nthWeekday(y, 5, 1, -1) }, 'Memorial Day');
  add(observed(y, 6, 19), 'Juneteenth');
  add(observed(y, 7, 4), 'Independence Day');
  add({ y, m: 9, d: nthWeekday(y, 9, 1, 1) }, 'Labor Day');
  const tg = nthWeekday(y, 11, 4, 4);
  add({ y, m: 11, d: tg }, 'Thanksgiving');
  add(observed(y, 12, 25), 'Christmas');
  // early closes (13:00 ET)
  if (wdOf(y, 7, 3) >= 1 && wdOf(y, 7, 3) <= 4) add({ y, m: 7, d: 3 }, 'Early close (Independence Day eve)', true);
  add({ y, m: 11, d: tg + 1 }, 'Early close (day after Thanksgiving)', true);
  if (wdOf(y, 12, 24) >= 1 && wdOf(y, 12, 24) <= 4) add({ y, m: 12, d: 24 }, 'Early close (Christmas Eve)', true);
  return out;
}

export function lseHolidays(y: number): Holiday[] {
  const e = easter(y);
  const out: Holiday[] = [];
  const add = (p: { y: number; m: number; d: number }, label: string, half = false) => out.push({ date: ymd(p.y, p.m, p.d), venue: 'LSE', label, half });
  const nyd = wdOf(y, 1, 1) === 6 ? { y, m: 1, d: 3 } : wdOf(y, 1, 1) === 0 ? { y, m: 1, d: 2 } : { y, m: 1, d: 1 };
  add(nyd, "New Year's Day");
  add(shift(y, e.m, e.d, -2), 'Good Friday');
  add(shift(y, e.m, e.d, 1), 'Easter Monday');
  add({ y, m: 5, d: nthWeekday(y, 5, 1, 1) }, 'Early May bank holiday');
  add({ y, m: 5, d: nthWeekday(y, 5, 1, -1) }, 'Spring bank holiday');
  add({ y, m: 8, d: nthWeekday(y, 8, 1, -1) }, 'Summer bank holiday');
  const xw = wdOf(y, 12, 25);
  add(xw === 6 ? { y, m: 12, d: 27 } : xw === 0 ? { y, m: 12, d: 27 } : { y, m: 12, d: 25 }, 'Christmas Day');
  const bw = wdOf(y, 12, 26);
  add(bw === 6 ? { y, m: 12, d: 28 } : bw === 0 ? { y, m: 12, d: 28 } : xw === 6 ? { y, m: 12, d: 28 } : { y, m: 12, d: 26 }, 'Boxing Day');
  if (wdOf(y, 12, 24) >= 1 && wdOf(y, 12, 24) <= 5) add({ y, m: 12, d: 24 }, 'Early close (Christmas Eve)', true);
  if (wdOf(y, 12, 31) >= 1 && wdOf(y, 12, 31) <= 5) add({ y, m: 12, d: 31 }, "Early close (New Year's Eve)", true);
  return out;
}

/** Fixed-date Tokyo closures (equinox holidays and Happy Mondays are omitted: approximate). */
export function tseHolidays(y: number): Holiday[] {
  const fixed: [number, number, string][] = [[1, 1, 'New Year'], [1, 2, 'New Year'], [1, 3, 'New Year'], [2, 11, 'National Foundation Day'], [2, 23, "Emperor's Birthday"],
    [4, 29, 'Showa Day'], [5, 3, 'Constitution Day'], [5, 4, 'Greenery Day'], [5, 5, "Children's Day"], [8, 11, 'Mountain Day'], [11, 3, 'Culture Day'], [11, 23, 'Labour Thanksgiving'], [12, 31, 'Year-end']];
  return fixed.filter(([m, d]) => wdOf(y, m, d) % 6 !== 0).map(([m, d, label]) => ({ date: ymd(y, m, d), venue: 'TSE' as const, label }));
}

export function isNyseClosed(dateStr: string): boolean {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = wdOf(y, m, d);
  if (wd === 0 || wd === 6) return true;
  return nyseHolidays(y).some((h) => h.date === dateStr && !h.half);
}

/** Most recent US cash close (16:00 New York) strictly before `now`, skipping weekends/holidays. */
export function lastUsCloseTs(now: number): number {
  let z = zonedParts(now, NY);
  let p = { y: z.y, m: z.m, d: z.d };
  for (let i = 0; i < 10; i++) {
    const date = ymd(p.y, p.m, p.d);
    if (!isNyseClosed(date)) {
      const half = nyseHolidays(p.y).some((h) => h.date === date && h.half);
      const ts = zonedToUtc(p.y, p.m, p.d, half ? 13 : 16, 0, NY);
      if (ts < now) return ts;
    }
    p = shift(p.y, p.m, p.d, -1);
    z = { ...z, ...p };
  }
  return now - DAY;
}

/** "Rollover" close used for FX/crypto overnight moves: 17:00 New York on the last weekday. */
export function lastFxCloseTs(now: number): number {
  let p = (() => { const z = zonedParts(now, NY); return { y: z.y, m: z.m, d: z.d }; })();
  for (let i = 0; i < 8; i++) {
    const wd = wdOf(p.y, p.m, p.d);
    if (wd >= 1 && wd <= 5) {
      const ts = zonedToUtc(p.y, p.m, p.d, 17, 0, NY);
      if (ts < now) return ts;
    }
    p = shift(p.y, p.m, p.d, -1);
  }
  return now - DAY;
}

function lastBusinessDay(y: number, m: number): number {
  let d = daysIn(y, m);
  while (wdOf(y, m, d) === 0 || wdOf(y, m, d) === 6 || nyseHolidays(y).some((h) => h.date === ymd(y, m, d) && !h.half)) d--;
  return d;
}

/** All structural events between two timestamps (inclusive), sorted by time. */
export function structureEvents(from: number, to: number): StructureEvent[] {
  const out: StructureEvent[] = [];
  const startY = new Date(from).getUTCFullYear(), endY = new Date(to).getUTCFullYear();
  const push = (y: number, m: number, d: number, kind: StructureEvent['kind'], venue: string, label: string, hour = 12, tz = NY) => {
    const ts = zonedToUtc(y, m, d, hour, 0, tz);
    if (ts >= from - DAY && ts <= to + DAY) out.push({ id: `${kind}-${venue}-${ymd(y, m, d)}`, date: ymd(y, m, d), ts, kind, venue, label });
  };
  for (let y = startY; y <= endY; y++) {
    for (const h of [...nyseHolidays(y), ...lseHolidays(y), ...tseHolidays(y)]) {
      const [yy, mm, dd] = h.date.split('-').map(Number);
      push(yy, mm, dd, h.half ? 'halfday' : 'holiday', h.venue, `${h.venue}: ${h.label}`, 9, h.venue === 'LSE' ? 'Europe/London' : h.venue === 'TSE' ? 'Asia/Tokyo' : NY);
    }
    for (let m = 1; m <= 12; m++) {
      const opex = nthWeekday(y, m, 5, 3);
      const quarterly = m % 3 === 0;
      push(y, m, opex, quarterly ? 'quad' : 'opex', 'US options', quarterly ? 'Quad witching (stock/index options + futures expiry)' : 'Monthly options expiry', 16);
      if (quarterly) {
        push(y, m, opex, 'rebalance', 'S&P', 'S&P 500 quarterly rebalance (effective after close)', 16);
        // equity index futures roll the week before expiry (Thursday, 8 days prior)
        const roll = shift(y, m, opex, -8);
        push(roll.y, roll.m, roll.d, 'roll', 'CME', 'Equity index futures roll week', 9);
      }
      if (m === 6 || m === 12) {
        const russ = nthWeekday(y, m, 5, 4);
        push(y, m, russ, 'rebalance', 'FTSE Russell', 'Russell reconstitution (approx.)', 16);
      }
      const lbd = lastBusinessDay(y, m);
      push(y, m, lbd, quarterly ? 'quarterend' : 'monthend', 'Global', quarterly ? 'Quarter-end: rebalancing flows, WM/R 4pm London fix' : 'Month-end: rebalancing flows, WM/R 4pm London fix', 11);
    }
    // daylight saving shifts that change session overlaps
    push(y, 3, nthWeekday(y, 3, 0, 2), 'dst', 'US', 'US clocks spring forward: NY opens 1h earlier vs Europe until EU shifts', 2);
    push(y, 3, nthWeekday(y, 3, 0, -1), 'dst', 'EU', 'Europe clocks spring forward: London–NY gap back to 5h', 1, 'Europe/London');
    push(y, 10, nthWeekday(y, 10, 0, -1), 'dst', 'EU', 'Europe clocks fall back: London–NY gap is 4h until US shifts', 1, 'Europe/London');
    push(y, 11, nthWeekday(y, 11, 0, 1), 'dst', 'US', 'US clocks fall back: London–NY gap back to 5h', 2);
  }
  return out.filter((e) => e.ts >= from - DAY && e.ts <= to + DAY).sort((a, b) => a.ts - b.ts);
}
