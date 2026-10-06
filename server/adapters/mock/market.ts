import type { Hub, QuoteInput } from '../../hub';
import type { HistoryPoint, StreamId } from '../../../shared/types';
import { SYMBOLS, SYMBOL_MAP, MOCK_USD_PER, type SymbolDef } from '../../../shared/symbols';
import type { Adapter, AdapterContext } from '../types';

const MINUTE = 60_000;
const MOCK_SOURCE = { fx: 'Mock FX', crypto: 'Mock Crypto', equities: 'Mock Equities', macro: 'Mock Macro' } as const;
const YEAR_MS = 365 * 24 * 3600_000;

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

type Kind = 'crypto' | 'fx' | 'equities' | 'macro';
const MACRO = new Set(['index', 'commodity', 'rate']);
const kindOf = (s: SymbolDef): Kind => (s.assetClass === 'crypto' ? 'crypto' : s.assetClass === 'fx' ? 'fx' : MACRO.has(s.assetClass) ? 'macro' : 'equities');

/**
 * Plausible streaming prices for demo mode: geometric random walks with realistic
 * volatilities, triangularly-consistent FX crosses, VIX anti-correlated with SPY,
 * and news-driven "impulses" so headlines visibly move the related asset.
 */
class MockMarket {
  private price = new Map<string, number>();
  /** log USD value per currency; FX pairs are derived from these so crosses stay consistent */
  private ccy = new Map<string, number>();
  private impulses = new Map<string, { perTick: number; ticks: number }>();
  private active = new Set<Kind>();
  private timer: NodeJS.Timeout | null = null;
  private hub: Hub | null = null;
  private seeded = false;
  private last = Date.now();
  /** Symbols owned by a live adapter (e.g. VIX from Cboe) that the mock engine must not publish */
  skip = new Set<string>();

  attach(hub: Hub, kind: Kind) {
    this.hub = hub;
    if (!this.seeded) this.seed(hub);
    this.active.add(kind);
    this.publish(kind, true);
    if (!this.timer) this.timer = setInterval(() => this.tick(), 200);
  }

  detach(kind: Kind) {
    this.active.delete(kind);
    if (!this.active.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  impulse(symbol: string, pct: number, overTicks = 25) {
    if (!SYMBOL_MAP[symbol]) return;
    this.impulses.set(symbol, { perTick: Math.log(1 + pct / 100) / overTicks, ticks: overTicks });
  }

  current(symbol: string) {
    return this.price.get(symbol);
  }

  private seed(hub: Hub) {
    this.seeded = true;
    const now = Date.now();
    const start = Math.floor(now / MINUTE) * MINUTE - 26 * 60 * MINUTE;
    const minuteSigma = (vol: number) => vol * Math.sqrt(MINUTE / YEAR_MS);

    // FX: simulate each currency's USD value, then derive pairs
    const ccyPaths = new Map<string, number[]>();
    for (const [c, usd] of Object.entries(MOCK_USD_PER)) {
      if (c === 'USD') continue;
      const vol = c === 'XAU' ? 0.16 : ['MXN', 'ZAR', 'TRY', 'BRL'].includes(c) ? 0.13 : c === 'CNH' ? 0.04 : 0.085;
      const path = randomPath(Math.log(usd), 26 * 60, minuteSigma(vol), gauss() * 0.004);
      ccyPaths.set(c, path);
      this.ccy.set(c, path[path.length - 1]);
    }
    this.ccy.set('USD', 0);
    const ccyAt = (c: string, i: number) => (c === 'USD' ? 0 : ccyPaths.get(c)![i]);

    for (const s of SYMBOLS) {
      let path: number[];
      if (s.assetClass === 'fx') {
        const b = s.symbol.slice(0, 3), q = s.symbol.slice(3);
        path = Array.from({ length: 26 * 60 }, (_, i) => ccyAt(b, i) - ccyAt(q, i));
      } else if (s.symbol === 'USDC') {
        path = Array.from({ length: 26 * 60 }, () => Math.log(1 + gauss() * 0.00008));
      } else {
        // daily move target: most names drift a little, a few are genuine movers
        const daily = s.mock.vol / Math.sqrt(252);
        const big = s.assetClass === 'equity' && Math.random() < 0.18;
        const target = gauss() * daily * (big ? 3.2 : 1.1) * (s.assetClass === 'crypto' ? 1.2 : 1);
        path = randomPath(Math.log(s.mock.base), 26 * 60, minuteSigma(s.mock.vol) * 0.6, target);
      }
      const pts: HistoryPoint[] = path.map((lp, i) => ({ t: start + i * MINUTE, c: round(Math.exp(lp), s.decimals + 1) }));
      if (s.symbol === 'VIX') pts.forEach((p) => (p.c = Math.max(10, p.c)));
      hub.seedHistory(s.symbol, pts);
      this.price.set(s.symbol, pts[pts.length - 1].c);
    }
  }

  private tick() {
    if (!this.hub) return;
    const now = Date.now();
    const dt = Math.min(2000, now - this.last);
    this.last = now;
    const sig = (vol: number) => vol * Math.sqrt(dt / YEAR_MS) * 2.2; // a touch livelier than reality
    const moved = new Set<string>();

    if (this.active.has('fx')) {
      for (const [c, v] of this.ccy) {
        if (c === 'USD' || Math.random() > 0.35) continue;
        const vol = c === 'XAU' ? 0.16 : ['MXN', 'ZAR', 'TRY', 'BRL'].includes(c) ? 0.13 : c === 'CNH' ? 0.04 : 0.085;
        this.ccy.set(c, v + gauss() * sig(vol) * 1.5);
        moved.add(c);
      }
      if (moved.size) {
        const qs: QuoteInput[] = [];
        for (const s of SYMBOLS) {
          if (s.assetClass !== 'fx') continue;
          const b = s.symbol.slice(0, 3), q = s.symbol.slice(3);
          if (!moved.has(b) && !moved.has(q)) continue;
          let lp = (this.ccy.get(b) ?? 0) - (this.ccy.get(q) ?? 0);
          lp += this.applyImpulse(s.symbol);
          const p = round(Math.exp(lp), s.decimals);
          this.price.set(s.symbol, p);
          const spread = p * (s.major ? 0.00004 : 0.0002);
          qs.push({ symbol: s.symbol, price: p, bid: round(p - spread / 2, s.decimals), ask: round(p + spread / 2, s.decimals), ts: now, source: 'Mock FX', mock: true });
        }
        this.hub.pushQuotes(qs, 'fx');
      }
    }

    for (const kind of ['equities', 'crypto', 'macro'] as const) {
      if (!this.active.has(kind)) continue;
      const qs: QuoteInput[] = [];
      let spyMove = 0;
      for (const s of SYMBOLS) {
        if (kindOf(s) !== kind || s.symbol === 'VIX') continue;
        if (Math.random() > (kind === 'crypto' ? 0.45 : kind === 'macro' ? 0.2 : 0.3)) continue;
        const p0 = this.price.get(s.symbol) ?? s.mock.base;
        let lr = gauss() * sig(s.mock.vol) + this.applyImpulse(s.symbol);
        if (s.symbol === 'USDC') lr = (Math.log(1) - Math.log(p0)) * 0.2 + gauss() * 0.00003;
        const p = round(p0 * Math.exp(lr), s.decimals);
        if (s.symbol === 'SPY') spyMove = Math.log(p / p0);
        this.price.set(s.symbol, p);
        qs.push({ symbol: s.symbol, price: p, ts: now, source: MOCK_SOURCE[kind], mock: true, volume: undefined });
      }
      if (kind === 'equities' && !this.skip.has('VIX')) {
        const v0 = this.price.get('VIX') ?? 16;
        const lv = Math.log(v0) - 5 * spyMove + (Math.log(16.5) - Math.log(v0)) * 0.0005 + gauss() * 0.0009 + this.applyImpulse('VIX');
        const v = round(Math.max(9, Math.exp(lv)), 2);
        this.price.set('VIX', v);
        qs.push({ symbol: 'VIX', price: v, ts: now, source: 'Mock Equities', mock: true });
      }
      if (qs.length) this.hub.pushQuotes(qs, kind);
    }
  }

  private applyImpulse(symbol: string): number {
    const imp = this.impulses.get(symbol);
    if (!imp) return 0;
    imp.ticks--;
    if (imp.ticks <= 0) this.impulses.delete(symbol);
    // impulses on FX pairs are accumulated into the base currency so crosses stay consistent
    if (SYMBOL_MAP[symbol]?.assetClass === 'fx') {
      const b = symbol.slice(0, 3), q = symbol.slice(3);
      if (b !== 'USD') this.ccy.set(b, (this.ccy.get(b) ?? 0) + imp.perTick);
      else this.ccy.set(q, (this.ccy.get(q) ?? 0) - imp.perTick);
      return 0;
    }
    return imp.perTick;
  }

  private publish(kind: Kind, initial = false) {
    if (!this.hub) return;
    const now = Date.now();
    const qs: QuoteInput[] = [];
    for (const s of SYMBOLS) {
      if (kindOf(s) !== kind || this.skip.has(s.symbol)) continue;
      const p = this.price.get(s.symbol)!;
      const ref = this.hub.priceAt(s.symbol, now - 24 * 3600_000) ?? p;
      qs.push({ symbol: s.symbol, price: p, ref, ts: now, source: MOCK_SOURCE[kind], mock: true });
    }
    this.hub.pushQuotes(qs, initial ? (kind as StreamId) : undefined);
  }
}

function randomPath(endLog: number, n: number, sigma: number, totalDrift: number): number[] {
  // Build a walk that ends exactly at endLog, having drifted by totalDrift over the window.
  const raw: number[] = [0];
  for (let i = 1; i < n; i++) raw.push(raw[i - 1] + gauss() * sigma);
  const endRaw = raw[n - 1];
  // Brownian bridge pinned to 0 at both ends, plus a linear drift
  return raw.map((r, i) => {
    const frac = i / (n - 1);
    return endLog - totalDrift * (1 - frac) + (r - endRaw * frac);
  });
}

function round(v: number, d: number) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export const mockMarket = new MockMarket();

export function mockQuoteAdapter(kind: Kind): Adapter {
  return {
    id: `mock-${kind}`,
    stream: kind,
    provider: `${MOCK_SOURCE[kind]} engine`,
    mock: true,
    delayedMin: 0,
    staleAfterMs: 10_000,
    start(ctx: AdapterContext) {
      mockMarket.attach(ctx.hub, kind);
    },
    stop() {
      mockMarket.detach(kind);
    },
  };
}
