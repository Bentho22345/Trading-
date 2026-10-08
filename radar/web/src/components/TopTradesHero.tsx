'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { ago, short, usd } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';
import { getTopFlash, onTopFlash, setTopFlash, type TopFlashPrefs } from '@/lib/topflash';
import { Icon } from './Icon';
import { AnimatePresence, motion } from './motion';
import { TokenIcon } from './ui';

/** Dashboard hero: every trade by the followed top-1000 wallets, live, plus what they're piling into this hour. */
export function TopTradesHero() {
  const now = useNow(1000);
  const [trades, setTrades] = useState<any[]>([]);
  const [prefs, setPrefs] = useState<TopFlashPrefs>({ on: true, minSol: 0, side: 'all', sound: true });
  useEffect(() => { setPrefs(getTopFlash()); return onTopFlash(() => setPrefs(getTopFlash())); }, []);
  useEffect(() => {
    const load = () => api('/api/top-trades?limit=120').then(setTrades).catch(() => {});
    load(); const t = setInterval(load, 60000); return () => clearInterval(t);
  }, []);
  useLive(({ ch, data }) => {
    if (ch === 'top_trade') setTrades((p) => (p.some((x) => x.signature === data.signature) ? p : [data, ...p].slice(0, 200)));
  });
  const hour = useMemo(() => trades.filter((t) => t.ts > now - 3600), [trades, now]);
  const hot = useMemo(() => {
    const m: Record<string, { mint: string; symbol?: string; image?: string; buyers: Set<string>; sellers: Set<string>; sol: number }> = {};
    for (const t of hour) {
      const x = (m[t.mint] ||= { mint: t.mint, symbol: t.symbol, image: t.image, buyers: new Set(), sellers: new Set(), sol: 0 });
      (t.side === 'buy' ? x.buyers : x.sellers).add(t.wallet);
      x.sol += (t.side === 'buy' ? 1 : -1) * (+t.sol || 0);
    }
    return Object.values(m).sort((a, b) => b.buyers.size - a.buyers.size || b.sol - a.sol).slice(0, 5);
  }, [hour]);
  const buys = hour.filter((t) => t.side === 'buy').length;
  const net = hour.reduce((s, t) => s + (t.side === 'buy' ? 1 : -1) * (+t.sol || 0), 0);
  const save = (p: Partial<TopFlashPrefs>) => setTopFlash({ ...prefs, ...p });

  return (
    <section className="glass mb-3 overflow-hidden rounded-2xl">
      <header className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
        <Icon name="wallet" size={15} className="text-warn" />
        <h2 className="text-[12px] font-semibold">Top wallet trades</h2>
        <span className="text-[11px] text-mute">every trade by the top 1,000 wallets, live</span>
        <span className="flex-1" />
        <span className="num text-[11px] text-mute">1h: <b className="text-fg">{hour.length}</b> trades · <span className="text-up">{buys} buys</span> / <span className="text-down">{hour.length - buys} sells</span> · net <span className={net >= 0 ? 'text-up' : 'text-down'}>{net >= 0 ? '+' : ''}{net.toFixed(1)} SOL</span></span>
        <button onClick={() => save({ on: !prefs.on })} className={`rounded-lg border px-2 py-0.5 text-[11px] ${prefs.on ? 'border-warn/50 bg-warn/10 text-warn' : 'border-white/10 text-mute'}`}>⚡ Flash {prefs.on ? 'on' : 'off'}</button>
        <select value={prefs.minSol} onChange={(e) => save({ minSol: +e.target.value })} className="rounded-lg border border-white/10 bg-panel2 px-1 py-0.5 text-[11px]" title="Only flash trades at least this big">
          {[0, 0.5, 1, 5, 10].map((v) => <option key={v} value={v}>{v ? `≥ ${v} SOL` : 'any size'}</option>)}
        </select>
        <select value={prefs.side} onChange={(e) => save({ side: e.target.value as TopFlashPrefs['side'] })} className="rounded-lg border border-white/10 bg-panel2 px-1 py-0.5 text-[11px]">
          <option value="all">buys + sells</option><option value="buy">buys only</option><option value="sell">sells only</option>
        </select>
        <button onClick={() => save({ sound: !prefs.sound })} className="text-[11px] text-mute hover:text-fg">{prefs.sound ? '🔔' : '🔕'}</button>
        <Link href="/wallets" className="text-[11px] text-accent">leaderboard →</Link>
      </header>
      <div className="grid gap-0 lg:grid-cols-[260px_1fr]">
        <div className="border-b border-white/5 p-2 lg:border-b-0 lg:border-r">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-mute">Most bought by top wallets · 1h</div>
          {hot.map((h) => (
            <Link key={h.mint} href={`/token?a=${h.mint}`} className="flex items-center gap-2 rounded-lg px-1 py-1 text-[12px] hover:bg-white/[0.04]">
              <TokenIcon src={h.image} symbol={h.symbol} size={20} />
              <b className="flex-1 truncate">{h.symbol || short(h.mint)}</b>
              <span className="num text-up">{h.buyers.size}↑</span><span className="num text-down">{h.sellers.size}↓</span>
            </Link>
          ))}
          {!hot.length && <p className="px-1 py-3 text-[12px] text-mute">No top-wallet trades in the last hour yet.</p>}
        </div>
        <div className="flex items-start gap-2 overflow-x-auto p-2">
          <AnimatePresence initial={false}>
            {trades.slice(0, 40).map((t) => (
              <motion.div key={t.signature} layout initial={{ opacity: 0, scale: 0.9, x: -12 }} animate={{ opacity: 1, scale: 1, x: 0 }}
                className={`w-[188px] shrink-0 rounded-xl border p-2 text-[12px] ${t.side === 'buy' ? 'border-up/30 bg-up/[0.06]' : 'border-down/30 bg-down/[0.06]'}`}>
                <div className="flex items-center gap-1.5">
                  <span className={`rounded px-1 text-[10px] font-bold uppercase ${t.side === 'buy' ? 'bg-up/20 text-up' : 'bg-down/20 text-down'}`}>{t.side}</span>
                  <Link href={`/token?a=${t.mint}`} className="flex min-w-0 flex-1 items-center gap-1 font-semibold hover:text-accent"><TokenIcon src={t.image} symbol={t.symbol} size={16} /><span className="truncate">{t.symbol || short(t.mint)}</span></Link>
                  {t.is_fixture ? <span className="rounded bg-warn/20 px-1 text-[9px] text-warn">TEST</span> : null}
                  <span className="num text-[10px] text-mute">{ago(t.ts, now)}</span>
                </div>
                <div className="num mt-1 flex justify-between"><b>{t.sol != null ? `${(+t.sol).toFixed(2)} SOL` : '—'}</b><span className="text-mute">{usd(t.usd)}</span></div>
                <div className="num mt-0.5 flex justify-between text-[11px] text-mute">
                  <span title={t.wallet}>{t.rank ? <span className="text-warn">#{t.rank}</span> : null} {short(t.wallet, 4)}</span>
                  <span>{t.roi != null ? `${t.roi > 0 ? '+' : ''}${Math.round(t.roi * 100)}% ${t.period}` : ''}</span>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {!trades.length && <p className="p-3 text-[12px] text-mute">Waiting for the first trade. Top wallets are followed once the leaderboard has ranked them (every 5 minutes).</p>}
        </div>
      </div>
    </section>
  );
}
