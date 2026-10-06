import { deflateSync, inflateSync } from 'node:zlib';
import type { Quote } from '../shared/types';
import { sqlite } from './db/client';
import { kvGet, kvSet } from './kv';
import type { Hub } from './hub';
import type { NewsPipeline } from './news/pipeline';
import { scheduler } from './scheduler';
import { bad, type Router } from './router';
import type { V2Feature } from './v2';

const MIN = 60_000;
const pack = (pts: [number, number][]) => deflateSync(Buffer.from(JSON.stringify(pts)));
const unpack = (b: Buffer) => JSON.parse(inflateSync(b).toString()) as [number, number][];

/**
 * Tick archive for Market Replay. Raw ticks (≤ 4/s per symbol) are written in compressed one-minute
 * blocks; after 1 day they are downsampled to 1 s, after 7 days to 1 min (hourly blocks), and
 * anything beyond the retention cap is deleted.
 */
export function replayFeature(hub: Hub, pipeline: NewsPipeline): V2Feature {
  const buf = new Map<string, { minute: number; pts: [number, number][]; lastT: number }>();
  const insert = sqlite.prepare('INSERT INTO tick_archive (symbol, t_start, res, data) VALUES (?, ?, ?, ?) ON CONFLICT(symbol, t_start, res) DO UPDATE SET data = excluded.data');

  const onQuotes = (qs: Quote[]) => {
    for (const q of qs) {
      const t = q.ts || Date.now();
      const minute = Math.floor(t / MIN) * MIN;
      let b = buf.get(q.symbol);
      if (!b || b.minute !== minute) {
        if (b && b.pts.length) insert.run(q.symbol, b.minute, 'raw', pack(b.pts));
        b = { minute, pts: [], lastT: 0 };
        buf.set(q.symbol, b);
      }
      if (t - b.lastT < 250) { if (b.pts.length) b.pts[b.pts.length - 1][1] = q.price; continue; }
      b.lastT = t;
      b.pts.push([t - minute, q.price]);
    }
  };

  const flushStale = () => {
    const now = Date.now();
    const tx = sqlite.transaction(() => {
      for (const [sym, b] of buf) if (b.minute < Math.floor(now / MIN) * MIN && b.pts.length) { insert.run(sym, b.minute, 'raw', pack(b.pts)); buf.delete(sym); }
    });
    tx();
  };

  const downsample = () => {
    const now = Date.now();
    const retention = kvGet<number>('replay.retentionDays', Number(process.env.REPLAY_RETENTION_DAYS) || 30);
    const tx = sqlite.transaction(() => {
      // raw → 1s after a day
      for (const r of sqlite.prepare("SELECT symbol, t_start, data FROM tick_archive WHERE res = 'raw' AND t_start < ? LIMIT 5000").all(now - 86400_000) as { symbol: string; t_start: number; data: Buffer }[]) {
        const per = new Map<number, number>();
        for (const [dt, p] of unpack(r.data)) per.set(Math.floor(dt / 1000) * 1000, p);
        insert.run(r.symbol, r.t_start, '1s', pack([...per.entries()]));
        sqlite.prepare("DELETE FROM tick_archive WHERE symbol = ? AND t_start = ? AND res = 'raw'").run(r.symbol, r.t_start);
      }
      // 1s → 1m (hour blocks) after a week
      const old = sqlite.prepare("SELECT symbol, t_start, data FROM tick_archive WHERE res = '1s' AND t_start < ? ORDER BY symbol, t_start LIMIT 20000").all(now - 7 * 86400_000) as { symbol: string; t_start: number; data: Buffer }[];
      const hours = new Map<string, [number, number][]>();
      for (const r of old) {
        const pts = unpack(r.data);
        if (!pts.length) continue;
        const hour = Math.floor(r.t_start / 3600_000) * 3600_000;
        const k = `${r.symbol}|${hour}`;
        hours.set(k, [...(hours.get(k) ?? []), [r.t_start - hour, pts[pts.length - 1][1]]]);
        sqlite.prepare("DELETE FROM tick_archive WHERE symbol = ? AND t_start = ? AND res = '1s'").run(r.symbol, r.t_start);
      }
      for (const [k, pts] of hours) {
        const [sym, hour] = k.split('|');
        const prev = sqlite.prepare("SELECT data FROM tick_archive WHERE symbol = ? AND t_start = ? AND res = '1m'").get(sym, Number(hour)) as { data: Buffer } | undefined;
        insert.run(sym, Number(hour), '1m', pack([...(prev ? unpack(prev.data) : []), ...pts].sort((a, b) => a[0] - b[0])));
      }
      sqlite.prepare('DELETE FROM tick_archive WHERE t_start < ?').run(now - retention * 86400_000);
    });
    tx();
  };

  return {
    start() {
      hub.on('quotes', onQuotes);
      scheduler.every('tick-flush', 'Tick archive flush', 30_000, flushStale);
      scheduler.every('tick-downsample', 'Tick archive downsampling & retention', 3600_000, downsample);
    },
    stop() {
      hub.off('quotes', onQuotes);
      flushStale();
    },
    routes(r: Router) {
      r.get('/api/replay/days', () => {
        const rows = sqlite.prepare("SELECT (t_start / 86400000) AS d, COUNT(DISTINCT symbol) AS symbols, MIN(t_start) AS first, MAX(t_start) AS last FROM tick_archive GROUP BY d ORDER BY d DESC LIMIT 120").all() as { d: number; symbols: number; first: number; last: number }[];
        return { days: rows.map((x) => ({ date: new Date(x.d * 86400_000).toISOString().slice(0, 10), symbols: x.symbols, first: x.first, last: x.last + MIN })), retentionDays: kvGet('replay.retentionDays', 30) };
      });
      r.put('/api/replay/retention', async ({ body }) => {
        const { days } = await body<{ days?: number }>();
        kvSet('replay.retentionDays', Math.max(1, Math.min(365, Number(days) || 30)));
        return { retentionDays: kvGet('replay.retentionDays', 30) };
      });
      /** All ticks, news and alerts in [from, to) — the client replays them on a virtual clock. */
      r.get('/api/replay/data', ({ url }) => {
        const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
        if (!(from > 0) || !(to > from) || to - from > 3 * 3600_000) bad('from/to required (max 3h per request)');
        flushStale();
        const rows = sqlite.prepare('SELECT symbol, t_start, res, data FROM tick_archive WHERE t_start >= ? AND t_start < ?').all(Math.floor(from / 3600_000) * 3600_000, to) as { symbol: string; t_start: number; res: string; data: Buffer }[];
        const ticks: [number, string, number][] = [];
        for (const row of rows) for (const [dt, p] of unpack(row.data)) { const t = row.t_start + dt; if (t >= from && t < to) ticks.push([t, row.symbol, p]); }
        ticks.sort((a, b) => a[0] - b[0]);
        const clusters = pipeline.archive(to, 300).filter((c) => c.receivedAt >= from && c.receivedAt < to);
        const alerts = sqlite.prepare('SELECT id, rule_id AS ruleId, message, ts FROM alert_events WHERE ts >= ? AND ts < ? ORDER BY ts').all(from, to);
        const releases = sqlite.prepare('SELECT id, series, currency, time, actual, consensus, previous, unit FROM econ_history WHERE time >= ? AND time < ?').all(from, to);
        // reference price per symbol (first tick at or before `from`)
        const refs: Record<string, number> = {};
        for (const row of sqlite.prepare('SELECT symbol, data, t_start FROM tick_archive WHERE t_start < ? AND t_start >= ? ORDER BY t_start DESC').all(from, from - 86400_000) as { symbol: string; data: Buffer }[]) if (!(row.symbol in refs)) { const p = unpack(row.data); if (p.length) refs[row.symbol] = p[p.length - 1][1]; }
        return { from, to, ticks, clusters, alerts, releases, refs };
      });
    },
  };
}
