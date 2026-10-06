import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Parser from 'rss-parser';
import type { Auction, CotRow, Filing, PredictionMarket, RatePath, Speaker } from '../../shared/v2';
import { SYMBOLS } from '../../shared/symbols';
import { kvGet, kvSet } from '../kv';
import { getJson, getText, type IntelJob } from './framework';

const here = dirname(fileURLToPath(import.meta.url));
const BANKS = JSON.parse(readFileSync(join(here, '../data/central-banks.json'), 'utf8')) as { banks: { id: string; name: string; short: string; currency: string; rate: number; meetings?: string[] }[] };
export const SPEAKERS = JSON.parse(readFileSync(join(here, '../data/speakers.json'), 'utf8')) as Omit<Speaker, 'next'>[];

const num = (v: unknown) => (v === null || v === undefined || v === '' || v === 'null' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const pick = (o: Record<string, unknown>, ...k: string[]) => k.map((x) => o[x]).find((v) => v !== undefined && v !== null && v !== '');

// ------------------------------------------------------------------ Treasury auctions (Fiscal Data, keyless)
export const auctionsJob: IntelJob = {
  key: 'auctions', label: 'US Treasury auctions', everyMs: 30 * 60_000, cadence: 'daily',
  async live() {
    const base = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od';
    const [up, res] = await Promise.all([
      getJson<{ data: Record<string, unknown>[] }>(`${base}/upcoming_auctions?sort=auction_date&page[size]=20`),
      getJson<{ data: Record<string, unknown>[] }>(`${base}/auctions_query?sort=-auction_date&page[size]=20`),
    ]);
    const map = (r: Record<string, unknown>, status: Auction['status']): Auction => ({
      id: `${pick(r, 'cusip') ?? ''}-${pick(r, 'auction_date')}`, date: String(pick(r, 'auction_date') ?? ''), security: String(pick(r, 'security_type') ?? ''), term: String(pick(r, 'security_term') ?? ''),
      offering: num(pick(r, 'offering_amt')), highYield: num(pick(r, 'high_yield', 'high_investment_rate', 'high_discnt_rate')), bidToCover: num(pick(r, 'bid_to_cover_ratio')),
      tail: null, indirect: num(pick(r, 'indirect_bidder_accepted')), status,
    });
    const data = [...up.data.map((r) => map(r, 'upcoming')), ...res.data.filter((r) => num(pick(r, 'bid_to_cover_ratio')) !== null).map((r) => map(r, 'result'))];
    return { data, source: 'US Treasury Fiscal Data', connected: true, asOf: data.find((d) => d.status === 'result')?.date };
  },
};

// ------------------------------------------------------------------ FRED real yields & breakevens (free key)
export const realYieldsJob: IntelJob = {
  key: 'realYields', label: 'Real yields & breakevens', everyMs: 6 * 3600_000, cadence: 'daily', connectHint: 'Add a free FRED_API_KEY to show 10Y real yields and breakevens (daily).',
  async live() {
    const key = process.env.FRED_API_KEY?.trim();
    if (!key) return null;
    const series = { DFII10: '10Y real yield (TIPS)', DFII5: '5Y real yield (TIPS)', T10YIE: '10Y breakeven', T5YIE: '5Y breakeven' };
    const out: { id: string; label: string; value: number | null; prev: number | null; date: string; spark: number[] }[] = [];
    for (const [id, label] of Object.entries(series)) {
      const r = await getJson<{ observations: { date: string; value: string }[] }>(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc&limit=30`);
      const obs = r.observations.filter((o) => o.value !== '.');
      out.push({ id, label, value: num(obs[0]?.value), prev: num(obs[1]?.value), date: obs[0]?.date ?? '', spark: obs.slice(0, 30).reverse().map((o) => Number(o.value)) });
    }
    return { data: out, source: 'FRED (St. Louis Fed)', connected: true, asOf: out[0]?.date };
  },
};

// ------------------------------------------------------------------ CFTC Commitments of Traders (weekly, keyless)
const COT: [string, string, string][] = [['099741', 'EUR', 'Euro FX'], ['097741', 'JPY', 'Japanese yen'], ['096742', 'GBP', 'British pound'], ['092741', 'CHF', 'Swiss franc'], ['090741', 'CAD', 'Canadian dollar'], ['232741', 'AUD', 'Australian dollar'], ['112741', 'NZD', 'NZ dollar'], ['088691', 'GOLD', 'Gold'], ['067651', 'WTI', 'WTI crude'], ['13874A', 'SPX', 'S&P 500 e-mini'], ['209742', 'NDX', 'Nasdaq 100 e-mini'], ['133741', 'BTC', 'Bitcoin (CME)']];
export const cotJob: IntelJob = {
  key: 'cot', label: 'CFTC Commitments of Traders', everyMs: 6 * 3600_000, cadence: 'weekly',
  async live() {
    const codes = COT.map(([c]) => `'${c}'`).join(',');
    const url = `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$select=cftc_contract_market_code,report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all&$where=cftc_contract_market_code in(${codes})&$order=report_date_as_yyyy_mm_dd DESC&$limit=2400`;
    const rows = await getJson<Record<string, string>[]>(encodeURI(url), process.env.CFTC_APP_TOKEN ? { headers: { 'X-App-Token': process.env.CFTC_APP_TOKEN } } : {});
    const out: CotRow[] = [];
    let asOf = '';
    for (const [code, symbol, market] of COT) {
      const r = rows.filter((x) => x.cftc_contract_market_code === code).slice(0, 157);
      if (!r.length) continue;
      const nets = r.map((x) => Number(x.noncomm_positions_long_all) - Number(x.noncomm_positions_short_all));
      const sorted = [...nets].sort((a, b) => a - b);
      const pct = (sorted.findIndex((v) => v >= nets[0]) / Math.max(1, sorted.length - 1)) * 100;
      asOf = r[0].report_date_as_yyyy_mm_dd.slice(0, 10);
      out.push({ market, symbol, net: nets[0], change: nets[0] - (nets[1] ?? nets[0]), pct3y: Math.round(pct), longs: Number(r[0].noncomm_positions_long_all), shorts: Number(r[0].noncomm_positions_short_all) });
    }
    return { data: out, source: 'CFTC Public Reporting (legacy futures, non-commercial)', connected: true, asOf, note: 'Weekly, as of Tuesday; released Friday.' };
  },
};

// ------------------------------------------------------------------ SEC EDGAR filings (keyless; UA + rate limit respected)
let cikMap: { at: number; byCik: Map<number, { ticker: string; rank: number }> } | null = null;
async function tickers() {
  if (cikMap && Date.now() - cikMap.at < 86400_000) return cikMap.byCik;
  const j = await getJson<Record<string, { cik_str: number; ticker: string; title: string }>>('https://www.sec.gov/files/company_tickers.json');
  const byCik = new Map<number, { ticker: string; rank: number }>();
  Object.values(j).forEach((v, i) => byCik.set(v.cik_str, { ticker: v.ticker, rank: i }));
  cikMap = { at: Date.now(), byCik };
  return byCik;
}

export function filingsJob(watch: () => string[], oneLiner?: (f: Filing) => Promise<string | null>): IntelJob {
  const parser = new Parser({ timeout: 15_000 });
  const universe = new Set(SYMBOLS.map((s) => s.symbol));
  return {
    key: 'filings', label: 'SEC EDGAR filings', everyMs: 2 * 60_000, cadence: 'live',
    async live() {
      const map = await tickers();
      const w = new Set(watch());
      const prev = kvGet<Filing[]>('filings.cache', []);
      const seen = new Set(prev.map((f) => f.id));
      const fresh: Filing[] = [];
      for (const form of ['8-K', 'S-1', 'SC 13D', '4']) {
        const xml = await getText(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}&company=&dateb=&owner=include&start=0&count=40&output=atom`);
        const feed = await parser.parseString(xml);
        for (const it of feed.items) {
          const m = /^(\S+(?: \S+)?) - (.+?) \((\d{10})\) \((\w+)\)/.exec(it.title ?? '');
          if (!m) continue;
          const cik = Number(m[3]);
          const t = map.get(cik);
          if (!t) continue;
          const watchHit = w.has(t.ticker) || universe.has(t.ticker);
          if (!watchHit && t.rank > 500) continue; // watchlist + large caps only
          const id = it.id ?? it.link ?? `${form}-${cik}-${it.isoDate}`;
          if (seen.has(id)) continue;
          seen.add(id);
          fresh.push({ id, form: m[1], company: m[2], ticker: t.ticker, title: it.title ?? '', url: it.link ?? '', ts: it.isoDate ? Date.parse(it.isoDate) : Date.now(), watch: watchHit });
        }
        await new Promise((r) => setTimeout(r, 250)); // well under 10 req/s
      }
      if (oneLiner) for (const f of fresh.filter((x) => x.watch).slice(0, 5)) f.oneLiner = (await oneLiner(f).catch(() => null)) ?? undefined;
      const all = [...fresh, ...prev].sort((a, b) => b.ts - a.ts).slice(0, 120);
      kvSet('filings.cache', all);
      return { data: all, source: 'SEC EDGAR (current filings)', connected: true };
    },
  };
}

// ------------------------------------------------------------------ prediction markets (Polymarket + Kalshi public data)
const MACRO = /\b(fed|fomc|rate|rates|inflation|cpi|recession|gdp|tariff|election|president|bitcoin|btc|ethereum|china|oil|treasury|shutdown|unemployment|jobs|powell|ecb|boj|war|ceasefire|default|debt)\b/i;
export const predictionJob: IntelJob = {
  key: 'prediction', label: 'Prediction markets', everyMs: 5 * 60_000, cadence: 'live',
  async live() {
    const out: PredictionMarket[] = [];
    const errors: string[] = [];
    try {
      const pm = await getJson<Record<string, unknown>[]>('https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=100');
      for (const m of pm) {
        const q = String(m.question ?? '');
        if (!MACRO.test(q)) continue;
        let yes = 0;
        try { yes = Number(JSON.parse(String(m.outcomePrices ?? '[]'))[0]); } catch { yes = 0; }
        out.push({ id: `pm-${m.id}`, venue: 'Polymarket', question: q, yes: Math.round(yes * 1000) / 10, change24h: num(m.oneDayPriceChange) !== null ? +(Number(m.oneDayPriceChange) * 100).toFixed(1) : null, volume24h: num(m.volume24hr), url: `https://polymarket.com/event/${m.slug ?? ''}`, endDate: String(m.endDate ?? '') });
        if (out.length >= 15) break;
      }
    } catch (e) { errors.push(`Polymarket: ${(e as Error).message}`); }
    try {
      for (const series of ['KXFED', 'KXCPIYOY', 'KXGDP', 'KXU3']) {
        const r = await getJson<{ markets: Record<string, unknown>[] }>(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&status=open&limit=8`);
        for (const m of r.markets ?? []) {
          const last = num(m.last_price) ?? num(m.yes_bid) ?? 0;
          const prev = num(m.previous_price);
          out.push({ id: `k-${m.ticker}`, venue: 'Kalshi', question: `${m.title ?? ''}${m.subtitle ? ` — ${m.subtitle}` : ''}`, yes: last, change24h: prev !== null ? last - prev : null, volume24h: num(m.volume_24h), url: `https://kalshi.com/markets/${String(series).toLowerCase()}`, endDate: String(m.close_time ?? '') });
        }
      }
    } catch (e) { errors.push(`Kalshi: ${(e as Error).message}`); }
    if (!out.length && errors.length) throw new Error(errors.join('; '));
    return { data: out, source: 'Polymarket & Kalshi public market data', connected: true, note: 'Market odds, not forecasts.' };
  },
};

// ------------------------------------------------------------------ crypto flows (DefiLlama stablecoins; others need a provider)
export const cryptoFlowsJob: IntelJob = {
  key: 'cryptoFlows', label: 'Crypto flows', everyMs: 30 * 60_000, cadence: 'daily',
  async live() {
    const chart = await getJson<{ date: string; totalCirculatingUSD: { peggedUSD: number } }[]>('https://stablecoins.llama.fi/stablecoincharts/all');
    const last = chart[chart.length - 1], d1 = chart[chart.length - 2], d7 = chart[chart.length - 8];
    const v = (x?: typeof last) => x?.totalCirculatingUSD?.peggedUSD ?? 0;
    return {
      data: {
        stablecoins: { total: v(last), change1d: v(last) - v(d1), change7d: v(last) - v(d7), spark: chart.slice(-60).map((x) => v(x)) },
        etfFlows: null, netflows: null, unlocks: null,
      },
      source: 'DefiLlama (stablecoin supply)', connected: true, asOf: new Date(Number(last.date) * 1000).toISOString().slice(0, 10),
      note: 'ETF flows, exchange netflows and token unlocks need a paid provider — use demo data to preview.',
    };
  },
};

// ------------------------------------------------------------------ rate-path probabilities
/** Market-implied odds need futures/OIS data (no reliable free source). Live mode offers a labelled estimate for the Fed only. */
export function ratePathsJob(hubQuote: (s: string) => number | null): IntelJob {
  return {
    key: 'ratePaths', label: 'Rate-path probabilities', everyMs: 10 * 60_000, cadence: 'estimate', connectHint: 'Connect a futures/OIS provider for market-implied odds.',
    async live() {
      const providerUrl = process.env.RATEPATH_URL?.trim();
      if (providerUrl) {
        const data = await getJson<RatePath[]>(providerUrl);
        return { data, source: 'Custom rate-path provider', connected: true, cadence: 'live' };
      }
      const fed = BANKS.banks.find((b) => b.id === 'FED');
      const twoY = hubQuote('US2Y');
      if (!fed || !twoY) return null;
      const spreadBp = (twoY - fed.rate) * 100;
      const prevDay = kvGet<Record<string, number>>('ratepaths.prev', {});
      const meetings = (fed.meetings ?? []).filter((m) => Date.parse(m) > Date.now()).slice(0, 3);
      const path: RatePath = {
        bank: 'Fed', name: 'Federal Reserve', currency: 'USD', rate: fed.rate,
        meetings: meetings.map((m, i) => {
          // crude: assume the 2Y–policy spread is priced evenly over ~8 meetings
          const expected = Math.max(-75, Math.min(75, (spreadBp * (i + 1)) / 8));
          const cut = Math.max(0, Math.min(100, (-expected / 25) * 100)), hike = Math.max(0, Math.min(100, (expected / 25) * 100));
          const hold = Math.max(0, 100 - cut - hike);
          const key = `fed-${m.slice(0, 10)}`;
          const lead = Math.max(cut, hold, hike);
          return { date: m.slice(0, 10), cut: +cut.toFixed(0), hold: +hold.toFixed(0), hike: +hike.toFixed(0), delta: prevDay[key] !== undefined ? +(lead - prevDay[key]).toFixed(0) : 0, impliedBps: +expected.toFixed(0) };
        }),
      };
      const today = new Date().toISOString().slice(0, 10);
      if (kvGet('ratepaths.day', '') !== today) {
        kvSet('ratepaths.day', today);
        kvSet('ratepaths.prev', Object.fromEntries(path.meetings.map((m) => [`fed-${m.date}`, Math.max(m.cut, m.hold, m.hike)])));
      }
      return { data: [path], source: 'Estimate from the US 2Y yield vs the policy rate', connected: true, note: 'Rough estimate, not market-implied odds. ECB/BoE/BoJ need a futures/OIS provider.' };
    },
  };
}

export { BANKS };
