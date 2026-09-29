import type { EconEvent, FundingRate, TermPoint } from '../../../shared/types';
import { CCY_COUNTRY } from '../../../shared/symbols';
import type { Adapter } from '../types';
import { errText, fetchJson, poller, sleep } from '../types';
import { structureOf } from '../mock/panels';
import { config } from '../../config';

/**
 * Keyless public crypto metrics:
 *  - Fear & Greed: alternative.me (daily index, attribution required — shown in the UI)
 *  - BTC dominance / total market cap: CoinGecko /global (public, low rate limit → 5 min poll)
 *  - Perp funding: OKX public funding-rate endpoint
 * Liquidation feeds need a paid/aggregated provider; the panel shows a "connect a provider" state.
 */
export function publicCryptoMarketAdapter(): Adapter {
  const stops: (() => void)[] = [];
  return {
    id: 'public-crypto-market', stream: 'cryptoMarket', provider: 'alternative.me · CoinGecko · OKX', mock: false, delayedMin: 0, staleAfterMs: 20 * 60_000,
    start(ctx) {
      const warn = (tag: string) => (e: unknown) => {
        ctx.log.warn(`[${tag}] ${errText(e)}`);
        ctx.hub.reportError('cryptoMarket', `${tag}: ${errText(e)}`);
      };
      stops.push(poller(async () => {
        const r = await fetchJson<{ data: { value: string; value_classification: string; timestamp: string }[] }>('https://api.alternative.me/fng/?limit=1');
        const d = r.data?.[0];
        if (d) ctx.hub.setCrypto({ fearGreed: { value: +d.value, label: d.value_classification, source: 'alternative.me Fear & Greed', ts: +d.timestamp * 1000 }, sources: ['alternative.me', 'CoinGecko', 'OKX'], mock: false });
      }, 30 * 60_000, warn('fng')));
      stops.push(poller(async () => {
        const r = await fetchJson<{ data: { market_cap_percentage: { btc: number }; total_market_cap: { usd: number }; market_cap_change_percentage_24h_usd: number } }>('https://api.coingecko.com/api/v3/global');
        ctx.hub.setCrypto({ btcDominance: r.data.market_cap_percentage.btc, totalMcapUsd: r.data.total_market_cap.usd, mcapChange24h: r.data.market_cap_change_percentage_24h_usd });
      }, 5 * 60_000, warn('coingecko')));
      stops.push(poller(async () => {
        const out: FundingRate[] = [];
        for (const s of ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']) {
          const r = await fetchJson<{ data: { fundingRate: string; nextFundingTime?: string; fundingTime?: string }[] }>(`https://www.okx.com/api/v5/public/funding-rate?instId=${s}-USDT-SWAP`);
          const d = r.data?.[0];
          if (d) out.push({ symbol: s, rate: +d.fundingRate, nextFundingTime: d.fundingTime ? +d.fundingTime : d.nextFundingTime ? +d.nextFundingTime : null, venue: 'OKX' });
          await sleep(300);
        }
        if (out.length) ctx.hub.setCrypto({ funding: out, liquidations: [] });
      }, 5 * 60_000, warn('okx')));
    },
    stop() {
      stops.forEach((s) => s());
    },
  };
}

/**
 * Cboe public delayed quotes (15-minute delayed). The implied-vol term structure is built from
 * Cboe's own VIX family (9-day, 30-day, 3-month, 6-month, 1-year) — a free, honest proxy for the
 * VIX futures curve (futures data requires a CFE market-data licence).
 */
export function cboeVolAdapter(): Adapter {
  let stop: (() => void) | null = null;
  const curve: [string, string, number][] = [['9D', '_VIX9D', 9], ['30D', '_VIX', 30], ['3M', '_VIX3M', 91], ['6M', '_VIX6M', 182], ['1Y', '_VIX1Y', 365]];
  return {
    id: 'cboe', stream: 'vol', provider: 'Cboe delayed quotes', mock: false, delayedMin: config.cboeDelayMin, staleAfterMs: 20 * 60_000,
    start(ctx) {
      stop = poller(async () => {
        const pts: TermPoint[] = [];
        for (const [label, sym, days] of curve) {
          try {
            const r = await fetchJson<{ data: { current_price: number; prev_day_close: number; last_trade_time?: string } }>(`https://cdn.cboe.com/api/global/delayed_quotes/quotes/${sym}.json`);
            pts.push({ label, expiry: Date.now() + days * 86400_000, value: r.data.current_price });
            if (sym === '_VIX') {
              ctx.hub.pushQuotes([{ symbol: 'VIX', price: r.data.current_price, ref: r.data.prev_day_close, ts: r.data.last_trade_time ? Date.parse(r.data.last_trade_time) : Date.now(), source: 'Cboe', delayedMin: 15 }]);
            }
          } catch (e) {
            ctx.log.warn(`[cboe] ${sym}: ${errText(e)}`);
          }
          await sleep(300);
        }
        if (!pts.length) throw new Error('no Cboe data');
        const spot = pts.find((p) => p.label === '30D')?.value ?? pts[0].value;
        const rest = pts.filter((p) => p.label !== '9D');
        ctx.hub.setVol({ termStructure: pts, structure: structureOf(spot, rest.slice(0)), termSource: 'Cboe VIX index family', termDelayedMin: 15 });
      }, 5 * 60_000, (e) => {
        ctx.log.warn(`[cboe] ${errText(e)}`);
        ctx.hub.reportError('vol', errText(e));
      });
    },
    stop() {
      stop?.();
    },
  };
}

/**
 * ForexFactory weekly calendar export (nfs.faireconomy.media). Free, no key, but limited to
 * 2 requests / 5 minutes, and it carries forecast + previous only — no "actual" values.
 * We poll every 30 minutes.
 */
export function forexFactoryAdapter(): Adapter {
  let stop: (() => void) | null = null;
  const parseNum = (s?: string) => {
    if (!s) return null;
    const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const unitOf = (s?: string) => (s ? (s.match(/[%KMBT]$/i)?.[0] ?? '').toUpperCase().replace('%', '%') : '');
  return {
    id: 'forexfactory', stream: 'calendar', provider: 'ForexFactory export (no actuals)', mock: false, delayedMin: 0, staleAfterMs: 2 * 3600_000,
    start(ctx) {
      stop = poller(async () => {
        const rows = await fetchJson<{ title: string; country: string; date: string; impact: string; forecast?: string; previous?: string; actual?: string }[]>(
          'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
        );
        const events: EconEvent[] = rows
          .filter((r) => r.impact !== 'Holiday')
          .map((r, i) => ({
            id: `ff-${Date.parse(r.date)}-${i}`, country: CCY_COUNTRY[r.country] ?? r.country.slice(0, 2), currency: r.country, title: r.title,
            time: Date.parse(r.date), importance: r.impact === 'High' ? 3 : r.impact === 'Medium' ? 2 : 1, unit: unitOf(r.forecast ?? r.previous),
            consensus: parseNum(r.forecast), previous: parseNum(r.previous), actual: parseNum(r.actual), lowerIsBetter: /unemploy|jobless|claims/i.test(r.title),
            source: 'ForexFactory',
          }));
        ctx.hub.setCalendar(events);
      }, 30 * 60_000, (e) => {
        ctx.log.warn(`[forexfactory] ${errText(e)}`);
        ctx.hub.reportError('calendar', errText(e));
      });
    },
    stop() {
      stop?.();
    },
  };
}
