'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { pct, pctClass, usd } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';
import { AnimatedNumber, Flash } from './motion';
import { AsOf, Dot } from './ui';

type Mkt = Record<string, any>;

export function MarketBar() {
  const [m, setM] = useState<Mkt>({});
  const [health, setHealth] = useState<any[]>([]);
  const now = useNow();
  useEffect(() => {
    api('/api/market').then(setM).catch(() => {});
    const load = () => api('/api/health').then((h) => setHealth(h.adapters)).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  useLive((msg) => {
    if (msg.ch === 'tick') setM((p) => ({ ...p, [`px_${msg.data.symbol}`]: { ...msg.data, value: msg.data.price } }));
    if (msg.ch === 'market') setM((p) => ({ ...p, [msg.data.key]: { ...msg.data, value: msg.data.value ?? p[msg.data.key]?.value } }));
  });
  const fg = m.fear_greed;
  const dex = m.sol_dex_volume;
  const meme = m.meme_category;
  return (
    <div className="glass mb-3 flex flex-wrap items-center gap-x-6 gap-y-1.5 rounded-2xl px-4 py-2.5 num">
      {['BTC', 'ETH', 'SOL'].map((s) => {
        const t = m[`px_${s}`];
        return (
          <span key={s} className="flex items-baseline gap-1.5" title={t ? `coinbase · ${new Date(t.as_of * 1000).toLocaleTimeString()}` : 'waiting for Coinbase'}>
            <b className="text-mute">{s}</b>
            <Flash value={t?.value}><AnimatedNumber value={t?.value} format={(v) => `$${v.toLocaleString(undefined, { maximumFractionDigits: s === 'SOL' ? 2 : 0, minimumFractionDigits: s === 'SOL' ? 2 : 0 })}`} className="text-[14px] font-semibold" /></Flash>
            <span className={pctClass(t?.chg_24h)}>{pct(t?.chg_24h)}</span>
          </span>
        );
      })}
      <span className="flex items-baseline gap-1.5" title="alternative.me Fear & Greed">
        <b className="text-mute">F&G</b>
        <span className={fg ? (fg.value >= 60 ? 'text-up' : fg.value <= 40 ? 'text-down' : '') : ''}>{fg ? `${fg.value} ${fg.label}` : '—'}</span>
      </span>
      <span className="flex items-baseline gap-1.5" title="DeFiLlama Solana DEX volume 24h">
        <b className="text-mute">SOL DEX 24h</b><span>{usd(dex?.total24h)}</span><span className={pctClass(dex?.change_1d)}>{pct(dex?.change_1d)}</span>
      </span>
      <span className="flex items-baseline gap-1.5" title="CoinGecko meme category market cap">
        <b className="text-mute">MEMES</b><span>{usd(meme?.market_cap)}</span><span className={pctClass(meme?.chg_24h)}>{pct(meme?.chg_24h)}</span>
      </span>
      <Link href="/health" className="ml-auto flex items-center gap-1" title="Adapter health">
        <span className="hidden items-center gap-1 md:flex">{health.map((h) => <span key={h.name} title={`${h.name}: ${h.status}`}><Dot status={h.status} /></span>)}</span>
        <span className="ml-1 text-mute">{health.filter((h) => h.status === 'ok').length}/{health.length} sources</span>
      </Link>
      {m.px_SOL && <span className="text-[10px]"><AsOf ts={m.px_SOL.as_of} now={now} staleAfter={30} /></span>}
    </div>
  );
}
