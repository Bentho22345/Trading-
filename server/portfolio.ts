import { randomUUID } from 'node:crypto';
import type { Exposure, Position } from '../shared/v2';
import { SYMBOL_MAP } from '../shared/symbols';
import { lastFxCloseTs, lastUsCloseTs } from '../shared/market';
import { docs } from './docs';
import { keys } from './config';
import type { Hub } from './hub';
import { bad, type Router } from './router';
import type { V2Feature } from './v2';

const SECTORS: Record<string, string> = {
  AAPL: 'Technology', MSFT: 'Technology', NVDA: 'Semiconductors', AMD: 'Semiconductors', AVGO: 'Semiconductors', INTC: 'Semiconductors', ARM: 'Semiconductors', SMCI: 'Semiconductors',
  AMZN: 'Consumer', WMT: 'Consumer', TSLA: 'Consumer', DIS: 'Communication', NFLX: 'Communication', GOOGL: 'Communication', META: 'Communication', ORCL: 'Technology', PLTR: 'Technology',
  JPM: 'Financials', GS: 'Financials', BAC: 'Financials', COIN: 'Financials', MSTR: 'Technology', XOM: 'Energy', LLY: 'Healthcare', UNH: 'Healthcare', BA: 'Industrials',
};

function usdPer(ccy: string, hub: Hub): number {
  if (ccy === 'USD') return 1;
  const d = hub.quotes.get(`${ccy}USD`)?.price;
  if (d) return d;
  const i = hub.quotes.get(`USD${ccy}`)?.price;
  return i ? 1 / i : 1;
}

/** Simple linear shock betas (per 1 unit of shock), clearly labelled as estimates in the UI. */
function shockPct(symbol: string, shock: 'dxy' | 'ust' | 'btc'): number {
  const m = SYMBOL_MAP[symbol];
  if (!m) return 0;
  if (shock === 'btc') return symbol === 'BTC' ? -5 : m.assetClass === 'crypto' && symbol !== 'USDC' ? -6 : ['COIN', 'MSTR'].includes(symbol) ? -8 : 0;
  if (shock === 'dxy') {
    if (m.assetClass === 'fx') return symbol.startsWith('USD') ? 1 : symbol.endsWith('USD') ? -1 : 0;
    if (symbol === 'GOLD' || symbol === 'SILVER') return -1;
    if (m.assetClass === 'crypto' && symbol !== 'USDC') return -0.8;
    if (m.assetClass === 'equity' || m.assetClass === 'etf' || m.assetClass === 'index') return -0.3;
    return 0;
  }
  // +10bp US 10Y
  if (m.assetClass === 'rate') return symbol.startsWith('US') ? (0.1 / (m.mock.base || 4)) * 100 : 0;
  if (['QQQ', 'NDX', 'NVDA', 'TSLA', 'AMD', 'PLTR', 'ARM', 'SMCI'].includes(symbol)) return -0.8;
  if (m.assetClass === 'equity' || m.assetClass === 'etf' || m.assetClass === 'index') return -0.5;
  if (symbol === 'GOLD') return -0.3;
  if (symbol === 'USDJPY') return 0.3;
  return 0;
}

export function computeExposure(positions: Position[], hub: Hub): Exposure {
  const now = Date.now();
  const byCcy = new Map<string, number>(), byClass = new Map<string, number>(), bySector = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const rows: Exposure['rows'] = [];
  let total = 0, pnlDay = 0, pnlOvernight = 0, pnlTotal = 0;
  const shocks = { dxy: 0, ust: 0, btc: 0 };
  for (const p of positions) {
    const m = SYMBOL_MAP[p.symbol];
    const q = hub.quotes.get(p.symbol);
    if (!m || !q) {
      rows.push({ id: p.id, symbol: p.symbol, qty: p.qty, price: null, value: 0, pnlDay: 0, pnlTotal: 0, priced: false });
      continue;
    }
    const quoteCcy = m.assetClass === 'fx' ? p.symbol.slice(3) : p.currency ?? 'USD';
    const conv = usdPer(quoteCcy, hub);
    const value = p.qty * q.price * conv;
    const day = p.qty * (q.price - q.ref) * conv;
    const ref = hub.priceAt(p.symbol, m.assetClass === 'equity' || m.assetClass === 'etf' ? lastUsCloseTs(now) : lastFxCloseTs(now)) ?? q.ref;
    const on = p.qty * (q.price - ref) * conv;
    const tot = p.avgPrice ? p.qty * (q.price - p.avgPrice) * conv : 0;
    total += Math.abs(value);
    pnlDay += day; pnlOvernight += on; pnlTotal += tot;
    rows.push({ id: p.id, symbol: p.symbol, qty: p.qty, price: q.price, value, pnlDay: day, pnlTotal: tot, priced: true, mock: q.mock });
    if (m.assetClass === 'fx') {
      add(byCcy, p.symbol.slice(0, 3), p.qty * usdPer(p.symbol.slice(0, 3), hub));
      add(byCcy, p.symbol.slice(3), -value);
    } else add(byCcy, m.assetClass === 'crypto' ? p.symbol : quoteCcy, value);
    add(byClass, m.assetClass, value);
    add(bySector, p.sector ?? SECTORS[p.symbol] ?? (m.assetClass === 'equity' ? 'Other equity' : m.assetClass), value);
    for (const k of ['dxy', 'ust', 'btc'] as const) shocks[k] += (Math.abs(value) * Math.sign(p.qty) * shockPct(p.symbol, k)) / 100;
  }
  const list = (mm: Map<string, number>) => [...mm.entries()].map(([key, v]) => ({ key, value: Math.round(v) })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return {
    totalValue: Math.round(total), pnlDay: Math.round(pnlDay), pnlOvernight: Math.round(pnlOvernight), pnlTotal: Math.round(pnlTotal),
    byCurrency: list(byCcy), byClass: list(byClass), bySector: list(bySector), rows,
    stress: [
      { id: 'dxy', label: 'DXY +1%', pnl: Math.round(shocks.dxy), note: 'Linear estimate: USD pairs ±1%, gold −1%, crypto −0.8%, equities −0.3%' },
      { id: 'dxy-', label: 'DXY −1%', pnl: Math.round(-shocks.dxy), note: 'Mirror of DXY +1%' },
      { id: 'ust', label: 'US 10Y +10bp', pnl: Math.round(shocks.ust), note: 'Linear estimate: equities −0.5%, growth −0.8%, gold −0.3%' },
      { id: 'btc', label: 'BTC −5%', pnl: Math.round(shocks.btc), note: 'Linear estimate: BTC −5%, alts −6%, crypto equities −8%' },
    ],
    ts: now,
  };
}

export function parseCsv(text: string): Omit<Position, 'id'>[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].toLowerCase().split(/[,;\t]/).map((h) => h.trim());
  const hasHeader = head.some((h) => /symbol|ticker|qty|quantity|price/.test(h));
  const idx = (names: string[], d: number) => { const i = head.findIndex((h) => names.includes(h)); return hasHeader ? i : d; };
  const iS = idx(['symbol', 'ticker', 'instrument'], 0), iQ = idx(['qty', 'quantity', 'shares', 'units', 'amount'], 1), iP = idx(['avg_price', 'avgprice', 'price', 'cost', 'avg cost', 'average price'], 2), iSec = idx(['sector'], 3);
  const out: Omit<Position, 'id'>[] = [];
  for (const l of lines.slice(hasHeader ? 1 : 0)) {
    const c = l.split(/[,;\t]/).map((x) => x.trim().replace(/^"|"$/g, ''));
    const symbol = (c[iS] ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const qty = Number((c[iQ] ?? '').replace(/,/g, ''));
    if (!symbol || !Number.isFinite(qty) || qty === 0) continue;
    const avg = Number((c[iP] ?? '').replace(/[$,]/g, ''));
    out.push({ symbol, qty, avgPrice: Number.isFinite(avg) ? avg : 0, sector: iSec >= 0 && c[iSec] ? c[iSec] : undefined, source: 'csv', assetClass: SYMBOL_MAP[symbol]?.assetClass });
  }
  return out.slice(0, 500);
}

export function portfolioFeature(hub: Hub, broadcast: (e: Exposure) => void): V2Feature {
  let timer: NodeJS.Timeout | null = null;
  let last: Exposure | null = null;
  const tick = () => {
    const positions = docs.list<Position>('positions');
    if (!positions.length && !last) return;
    last = computeExposure(positions, hub);
    broadcast(last);
  };
  return {
    start() {
      timer = setInterval(tick, 5000);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
    routes(r: Router) {
      r.get('/api/exposure', () => computeExposure(docs.list<Position>('positions'), hub));
      r.post('/api/positions/import', async ({ raw, url }) => {
        const rows = parseCsv((await raw()).toString('utf8'));
        if (!rows.length) bad('no positions found — expected columns symbol, qty, avg_price');
        if (url.searchParams.get('replace') === '1') for (const p of docs.list<Position>('positions')) docs.remove('positions', p.id);
        for (const p of rows) docs.put('positions', { ...p, id: randomUUID() });
        tick();
        return { imported: rows.length, unpriced: rows.filter((p) => !SYMBOL_MAP[p.symbol]).map((p) => p.symbol) };
      });
      // read-only broker import: Alpaca positions (GET only; PULSE never places orders)
      r.post('/api/positions/broker/alpaca', async () => {
        if (!keys.alpacaKey || !keys.alpacaSecret) bad('set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY on the server first');
        const base = process.env.ALPACA_LIVE === '1' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
        const res = await fetch(`${base}/v2/positions`, { headers: { 'APCA-API-KEY-ID': keys.alpacaKey, 'APCA-API-SECRET-KEY': keys.alpacaSecret }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) bad(`Alpaca returned HTTP ${res.status}`);
        const list = (await res.json()) as { symbol: string; qty: string; avg_entry_price: string; asset_class: string }[];
        for (const p of docs.list<Position>('positions').filter((x) => x.source === 'alpaca')) docs.remove('positions', p.id);
        for (const p of list) {
          const sym = p.symbol.replace(/USD$/, '').replace('/', '');
          docs.put('positions', { id: randomUUID(), symbol: SYMBOL_MAP[sym] ? sym : p.symbol, qty: Number(p.qty), avgPrice: Number(p.avg_entry_price), source: 'alpaca', assetClass: p.asset_class });
        }
        tick();
        return { imported: list.length, account: base.includes('paper') ? 'paper' : 'live' };
      });
    },
  };
}
