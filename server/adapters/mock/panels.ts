import type { EconEvent, EarningsItem, Liquidation, TermPoint, UnusualOption } from '../../../shared/types';
import { SYMBOLS } from '../../../shared/symbols';
import type { Adapter, AdapterContext } from '../types';
import { mockMarket } from './market';

const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

// ------------------------------------------------------------------ economic calendar
interface Tpl { country: string; ccy: string; title: string; imp: 1 | 2 | 3; unit: string; base: number; spread: number; d: number; lower?: boolean }
const TEMPLATES: Tpl[] = [
  { country: 'US', ccy: 'USD', title: 'CPI (YoY)', imp: 3, unit: '%', base: 2.9, spread: 0.2, d: 1 },
  { country: 'US', ccy: 'USD', title: 'Core CPI (MoM)', imp: 3, unit: '%', base: 0.3, spread: 0.1, d: 1 },
  { country: 'US', ccy: 'USD', title: 'Nonfarm Payrolls', imp: 3, unit: 'K', base: 95, spread: 60, d: 0 },
  { country: 'US', ccy: 'USD', title: 'Unemployment Rate', imp: 3, unit: '%', base: 4.3, spread: 0.1, d: 1, lower: true },
  { country: 'US', ccy: 'USD', title: 'Initial Jobless Claims', imp: 2, unit: 'K', base: 228, spread: 12, d: 0, lower: true },
  { country: 'US', ccy: 'USD', title: 'ISM Manufacturing PMI', imp: 2, unit: '', base: 49.2, spread: 1.2, d: 1 },
  { country: 'US', ccy: 'USD', title: 'Retail Sales (MoM)', imp: 2, unit: '%', base: 0.4, spread: 0.3, d: 1 },
  { country: 'US', ccy: 'USD', title: 'Core PCE Price Index (MoM)', imp: 3, unit: '%', base: 0.2, spread: 0.1, d: 1 },
  { country: 'US', ccy: 'USD', title: 'JOLTS Job Openings', imp: 2, unit: 'M', base: 7.2, spread: 0.3, d: 2 },
  { country: 'US', ccy: 'USD', title: 'CB Consumer Confidence', imp: 2, unit: '', base: 97, spread: 3, d: 1 },
  { country: 'EU', ccy: 'EUR', title: 'CPI Flash Estimate (YoY)', imp: 3, unit: '%', base: 2.1, spread: 0.2, d: 1 },
  { country: 'EU', ccy: 'EUR', title: 'HCOB Manufacturing PMI', imp: 2, unit: '', base: 49.6, spread: 1, d: 1 },
  { country: 'DE', ccy: 'EUR', title: 'Ifo Business Climate', imp: 2, unit: '', base: 88.4, spread: 1, d: 1 },
  { country: 'GB', ccy: 'GBP', title: 'CPI (YoY)', imp: 3, unit: '%', base: 3.6, spread: 0.2, d: 1 },
  { country: 'GB', ccy: 'GBP', title: 'GDP (MoM)', imp: 2, unit: '%', base: 0.1, spread: 0.2, d: 1 },
  { country: 'JP', ccy: 'JPY', title: 'Tokyo Core CPI (YoY)', imp: 2, unit: '%', base: 2.6, spread: 0.2, d: 1 },
  { country: 'JP', ccy: 'JPY', title: 'Tankan Large Manufacturers', imp: 2, unit: '', base: 13, spread: 2, d: 0 },
  { country: 'AU', ccy: 'AUD', title: 'Employment Change', imp: 2, unit: 'K', base: 22, spread: 15, d: 1 },
  { country: 'CA', ccy: 'CAD', title: 'Employment Change', imp: 2, unit: 'K', base: 15, spread: 20, d: 1 },
  { country: 'CN', ccy: 'CNY', title: 'Caixin Manufacturing PMI', imp: 2, unit: '', base: 50.4, spread: 1, d: 1 },
  { country: 'NZ', ccy: 'NZD', title: 'GDP (QoQ)', imp: 2, unit: '%', base: 0.3, spread: 0.3, d: 1 },
  { country: 'CH', ccy: 'CHF', title: 'CPI (YoY)', imp: 2, unit: '%', base: 0.2, spread: 0.2, d: 1 },
  { country: 'US', ccy: 'USD', title: 'Crude Oil Inventories', imp: 1, unit: 'M', base: -1.2, spread: 2, d: 1 },
  { country: 'US', ccy: 'USD', title: 'Existing Home Sales', imp: 1, unit: 'M', base: 4.0, spread: 0.1, d: 2 },
  { country: 'EU', ccy: 'EUR', title: 'ZEW Economic Sentiment', imp: 1, unit: '', base: 25, spread: 8, d: 1 },
  { country: 'GB', ccy: 'GBP', title: 'Retail Sales (MoM)', imp: 1, unit: '%', base: 0.2, spread: 0.4, d: 1 },
];

function mkEvent(t: Tpl, time: number, idx: number): EconEvent {
  const consensus = round(t.base + (Math.random() - 0.5) * t.spread, t.d);
  const previous = round(consensus + (Math.random() - 0.5) * t.spread, t.d);
  return {
    id: `mock-${time}-${idx}`, country: t.country, currency: t.ccy, title: t.title, time, importance: t.imp, unit: t.unit,
    consensus, previous, actual: time < Date.now() ? round(consensus + (Math.random() - 0.5) * t.spread * 1.4, t.d) : null,
    lowerIsBetter: t.lower, source: 'Demo calendar', mock: true,
  };
}

export function mockCalendarAdapter(): Adapter {
  let timer: NodeJS.Timeout | null = null;
  let events: EconEvent[] = [];
  const build = () => {
    const now = new Date();
    const day = now.getUTCDay();
    const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((day + 6) % 7));
    const hours = [0.5, 1.5, 6, 7, 8, 9, 12.5, 13.5, 14, 15, 18, 23.75];
    const out: EconEvent[] = [];
    let i = 0;
    for (let d = 0; d < 5; d++) {
      const n = 5 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n; k++) {
        const t = pick(TEMPLATES);
        out.push(mkEvent(t, monday + d * 86400_000 + pick(hours) * 3600_000, i++));
      }
    }
    // demo: guarantee near-term high-importance releases so countdowns + "actual posts" are visible
    const soon = Date.now();
    out.push(mkEvent(TEMPLATES[0], Math.ceil((soon + 3 * 60_000) / 60_000) * 60_000, i++));
    out.push(mkEvent(TEMPLATES[2], Math.ceil((soon + 26 * 60_000) / 60_000) * 60_000, i++));
    out.push(mkEvent(TEMPLATES[10], Math.ceil((soon + 71 * 60_000) / 60_000) * 60_000, i++));
    return out;
  };

  return {
    id: 'mock-calendar', stream: 'calendar', provider: 'Demo calendar', mock: true, delayedMin: 0, staleAfterMs: 3600_000,
    start(ctx: AdapterContext) {
      events = build();
      ctx.hub.setCalendar(events);
      timer = setInterval(() => {
        const now = Date.now();
        let changed = false;
        for (const e of events) {
          if (e.actual === null && e.time <= now) {
            const tpl = TEMPLATES.find((t) => t.title === e.title && t.country === e.country)!;
            e.actual = round((e.consensus ?? tpl.base) + (Math.random() - 0.5) * tpl.spread * 1.5, tpl.d);
            changed = true;
            const diff = (e.actual - (e.consensus ?? e.actual)) * (e.lowerIsBetter ? -1 : 1);
            const beat = diff > 0 ? 'beats' : diff < 0 ? 'misses' : 'matches';
            if (e.importance >= 2)
              ctx.emitNews({
                sourceId: 'demo-wire', source: 'Demo Wire', demo: true, publishedAt: now,
                headline: `${e.country} ${e.title} ${e.actual}${e.unit} vs ${e.consensus}${e.unit} expected — data ${beat} consensus`,
                summary: `Previous: ${e.previous}${e.unit}. ${e.currency} traders reacted to the release.`,
                url: `https://example.com/pulse-demo/calendar-${e.id}`,
              });
          }
        }
        // keep a rolling near-term high-importance event in demo mode
        if (!events.some((e) => e.importance === 3 && e.time > now && e.time - now < 90 * 60_000)) {
          events.push(mkEvent(pick(TEMPLATES.filter((t) => t.imp === 3)), Math.ceil((now + (8 + Math.random() * 30) * 60_000) / 60_000) * 60_000, events.length));
          changed = true;
        }
        if (changed) ctx.hub.setCalendar([...events]);
        else ctx.hub.touch('calendar');
      }, 1000);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

// ------------------------------------------------------------------ crypto market
export function mockCryptoMarketAdapter(): Adapter {
  let timer: NodeJS.Timeout | null = null;
  let dom = 57.4;
  const funding: Record<string, number> = { BTC: 0.0001, ETH: 0.00012, SOL: 0.00018, XRP: 0.00009, DOGE: 0.00022 };
  const liqs: Liquidation[] = [];
  let lastPx: Record<string, number> = {};
  return {
    id: 'mock-crypto-market', stream: 'cryptoMarket', provider: 'Demo crypto metrics', mock: true, delayedMin: 0, staleAfterMs: 60_000,
    start(ctx) {
      const tick = () => {
        dom = Math.max(50, Math.min(64, dom + (Math.random() - 0.5) * 0.06));
        for (const k of Object.keys(funding)) funding[k] = Math.max(-0.0005, Math.min(0.0008, funding[k] + (Math.random() - 0.5) * 0.00002));
        const btc = ctx.hub.quotes.get('BTC');
        const fg = Math.round(Math.max(5, Math.min(95, 52 + (btc?.changePct ?? 0) * 7)));
        const label = fg < 25 ? 'Extreme Fear' : fg < 45 ? 'Fear' : fg <= 55 ? 'Neutral' : fg < 75 ? 'Greed' : 'Extreme Greed';
        // liquidation headlines when a coin moves > 0.35% between ticks
        for (const s of ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']) {
          const p = mockMarket.current(s);
          const prev = lastPx[s];
          if (p && prev) {
            const mv = (p - prev) / prev;
            if (Math.abs(mv) > 0.0025 || Math.random() < 0.02) {
              const side = mv < 0 ? 'long' : 'short';
              const usd = Math.round((0.4 + Math.random() * 6) * (s === 'BTC' ? 3 : 1) * 1e6);
              liqs.unshift({ id: `${s}-${Date.now()}`, symbol: s, side, usd, ts: Date.now(), text: `${s} ${side}s liquidated: $${(usd / 1e6).toFixed(1)}M on perp venues` });
            }
          }
          if (p) lastPx[s] = p;
        }
        liqs.splice(12);
        const mcap = ((btc?.price ?? 112000) * 19.9e6) / (dom / 100);
        ctx.hub.setCrypto({
          btcDominance: round(dom, 2), totalMcapUsd: mcap, mcapChange24h: btc ? round(btc.changePct * 0.9, 2) : null,
          fearGreed: { value: fg, label, source: 'Demo index (alternative.me-style)', ts: Date.now() },
          funding: Object.entries(funding).map(([symbol, rate]) => ({ symbol, rate, nextFundingTime: Math.ceil(Date.now() / (8 * 3600_000)) * 8 * 3600_000, venue: 'Demo perps' })),
          liquidations: [...liqs], sources: ['Demo crypto metrics'], mock: true,
        });
      };
      tick();
      timer = setInterval(tick, 5000);
      lastPx = {};
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

// ------------------------------------------------------------------ vol term structure
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function termFromSpot(spot: number): TermPoint[] {
  // VIX futures: contango toward ~19-20 in calm markets, backwardation when spot is elevated
  const lr = 19.5;
  const now = new Date();
  const out: TermPoint[] = [];
  for (let i = 0; i < 8; i++) {
    const exp = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i + 1, 15);
    const k = 1 - Math.exp(-(i + 1) / 3);
    out.push({ label: MONTHS[new Date(exp).getUTCMonth()], expiry: exp, value: round(spot + (lr - spot) * k + (Math.random() - 0.5) * 0.08, 2) });
  }
  return out;
}

export function structureOf(spot: number, term: TermPoint[]) {
  if (!term.length) return null;
  const d = term[Math.min(2, term.length - 1)].value - (term[0]?.value ?? spot);
  return Math.abs(d) < 0.15 ? 'flat' : d > 0 ? 'contango' : 'backwardation';
}

export function mockVolAdapter(): Adapter {
  let timer: NodeJS.Timeout | null = null;
  return {
    id: 'mock-vol', stream: 'vol', provider: 'Demo VIX curve', mock: true, delayedMin: 0, staleAfterMs: 60_000,
    start(ctx) {
      const tick = () => {
        const spot = ctx.hub.quotes.get('VIX')?.price ?? 16;
        const term = termFromSpot(spot);
        ctx.hub.setVol({ termStructure: term, structure: structureOf(spot, term), termSource: 'Demo VIX futures', termDelayedMin: 0 });
      };
      setTimeout(tick, 500);
      timer = setInterval(tick, 10_000);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

// ------------------------------------------------------------------ options flow (put/call + unusual activity)
export function mockOptionsAdapter(): Adapter {
  let timer: NodeJS.Timeout | null = null;
  const flows: UnusualOption[] = [];
  let pc = { equity: 0.62, index: 1.12 };
  const names = SYMBOLS.filter((s) => s.assetClass === 'equity' || s.assetClass === 'etf');
  return {
    id: 'mock-options', stream: 'options', provider: 'Demo options flow', mock: true, delayedMin: 0, staleAfterMs: 120_000,
    start(ctx) {
      const tick = () => {
        pc = { equity: round(Math.max(0.4, Math.min(1.1, pc.equity + (Math.random() - 0.5) * 0.02)), 2), index: round(Math.max(0.8, Math.min(1.6, pc.index + (Math.random() - 0.5) * 0.03)), 2) };
        if (Math.random() < 0.6) {
          const s = pick(names);
          const px = ctx.hub.quotes.get(s.symbol)?.price ?? s.mock.base;
          const type = Math.random() < 0.58 ? 'call' : 'put';
          const strikeStep = px > 500 ? 10 : px > 100 ? 5 : 1;
          const strike = Math.round((px * (type === 'call' ? 1.03 + Math.random() * 0.08 : 0.97 - Math.random() * 0.08)) / strikeStep) * strikeStep;
          const exp = new Date(Date.now() + (3 + Math.floor(Math.random() * 40)) * 86400_000);
          flows.unshift({
            id: `${s.symbol}-${Date.now()}`, symbol: s.symbol, type, strike, expiry: exp.toISOString().slice(0, 10),
            premiumUsd: Math.round((0.3 + Math.random() * 4.5) * 1e6), volOi: round(2 + Math.random() * 12, 1), side: pick(['ask', 'ask', 'bid', 'mid'] as const), ts: Date.now(),
          });
          flows.splice(20);
        }
        ctx.hub.setVol(
          {
            putCall: { equity: pc.equity, index: pc.index, total: round((pc.equity + pc.index) / 2, 2), ts: Date.now(), source: 'Demo' },
            putCallConnected: false, unusual: [...flows], unusualConnected: false, unusualSource: 'Demo flow (connect a provider)',
          },
          'options',
        );
      };
      tick();
      timer = setInterval(tick, 6000);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

// ------------------------------------------------------------------ earnings
export function mockEarningsAdapter(): Adapter {
  return {
    id: 'mock-earnings', stream: 'earnings', provider: 'Demo earnings calendar', mock: true, delayedMin: 0, staleAfterMs: 86400_000,
    start(ctx) {
      const eq = SYMBOLS.filter((s) => s.assetClass === 'equity');
      const items: EarningsItem[] = eq
        .sort(() => Math.random() - 0.5)
        .slice(0, 12)
        .map((s, i) => ({
          symbol: s.symbol, name: s.name, date: Date.now() + Math.floor(i / 2) * 86400_000 + 3600_000,
          session: (i % 2 ? 'amc' : 'bmo') as EarningsItem['session'], epsEst: round(0.5 + Math.random() * 4, 2), impliedMovePct: round(s.mock.vol * 12 * (0.7 + Math.random() * 0.6), 1),
        }))
        .sort((a, b) => a.date - b.date);
      ctx.hub.setVol({ earnings: items, earningsSource: 'Demo earnings calendar' }, 'earnings');
    },
    stop() {},
  };
}
