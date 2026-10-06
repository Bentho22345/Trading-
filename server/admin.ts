import type { StreamId } from '../shared/types';
import type { Adapter, AdapterContext } from './adapters/types';
import { buildStream } from './adapters';
import type { Hub } from './hub';
import type { NewsPipeline } from './news/pipeline';
import { sqlite } from './db/client';
import { usageToday, setDailyBudget, dailyBudget } from './ai/client';
import { scheduler } from './scheduler';
import { jobHealth } from './intel/framework';
import { rssRegistry } from './adapters/live/news';
import { bad, type Router } from './router';
import type { V2Feature } from './v2';

// ------------------------------------------------------------------ outbound request accounting (quota meters)
const LIMITS: Record<string, { perMin: number; label: string }> = {
  'finnhub.io': { perMin: 60, label: 'Finnhub (free: 60/min)' }, 'api.twelvedata.com': { perMin: 8, label: 'Twelve Data (free: 8/min)' },
  'api.stlouisfed.org': { perMin: 120, label: 'FRED (120/min)' }, 'www.sec.gov': { perMin: 600, label: 'SEC EDGAR (≤10/s)' },
  'gamma-api.polymarket.com': { perMin: 1800, label: 'Polymarket Gamma (300/10s)' }, 'api.coingecko.com': { perMin: 30, label: 'CoinGecko (public ~30/min)' },
  'api.anthropic.com': { perMin: 50, label: 'Anthropic' }, 'stooq.com': { perMin: 60, label: 'Stooq (polite use)' },
};
const calls = new Map<string, number[]>();
const errors = new Map<string, number[]>();
let patched = false;
export function instrumentFetch() {
  if (patched) return;
  patched = true;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    let host = '';
    try { host = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host; } catch { /* ignore */ }
    const now = Date.now();
    if (host && !/^(127\.|localhost|telemetry\.nextjs)/.test(host)) calls.set(host, [...(calls.get(host) ?? []).filter((t) => now - t < 3600_000), now].slice(-4000));
    try {
      const res = await orig(input, init);
      if (host && res.status >= 400) errors.set(host, [...(errors.get(host) ?? []).filter((t) => now - t < 3600_000), now]);
      return res;
    } catch (e) {
      if (host) errors.set(host, [...(errors.get(host) ?? []).filter((t) => now - t < 3600_000), now]);
      throw e;
    }
  }) as typeof fetch;
}

const pct = (arr: number[], p: number) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

export function adminFeature(hub: Hub, pipeline: NewsPipeline, adapters: Adapter[], ctx: AdapterContext): V2Feature {
  const latency = new Map<string, number[]>();
  const stopped = new Set<string>();
  const overrides = new Map<string, 'mock' | 'live'>();
  let lastStats = { ...pipeline.stats };
  return {
    start() {
      // sample stream latency every 10s for percentiles
      setInterval(() => {
        for (const s of hub.statuses.values()) if (s.latencyMs !== null) latency.set(s.id, [...(latency.get(s.id) ?? []), s.latencyMs].slice(-360));
      }, 10_000).unref();
      scheduler.every('pipeline-stats', 'Pipeline stats (hourly)', 60_000, () => {
        const hour = Math.floor(Date.now() / 3600_000) * 3600_000;
        const d = { i: pipeline.stats.ingested - lastStats.ingested, d: pipeline.stats.deduped - lastStats.deduped, c: pipeline.stats.clustered - lastStats.clustered };
        lastStats = { ...pipeline.stats };
        sqlite.prepare('INSERT INTO pipeline_stats (hour, ingested, deduped, clustered) VALUES (?, ?, ?, ?) ON CONFLICT(hour) DO UPDATE SET ingested = ingested + excluded.ingested, deduped = deduped + excluded.deduped, clustered = clustered + excluded.clustered').run(hour, d.i, d.d, d.c);
      });
    },
    routes(r: Router) {
      r.get('/api/admin', () => {
        const now = Date.now();
        return {
          streams: [...hub.statuses.values()].map((s) => ({ ...s, p50: pct(latency.get(s.id) ?? [], 50), p95: pct(latency.get(s.id) ?? [], 95), override: overrides.get(s.id) ?? null })),
          adapters: adapters.map((a) => ({ id: a.id, stream: a.stream, provider: a.provider, mock: a.mock, running: !stopped.has(a.id), delayedMin: a.delayedMin })),
          quotas: [...calls.entries()].map(([host, ts]) => ({ host, label: LIMITS[host]?.label ?? host, lastMin: ts.filter((t) => now - t < 60_000).length, lastHour: ts.length, limitPerMin: LIMITS[host]?.perMin ?? null, errorsHour: (errors.get(host) ?? []).length })).sort((a, b) => b.lastHour - a.lastHour),
          rss: [...rssRegistry.stats.entries()].map(([url, s]) => ({ url, ...s, items: s.items.length })),
          intel: [...jobHealth.values()].map((j) => ({ ...j, p50: pct(j.latencyMs, 50), p95: pct(j.latencyMs, 95) })),
          jobs: scheduler.stats(),
          pipeline: { totals: pipeline.stats, hourly: sqlite.prepare('SELECT * FROM pipeline_stats ORDER BY hour DESC LIMIT 24').all() },
          ai: { ...usageToday(), budget: dailyBudget() },
          outbox: { pending: (sqlite.prepare("SELECT COUNT(*) n FROM outbox WHERE status = 'pending'").get() as { n: number }).n, dead: sqlite.prepare("SELECT id, dest, attempts, last_error, created_at FROM outbox WHERE status = 'dead' ORDER BY created_at DESC LIMIT 30").all() },
          db: { ticks: (sqlite.prepare('SELECT COUNT(*) n FROM tick_archive').get() as { n: number }).n, articles: (sqlite.prepare('SELECT COUNT(*) n FROM articles').get() as { n: number }).n, briefs: (sqlite.prepare('SELECT COUNT(*) n FROM briefs').get() as { n: number }).n },
          uptime: process.uptime(), memoryMb: Math.round(process.memoryUsage().rss / 1e6),
        };
      });
      r.post('/api/admin/adapters/:id/toggle', async ({ params }) => {
        const a = adapters.find((x) => x.id === params[0]);
        if (!a) bad('unknown adapter');
        if (stopped.has(a.id)) { stopped.delete(a.id); await a.start(ctx); hub.setState(a.stream, 'connecting'); }
        else { stopped.add(a.id); await a.stop(); hub.setState(a.stream, 'down', 'stopped from admin console'); }
        return { running: !stopped.has(a.id) };
      });
      r.post('/api/admin/streams/:id/provider', async ({ params, body }) => {
        const { provider } = await body<{ provider?: 'mock' | 'live' }>();
        if (provider !== 'mock' && provider !== 'live') bad('provider must be mock or live');
        const stream = params[0] as StreamId;
        const fresh = buildStream(stream, provider);
        if (!fresh.length) bad(`no ${provider} adapter for ${stream}`);
        for (const a of adapters.filter((x) => x.stream === stream)) { await a.stop(); stopped.delete(a.id); }
        for (let i = adapters.length - 1; i >= 0; i--) if (adapters[i].stream === stream) adapters.splice(i, 1);
        adapters.push(...fresh);
        const s = hub.statuses.get(stream);
        if (s) { s.provider = fresh.map((a) => a.provider).join(' + '); s.mock = fresh.every((a) => a.mock); s.delayedMin = Math.max(...fresh.map((a) => a.delayedMin)); s.lastUpdate = null; }
        hub.setState(stream, 'connecting');
        for (const a of fresh) await a.start(ctx);
        overrides.set(stream, provider);
        return { stream, provider, adapters: fresh.map((a) => a.id) };
      });
      r.put('/api/admin/ai-budget', async ({ body }) => {
        const { tokens } = await body<{ tokens?: number }>();
        setDailyBudget(Number(tokens));
        return { budget: dailyBudget() };
      });
      r.get('/api/ai/usage', () => ({ ...usageToday(), budget: dailyBudget() }));
    },
  };
}
