import { SYMBOLS } from '../../../shared/symbols';
import type { Adapter } from '../types';
import { errText, fetchJson, poller } from '../types';
import { ReconnectingWS } from './rws';
import { config, keys } from '../../config';

const eq = SYMBOLS.filter((s) => s.assetClass === 'equity' || s.assetClass === 'etf');

/**
 * Alpaca Market Data, free "Basic" plan: real-time trades from the IEX exchange only
 * (a small share of consolidated volume — prices are real-time but can lag the NBBO in thin names).
 * Previous close + a REST safety net come from the snapshots endpoint every minute.
 */
export function alpacaAdapter(): Adapter {
  let rws: ReconnectingWS | null = null;
  let stopPoll: (() => void) | null = null;
  const refs = new Map<string, number>();
  const feed = process.env.ALPACA_FEED || 'iex';
  const headers = { 'APCA-API-KEY-ID': keys.alpacaKey, 'APCA-API-SECRET-KEY': keys.alpacaSecret };
  const label = `Alpaca ${feed.toUpperCase()}`;
  return {
    id: 'alpaca', stream: 'equities', provider: `${label} (WS)`, mock: false, delayedMin: config.equityDelayMin, staleAfterMs: 5 * 60_000,
    start(ctx) {
      const pending = new Map<string, { p: number; t: number }>();
      rws = new ReconnectingWS({
        url: `wss://stream.data.alpaca.markets/v2/${feed}`, stream: 'equities', name: 'alpaca', ctx, idleTimeoutMs: 120_000,
        onOpen: (ws) => ws.send(JSON.stringify({ action: 'auth', key: keys.alpacaKey, secret: keys.alpacaSecret })),
        onMessage: (raw, ws) => {
          for (const m of JSON.parse(raw) as { T: string; msg?: string; S?: string; p?: number; t?: string; code?: number }[]) {
            if (m.T === 'success' && m.msg === 'authenticated') ws.send(JSON.stringify({ action: 'subscribe', trades: eq.map((s) => s.alpaca) }));
            else if (m.T === 'error') {
              ctx.log.error(`[alpaca] ${m.code} ${m.msg}`);
              ctx.hub.setState('equities', 'down', `Alpaca: ${m.msg}`);
            } else if (m.T === 't' && m.S && m.p) pending.set(m.S, { p: m.p, t: Date.parse(m.t!) });
          }
        },
      });
      rws.start();
      const flush = setInterval(() => {
        if (!pending.size) return;
        ctx.hub.pushQuotes([...pending].map(([symbol, v]) => ({ symbol, price: v.p, ref: refs.get(symbol), ts: v.t, source: label, delayedMin: config.equityDelayMin })), 'equities');
        pending.clear();
      }, 250);
      stopPoll = poller(async () => {
        const res = await fetchJson<Record<string, { latestTrade?: { p: number; t: string }; prevDailyBar?: { c: number } }>>(
          `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${eq.map((s) => s.alpaca).join(',')}&feed=${feed}`, { headers },
        );
        const qs = [];
        for (const [symbol, snap] of Object.entries(res)) {
          if (snap.prevDailyBar?.c) refs.set(symbol, snap.prevDailyBar.c);
          if (snap.latestTrade?.p && !ctx.hub.quotes.get(symbol)) qs.push({ symbol, price: snap.latestTrade.p, ref: refs.get(symbol), ts: Date.parse(snap.latestTrade.t), source: label, delayedMin: config.equityDelayMin });
        }
        if (qs.length) ctx.hub.pushQuotes(qs, 'equities');
      }, 60_000, (e) => {
        ctx.log.warn(`[alpaca] snapshots: ${errText(e)}`);
        ctx.hub.reportError('equities', errText(e));
      });
      const origStop = stopPoll;
      stopPoll = () => {
        origStop();
        clearInterval(flush);
      };
    },
    stop() {
      rws?.stop();
      stopPoll?.();
    },
  };
}
