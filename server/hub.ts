import { EventEmitter } from 'node:events';
import type {
  Analytics, CentralBank, CryptoMarket, EconEvent, HistoryPoint, Quote, StreamId, StreamState, StreamStatus, VolData,
} from '../shared/types';
import type { IntelBlock, IntelKey } from '../shared/v2';
import { SYMBOL_MAP, MAJOR_PAIRS } from '../shared/symbols';
import { currencyStrength } from '../shared/strength';

export interface QuoteInput {
  symbol: string;
  price: number;
  /** reference price (prev close / 24h open). If omitted, the previous ref or 24h-ago history is used. */
  ref?: number;
  ts?: number;
  bid?: number;
  ask?: number;
  volume?: number;
  source: string;
  delayedMin?: number;
  mock?: boolean;
}

const MINUTE = 60_000;
const HISTORY_MINUTES = 26 * 60;

/**
 * The hub is the worker's single source of truth: adapters write into it, the WebSocket
 * fan-out and REST API read from it. It never throws on bad input from adapters.
 */
export class Hub extends EventEmitter {
  quotes = new Map<string, Quote>();
  history = new Map<string, HistoryPoint[]>();
  statuses = new Map<StreamId, StreamStatus>();
  calendar: EconEvent[] = [];
  banks: CentralBank[] = [];
  crypto: CryptoMarket | null = null;
  vol: VolData | null = null;
  analytics: Analytics | null = null;
  intel = new Map<IntelKey, IntelBlock>();
  private timers: NodeJS.Timeout[] = [];

  constructor() {
    super();
    this.setMaxListeners(50);
    this.timers.push(setInterval(() => this.checkStaleness(), 2000));
    this.timers.push(setInterval(() => this.computeAnalytics(), 5000));
  }

  stop() {
    this.timers.forEach(clearInterval);
  }

  // ---------------------------------------------------------------- streams
  registerStream(s: Omit<StreamStatus, 'state' | 'lastUpdate' | 'latencyMs'>) {
    this.statuses.set(s.id, { ...s, state: 'connecting', lastUpdate: null, latencyMs: null });
    this.emitStatus();
  }

  setState(id: StreamId, state: StreamState, message?: string) {
    const s = this.statuses.get(id);
    if (!s || (s.state === state && s.message === message)) return;
    s.state = state;
    s.message = message;
    this.emitStatus();
  }

  /**
   * An adapter hit an error. Never received data → "down"; otherwise keep the last data
   * (staleness takes over after staleAfterMs) and just surface the message.
   */
  reportError(id: StreamId, message: string) {
    const s = this.statuses.get(id);
    if (!s) return;
    if (s.lastUpdate === null) this.setState(id, 'down', message);
    else if (s.message !== message) {
      s.message = message;
      this.emitStatus();
    }
  }

  touch(id: StreamId, latencyMs?: number | null) {
    const s = this.statuses.get(id);
    if (!s) return;
    s.lastUpdate = Date.now();
    if (latencyMs !== undefined && latencyMs !== null && Number.isFinite(latencyMs)) {
      // EWMA so the indicator doesn't flicker
      s.latencyMs = s.latencyMs === null ? latencyMs : Math.round(s.latencyMs * 0.8 + latencyMs * 0.2);
    }
    if (s.state !== 'live') {
      s.state = 'live';
      s.message = undefined;
      this.emitStatus();
    }
  }

  private checkStaleness() {
    const now = Date.now();
    let changed = false;
    for (const s of this.statuses.values()) {
      if (s.state === 'live' && s.lastUpdate && now - s.lastUpdate > s.staleAfterMs) {
        s.state = 'stale';
        changed = true;
      }
    }
    if (changed) this.emitStatus();
  }

  private statusTimer: NodeJS.Timeout | null = null;
  private emitStatus() {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.emit('status', [...this.statuses.values()]);
    }, 50);
  }

  // ---------------------------------------------------------------- quotes
  pushQuotes(inputs: QuoteInput[], stream?: StreamId) {
    const now = Date.now();
    const out: Quote[] = [];
    let maxLatency: number | null = null;
    for (const q of inputs) {
      if (!SYMBOL_MAP[q.symbol] || !Number.isFinite(q.price) || q.price <= 0) continue;
      const prev = this.quotes.get(q.symbol);
      const ts = q.ts ?? now;
      let ref = q.ref ?? prev?.ref;
      if (!ref || !Number.isFinite(ref)) ref = this.priceAt(q.symbol, now - 24 * 3600_000) ?? q.price;
      const quote: Quote = {
        symbol: q.symbol,
        price: q.price,
        ref,
        change: q.price - ref,
        changePct: ((q.price - ref) / ref) * 100,
        bid: q.bid,
        ask: q.ask,
        volume: q.volume ?? prev?.volume,
        ts,
        receivedAt: now,
        source: q.source,
        delayedMin: q.delayedMin ?? 0,
        mock: q.mock,
      };
      this.quotes.set(q.symbol, quote);
      this.record(q.symbol, ts, q.price);
      out.push(quote);
      if (!q.mock && q.ts) {
        const lat = now - q.ts - (q.delayedMin ?? 0) * MINUTE;
        if (lat >= 0 && lat < 60_000) maxLatency = Math.max(maxLatency ?? 0, lat);
      }
    }
    if (!out.length) return;
    if (stream) this.touch(stream, maxLatency);
    this.emit('quotes', out);
  }

  private record(symbol: string, ts: number, price: number) {
    const t = Math.floor(ts / MINUTE) * MINUTE;
    let h = this.history.get(symbol);
    if (!h) this.history.set(symbol, (h = []));
    const last = h[h.length - 1];
    if (last && last.t === t) last.c = price;
    else if (!last || t > last.t) {
      h.push({ t, c: price });
      if (h.length > HISTORY_MINUTES) h.splice(0, h.length - HISTORY_MINUTES);
    }
  }

  seedHistory(symbol: string, points: HistoryPoint[]) {
    const existing = this.history.get(symbol) ?? [];
    const merged = [...points.filter((p) => !existing.length || p.t < existing[0].t), ...existing];
    this.history.set(symbol, merged.slice(-HISTORY_MINUTES));
  }

  /** Last known minute close at or before ts */
  priceAt(symbol: string, ts: number): number | null {
    const h = this.history.get(symbol);
    if (!h || !h.length || h[0].t > ts) return null;
    let lo = 0, hi = h.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (h[mid].t <= ts) lo = mid;
      else hi = mid - 1;
    }
    return h[lo].c;
  }

  historySince(symbol: string, since: number, maxPoints = 500): HistoryPoint[] {
    const h = this.history.get(symbol) ?? [];
    const pts = h.filter((p) => p.t >= since);
    if (pts.length <= maxPoints) return pts;
    const step = pts.length / maxPoints;
    const out: HistoryPoint[] = [];
    for (let i = 0; i < maxPoints; i++) out.push(pts[Math.floor(i * step)]);
    out.push(pts[pts.length - 1]);
    return out;
  }

  spark(symbol: string, minutes = 180, points = 60): number[] {
    return this.historySince(symbol, Date.now() - minutes * MINUTE, points).map((p) => p.c);
  }

  // ---------------------------------------------------------------- panels
  setCalendar(events: EconEvent[], stream: StreamId = 'calendar') {
    this.calendar = events.sort((a, b) => a.time - b.time);
    this.touch(stream);
    this.emit('calendar', this.calendar);
  }
  setBanks(banks: CentralBank[]) {
    this.banks = banks;
    this.touch('banks');
    this.emit('banks', banks);
  }
  setCrypto(c: Partial<CryptoMarket>) {
    const base: CryptoMarket = this.crypto ?? {
      btcDominance: null, totalMcapUsd: null, mcapChange24h: null, fearGreed: null, funding: [], liquidations: [], sources: [], ts: 0,
    };
    this.crypto = { ...base, ...c, ts: Date.now() };
    this.touch('cryptoMarket');
    this.emit('crypto', this.crypto);
  }
  setVol(v: Partial<VolData>, stream: StreamId = 'vol') {
    const base: VolData = this.vol ?? {
      termStructure: [], structure: null, termSource: '—', termDelayedMin: 0, putCall: null, putCallConnected: false,
      earnings: [], earningsSource: '—', unusual: [], unusualConnected: false, unusualSource: '—', ts: 0,
    };
    // keep options-derived implied moves when an earnings adapter refreshes the list
    if (v.earnings && base.earnings.length) {
      const prev = new Map(base.earnings.map((e) => [e.symbol, e.impliedMovePct]));
      v = { ...v, earnings: v.earnings.map((e) => (e.impliedMovePct === null && prev.get(e.symbol) != null ? { ...e, impliedMovePct: prev.get(e.symbol)! } : e)) };
    }
    this.vol = { ...base, ...v, ts: Date.now() };
    this.touch(stream);
    this.emit('vol', this.vol);
  }

  /** Publish an intel block (rates, COT, filings…). Each carries its own source, cadence and timestamp. */
  setIntel<T>(b: IntelBlock<T>) {
    this.intel.set(b.key, b as IntelBlock);
    this.emit('intel', b);
  }

  // ---------------------------------------------------------------- analytics
  computeAnalytics() {
    const now = Date.now();
    const windows = { '1h': 3600_000, '4h': 4 * 3600_000, '1d': 24 * 3600_000 } as const;
    const strength = {} as Analytics['strength'];
    for (const [tf, ms] of Object.entries(windows) as [keyof typeof windows, number][]) {
      const changes: Record<string, number | undefined> = {};
      for (const p of MAJOR_PAIRS) {
        const q = this.quotes.get(p);
        const then = this.priceAt(p, now - ms);
        if (q && then) changes[p] = ((q.price - then) / then) * 100;
      }
      strength[tf] = currencyStrength(changes);
    }
    let up = 0, down = 0, n = 0;
    for (const q of this.quotes.values()) {
      const ac = SYMBOL_MAP[q.symbol]?.assetClass;
      if (ac !== 'equity' && ac !== 'crypto' && ac !== 'etf') continue;
      n++;
      if (q.changePct > 0.02) up++;
      else if (q.changePct < -0.02) down++;
    }
    this.analytics = { strength, breadth: n ? (up - down) / n : 0, ts: now };
    this.emit('analytics', this.analytics);
  }
}

export const hub = new Hub();
