'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { pct, pctClass, usd } from '@/lib/format';
import { useLive, useNow, usePoll } from '@/lib/live';
import { AnimatedNumber, Flash } from './motion';
import { AsOf, Dot } from './ui';

type Mkt = Record<string, any>;

export function MarketBar() {
  const [m, setM] = useState<Mkt>({});
  const [health, setHealth] = useState<any[]>([]);
  const now = useNow();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { api('/api/market').then(setM).catch(() => {}).finally(() => setLoaded(true)); }, []);
  usePoll(() => api('/api/health').then((h) => setHealth(h.adapters)).catch(() => {}), 10000);
  useLive((msg) => {
    if (msg.ch === 'tick') setM((p) => ({ ...p, [`px_${msg.data.symbol}`]: { ...msg.data, value: msg.data.price } }));
    if (msg.ch === 'market') setM((p) => ({ ...p, [msg.data.key]: { ...msg.data, value: msg.data.value ?? p[msg.data.key]?.value } }));
  });
  const fg = m.fear_greed;
  const dex = m.sol_dex_volume;
  const meme = m.meme_category;
  const okCount = health.filter((h) => h.status === 'ok').length;
  return (
    <div className="glass mb-3 flex items-stretch overflow-hidden rounded-2xl num">
      <div className="scroll-x fade-x flex min-w-0 flex-1 items-stretch md:[mask-image:none]">
        {['BTC', 'ETH', 'SOL'].map((s) => {
          const t = m[`px_${s}`];
          return (
            <Stat key={s} loaded={loaded} label={s} title={t ? `coinbase · ${new Date(t.as_of * 1000).toLocaleTimeString()}` : 'waiting for Coinbase'}
              value={t?.value != null && <Flash value={t.value}><AnimatedNumber value={t.value} format={(v) => `$${v.toLocaleString(undefined, { maximumFractionDigits: s === 'SOL' ? 2 : 0, minimumFractionDigits: s === 'SOL' ? 2 : 0 })}`} /></Flash>}
              delta={t?.chg_24h} />
          );
        })}
        <Stat loaded={loaded} label="Fear & Greed" title="alternative.me Fear & Greed"
          value={fg && <span className={fg.value >= 60 ? 'text-up' : fg.value <= 40 ? 'text-down' : ''}>{fg.value}<span className="ml-1 font-sans text-[11px] font-normal text-mute">{fg.label}</span></span>} />
        <Stat loaded={loaded} label="SOL DEX 24h" title="DeFiLlama Solana DEX volume 24h" value={dex?.total24h != null && usd(dex.total24h)} delta={dex?.change_1d} />
        <Stat loaded={loaded} label="Meme mcap" title="CoinGecko meme category market cap" value={meme?.market_cap != null && usd(meme.market_cap)} delta={meme?.chg_24h} />
      </div>
      <Link href="/health" className="hidden shrink-0 flex-col justify-center gap-1 border-l border-white/[0.06] px-4 py-2 transition-colors hover:bg-white/[0.02] md:flex" title="Adapter health">
        <span className="eyebrow">Sources {m.px_SOL && <span className="ml-1 normal-case tracking-normal"><AsOf ts={m.px_SOL.as_of} now={now} staleAfter={30} /></span>}</span>
        <span className="flex items-center gap-2">
          <span className="flex flex-wrap items-center gap-[3px]">{health.map((h) => <span key={h.name} title={`${h.name}: ${h.status}`}><Dot status={h.status} /></span>)}</span>
          <span className="text-[12px]"><b className={okCount ? 'text-fg' : 'text-mute'}>{okCount}</b><span className="text-mute">/{health.length}</span></span>
        </span>
      </Link>
    </div>
  );
}

function Stat({ label, value, delta, title, loaded }: { loaded: boolean; label: string; value: React.ReactNode; delta?: number | null; title?: string }) {
  return (
    <span className="flex shrink-0 flex-col justify-center gap-0.5 border-r border-white/[0.05] px-4 py-2 last:border-r-0" title={title}>
      <span className="eyebrow font-sans">{label}</span>
      <span className="flex items-baseline gap-1.5 whitespace-nowrap">
        {value ? <span className="text-[14px] font-semibold text-fg">{value}</span> : loaded ? <span className="text-[14px] text-mute">—</span> : <span className="skeleton my-0.5 inline-block h-4 w-16" />}
        {delta != null && <span className={`text-[11px] ${pctClass(delta)}`}>{pct(delta)}</span>}
      </span>
    </span>
  );
}
