'use client';
import { useEffect, useMemo, useState } from 'react';
import type { HistoryPoint } from '@shared/types';
import { useStore } from '@/lib/store';
import { useQuote, useNow } from '@/lib/hooks';
import { fmtChange, fmtPct, fmtPrice, pairLabel, timeAgo, DOMAIN_LABEL, primaryDomain } from '@/lib/format';
import { Overlay } from './Overlay';
import { PriceChart } from './charts';
import { Odometer } from './Odometer';
import { Icon, Segmented, DelayChip, DemoChip, IconButton } from './ui';

const RANGES = { '1h': 60, '4h': 240, '1d': 1440 } as const;

export function TickerDrawer() {
  const symbol = useStore((s) => s.drawerSymbol);
  const set = useStore((s) => s.set);
  return (
    <Overlay open={!!symbol} onClose={() => set({ drawerSymbol: null })} side="right" label={`${symbol ?? ''} detail`}>
      {symbol ? <DrawerBody symbol={symbol} /> : null}
    </Overlay>
  );
}

function DrawerBody({ symbol }: { symbol: string }) {
  const meta = useStore((s) => s.symbols[symbol]);
  const q = useQuote(symbol);
  const clusters = useStore((s) => s.clusters);
  const watch = useStore((s) => s.watchlist);
  const set = useStore((s) => s.set);
  const [range, setRange] = useState<keyof typeof RANGES>('4h');
  const [points, setPoints] = useState<HistoryPoint[] | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    let alive = true;
    setPoints(null);
    fetch(`/api/history/${symbol}?minutes=${RANGES[range]}`)
      .then((r) => r.json())
      .then((d: HistoryPoint[]) => alive && setPoints(Array.isArray(d) ? d : []))
      .catch(() => alive && setPoints([]));
    return () => {
      alive = false;
    };
  }, [symbol, range]);

  const related = useMemo(() => {
    const ccys = meta?.assetClass === 'fx' ? [symbol.slice(0, 3), symbol.slice(3)] : [];
    return clusters.filter((c) => c.tickers.includes(symbol) || c.currencies.includes(symbol) || (ccys.length && ccys.every((x) => c.currencies.includes(x)))).slice(0, 30);
  }, [clusters, symbol, meta]);

  const stats = useMemo(() => {
    if (!points?.length) return null;
    const vals = points.map((p) => p.c);
    return { hi: Math.max(...vals, q?.price ?? -Infinity), lo: Math.min(...vals, q?.price ?? Infinity) };
  }, [points, q?.price]);

  if (!meta) return <div className="p-6 text-sm text-faint">Unknown symbol {symbol}</div>;
  const d = meta.decimals;
  const up = (q?.change ?? 0) >= 0;
  const inWatch = watch.some((w) => w.value === symbol);

  const addWatch = async () => {
    const kind = meta.assetClass === 'fx' ? 'pair' : meta.assetClass === 'crypto' ? 'coin' : 'ticker';
    const res = await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, value: symbol }) });
    if (res.ok) set({ watchlist: await res.json() });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-text">{pairLabel(symbol, meta.assetClass)}</h2>
            <span className="rounded border border-line px-1.5 text-[10px] uppercase text-faint">{meta.assetClass}</span>
            {q?.mock ? <DemoChip /> : null}
            {q ? <DelayChip min={q.delayedMin} /> : null}
          </div>
          <div className="text-xs text-faint">{meta.name}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <IconButton label={inWatch ? 'In watchlist' : 'Add to watchlist'} active={inWatch} onClick={inWatch ? undefined : addWatch}><Icon name={inWatch ? 'eye' : 'plus'} size={13} /></IconButton>
          <IconButton label="Close" onClick={() => set({ drawerSymbol: null })}><Icon name="x" size={14} /></IconButton>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {q ? (
          <div className="flex items-baseline gap-3">
            <Odometer value={fmtPrice(q.price, d)} className="text-3xl font-semibold text-text" />
            <span className={`num text-sm ${up ? 'text-up' : 'text-down'}`}>{fmtChange(q.change, d)} ({fmtPct(q.changePct)})</span>
          </div>
        ) : <div className="skeleton h-9 w-48" />}
        <div className="mt-1 text-[11px] text-faint">{q ? <>{q.source} · updated <span className="num">{timeAgo(q.receivedAt, now)}</span> ago · change vs {meta.assetClass === 'equity' || meta.assetClass === 'etf' ? 'previous close' : '24h ago'}</> : 'Waiting for data…'}</div>

        <div className="mt-4 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-faint">Live chart · 1m</span>
          <Segmented label="Chart range" value={range} onChange={setRange} options={[{ value: '1h', label: '1H' }, { value: '4h', label: '4H' }, { value: '1d', label: '1D' }]} />
        </div>
        <div className="mt-2 rounded-lg border border-line bg-bg-2/40 p-1">
          {points === null ? <div className="skeleton h-[220px]" /> : points.length < 2 ? <div className="flex h-[220px] items-center justify-center text-xs text-faint">Collecting history…</div> : (
            <PriceChart points={points} live={q ? { t: q.ts, c: q.price } : undefined} up={up} height={220} decimals={d} />
          )}
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-2 text-[11px]">
          {[
            ['Last', fmtPrice(q?.price, d)],
            [meta.assetClass === 'equity' || meta.assetClass === 'etf' ? 'Prev close' : '24h ref', fmtPrice(q?.ref, d)],
            ['Change', q ? fmtPct(q.changePct) : '—'],
            [`${range} high`, fmtPrice(stats?.hi, d)],
            [`${range} low`, fmtPrice(stats?.lo, d)],
            ['Bid / Ask', q?.bid && q?.ask ? `${fmtPrice(q.bid, d)} / ${fmtPrice(q.ask, d)}` : '—'],
          ].map(([k, v]) => (
            <div key={k} className="rounded-md border border-line bg-bg-2/40 px-2 py-1.5">
              <dt className="text-[9px] uppercase tracking-wider text-faint">{k}</dt>
              <dd className="num mt-0.5 truncate text-text">{v}</dd>
            </div>
          ))}
        </dl>

        <h3 className="mb-2 mt-5 text-[10px] font-semibold uppercase tracking-wider text-faint">Related news ({related.length})</h3>
        {related.length ? (
          <ul className="space-y-1.5">
            {related.map((c) => (
              <li key={c.id} className={`d-${primaryDomain(c.domains)} rounded-lg border border-line bg-bg-2/40 px-3 py-2`}>
                <div className="mb-0.5 flex items-center gap-2 text-[10px] text-faint">
                  <span style={{ color: 'var(--d)' }} className="font-semibold uppercase">{DOMAIN_LABEL[primaryDomain(c.domains)]}</span>
                  <span className="num">{timeAgo(c.publishedAt, now)}</span>
                  <span>{c.source}</span>
                  {c.articles.length > 1 ? <span>+{c.articles.length - 1}</span> : null}
                  <span className="num ml-auto">impact {c.impact}</span>
                </div>
                <button onClick={() => set({ timelineId: c.id })} className="text-left text-[13px] leading-snug text-text hover:underline">{c.headline}</button>
              </li>
            ))}
          </ul>
        ) : <div className="text-xs text-faint">No related stories in the current window.</div>}
      </div>
    </div>
  );
}
