import type { UnusualOption } from '../../../shared/types';
import type { Adapter } from '../types';
import { errText, fetchJson, poller, sleep } from '../types';
import { hub } from '../../hub';

/**
 * Real options analytics from Cboe's public delayed option chains (15-minute delayed, no key):
 *  - put/call volume ratios: index (SPY, QQQ, IWM) and an equity basket
 *  - unusual activity: contracts trading far above open interest with large premium
 *  - earnings implied move: nearest-expiry ATM straddle ÷ spot for upcoming reporters
 */
interface CboeOption { option: string; bid?: number; ask?: number; last_trade_price?: number; volume?: number; open_interest?: number }
interface Chain { data?: { current_price?: number; close?: number; options?: CboeOption[] } }

const OCC = /^([A-Z.]+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const INDEX = ['SPY', 'QQQ', 'IWM'];
const EQUITY = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'TSLA', 'AMD', 'GOOGL', 'NFLX', 'JPM', 'PLTR', 'COIN'];

function parse(o: CboeOption) {
  const m = OCC.exec(o.option);
  if (!m) return null;
  const [, , yy, mm, dd, cp, k] = m;
  const mid = o.bid && o.ask ? (o.bid + o.ask) / 2 : o.last_trade_price ?? 0;
  return { expiry: `20${yy}-${mm}-${dd}`, type: cp === 'C' ? 'call' as const : 'put' as const, strike: Number(k) / 1000, mid, vol: o.volume ?? 0, oi: o.open_interest ?? 0, bid: o.bid ?? 0, ask: o.ask ?? 0, last: o.last_trade_price ?? 0 };
}

async function chain(sym: string) {
  const r = await fetchJson<Chain>(`https://cdn.cboe.com/api/global/delayed_quotes/options/${sym}.json`, { timeoutMs: 20_000 });
  const spot = r.data?.current_price ?? r.data?.close ?? 0;
  const opts = (r.data?.options ?? []).map(parse).filter((x): x is NonNullable<ReturnType<typeof parse>> => !!x);
  return { spot, opts };
}

export function cboeOptionsAdapter(): Adapter {
  let stop: (() => void) | null = null;
  return {
    id: 'cboe-options', stream: 'options', provider: 'Cboe delayed option chains', mock: false, delayedMin: 15, staleAfterMs: 40 * 60_000,
    start(ctx) {
      stop = poller(async () => {
        const vol = { index: { c: 0, p: 0 }, equity: { c: 0, p: 0 } };
        const unusual: UnusualOption[] = [];
        const implied: Record<string, number> = {};
        const earningsSoon = new Set((hub.vol?.earnings ?? []).filter((e) => e.date - Date.now() < 10 * 86400_000).map((e) => e.symbol));
        let ok = 0;
        for (const sym of [...INDEX, ...EQUITY, ...[...earningsSoon].filter((s) => !INDEX.includes(s) && !EQUITY.includes(s)).slice(0, 6)]) {
          try {
            const { spot, opts } = await chain(sym);
            if (!opts.length) continue;
            ok++;
            const bucket = INDEX.includes(sym) ? vol.index : EQUITY.includes(sym) ? vol.equity : null;
            for (const o of opts) {
              if (bucket) o.type === 'call' ? (bucket.c += o.vol) : (bucket.p += o.vol);
              const premium = o.vol * (o.mid || o.last) * 100;
              if (o.vol >= 1000 && o.vol > 2 * Math.max(1, o.oi) && premium >= 500_000) {
                const side = o.last && o.ask && o.last >= o.ask ? 'ask' : o.last && o.bid && o.last <= o.bid ? 'bid' : 'mid';
                unusual.push({ id: `${sym}-${o.expiry}-${o.type}-${o.strike}`, symbol: sym, type: o.type, strike: o.strike, expiry: o.expiry, premiumUsd: Math.round(premium), volOi: +(o.vol / Math.max(1, o.oi)).toFixed(1), side, ts: Date.now() });
              }
            }
            if (earningsSoon.has(sym) && spot > 0) {
              // nearest expiry on/after the earnings date, ATM straddle
              const e = hub.vol?.earnings.find((x) => x.symbol === sym);
              const after = new Date((e?.date ?? Date.now()) - 86400_000).toISOString().slice(0, 10);
              const expiries = [...new Set(opts.map((o) => o.expiry))].filter((x) => x >= after).sort();
              const exp = expiries[0];
              if (exp) {
                const atExp = opts.filter((o) => o.expiry === exp);
                const k = atExp.reduce((best, o) => (Math.abs(o.strike - spot) < Math.abs(best - spot) ? o.strike : best), atExp[0].strike);
                const c = atExp.find((o) => o.strike === k && o.type === 'call')?.mid ?? 0;
                const p = atExp.find((o) => o.strike === k && o.type === 'put')?.mid ?? 0;
                if (c > 0 && p > 0) implied[sym] = +(((c + p) / spot) * 100).toFixed(1);
              }
            }
          } catch (e) {
            ctx.log.warn(`[cboe-options] ${sym}: ${errText(e)}`);
          }
          await sleep(800);
        }
        if (!ok) throw new Error('no option chains from Cboe');
        const r = (b: { c: number; p: number }) => (b.c ? +(b.p / b.c).toFixed(2) : 0);
        const tot = { c: vol.index.c + vol.equity.c, p: vol.index.p + vol.equity.p };
        const earnings = (hub.vol?.earnings ?? []).map((e) => (implied[e.symbol] !== undefined ? { ...e, impliedMovePct: implied[e.symbol] } : e));
        ctx.hub.setVol({
          putCall: { equity: r(vol.equity), index: r(vol.index), total: r(tot), ts: Date.now(), source: 'Cboe chains (SPY/QQQ/IWM; 12-stock basket)' },
          putCallConnected: true,
          unusual: unusual.sort((a, b) => b.premiumUsd - a.premiumUsd).slice(0, 20),
          unusualConnected: true,
          unusualSource: 'Cboe chains · volume > 2× OI, premium ≥ $0.5M',
          earnings,
        }, 'options');
      }, 15 * 60_000, (e) => {
        ctx.log.warn(`[cboe-options] ${errText(e)}`);
        ctx.hub.reportError('options', errText(e));
      });
    },
    stop() {
      stop?.();
    },
  };
}
