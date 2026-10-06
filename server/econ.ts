import type { EconEvent } from '../shared/types';
import { sqlite } from './db/client';

/** Normalise a release title into a series key: "CPI m/m (Sep)" → "cpi m/m" */
export function seriesKey(title: string): string {
  return title.toLowerCase().replace(/\([^)]*\)/g, '').replace(/\b(prelim|flash|final|revised|advance|q[1-4]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/g, '').replace(/\s+/g, ' ').trim();
}

const upsert = sqlite.prepare(`INSERT INTO econ_history (id, series, country, currency, time, actual, consensus, previous, unit, lower_is_better)
  VALUES (@id, @series, @country, @currency, @time, @actual, @consensus, @previous, @unit, @lib)
  ON CONFLICT(id) DO UPDATE SET actual = excluded.actual, consensus = COALESCE(excluded.consensus, econ_history.consensus), previous = excluded.previous`);

/** Persist every release that has an actual, so the reaction analyzer and surprise index can build history. */
export function recordReleases(events: EconEvent[]) {
  const tx = sqlite.transaction((list: EconEvent[]) => {
    for (const e of list) {
      if (e.actual === null || e.mock) continue;
      upsert.run({ id: e.id, series: seriesKey(e.title), country: e.country, currency: e.currency, time: e.time, actual: e.actual, consensus: e.consensus, previous: e.previous, unit: e.unit, lib: e.lowerIsBetter ? 1 : 0 });
    }
  });
  tx(events);
}

export function avgSurprise(title: string, currency: string, n = 12): { avg: number; n: number } | null {
  const rows = sqlite.prepare('SELECT actual, consensus FROM econ_history WHERE series = ? AND currency = ? AND actual IS NOT NULL AND consensus IS NOT NULL AND demo = 0 ORDER BY time DESC LIMIT ?')
    .all(seriesKey(title), currency, n) as { actual: number; consensus: number }[];
  if (rows.length < 2) return null;
  return { avg: +(rows.reduce((s, r) => s + (r.actual - r.consensus), 0) / rows.length).toFixed(3), n: rows.length };
}
