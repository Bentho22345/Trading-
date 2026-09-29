import { MAJOR_PAIRS, SYMBOL_MAP, EM_FX } from '../../../shared/symbols';
import type { Hub, QuoteInput } from '../../hub';
import type { Adapter } from '../types';
import { errText, fetchJson, poller } from '../types';
import { config, keys } from '../../config';
import { finnhubSocket } from './finnhub';

/** The seven USD majors: every one of the 28 crosses can be derived from these. */
export const USD_MAJORS = ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY'];

function usdValue(hub: Hub, ccy: string, field: 'price' | 'ref'): number | null {
  if (ccy === 'USD') return 1;
  const direct = hub.quotes.get(`${ccy}USD`);
  if (direct) return direct[field];
  const inv = hub.quotes.get(`USD${ccy}`);
  return inv ? 1 / inv[field] : null;
}

/** Derive the non-USD crosses (EURJPY, GBPCHF, …) from the USD legs so the heatmap and strength meter are complete. */
export function deriveCrosses(hub: Hub, source: string, delayedMin: number, ts: number) {
  const out: QuoteInput[] = [];
  for (const p of MAJOR_PAIRS) {
    if (p.includes('USD')) continue;
    const b = p.slice(0, 3), q = p.slice(3);
    const pb = usdValue(hub, b, 'price'), pq = usdValue(hub, q, 'price');
    const rb = usdValue(hub, b, 'ref'), rq = usdValue(hub, q, 'ref');
    if (!pb || !pq || !rb || !rq) continue;
    const d = SYMBOL_MAP[p].decimals;
    out.push({ symbol: p, price: +(pb / pq).toFixed(d), ref: rb / rq, ts, source: `${source} (derived)`, delayedMin });
  }
  hub.pushQuotes(out, 'fx');
}

/**
 * Twelve Data REST (free: 8 credits/min, 800/day; 1 credit per symbol).
 * The poll interval is derived from the daily budget, and quotes are labeled with the
 * resulting maximum age so polled data is never presented as streaming.
 */
export function twelveDataAdapter(): Adapter {
  let stop: (() => void) | null = null;
  const envSyms = (process.env.TWELVEDATA_SYMBOLS ?? '').split(',').map((x) => x.trim().toUpperCase()).filter((x) => SYMBOL_MAP[x]?.twelvedata);
  const symbols = envSyms.length ? envSyms : USD_MAJORS;
  const daily = Number(process.env.TWELVEDATA_DAILY_CREDITS) || 800;
  const intervalSec = Math.max(config.twelvedataIntervalSec, Math.ceil((symbols.length * 86400) / (daily * 0.95)), Math.ceil((symbols.length / 8) * 60));
  const ageMin = Math.ceil(intervalSec / 60);
  return {
    id: 'twelvedata', stream: 'fx', provider: `Twelve Data (REST, polled every ${ageMin}m)`, mock: false, delayedMin: ageMin, staleAfterMs: intervalSec * 2500,
    start(ctx) {
      const tdSym = symbols.map((s) => SYMBOL_MAP[s]?.twelvedata).filter(Boolean) as string[];
      stop = poller(async () => {
        const res = await fetchJson<Record<string, { close?: string; previous_close?: string; timestamp?: number; status?: string; code?: number; message?: string }>>(
          `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(tdSym.join(','))}&apikey=${keys.twelvedata}`,
        );
        if ((res as { code?: number }).code === 429) throw new Error('twelvedata rate limited');
        const rows = tdSym.length === 1 ? { [tdSym[0]]: res as never } : res;
        const qs: QuoteInput[] = [];
        let ts = Date.now();
        for (const [td, v] of Object.entries(rows)) {
          const sym = td.replace('/', '');
          if (!v || v.status === 'error' || !v.close) continue;
          ts = v.timestamp ? v.timestamp * 1000 : Date.now();
          qs.push({ symbol: sym, price: Number(v.close), ref: Number(v.previous_close) || undefined, ts, source: 'Twelve Data', delayedMin: ageMin });
        }
        if (!qs.length) throw new Error('no quotes returned');
        ctx.hub.pushQuotes(qs, 'fx');
        deriveCrosses(ctx.hub, 'Twelve Data', ageMin, ts);
      }, intervalSec * 1000, (e) => {
        ctx.log.warn(`[twelvedata] ${errText(e)}`);
        ctx.hub.reportError('fx', errText(e));
      });
    },
    stop() {
      stop?.();
    },
  };
}

/** Finnhub forex over the shared Finnhub WebSocket (OANDA symbols). */
export function finnhubFxAdapter(): Adapter {
  let unsub: (() => void) | null = null;
  const syms = [...USD_MAJORS, ...EM_FX, 'XAUUSD'];
  return {
    id: 'finnhub-fx', stream: 'fx', provider: 'Finnhub (OANDA via WS)', mock: false, delayedMin: config.fxDelayMin, staleAfterMs: 120_000,
    start(ctx) {
      let lastDerive = 0;
      unsub = finnhubSocket.subscribe(ctx, 'fx', syms.map((s) => ({ symbol: s, finnhub: SYMBOL_MAP[s].finnhub! })), (symbol, price, ts) => {
        ctx.hub.pushQuotes([{ symbol, price, ts, source: 'Finnhub/OANDA', delayedMin: config.fxDelayMin }], 'fx');
        if (Date.now() - lastDerive > 1000) {
          lastDerive = Date.now();
          deriveCrosses(ctx.hub, 'Finnhub/OANDA', config.fxDelayMin, ts);
        }
      });
    },
    stop() {
      unsub?.();
    },
  };
}
