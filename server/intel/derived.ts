import type { NewsCluster } from '../../shared/types';
import type { CorrelationMatrix, ReactionSeries, RegimeState, SocialRow, Speaker, StatementDiff, SurpriseIndex, ThemeItem } from '../../shared/v2';
import { correlationBreaks, correlationMatrix, regimeScore, surpriseIndex } from '../../shared/quant';
import { structureEvents } from '../../shared/market';
import { SYMBOL_MAP } from '../../shared/symbols';
import { sentences } from '../../shared/briefDiff';
import { sqlite } from '../db/client';
import { kvGet, kvSet } from '../kv';
import type { Hub } from '../hub';
import { aiJson, hashKey } from '../ai/client';
import { getText, type IntelJob } from './framework';
import { SPEAKERS } from './sources';

// ------------------------------------------------------------------ social: mention velocity from our own news stream
export function socialJob(clusters: () => NewsCluster[]): IntelJob {
  return {
    key: 'social', label: 'Mention velocity', everyMs: 60_000, cadence: 'live', derived: true,
    async live() {
      const now = Date.now();
      const counts = new Map<string, number[]>(); // 24 hourly bins
      for (const c of clusters()) {
        const age = Math.floor((now - c.receivedAt) / 3600_000);
        if (age < 0 || age >= 24) continue;
        for (const t of new Set([...c.tickers, ...c.currencies.filter((x) => x.length === 6)])) {
          const arr = counts.get(t) ?? new Array(24).fill(0);
          arr[23 - age] += c.articles.length;
          counts.set(t, arr);
        }
      }
      const rows: SocialRow[] = [...counts.entries()].map(([symbol, bins]) => {
        const recent = bins[23];
        const base = bins.slice(0, 23).reduce((s, x) => s + x, 0) / 23;
        const ratio = base > 0 ? recent / base : recent;
        return { symbol, mentions1h: recent, baseline: +base.toFixed(2), ratio: +ratio.toFixed(1), spike: recent >= 3 && ratio >= 3, spark: bins };
      }).filter((r) => r.spark.some((x) => x > 0)).sort((a, b) => b.ratio - a.ratio || b.mentions1h - a.mentions1h).slice(0, 25);
      return { data: rows, source: 'Mentions across PULSE news sources (last 24h)', connected: true, note: 'Reddit/X/StockTwits are not used: their API terms restrict this use without an approved app.' };
    },
  };
}

// ------------------------------------------------------------------ themes: multi-day narratives
const STOP = new Set('the a an and or of to in on for with as at by from is are be was were it its this that after over amid into says said new up down more than will may could would ahead us how why what who'.split(' '));
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));

export function clusterThemes(list: NewsCluster[], now = Date.now()): ThemeItem[] {
  const recent = list.filter((c) => now - c.receivedAt < 3 * 86400_000);
  // feature = entities + top keywords; group by most frequent co-occurring feature pair
  const feat = new Map<string, NewsCluster[]>();
  for (const c of recent) {
    const ents = [...c.tickers, ...c.currencies.filter((x) => x.length === 6), ...c.tags];
    const kws = [...new Set(words(`${c.headline} ${c.summary}`))].slice(0, 8);
    for (const f of new Set([...ents.map((e) => `#${e}`), ...kws])) feat.set(f, [...(feat.get(f) ?? []), c]);
  }
  const seeds = [...feat.entries()].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length);
  const used = new Set<string>();
  const themes: ThemeItem[] = [];
  for (const [f, members] of seeds) {
    const fresh = members.filter((c) => !used.has(c.id));
    if (fresh.length < 3) continue;
    // second keyword that co-occurs most to make the label specific
    const co = new Map<string, number>();
    for (const c of fresh) for (const w of new Set([...words(c.headline), ...c.tickers.map((t) => `#${t}`)])) if (w !== f) co.set(w, (co.get(w) ?? 0) + 1);
    const second = [...co.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const label = [f, second].filter(Boolean).map((x) => x!.replace('#', '')).map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(' · ');
    const timeline = new Array(12).fill(0);
    for (const c of fresh) {
      const bin = 11 - Math.floor((now - c.receivedAt) / (6 * 3600_000));
      if (bin >= 0) timeline[bin]++;
    }
    const recentHalf = timeline.slice(6).reduce((s, x) => s + x, 0), older = timeline.slice(0, 6).reduce((s, x) => s + x, 0);
    for (const c of fresh) used.add(c.id);
    themes.push({
      id: f.replace(/[^a-z0-9#]/gi, ''), label, keywords: [f, second].filter(Boolean) as string[],
      assets: [...new Set(fresh.flatMap((c) => [...c.tickers, ...c.currencies.filter((x) => x.length === 6)]))].slice(0, 6),
      volume: fresh.length, momentum: +((recentHalf - older) / Math.max(1, recentHalf + older)).toFixed(2),
      sentiment: +(fresh.reduce((s, c) => s + c.sentiment, 0) / fresh.length).toFixed(2), clusters: fresh.map((c) => c.id).slice(0, 40),
      firstSeen: Math.min(...fresh.map((c) => c.receivedAt)), lastSeen: Math.max(...fresh.map((c) => c.receivedAt)), timeline,
      quotes: fresh.sort((a, b) => b.impact - a.impact).slice(0, 4).map((c) => ({ text: c.headline, source: c.source, url: c.url, ts: c.publishedAt })),
    });
    if (themes.length >= 12) break;
  }
  return themes.sort((a, b) => b.volume - a.volume);
}

export function themesJob(clusters: () => NewsCluster[], onNewTop5: (t: ThemeItem) => void): IntelJob {
  return {
    key: 'themes', label: 'Theme radar', everyMs: 5 * 60_000, cadence: 'live', derived: true,
    async live() {
      const themes = clusterThemes(clusters());
      // optional AI labels (cached per theme member set)
      for (const t of themes.slice(0, 6)) {
        const out = await aiJson<{ label: string }>({
          kind: 'themes', small: true, system: 'Name a multi-day market news theme in 2–5 words, e.g. "Japan intervention watch". Use only the headlines.',
          user: t.quotes.map((q) => `- ${q.text}`).join('\n'), schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false },
          maxTokens: 200, cacheKey: hashKey('theme', t.clusters.slice(0, 6)), cacheMaxAgeMs: 2 * 86400_000,
        }).catch(() => null);
        if (out?.label) { t.label = out.label.slice(0, 50); t.ai = true; }
      }
      const prevTop = new Set(kvGet<string[]>('themes.top5', []));
      for (const t of themes.slice(0, 5)) if (prevTop.size && !prevTop.has(t.id)) onNewTop5(t);
      kvSet('themes.top5', themes.slice(0, 5).map((t) => t.id));
      return { data: themes, source: 'Keyword & entity co-occurrence across PULSE news (3 days)', connected: true };
    },
  };
}

// ------------------------------------------------------------------ correlation matrix & regime
export const CORR_DEFAULT = ['SPX', 'NDX', 'US10Y', 'DXY', 'EURUSD', 'USDJPY', 'GOLD', 'WTI', 'BTC', 'ETH', 'VIX', 'COPPER'];

export function correlationJob(hub: Hub, symbols: () => string[]): IntelJob {
  return {
    key: 'correlation', label: 'Correlation matrix', everyMs: 60_000, cadence: 'live', derived: true,
    async live() {
      const syms = symbols().filter((s) => SYMBOL_MAP[s]);
      const now = Date.now();
      const sample = (from: number, step: number) => syms.map((s) => {
        const out: number[] = [];
        for (let t = from; t <= now; t += step) out.push(hub.priceAt(s, t) ?? NaN);
        return out;
      });
      const clean = (rows: number[][]) => {
        const ok = rows[0]?.map((_, i) => rows.every((r) => Number.isFinite(r[i]))) ?? [];
        return rows.map((r) => r.filter((_, i) => ok[i]));
      };
      const day = clean(sample(now - 24 * 3600_000, 15 * 60_000));
      const prior = clean(sample(now - 24 * 3600_000, 15 * 60_000).map((r) => r.slice(0, Math.floor(r.length / 2))));
      const recent = clean(sample(now - 12 * 3600_000, 15 * 60_000));
      const m: CorrelationMatrix = { window: '1d', symbols: syms, values: correlationMatrix(day), breaks: day[0]?.length > 10 ? correlationBreaks(syms, correlationMatrix(recent), correlationMatrix(prior), 0.6).slice(0, 6) : [] };
      // longer windows from stored daily closes
      const closes = kvGet<Record<string, Record<string, number>>>('closes', {});
      const daily = Object.keys(closes).map(Number).sort((a, b) => a - b).map((k) => closes[String(k)]);
      const longer = daily.length >= 6 ? { window: '1w' as const, symbols: syms, values: correlationMatrix(syms.map((s) => daily.map((d) => d[s] ?? NaN))), breaks: [] } : null;
      return { data: { '1d': m, '1w': longer, '1m': null }, source: '15-minute returns from PULSE price history', connected: true, note: longer ? undefined : '1w/1m windows build up from daily closes.' };
    },
  };
}

export function regimeJob(hub: Hub): IntelJob {
  return {
    key: 'regime', label: 'Risk regime', everyMs: 60_000, cadence: 'live', derived: true,
    async live() {
      const pct = (s: string) => hub.quotes.get(s)?.changePct ?? null;
      const r = regimeScore({ spxPct: pct('SPX') ?? pct('SPY'), vixLevel: hub.quotes.get('VIX')?.price ?? null, vixPct: pct('VIX'), hygPct: pct('IWM'), usdjpyPct: pct('USDJPY'), goldPct: pct('GOLD') ?? pct('XAUUSD'), btcPct: pct('BTC') });
      const hist = kvGet<RegimeState['history']>('regime.history', []);
      const now = Date.now();
      if (!hist.length || now - hist[hist.length - 1].t > 15 * 60_000) {
        hist.push({ t: now, score: r.score });
        kvSet('regime.history', hist.slice(-96 * 7));
      }
      const data: RegimeState = { ...r, history: hist.slice(-96) };
      return { data, source: 'Equities, VIX, small caps (credit proxy), USDJPY, gold, BTC', connected: true };
    },
  };
}

// ------------------------------------------------------------------ economic surprise index & reaction analyzer
export function surpriseJob(): IntelJob {
  const regions: Record<string, string[]> = { US: ['USD'], 'Euro area': ['EUR'], UK: ['GBP'], Japan: ['JPY'], China: ['CNY', 'CNH'] };
  return {
    key: 'surprise', label: 'Economic surprise index', everyMs: 15 * 60_000, cadence: 'daily', derived: true,
    async live() {
      const out: SurpriseIndex[] = [];
      for (const [region, ccys] of Object.entries(regions)) {
        const rows = sqlite.prepare(`SELECT series, time, actual, consensus, lower_is_better AS lib, demo FROM econ_history WHERE currency IN (${ccys.map(() => '?').join(',')}) AND actual IS NOT NULL AND consensus IS NOT NULL AND time > ? ORDER BY time`)
          .all(...ccys, Date.now() - 180 * 86400_000) as { series: string; time: number; actual: number; consensus: number; lib: number; demo: number }[];
        if (rows.length < 3) continue;
        const s = surpriseIndex(rows.map((r) => ({ ...r, lowerIsBetter: !!r.lib })));
        out.push({ region, value: s.value, series: s.series.slice(-120) });
      }
      return { data: out, source: 'Actual vs consensus of recorded releases (PULSE history)', connected: true, note: out.length ? undefined : 'Builds up as releases with consensus are recorded.' };
    },
  };
}

const REACTION_ASSETS: Record<string, string[]> = { USD: ['USDJPY', 'EURUSD', 'US2Y', 'GOLD', 'SPX'], EUR: ['EURUSD', 'DE10Y'], GBP: ['GBPUSD', 'GB10Y'], JPY: ['USDJPY', 'JP10Y'], AUD: ['AUDUSD'], CAD: ['USDCAD'], CHF: ['USDCHF'], NZD: ['NZDUSD'] };
export function reactionsJob(hub: Hub): IntelJob {
  return {
    key: 'reactions', label: 'Historical reactions', everyMs: 10 * 60_000, cadence: 'daily', derived: true,
    async live() {
      // fill price reactions for releases we have prices around (hub keeps ~26h; tick archive extends it)
      const pending = sqlite.prepare("SELECT id, currency, time, reactions FROM econ_history WHERE time > ? AND time < ? AND (reactions = '{}' OR reactions LIKE '%\"partial\":true%')").all(Date.now() - 26 * 3600_000, Date.now() - 5 * 60_000) as { id: string; currency: string; time: number; reactions: string }[];
      for (const p of pending) {
        const moves: Record<string, { m5?: number; m30?: number; d1?: number }> = {};
        for (const s of REACTION_ASSETS[p.currency] ?? []) {
          const base = hub.priceAt(s, p.time - 60_000);
          if (!base) continue;
          const at = (dt: number) => (Date.now() > p.time + dt ? hub.priceAt(s, p.time + dt) : null);
          const pct = (v: number | null) => (v ? +(((v - base) / base) * 100).toFixed(3) : undefined);
          moves[s] = { m5: pct(at(5 * 60_000)), m30: pct(at(30 * 60_000)), d1: pct(at(86400_000 - 120_000)) };
        }
        const partial = Date.now() < p.time + 86400_000;
        sqlite.prepare('UPDATE econ_history SET reactions = ? WHERE id = ?').run(JSON.stringify({ ...moves, ...(partial ? { partial: true } : {}) }), p.id);
      }
      const series = sqlite.prepare('SELECT series, currency, COUNT(*) n FROM econ_history GROUP BY series, currency HAVING n >= 2 ORDER BY n DESC LIMIT 40').all() as { series: string; currency: string; n: number }[];
      const data: ReactionSeries[] = series.map((s) => {
        const rows = sqlite.prepare('SELECT id, time, actual, consensus, reactions, demo FROM econ_history WHERE series = ? AND currency = ? ORDER BY time DESC LIMIT 24').all(s.series, s.currency) as { id: string; time: number; actual: number | null; consensus: number | null; reactions: string; demo: number }[];
        return {
          series: s.series, currency: s.currency, demo: rows.some((r) => r.demo),
          rows: rows.map((r) => {
            const m = JSON.parse(r.reactions) as Record<string, { m5?: number; m30?: number; d1?: number }>;
            delete (m as Record<string, unknown>).partial;
            return { id: r.id, time: r.time, actual: r.actual, consensus: r.consensus, surprise: r.actual !== null && r.consensus !== null ? +(r.actual - r.consensus).toFixed(4) : null, moves: m };
          }),
        };
      });
      return { data, source: 'Recorded releases and PULSE price history', connected: true, note: data.length ? undefined : 'History builds up as releases post. Use demo data to preview.' };
    },
  };
}

// ------------------------------------------------------------------ market structure, speakers, statement diffs
export const structureJob: IntelJob = {
  key: 'structure', label: 'Market structure calendar', everyMs: 3600_000, cadence: 'daily', derived: true,
  async live() {
    return { data: structureEvents(Date.now() - 86400_000, Date.now() + 45 * 86400_000), source: 'Exchange holiday rules, expiry & rebalance schedules (computed)', connected: true, note: 'Tokyo holidays are approximate (fixed-date only).' };
  },
};

export function speakersJob(hub: Hub): IntelJob {
  return {
    key: 'speakers', label: 'Central bank speakers', everyMs: 10 * 60_000, cadence: 'live', derived: true,
    async live() {
      const upcoming = hub.calendar.filter((e) => e.time > Date.now() - 3600_000 && /speak|testif|remarks|speech|press conference/i.test(e.title));
      const data: Speaker[] = SPEAKERS.map((s) => {
        const last = s.name.split(' ').pop()!;
        const ev = upcoming.find((e) => e.title.includes(last));
        return { ...s, next: ev ? { title: `${ev.currency} ${ev.title}`, time: ev.time } : undefined };
      }).sort((a, b) => (a.next?.time ?? Infinity) - (b.next?.time ?? Infinity));
      return { data, source: 'Economic calendar + editable lean reference (server/data/speakers.json)', connected: true };
    },
  };
}

const STATEMENT_RE = /\b(FOMC statement|monetary policy decisions?|policy statement|Monetary Policy Summary|Statement on Monetary Policy|minutes)\b/i;
export function statementsJob(clusters: () => NewsCluster[]): IntelJob {
  return {
    key: 'statements', label: 'Statement diffs', everyMs: 15 * 60_000, cadence: 'live', derived: true,
    async live() {
      const store = kvGet<Record<string, { url: string; title: string; date: string; sentences: string[] }[]>>('statements', {});
      for (const c of clusters().filter((x) => x.domains.includes('centralbanks') && STATEMENT_RE.test(x.headline)).slice(0, 4)) {
        const a = c.articles.find((x) => /federalreserve\.gov|ecb\.europa\.eu|bankofengland\.co\.uk|boj\.or\.jp/.test(x.url));
        if (!a) continue;
        const bank = /federalreserve/.test(a.url) ? 'Fed' : /ecb/.test(a.url) ? 'ECB' : /bankofengland/.test(a.url) ? 'BoE' : 'BoJ';
        const list = store[bank] ?? [];
        if (list.some((x) => x.url === a.url)) continue;
        const html = await getText(a.url).catch(() => '');
        const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
        const ss = sentences(body).filter((s) => s.length > 40 && s.length < 600).slice(0, 120);
        if (ss.length < 3) continue;
        store[bank] = [{ url: a.url, title: a.headline, date: new Date(a.publishedAt).toISOString().slice(0, 10), sentences: ss }, ...list].slice(0, 2);
      }
      kvSet('statements', store);
      const data: StatementDiff[] = Object.entries(store).filter(([, l]) => l.length).map(([bank, [cur, prev]]) => {
        const p = new Set((prev?.sentences ?? []).map((s) => s.toLowerCase()));
        const c = new Set(cur.sentences.map((s) => s.toLowerCase()));
        return { id: `${bank}-${cur.date}`, bank, title: cur.title, url: cur.url, date: cur.date, added: prev ? cur.sentences.filter((s) => !p.has(s.toLowerCase())) : [], removed: prev ? prev.sentences.filter((s) => !c.has(s.toLowerCase())) : [], kept: prev ? cur.sentences.filter((s) => p.has(s.toLowerCase())).length : cur.sentences.length };
      });
      return { data, source: 'Official statements linked from central-bank feeds', connected: true, note: data.length ? undefined : 'Appears after a central bank publishes its next statement.' };
    },
  };
}
