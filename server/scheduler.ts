import { zonedParts } from '../shared/sessions';

export interface JobStats {
  id: string;
  label: string;
  runs: number;
  lastRun: number | null;
  lastMs: number | null;
  lastError: string | null;
  nextHint: string;
}

interface Job {
  id: string;
  label: string;
  /** run every N ms */
  everyMs?: number;
  /** checked once per minute; return true to run now */
  due?: (now: number) => boolean;
  run: () => unknown;
  stats: JobStats;
  running: boolean;
  last: number;
}

/**
 * Background job runner for the always-on worker: briefs, handoffs, theme clustering,
 * correlations, archive downsampling. Nothing here runs on a request path.
 */
export class Scheduler {
  private jobs = new Map<string, Job>();
  private timer: NodeJS.Timeout | null = null;
  private lastMinute = 0;

  every(id: string, label: string, everyMs: number, run: () => unknown, opts: { immediate?: boolean } = {}) {
    this.add({ id, label, everyMs, run, last: opts.immediate ? 0 : Date.now(), nextHint: `every ${fmtMs(everyMs)}` });
  }

  /** Run when `due(now)` is true; checked at the start of every minute. */
  minutely(id: string, label: string, due: (now: number) => boolean, run: () => unknown, nextHint = 'scheduled') {
    this.add({ id, label, due, run, last: 0, nextHint });
  }

  private add(j: { id: string; label: string; everyMs?: number; due?: (now: number) => boolean; run: () => unknown; last: number; nextHint: string }) {
    this.jobs.set(j.id, { ...j, running: false, stats: { id: j.id, label: j.label, runs: 0, lastRun: null, lastMs: null, lastError: null, nextHint: j.nextHint } });
  }

  remove(id: string) {
    this.jobs.delete(id);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 5000);
    setTimeout(() => this.tick(), 3000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runNow(id: string) {
    const j = this.jobs.get(id);
    if (j) await this.exec(j);
  }

  stats(): JobStats[] {
    return [...this.jobs.values()].map((j) => j.stats);
  }

  private tick() {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    const newMinute = minute !== this.lastMinute;
    this.lastMinute = minute;
    for (const j of this.jobs.values()) {
      if (j.everyMs && now - j.last >= j.everyMs) void this.exec(j);
      else if (j.due && newMinute) {
        let due = false;
        try {
          due = j.due(now);
        } catch {
          due = false;
        }
        if (due) void this.exec(j);
      }
    }
  }

  private async exec(j: Job) {
    if (j.running) return;
    j.running = true;
    j.last = Date.now();
    const t0 = performance.now();
    try {
      await j.run();
      j.stats.lastError = null;
    } catch (e) {
      j.stats.lastError = (e as Error).message?.slice(0, 200) ?? 'error';
      console.warn(`[scheduler] ${j.id} failed: ${j.stats.lastError}`);
    } finally {
      j.running = false;
      j.stats.runs++;
      j.stats.lastRun = Date.now();
      j.stats.lastMs = Math.round(performance.now() - t0);
    }
  }
}

function fmtMs(ms: number) {
  return ms >= 3600_000 ? `${ms / 3600_000}h` : ms >= 60_000 ? `${ms / 60_000}m` : `${ms / 1000}s`;
}

/** True when the wall clock in `tz` reads exactly HH:MM (checked once per minute). */
export function isTime(now: number, tz: string, hhmm: string | null | undefined, weekdays?: number[]): boolean {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return false;
  const z = zonedParts(now, tz);
  if (weekdays && !weekdays.includes(z.wd)) return false;
  const [h, m] = hhmm.split(':').map(Number);
  return z.h === h && z.min === m;
}

/** YYYY-MM-DD in a time zone */
export function localDate(ts: number, tz: string): string {
  const z = zonedParts(ts, tz);
  return `${z.y}-${String(z.m).padStart(2, '0')}-${String(z.d).padStart(2, '0')}`;
}

export const scheduler = new Scheduler();
