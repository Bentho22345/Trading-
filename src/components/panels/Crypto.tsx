'use client';
import { memo } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '@/lib/store';
import { useFlash, useQuote, useNow, useCalm } from '@/lib/hooks';
import { fmtCompact, fmtPct, fmtPrice, timeAgo } from '@/lib/format';
import { Odometer } from '../Odometer';
import { Sparkline } from '../charts';
import { Panel, SkeletonRows, StreamBadge, SourceStamp, EmptyState } from '../ui';

const MAJORS = ['BTC', 'ETH', 'SOL', 'XRP'];
const MINORS = ['BNB', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC', 'DOT', 'USDC'];

const CoinCard = memo(function CoinCard({ symbol }: { symbol: string }) {
  const q = useQuote(symbol);
  const meta = useStore((s) => s.symbols[symbol]);
  const spark = useStore((s) => s.sparks[symbol]);
  const ref = useFlash<HTMLButtonElement>(q?.price);
  if (!q || !meta) return <div className="skeleton h-[74px]" />;
  const up = q.changePct >= 0;
  return (
    <button ref={ref} onClick={() => useStore.getState().set({ drawerSymbol: symbol })} className="card-hover rounded-lg border border-line bg-bg-2/50 p-2 text-left">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold text-text">{symbol}</span>
        <span className={`num text-[10px] ${up ? 'text-up' : 'text-down'}`}>{fmtPct(q.changePct)}</span>
      </div>
      <Odometer value={fmtPrice(q.price, meta.decimals)} className="text-[13px] font-semibold text-text" />
      <div className="mt-1 -mx-1"><Sparkline data={spark?.length ? [...spark.slice(0, -1), q.price] : [q.price]} up={up} height={24} /></div>
    </button>
  );
});

const CoinRow = memo(function CoinRow({ symbol }: { symbol: string }) {
  const q = useQuote(symbol);
  const meta = useStore((s) => s.symbols[symbol]);
  const ref = useFlash<HTMLButtonElement>(q?.price);
  if (!q || !meta) return null;
  return (
    <button ref={ref} onClick={() => useStore.getState().set({ drawerSymbol: symbol })} className="flex items-center justify-between rounded px-1 py-0.5 text-[11px] hover:bg-panel-hover">
      <span className="font-medium text-dim">{symbol}</span>
      <span className="num text-text">{fmtPrice(q.price, meta.decimals)}</span>
      <span className={`num w-14 text-right ${q.changePct >= 0 ? 'text-up' : 'text-down'}`}>{fmtPct(q.changePct)}</span>
    </button>
  );
});

function Gauge({ value, label }: { value: number; label: string }) {
  const calm = useCalm();
  const angle = -90 + (value / 100) * 180;
  const color = value < 25 ? 'var(--down)' : value < 45 ? 'var(--warn)' : value <= 55 ? 'var(--text-dim)' : value < 75 ? 'var(--up)' : 'var(--up)';
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 100 58" className="w-full max-w-[140px]" aria-label={`Fear and greed ${value}: ${label}`}>
        <defs>
          <linearGradient id="fg" x1="0" x2="1">
            <stop offset="0" stopColor="var(--down)" />
            <stop offset="0.5" stopColor="var(--warn)" />
            <stop offset="1" stopColor="var(--up)" />
          </linearGradient>
        </defs>
        <path d="M8 52 A42 42 0 0 1 92 52" fill="none" stroke="url(#fg)" strokeWidth="7" strokeLinecap="round" opacity="0.85" />
        <motion.g initial={false} animate={{ rotate: angle }} transition={calm ? { duration: 0 } : { type: 'spring', stiffness: 60, damping: 12 }} style={{ originX: '50px', originY: '52px' }}>
          <line x1="50" y1="52" x2="50" y2="18" stroke="var(--text)" strokeWidth="2" strokeLinecap="round" />
        </motion.g>
        <circle cx="50" cy="52" r="3.5" fill="var(--text)" />
      </svg>
      <div className="num -mt-1 text-lg font-semibold" style={{ color }}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-faint">{label}</div>
    </div>
  );
}

export function CryptoPanel() {
  const m = useStore((s) => s.crypto);
  const hydrated = useStore((s) => s.hydrated);
  const cryptoStatus = useStore((s) => s.statuses.find((x) => x.id === 'crypto'));
  const now = useNow(1000);
  return (
    <Panel title="Crypto" accent="var(--crypto)" right={<StreamBadge id="crypto" />}>
      <div className="grid grid-cols-2 gap-2">{MAJORS.map((s) => <CoinCard key={s} symbol={s} />)}</div>
      <div className="mt-2 grid grid-cols-1 gap-x-3 sm:grid-cols-2">{MINORS.map((s) => <CoinRow key={s} symbol={s} />)}</div>
      <SourceStamp className="mt-1" source={cryptoStatus?.provider ?? 'Crypto'} ts={cryptoStatus?.lastUpdate} mock={cryptoStatus?.mock} delayedMin={cryptoStatus?.delayedMin} />

      <div className="mt-3 border-t border-line pt-3">
        {!hydrated || !m ? (
          <SkeletonRows n={3} />
        ) : (
          <>
            <div className="grid grid-cols-[1fr_1fr] items-center gap-3">
              <div className="space-y-2 text-[11px]">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-faint">BTC dominance</div>
                  <div className="num text-base font-semibold text-text">{m.btcDominance !== null ? `${m.btcDominance.toFixed(2)}%` : '—'}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-faint">Total market cap</div>
                  <div className="num text-sm font-semibold text-text">
                    {fmtCompact(m.totalMcapUsd, '$')}{' '}
                    {m.mcapChange24h !== null ? <span className={m.mcapChange24h >= 0 ? 'text-up' : 'text-down'}>{fmtPct(m.mcapChange24h)}</span> : null}
                  </div>
                </div>
              </div>
              {m.fearGreed ? (
                <div title={`${m.fearGreed.source} · updated ${new Date(m.fearGreed.ts).toLocaleString()}`}>
                  <Gauge value={m.fearGreed.value} label={m.fearGreed.label} />
                  <div className="mt-0.5 text-center text-[9px] text-faint">{m.fearGreed.source}</div>
                </div>
              ) : <div className="text-[10px] text-faint">Sentiment gauge unavailable</div>}
            </div>

            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-faint">
                <span>Perp funding (8h)</span>
                <StreamBadge id="cryptoMarket" />
              </div>
              <div className="grid grid-cols-5 gap-1">
                {m.funding.map((f) => (
                  <div key={f.symbol} className="rounded-md border border-line bg-bg-2/50 px-1 py-1 text-center" title={`${f.venue}${f.nextFundingTime ? ` · next ${new Date(f.nextFundingTime).toLocaleTimeString()}` : ''}`}>
                    <div className="text-[10px] font-semibold text-dim">{f.symbol}</div>
                    <div className={`num text-[11px] ${f.rate >= 0 ? 'text-up' : 'text-down'}`}>{(f.rate * 100).toFixed(4)}%</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-3">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-faint">Liquidations</div>
              {m.liquidations.length ? (
                <ul className="max-h-28 space-y-0.5 overflow-y-auto">
                  {m.liquidations.slice(0, 8).map((l) => (
                    <li key={l.id} className="flex items-center gap-2 text-[11px]">
                      <span className="num w-7 text-faint">{timeAgo(l.ts, now)}</span>
                      <span className={`rounded px-1 text-[9px] font-bold uppercase ${l.side === 'long' ? 'bg-down/15 text-down' : 'bg-up/15 text-up'}`}>{l.side}s</span>
                      <span className="truncate text-dim">{l.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="Connect a liquidation provider" body="No free liquidation feed is wired up. Add an adapter (e.g. an aggregated derivatives API) to populate this list." />
              )}
            </div>
            <SourceStamp className="mt-2" source={m.sources.join(' · ')} ts={m.ts} mock={m.mock} />
          </>
        )}
      </div>
    </Panel>
  );
}
