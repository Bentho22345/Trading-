'use client';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { TickerGroup } from '@shared/types';
import { HEADLINE_FX } from '@shared/symbols';
import { useStore } from '@/lib/store';
import { useSettings } from '@/lib/settings';
import { useFlash, useQuote, usePrefersReducedMotion, useInterval } from '@/lib/hooks';
import { fmtBp, fmtChange, fmtPct, fmtPrice, pairLabel } from '@/lib/format';
import { Odometer } from './Odometer';
import { Icon } from './ui';

type Item = { kind: 'label'; group: TickerGroup; text: string } | { kind: 'sym'; symbol: string; group: TickerGroup };

const GROUP_COLOR: Record<TickerGroup, string> = { EQ: 'var(--eq)', FX: 'var(--fx)', CRYPTO: 'var(--crypto)', MACRO: 'var(--rates)' };

/** Membership is recomputed once a minute (not on every tick) so the strip doesn't reshuffle under the reader. */
function computeItems(groups: TickerGroup[]): Item[] {
  const { quotes, symbols } = useStore.getState();
  const t = useSettings.getState().ticker;
  if (t.mode === 'custom' && t.symbols.length) {
    return t.symbols.filter((s) => quotes[s]).map((s) => ({ kind: 'sym' as const, symbol: s, group: (symbols[s]?.group ?? 'EQ') as TickerGroup }));
  }
  const qs = Object.values(quotes);
  const out: Item[] = [];
  for (const g of groups) {
    if (g === 'EQ') {
      const eq = qs.filter((q) => symbols[q.symbol]?.assetClass === 'equity').sort((a, b) => b.changePct - a.changePct);
      const gainers = eq.slice(0, 6), losers = eq.slice(-6).reverse();
      out.push({ kind: 'label', group: g, text: 'Indices' });
      for (const s of ['SPY', 'QQQ', 'IWM', 'VIX']) if (quotes[s]) out.push({ kind: 'sym', symbol: s, group: g });
      out.push({ kind: 'label', group: g, text: 'Gainers' });
      gainers.forEach((q) => out.push({ kind: 'sym', symbol: q.symbol, group: g }));
      out.push({ kind: 'label', group: g, text: 'Losers' });
      losers.forEach((q) => out.push({ kind: 'sym', symbol: q.symbol, group: g }));
    } else if (g === 'FX') {
      out.push({ kind: 'label', group: g, text: 'FX' });
      for (const s of [...HEADLINE_FX, 'USDMXN', 'USDCNH', 'XAUUSD']) if (quotes[s]) out.push({ kind: 'sym', symbol: s, group: g });
    } else if (g === 'MACRO') {
      out.push({ kind: 'label', group: g, text: 'Macro' });
      for (const s of ['SPX', 'NDX', 'DAX', 'NKY', 'DXY', 'US2Y', 'US10Y', 'GOLD', 'WTI', 'BRENT', 'COPPER']) if (quotes[s]) out.push({ kind: 'sym', symbol: s, group: g });
    } else {
      const cr = qs.filter((q) => symbols[q.symbol]?.assetClass === 'crypto' && q.symbol !== 'USDC').sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
      out.push({ kind: 'label', group: g, text: 'Crypto' });
      cr.slice(0, 10).forEach((q) => out.push({ kind: 'sym', symbol: q.symbol, group: g }));
    }
  }
  return out;
}

const TickerItem = memo(function TickerItem({ symbol }: { symbol: string }) {
  const fields = useSettings((s) => s.ticker.fields);
  const compact = useSettings((s) => s.ticker.density === 'compact');
  const q = useQuote(symbol);
  const meta = useStore((s) => s.symbols[symbol]);
  const ref = useFlash<HTMLButtonElement>(q?.price);
  if (!q || !meta) return null;
  const up = q.change >= 0;
  const d = meta.decimals;
  return (
    <button
      ref={ref}
      onClick={() => useStore.getState().set({ drawerSymbol: symbol })}
      className={`group flex shrink-0 items-center rounded-md transition-colors hover:bg-panel-hover ${compact ? 'gap-1.5 px-1.5 py-0.5 text-[11px]' : 'gap-2 px-2.5 py-1 text-xs'}`}
      title={`${meta.name} · ${q.source}${q.delayedMin ? ` · ${q.delayedMin}m delayed` : ''}`}
    >
      <span className="font-semibold tracking-wide text-text">{pairLabel(symbol, meta.assetClass)}</span>
      <Odometer value={fmtPrice(q.price, d)} className="text-text" />
      <span className={`flex items-center gap-0.5 num ${up ? 'text-up' : 'text-down'}`}>
        <Icon name={up ? 'up' : 'down'} size={10} />
        {meta.bp ? <span>{fmtBp(q.change)}</span> : <>
          {fields.change ? <span className="hidden sm:inline">{fmtChange(q.change, d)}</span> : null}
          {fields.pct ? <span className="opacity-90">{fields.change ? `(${fmtPct(q.changePct)})` : fmtPct(q.changePct)}</span> : null}
        </>}
      </span>
      {q.delayedMin && fields.delay ? <span className="rounded bg-warn/15 px-1 text-[9px] font-semibold text-warn">{q.delayedMin}m</span> : null}
    </button>
  );
});

function Row({ items }: { items: Item[] }) {
  return (
    <>
      {items.map((it, i) =>
        it.kind === 'label' ? (
          <span key={`l${i}`} className="flex shrink-0 items-center gap-1.5 pl-3 pr-1 text-[9px] font-bold uppercase tracking-[0.18em]" style={{ color: GROUP_COLOR[it.group] }}>
            <span className="h-1 w-1 rounded-full" style={{ background: GROUP_COLOR[it.group] }} />
            {it.text}
          </span>
        ) : (
          <TickerItem key={`${it.symbol}`} symbol={it.symbol} />
        ),
      )}
    </>
  );
}

/**
 * Movers ticker. Infinite loop = two identical copies translated by a rAF loop that wraps at
 * exactly one copy's width, so there is never a seam jump — even when membership or widths
 * change. transform-only → compositor friendly. Hover pauses; reduced motion → static
 * horizontally scrollable row.
 */
export function TickerStrip() {
  const groups = useSettings((s) => s.tickerGroups);
  const speed = useSettings((s) => s.tickerSpeed);
  const calm = useSettings((s) => s.calm);
  const reduced = usePrefersReducedMotion();
  const hydrated = useStore((s) => s.hydrated);
  const [items, setItems] = useState<Item[]>([]);
  const trackRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const paused = useRef(false);

  const tickerCfg = useSettings((s) => s.ticker);
  const groupsKey = groups.join(',') + JSON.stringify(tickerCfg.mode === 'custom' ? tickerCfg.symbols : []) + tickerCfg.mode;
  useEffect(() => {
    if (hydrated) setItems(computeItems(groups));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, groupsKey]);
  useInterval(() => setItems(computeItems(groups)), hydrated ? 60_000 : null);

  const effectiveSpeed = calm ? speed * 0.5 : speed;
  useEffect(() => {
    if (reduced) return;
    // Width comes from a ResizeObserver: reading offsetWidth in the frame loop would force a
    // synchronous layout every frame while prices are updating.
    let width = copyRef.current?.offsetWidth ?? 0;
    const ro = new ResizeObserver(([e]) => (width = e.borderBoxSize?.[0]?.inlineSize ?? (e.target as HTMLElement).offsetWidth));
    if (copyRef.current) ro.observe(copyRef.current);
    let raf = 0, last = performance.now(), offset = 0;
    const loop = (t: number) => {
      const dt = Math.min(64, t - last);
      last = t;
      if (!paused.current && width > 0 && !document.hidden) {
        offset = (offset + (effectiveSpeed * dt) / 1000) % width;
        if (trackRef.current) trackRef.current.style.transform = `translate3d(${-offset}px,0,0)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [effectiveSpeed, reduced, items.length > 0]);

  const content = useMemo(() => <Row items={items} />, [items]);

  return (
    <div
      className="relative z-30 border-b border-line bg-bg/85"
      onMouseEnter={() => (paused.current = true)}
      onMouseLeave={() => (paused.current = false)}
      onFocus={() => (paused.current = true)}
      onBlur={() => (paused.current = false)}
      aria-label="Market movers ticker"
      role="region"
    >
      {!items.length ? (
        <div className="flex h-9 items-center gap-4 overflow-hidden px-3">
          {Array.from({ length: 10 }, (_, i) => <div key={i} className="skeleton h-4 w-40 shrink-0" />)}
        </div>
      ) : reduced ? (
        <div className="flex h-9 items-center overflow-x-auto">{content}</div>
      ) : (
        <div className="relative h-9 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_3%,#000_97%,transparent)]">
          <div ref={trackRef} className="flex h-9 w-max items-center will-change-transform">
            <div ref={copyRef} className="flex items-center pr-6">{content}</div>
            <div className="flex items-center pr-6" aria-hidden inert>{content}</div>
          </div>
        </div>
      )}
    </div>
  );
}
