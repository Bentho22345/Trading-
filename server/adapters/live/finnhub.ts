import type { StreamId, EarningsItem } from '../../../shared/types';
import { SYMBOLS, SYMBOL_MAP } from '../../../shared/symbols';
import type { Adapter, AdapterContext } from '../types';
import { fetchJson, poller, sleep } from '../types';
import { ReconnectingWS } from './rws';
import { config, keys } from '../../config';

const API = 'https://finnhub.io/api/v1';
const MAX_WS_SYMBOLS = 50; // free-tier WebSocket limit

type TradeCb = (symbol: string, price: number, ts: number) => void;

/**
 * Finnhub allows one WebSocket per key, so equities and FX share a single connection.
 * Trades are coalesced per symbol and flushed every 250 ms to keep the hub calm.
 */
class FinnhubSocket {
  private rws: ReconnectingWS | null = null;
  private subs = new Map<string, { symbol: string; stream: StreamId; cb: TradeCb }>();
  private pending = new Map<string, { price: number; ts: number }>();
  private flushTimer: NodeJS.Timeout | null = null;

  subscribe(ctx: AdapterContext, stream: StreamId, syms: { symbol: string; finnhub: string }[], cb: TradeCb) {
    for (const s of syms) {
      if (this.subs.size >= MAX_WS_SYMBOLS) {
        ctx.log.warn(`[finnhub] WebSocket symbol cap (${MAX_WS_SYMBOLS}) reached; ${s.symbol} not streamed`);
        continue;
      }
      this.subs.set(s.finnhub, { symbol: s.symbol, stream, cb });
      this.rws?.send({ type: 'subscribe', symbol: s.finnhub });
    }
    if (!this.rws) {
      this.rws = new ReconnectingWS({
        url: `wss://ws.finnhub.io?token=${keys.finnhub}`, stream, name: 'finnhub', ctx, idleTimeoutMs: 90_000,
        onOpen: (ws) => {
          for (const k of this.subs.keys()) ws.send(JSON.stringify({ type: 'subscribe', symbol: k }));
        },
        onMessage: (raw) => {
          const m = JSON.parse(raw);
          if (m.type !== 'trade') return;
          for (const t of m.data ?? []) this.pending.set(t.s, { price: t.p, ts: t.t });
        },
      });
      this.rws.start();
      this.flushTimer = setInterval(() => {
        for (const [k, v] of this.pending) this.subs.get(k)?.cb(this.subs.get(k)!.symbol, v.price, v.ts);
        this.pending.clear();
      }, 250);
    }
    return () => {
      for (const s of syms) {
        this.subs.delete(s.finnhub);
        this.rws?.send({ type: 'unsubscribe', symbol: s.finnhub });
      }
      if (!this.subs.size) {
        this.rws?.stop();
        this.rws = null;
        if (this.flushTimer) clearInterval(this.flushTimer);
      }
    };
  }
}

export const finnhubSocket = new FinnhubSocket();

/** US equities: real-time trades over WS + /quote for previous close (and as a REST fallback). */
export function finnhubEquityAdapter(): Adapter {
  let unsub: (() => void) | null = null;
  let stopPoll: (() => void) | null = null;
  const eq = SYMBOLS.filter((s) => s.assetClass === 'equity' || s.assetClass === 'etf');
  return {
    id: 'finnhub-equities', stream: 'equities', provider: 'Finnhub (WS trades + REST)', mock: false, delayedMin: config.equityDelayMin, staleAfterMs: 5 * 60_000,
    start(ctx) {
      const refs = new Map<string, number>();
      unsub = finnhubSocket.subscribe(ctx, 'equities', eq.map((s) => ({ symbol: s.symbol, finnhub: s.finnhub! })), (symbol, price, ts) => {
        ctx.hub.pushQuotes([{ symbol, price, ref: refs.get(symbol), ts, source: 'Finnhub', delayedMin: config.equityDelayMin }], 'equities');
      });
      // REST sweep: ~30 calls every 10 min stays far below 60/min.
      stopPoll = poller(async () => {
        for (const s of eq) {
          const q = await fetchJson<{ c: number; pc: number; t: number }>(`${API}/quote?symbol=${s.finnhub}&token=${keys.finnhub}`);
          if (q.pc) refs.set(s.symbol, q.pc);
          if (q.c) ctx.hub.pushQuotes([{ symbol: s.symbol, price: q.c, ref: q.pc, ts: q.t * 1000, source: 'Finnhub', delayedMin: config.equityDelayMin }], 'equities');
          await sleep(1100);
        }
      }, 10 * 60_000, (e) => ctx.log.warn(`[finnhub] quote sweep: ${(e as Error).message}`));
    },
    stop() {
      unsub?.();
      stopPoll?.();
    },
  };
}

interface FinnhubNews { id: number; category: string; datetime: number; headline: string; related: string; source: string; summary: string; url: string }

export function finnhubNewsAdapter(): Adapter {
  let stop: (() => void) | null = null;
  const minIds: Record<string, number> = {};
  return {
    id: 'finnhub-news', stream: 'news', provider: 'Finnhub market news', mock: false, delayedMin: 0, staleAfterMs: 10 * 60_000,
    start(ctx) {
      stop = poller(async () => {
        for (const cat of ['general', 'forex', 'crypto', 'merger']) {
          const rows = await fetchJson<FinnhubNews[]>(`${API}/news?category=${cat}${minIds[cat] ? `&minId=${minIds[cat]}` : ''}&token=${keys.finnhub}`);
          for (const n of rows.sort((a, b) => a.datetime - b.datetime)) {
            minIds[cat] = Math.max(minIds[cat] ?? 0, n.id);
            ctx.emitNews({
              sourceId: `finnhub:${n.source}`.toLowerCase(), source: n.source || 'Finnhub', headline: n.headline, summary: n.summary, url: n.url,
              publishedAt: n.datetime * 1000, tickers: n.related ? n.related.split(',').map((t) => t.trim()) : undefined, category: cat,
            });
          }
          await sleep(500);
        }
        ctx.hub.touch('news');
      }, config.finnhubNewsIntervalSec * 1000, (e) => ctx.log.warn(`[finnhub-news] ${(e as Error).message}`));
    },
    stop() {
      stop?.();
    },
  };
}

export function finnhubEarningsAdapter(): Adapter {
  let stop: (() => void) | null = null;
  return {
    id: 'finnhub-earnings', stream: 'earnings', provider: 'Finnhub earnings calendar', mock: false, delayedMin: 0, staleAfterMs: 24 * 3600_000,
    start(ctx) {
      stop = poller(async () => {
        const d = (o: number) => new Date(Date.now() + o * 86400_000).toISOString().slice(0, 10);
        const res = await fetchJson<{ earningsCalendar: { date: string; epsEstimate: number | null; hour: string; symbol: string }[] }>(
          `${API}/calendar/earnings?from=${d(0)}&to=${d(10)}&token=${keys.finnhub}`,
        );
        const all = res.earningsCalendar ?? [];
        const ours = all.filter((e) => SYMBOL_MAP[e.symbol]);
        const list = (ours.length >= 6 ? ours : [...ours, ...all.filter((e) => !SYMBOL_MAP[e.symbol]).slice(0, 14 - ours.length)]).slice(0, 16);
        const items: EarningsItem[] = list.map((e) => ({
          symbol: e.symbol, name: SYMBOL_MAP[e.symbol]?.name ?? e.symbol, date: Date.parse(`${e.date}T${e.hour === 'amc' ? '20:00' : '12:00'}:00Z`),
          session: (e.hour === 'amc' ? 'amc' : e.hour === 'bmo' ? 'bmo' : 'dmh') as EarningsItem['session'], epsEst: e.epsEstimate, impliedMovePct: null,
        })).sort((a, b) => a.date - b.date);
        ctx.hub.setVol({ earnings: items, earningsSource: 'Finnhub (implied move needs an options provider)' }, 'earnings');
      }, 3 * 3600_000, (e) => ctx.log.warn(`[finnhub-earnings] ${(e as Error).message}`));
    },
    stop() {
      stop?.();
    },
  };
}
