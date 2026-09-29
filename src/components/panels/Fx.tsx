'use client';
import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import type { Timeframe } from '@shared/types';
import { MAJORS } from '@shared/symbols';
import { useStore } from '@/lib/store';
import { useCalm, useInterval } from '@/lib/hooks';
import { Panel, Segmented, SkeletonRows, StreamBadge, SourceStamp } from '../ui';

export function StrengthPanel() {
  const analytics = useStore((s) => s.analytics);
  const status = useStore((s) => s.statuses.find((x) => x.id === 'fx'));
  const [tf, setTf] = useState<Timeframe>('1d');
  const calm = useCalm();
  const rows = analytics?.strength[tf] ?? [];
  const max = Math.max(0.05, ...rows.map((r) => Math.abs(r.score)));
  return (
    <Panel title="Currency strength" accent="var(--fx)" right={<><StreamBadge id="fx" /><Segmented label="Strength timeframe" value={tf} onChange={setTf} options={[{ value: '1h', label: '1h' }, { value: '4h', label: '4h' }, { value: '1d', label: '1d' }]} /></>}>
      {!rows.length ? (
        <SkeletonRows n={8} />
      ) : (
        <ul className="space-y-1">
          {rows.map((r, i) => {
            const pct = (Math.abs(r.score) / max) * 50;
            const up = r.score >= 0;
            return (
              <motion.li layout={!calm} key={r.ccy} transition={{ type: 'spring', stiffness: 350, damping: 32 }} className="grid grid-cols-[14px_34px_1fr_52px] items-center gap-2 text-[11px]">
                <span className="num text-faint">{i + 1}</span>
                <span className="font-semibold text-text">{r.ccy}</span>
                <div className="relative h-2.5 rounded-full bg-bg-2/70">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
                  <motion.div
                    className="absolute inset-y-0 rounded-full"
                    style={{ background: up ? 'var(--up)' : 'var(--down)', [up ? 'left' : 'right']: '50%' }}
                    initial={false}
                    animate={{ width: `${pct}%` }}
                    transition={calm ? { duration: 0 } : { type: 'spring', stiffness: 120, damping: 20 }}
                  />
                </div>
                <span className={`num text-right ${up ? 'text-up' : 'text-down'}`}>{up ? '+' : ''}{r.score.toFixed(2)}%</span>
              </motion.li>
            );
          })}
        </ul>
      )}
      <SourceStamp className="mt-2" source={`Computed from 28 major crosses · ${status?.provider ?? ''}`} ts={analytics?.ts} delayedMin={status?.delayedMin} />
    </Panel>
  );
}

/** Heatmap of major-pair % changes (row currency vs column currency). */
export function HeatmapPanel() {
  const [tick, setTick] = useState(0);
  // quotes change many times a second; the heatmap only needs to repaint every 2s
  useInterval(() => setTick((t) => t + 1), 2000);
  const hydrated = useStore((s) => s.hydrated);
  const status = useStore((s) => s.statuses.find((x) => x.id === 'fx'));
  const grid = useMemo(() => {
    const quotes = useStore.getState().quotes;
    const g: (number | null)[][] = MAJORS.map((b) =>
      MAJORS.map((q) => {
        if (b === q) return null;
        const direct = quotes[`${b}${q}`];
        if (direct) return direct.changePct;
        const inv = quotes[`${q}${b}`];
        return inv ? (inv.ref / inv.price - 1) * 100 : null;
      }),
    );
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, hydrated]);
  const max = Math.max(0.2, ...grid.flat().map((v) => Math.abs(v ?? 0)));
  return (
    <Panel title="FX heatmap" accent="var(--fx)" right={<span className="text-[10px] text-faint">row vs column · 24h</span>}>
      {!hydrated ? (
        <div className="skeleton aspect-square w-full" />
      ) : (
        <div className="grid grid-cols-[28px_repeat(8,1fr)] gap-[3px] text-[10px]">
          <span />
          {MAJORS.map((c) => <span key={c} className="text-center font-semibold text-faint">{c}</span>)}
          {MAJORS.map((b, i) => (
            <div key={b} className="contents">
              <span className="flex items-center font-semibold text-faint">{b}</span>
              {grid[i].map((v, j) => {
                if (v === null) return <span key={j} className="rounded bg-bg-2/40" />;
                const a = Math.min(1, Math.abs(v) / max);
                const color = v >= 0 ? 'var(--up)' : 'var(--down)';
                return (
                  <button
                    key={j}
                    onClick={() => {
                      const sym = useStore.getState().quotes[`${b}${MAJORS[j]}`] ? `${b}${MAJORS[j]}` : `${MAJORS[j]}${b}`;
                      useStore.getState().set({ drawerSymbol: sym });
                    }}
                    className="num flex aspect-[1.3] items-center justify-center rounded transition-[background-color] duration-700 hover:ring-1 hover:ring-line-strong"
                    style={{ background: `color-mix(in oklab, ${color} ${Math.round(10 + a * 55)}%, transparent)`, color: 'var(--text)', fontWeight: a > 0.55 ? 600 : 400 }}
                    title={`${b}/${MAJORS[j]} ${v >= 0 ? '+' : ''}${v.toFixed(2)}%`}
                  >
                    {v >= 0 ? '+' : ''}{v.toFixed(2)}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <SourceStamp className="mt-2" source={status?.provider ?? 'FX'} ts={status?.lastUpdate} mock={status?.mock} delayedMin={status?.delayedMin} />
    </Panel>
  );
}
