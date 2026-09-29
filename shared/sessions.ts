// FX trading sessions computed in each centre's own time zone so DST is handled correctly.

export interface SessionDef {
  id: 'sydney' | 'tokyo' | 'london' | 'newyork';
  label: string;
  tz: string;
  openH: number;
  closeH: number;
}

export const SESSIONS: SessionDef[] = [
  { id: 'sydney', label: 'Sydney', tz: 'Australia/Sydney', openH: 7, closeH: 16 },
  { id: 'tokyo', label: 'Tokyo', tz: 'Asia/Tokyo', openH: 9, closeH: 18 },
  { id: 'london', label: 'London', tz: 'Europe/London', openH: 8, closeH: 17 },
  { id: 'newyork', label: 'New York', tz: 'America/New_York', openH: 8, closeH: 17 },
];

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts { y: number; m: number; d: number; h: number; min: number; s: number; wd: number }
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(ts: number, tz: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of dtf(tz).formatToParts(ts)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second, wd: WD[p.weekday] ?? 0 };
}

function tzOffsetMs(ts: number, tz: string) {
  const z = zonedParts(ts, tz);
  return Date.UTC(z.y, z.m - 1, z.d, z.h, z.min, z.s) - Math.floor(ts / 1000) * 1000;
}

/** Wall-clock time in `tz` -> UTC epoch ms */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz);
  return ts;
}

/** FX is closed from Friday 17:00 New York until Sunday 17:00 New York. */
export function isFxWeekend(ts: number): boolean {
  const z = zonedParts(ts, 'America/New_York');
  if (z.wd === 6) return true;
  if (z.wd === 5 && z.h >= 17) return true;
  if (z.wd === 0 && z.h < 17) return true;
  return false;
}

export interface Window { start: number; end: number }

/** Session windows overlapping [from, to]. Weekend-closed hours are removed. */
export function sessionWindows(s: SessionDef, from: number, to: number): Window[] {
  const out: Window[] = [];
  for (let t = from - 2 * 86400000; t <= to + 86400000; t += 86400000) {
    const z = zonedParts(t, s.tz);
    const start = zonedToUtc(z.y, z.m, z.d, s.openH, 0, s.tz);
    const end = zonedToUtc(z.y, z.m, z.d, s.closeH, 0, s.tz);
    if (end < from || start > to) continue;
    if (out.some((w) => w.start === start)) continue;
    // trim weekend: skip windows whose midpoint falls in the FX weekend
    if (isFxWeekend(start + (end - start) / 2)) continue;
    out.push({ start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface SessionState {
  def: SessionDef;
  open: boolean;
  /** next transition time (open -> close or close -> open) */
  nextChange: number;
  windows: Window[];
}

export function sessionStates(now: number, from: number, to: number): SessionState[] {
  return SESSIONS.map((def) => {
    const ws = sessionWindows(def, now - 86400000, now + 8 * 86400000);
    const cur = ws.find((w) => now >= w.start && now < w.end);
    const next = ws.find((w) => w.start > now);
    return {
      def,
      open: !!cur,
      nextChange: cur ? cur.end : next ? next.start : now,
      windows: sessionWindows(def, from, to),
    };
  });
}

export function intersect(a: Window[], b: Window[]): Window[] {
  const out: Window[] = [];
  for (const x of a)
    for (const y of b) {
      const s = Math.max(x.start, y.start), e = Math.min(x.end, y.end);
      if (e > s) out.push({ start: s, end: e });
    }
  return out;
}
