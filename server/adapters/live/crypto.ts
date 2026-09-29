import { SYMBOLS } from '../../../shared/symbols';
import type { HistoryPoint } from '../../../shared/types';
import type { Adapter, AdapterContext } from '../types';
import { fetchJson } from '../types';
import { ReconnectingWS } from './rws';

const coins = SYMBOLS.filter((s) => s.assetClass === 'crypto');

/**
 * Coinbase Exchange public WebSocket (wss://ws-feed.exchange.coinbase.com), "ticker" channel.
 * Public, no key, real-time. open_24h gives a 24h reference price. Also backfills 5h of
 * 1-minute candles from the public REST API so charts and % move alerts work immediately.
 */
export function coinbaseAdapter(): Adapter {
  let rws: ReconnectingWS | null = null;
  const bySymbol = new Map(coins.filter((c) => c.coinbase).map((c) => [c.coinbase!, c.symbol]));
  // USDC-USD isn't a Coinbase product (USDC is their USD); price it at the peg via USDT-USDC inverse
  bySymbol.delete('USDC-USD');
  return {
    id: 'coinbase', stream: 'crypto', provider: 'Coinbase Exchange (WS)', mock: false, delayedMin: 0, staleAfterMs: 30_000,
    async start(ctx: AdapterContext) {
      rws = new ReconnectingWS({
        url: 'wss://ws-feed.exchange.coinbase.com', stream: 'crypto', name: 'coinbase', ctx, idleTimeoutMs: 45_000,
        onOpen: (ws) => ws.send(JSON.stringify({ type: 'subscribe', product_ids: [...bySymbol.keys(), 'USDT-USDC'], channels: ['ticker', 'heartbeat'] })),
        onMessage: (raw) => {
          const m = JSON.parse(raw);
          if (m.type !== 'ticker') return;
          if (m.product_id === 'USDT-USDC') {
            ctx.hub.pushQuotes([{ symbol: 'USDC', price: 1 / Number(m.price), ref: 1 / Number(m.open_24h), ts: Date.parse(m.time), source: 'Coinbase' }], 'crypto');
            return;
          }
          const symbol = bySymbol.get(m.product_id);
          if (!symbol) return;
          ctx.hub.pushQuotes([{
            symbol, price: Number(m.price), ref: Number(m.open_24h), bid: Number(m.best_bid), ask: Number(m.best_ask),
            volume: Number(m.volume_24h), ts: Date.parse(m.time), source: 'Coinbase',
          }], 'crypto');
        },
      });
      rws.start();
      // backfill (sequential, gentle on the public REST limits)
      for (const [pid, symbol] of bySymbol) {
        try {
          const rows = await fetchJson<number[][]>(`https://api.exchange.coinbase.com/products/${pid}/candles?granularity=60`);
          const pts: HistoryPoint[] = rows.map((r) => ({ t: r[0] * 1000, c: r[4] })).sort((a, b) => a.t - b.t);
          ctx.hub.seedHistory(symbol, pts);
        } catch (e) {
          ctx.log.warn(`[coinbase] backfill ${pid} failed: ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    stop() {
      rws?.stop();
    },
  };
}

/**
 * Binance combined-stream 24h tickers. `binance` = binance.com (geo-blocked in the US),
 * `binanceus` = Binance.US. Public, no key, real-time.
 */
export function binanceAdapter(us: boolean): Adapter {
  let rws: ReconnectingWS | null = null;
  const quote = us ? 'USD' : 'USDT';
  const pairs = coins.filter((c) => c.symbol !== 'USDC' || !us).map((c) => ({ sym: c.symbol, pair: c.symbol === 'USDC' ? 'USDCUSDT' : `${c.symbol}${quote}` }));
  const map = new Map(pairs.map((p) => [p.pair, p.sym]));
  const host = us ? 'wss://stream.binance.us:9443' : 'wss://stream.binance.com:9443';
  const label = us ? 'Binance.US' : 'Binance';
  return {
    id: us ? 'binanceus' : 'binance', stream: 'crypto', provider: `${label} (WS)`, mock: false, delayedMin: 0, staleAfterMs: 30_000,
    start(ctx) {
      rws = new ReconnectingWS({
        url: `${host}/stream?streams=${pairs.map((p) => `${p.pair.toLowerCase()}@ticker`).join('/')}`,
        stream: 'crypto', name: label, ctx, idleTimeoutMs: 45_000,
        onOpen: () => {},
        onMessage: (raw) => {
          const { data: d } = JSON.parse(raw);
          const symbol = d && map.get(d.s);
          if (!symbol) return;
          ctx.hub.pushQuotes([{ symbol, price: +d.c, ref: +d.o, bid: +d.b, ask: +d.a, volume: +d.v, ts: d.E, source: label }], 'crypto');
        },
      });
      rws.start();
    },
    stop() {
      rws?.stop();
    },
  };
}
