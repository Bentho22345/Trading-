import type { Auction, CotRow, Filing, PredictionMarket, RatePath, ReactionSeries } from '../../shared/v2';
import { rng } from './framework';
import { BANKS } from './sources';

const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const seed = () => Math.floor(Date.now() / 3600_000);

export const mockAuctions = (): Auction[] => [
  { id: 'm1', date: day(1), security: 'Note', term: '10-Year', offering: 42e9, highYield: null, bidToCover: null, tail: null, indirect: null, status: 'upcoming' },
  { id: 'm2', date: day(2), security: 'Bond', term: '30-Year', offering: 25e9, highYield: null, bidToCover: null, tail: null, indirect: null, status: 'upcoming' },
  { id: 'm3', date: day(-1), security: 'Note', term: '3-Year', offering: 58e9, highYield: 3.612, bidToCover: 2.61, tail: -0.4, indirect: 66.2, status: 'result' },
  { id: 'm4', date: day(-6), security: 'Note', term: '7-Year', offering: 44e9, highYield: 3.842, bidToCover: 2.48, tail: 1.1, indirect: 61.8, status: 'result' },
];

export const mockRealYields = () => [
  { id: 'DFII10', label: '10Y real yield (TIPS)', value: 1.82, prev: 1.79, date: day(-1), spark: Array.from({ length: 30 }, (_, i) => 1.7 + Math.sin(i / 4) * 0.08 + i * 0.003) },
  { id: 'DFII5', label: '5Y real yield (TIPS)', value: 1.41, prev: 1.43, date: day(-1), spark: Array.from({ length: 30 }, (_, i) => 1.45 - Math.cos(i / 5) * 0.06) },
  { id: 'T10YIE', label: '10Y breakeven', value: 2.31, prev: 2.30, date: day(-1), spark: Array.from({ length: 30 }, (_, i) => 2.28 + Math.sin(i / 6) * 0.03) },
  { id: 'T5YIE', label: '5Y breakeven', value: 2.37, prev: 2.39, date: day(-1), spark: Array.from({ length: 30 }, (_, i) => 2.38 + Math.cos(i / 3) * 0.02) },
];

export function mockRatePaths(): RatePath[] {
  const r = rng(seed());
  return BANKS.banks.filter((b) => ['FED', 'ECB', 'BOE', 'BOJ'].includes(b.id)).map((b) => {
    const meetings = (b.meetings ?? []).filter((m) => Date.parse(m) > Date.now()).slice(0, 3);
    const bias = b.id === 'BOJ' ? 1 : b.id === 'ECB' ? 0 : -1;
    return {
      bank: b.short, name: b.name, currency: b.currency, rate: b.rate,
      meetings: meetings.map((m, i) => {
        const move = Math.min(85, 20 + i * 18 + r() * 25);
        const cut = bias < 0 ? move : bias === 0 ? r() * 15 : 0, hike = bias > 0 ? move * 0.7 : 0;
        return { date: m.slice(0, 10), cut: Math.round(cut), hike: Math.round(hike), hold: Math.round(100 - cut - hike), delta: Math.round((r() - 0.5) * 12), impliedBps: Math.round((hike - cut) / 4) };
      }),
    };
  });
}

export function mockCot(): CotRow[] {
  const r = rng(42);
  return [['Euro FX', 'EUR'], ['Japanese yen', 'JPY'], ['British pound', 'GBP'], ['Swiss franc', 'CHF'], ['Canadian dollar', 'CAD'], ['Australian dollar', 'AUD'], ['Gold', 'GOLD'], ['WTI crude', 'WTI'], ['S&P 500 e-mini', 'SPX'], ['Bitcoin (CME)', 'BTC']].map(([market, symbol]) => {
    const net = Math.round((r() - 0.4) * 200_000);
    return { market, symbol, net, change: Math.round((r() - 0.5) * 30_000), pct3y: Math.round(r() * 100), longs: Math.abs(net) + 80_000, shorts: 80_000 };
  });
}

export const mockCryptoFlows = () => {
  const r = rng(seed());
  return {
    stablecoins: { total: 2.92e11, change1d: 4.1e8, change7d: 2.3e9, spark: Array.from({ length: 60 }, (_, i) => 2.8e11 + i * 2e9) },
    etfFlows: [{ asset: 'BTC', d1: Math.round((r() - 0.3) * 6e8), d7: Math.round((r() - 0.3) * 2.5e9) }, { asset: 'ETH', d1: Math.round((r() - 0.4) * 2e8), d7: Math.round((r() - 0.4) * 8e8) }],
    netflows: [{ asset: 'BTC', d1: Math.round((r() - 0.6) * 9000) }, { asset: 'ETH', d1: Math.round((r() - 0.5) * 60000) }],
    unlocks: [{ token: 'ARB', date: day(3), usd: 42e6 }, { token: 'OP', date: day(8), usd: 31e6 }, { token: 'SUI', date: day(12), usd: 120e6 }],
  };
};

export const mockFilings = (): Filing[] => [
  { id: 'f1', form: '8-K', company: 'NVIDIA CORP', ticker: 'NVDA', title: '8-K - NVIDIA CORP', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810', ts: Date.now() - 1800_000, watch: true, oneLiner: 'Demo: announced a new share repurchase authorization.' },
  { id: 'f2', form: '4', company: 'TESLA, INC.', ticker: 'TSLA', title: '4 - TESLA, INC.', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001318605', ts: Date.now() - 3600_000, watch: true },
  { id: 'f3', form: 'SC 13D', company: 'INTEL CORP', ticker: 'INTC', title: 'SC 13D - INTEL CORP', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000050863', ts: Date.now() - 7200_000, watch: true },
];

export const mockPrediction = (): PredictionMarket[] => {
  const r = rng(seed());
  return [
    ['Fed cuts rates at the next FOMC meeting?', 'Polymarket'], ['US recession in 2027?', 'Polymarket'], ['Bitcoin above $120k on Dec 31?', 'Polymarket'],
    ['CPI YoY above 3.0% next print?', 'Kalshi'], ['Unemployment rate above 4.5% in December?', 'Kalshi'], ['Government shutdown before year end?', 'Polymarket'],
  ].map(([q, venue], i) => ({ id: `mp${i}`, venue: venue as PredictionMarket['venue'], question: q, yes: Math.round(10 + r() * 80), change24h: +((r() - 0.5) * 10).toFixed(1), volume24h: Math.round(r() * 3e6), url: venue === 'Kalshi' ? 'https://kalshi.com' : 'https://polymarket.com' }));
};

export function mockReactions(): ReactionSeries[] {
  const r = rng(7);
  const mk = (series: string, currency: string, scale: number, assets: string[]) => ({
    series, currency, demo: true,
    rows: Array.from({ length: 18 }, (_, i) => {
      const consensus = +(scale * (1 + r())).toFixed(2), actual = +(consensus + (r() - 0.5) * scale * 1.6).toFixed(2), s = actual - consensus;
      return { id: `${series}-${i}`, time: Date.now() - (i + 1) * 30 * 86400_000, actual, consensus, surprise: +s.toFixed(3), moves: Object.fromEntries(assets.map((a, k) => [a, { m5: +((s / scale) * 0.15 * (k === 0 ? 1 : -0.7) + (r() - 0.5) * 0.08).toFixed(3), m30: +((s / scale) * 0.25 * (k === 0 ? 1 : -0.7) + (r() - 0.5) * 0.15).toFixed(3), d1: +((s / scale) * 0.3 + (r() - 0.5) * 0.4).toFixed(3) }])) };
    }),
  });
  return [mk('nonfarm payrolls', 'USD', 100, ['USDJPY', 'GOLD', 'US2Y']), mk('cpi m/m', 'USD', 0.2, ['USDJPY', 'SPX', 'US10Y']), mk('main refinancing rate', 'EUR', 0.25, ['EURUSD', 'DE10Y'])];
}

export const mockSocial = () => ['NVDA', 'BTC', 'TSLA', 'USDJPY', 'ETH', 'COIN', 'PLTR'].map((symbol, i) => {
  const spark = Array.from({ length: 24 }, (_, k) => Math.round(2 + Math.sin(k / 3 + i) * 2 + (k === 23 ? 8 - i : 0)));
  const base = spark.slice(0, 23).reduce((s, x) => s + x, 0) / 23;
  return { symbol, mentions1h: spark[23], baseline: +base.toFixed(1), ratio: +(spark[23] / base).toFixed(1), spike: spark[23] / base >= 3, spark };
});
