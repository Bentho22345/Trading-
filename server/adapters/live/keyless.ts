import { SYMBOLS, SYMBOL_MAP, EM_FX } from '../../../shared/symbols';
import { zonedToUtc } from '../../../shared/sessions';
import type { EarningsItem, Liquidation } from '../../../shared/types';
import type { QuoteInput } from '../../hub';
import type { Adapter } from '../types';
import { errText, fetchJson, poller, sleep } from '../types';
import { deriveCrosses, USD_MAJORS } from './fx';

/**
 * Keyless live sources so the terminal runs on real data with zero API keys.
 * Keyed providers (Alpaca, Finnhub, Twelve Data) are still preferred when their keys exist.
 */

// ------------------------------------------------------------------ Stooq (equities + FX)
// Public CSV quotes, no key. Quote age varies (US equities are typically ~15 min delayed),
// so each quote's delay label is computed from its own timestamp — never shown as live.
async function stooqBatch(symbols: string[]): Promise<Map<string, { close: number; prev: number | null; ts: number }>> {
  const url = `https://stooq.com/q/l/?s=${symbols.join('+')}&f=sd2t2ohlcp&h&e=csv`;
  const ctrl = AbortSignal.timeout(10_000);
  const res = await fetch(url, { signal: ctrl, headers: { 'User-Agent': 'PulseTerminal/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} stooq`);
  const out = new Map<string, { close: number; prev: number | null; ts: number }>();
  const lines = (await res.text()).trim().split(/\r?\n/).slice(1);
  for (const l of lines) {
    const [sym, date, time, , , , close, prev] = l.split(',');
    const c = Number(close);
    if (!sym || !Number.isFinite(c) || c <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) continue;
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = (time ?? '00:00:00').split(':').map(Number);
    // Stooq timestamps are Warsaw local time
    out.set(sym.toLowerCase(), { close: c, prev: Number(prev) > 0 ? Number(prev) : null, ts: zonedToUtc(y, m, d, hh || 0, mm || 0, 'Europe/Warsaw') });
  }
  return out;
}

const delayOf = (ts: number) => Math.max(0, Math.min(24 * 60, Math.round((Date.now() - ts) / 60_000)));

export function stooqEquityAdapter(): Adapter {
  let stop: (() => void) | null = null;
  const eq = SYMBOLS.filter((s) => s.assetClass === 'equity' || s.assetClass === 'etf');
  return {
    id: 'stooq-equities', stream: 'equities', provider: 'Stooq (keyless, delayed)', mock: false, delayedMin: 15, staleAfterMs: 10 * 60_000,
    start(ctx) {
      stop = poller(async () => {
        const qs: QuoteInput[] = [];
        for (let i = 0; i < eq.length; i += 15) {
          const chunk = eq.slice(i, i + 15);
          const rows = await stooqBatch(chunk.map((s) => `${s.symbol.toLowerCase()}.us`));
          for (const s of chunk) {
            const r = rows.get(`${s.symbol.toLowerCase()}.us`);
            if (r) qs.push({ symbol: s.symbol, price: r.close, ref: r.prev ?? undefined, ts: r.ts, source: 'Stooq', delayedMin: Math.max(15, delayOf(r.ts)) });
          }
          await sleep(400);
        }
        if (!qs.length) throw new Error('no equity quotes from Stooq');
        ctx.hub.pushQuotes(qs, 'equities');
      }, 60_000, (e) => {
        ctx.log.warn(`[stooq-equities] ${errText(e)}`);
        ctx.hub.reportError('equities', errText(e));
      });
    },
    stop() {
      stop?.();
    },
  };
}

export function stooqFxAdapter(): Adapter {
  let stop: (() => void) | null = null;
  const syms = [...USD_MAJORS, ...EM_FX, 'XAUUSD'];
  return {
    id: 'stooq-fx', stream: 'fx', provider: 'Stooq (keyless, polled)', mock: false, delayedMin: 1, staleAfterMs: 5 * 60_000,
    start(ctx) {
      stop = poller(async () => {
        const rows = await stooqBatch(syms.map((s) => s.toLowerCase()));
        const qs: QuoteInput[] = [];
        let ts = Date.now();
        for (const s of syms) {
          const r = rows.get(s.toLowerCase());
          if (!r) continue;
          ts = r.ts;
          qs.push({ symbol: s, price: +r.close.toFixed(SYMBOL_MAP[s].decimals), ref: r.prev ?? undefined, ts: r.ts, source: 'Stooq', delayedMin: Math.max(1, delayOf(r.ts)) });
        }
        if (!qs.length) throw new Error('no FX quotes from Stooq');
        ctx.hub.pushQuotes(qs, 'fx');
        deriveCrosses(ctx.hub, 'Stooq', Math.max(1, delayOf(ts)), ts);
      }, 30_000, (e) => {
        ctx.log.warn(`[stooq-fx] ${errText(e)}`);
        ctx.hub.reportError('fx', errText(e));
      });
    },
    stop() {
      stop?.();
    },
  };
}

// ------------------------------------------------------------------ Nasdaq earnings calendar
export function nasdaqEarningsAdapter(): Adapter {
  let stop: (() => void) | null = null;
  return {
    id: 'nasdaq-earnings', stream: 'earnings', provider: 'Nasdaq earnings calendar (keyless)', mock: false, delayedMin: 0, staleAfterMs: 24 * 3600_000,
    start(ctx) {
      stop = poller(async () => {
        const items: EarningsItem[] = [];
        for (let d = 0; d < 7 && items.length < 40; d++) {
          const day = new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
          const r = await fetchJson<{ data?: { rows?: { symbol: string; name: string; time: string; epsForecast: string; marketCap: string }[] | null } }>(
            `https://api.nasdaq.com/api/calendar/earnings?date=${day}`,
            { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 PulseTerminal/0.1' } },
          );
          for (const row of r.data?.rows ?? []) {
            const mcap = Number(String(row.marketCap).replace(/[$,]/g, ''));
            if (!SYMBOL_MAP[row.symbol] && !(mcap > 50e9)) continue; // our universe + mega caps only
            const session = /pre/i.test(row.time) ? 'bmo' : /after/i.test(row.time) ? 'amc' : 'dmh';
            const eps = Number(String(row.epsForecast).replace(/[$()]/g, ''));
            items.push({ symbol: row.symbol, name: row.name, date: Date.parse(`${day}T${session === 'amc' ? '20:00' : '12:00'}:00Z`), session, epsEst: Number.isFinite(eps) ? eps : null, impliedMovePct: null });
          }
          await sleep(500);
        }
        ctx.hub.setVol({ earnings: items.slice(0, 20), earningsSource: 'Nasdaq (implied move needs an options provider)' }, 'earnings');
      }, 6 * 3600_000, (e) => {
        ctx.log.warn(`[nasdaq-earnings] ${errText(e)}`);
        ctx.hub.reportError('earnings', errText(e));
      });
    },
    stop() {
      stop?.();
    },
  };
}

// ------------------------------------------------------------------ OKX liquidations
/** Public OKX liquidation orders for the major perps (no key). Merged into the crypto panel. */
export function okxLiquidationsAdapter(): Adapter {
  let stop: (() => void) | null = null;
  const ctVal: Record<string, number> = { BTC: 0.01, ETH: 0.1, SOL: 1, XRP: 100, DOGE: 1000 };
  return {
    id: 'okx-liquidations', stream: 'cryptoMarket', provider: 'OKX liquidations', mock: false, delayedMin: 0, staleAfterMs: 20 * 60_000,
    start(ctx) {
      const seen = new Map<string, Liquidation>();
      stop = poller(async () => {
        for (const s of Object.keys(ctVal)) {
          const r = await fetchJson<{ data: { details: { side: string; sz: string; bkPx: string; ts: string }[] }[] }>(
            `https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=${s}-USDT&state=filled&limit=20`,
          );
          for (const d of r.data?.[0]?.details ?? []) {
            const usd = Number(d.sz) * ctVal[s] * Number(d.bkPx);
            if (!(usd >= 50_000)) continue;
            const side = d.side === 'sell' ? 'long' : 'short'; // a forced sell closes a long
            const id = `${s}-${d.ts}-${d.sz}`;
            seen.set(id, { id, symbol: s, side, usd: Math.round(usd), ts: Number(d.ts), text: `${s} ${side}s liquidated: $${(usd / 1e6).toFixed(2)}M on OKX` });
          }
          await sleep(300);
        }
        const list = [...seen.values()].sort((a, b) => b.ts - a.ts).slice(0, 20);
        for (const k of seen.keys()) if (!list.some((l) => l.id === k)) seen.delete(k);
        ctx.hub.setCrypto({ liquidations: list });
      }, 60_000, (e) => ctx.log.warn(`[okx-liquidations] ${errText(e)}`));
    },
    stop() {
      stop?.();
    },
  };
}
