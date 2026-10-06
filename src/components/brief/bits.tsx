'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useCalm } from '@/lib/hooks';
import { fmtPrice } from '@/lib/format';
import { Icon } from '../ui';

/** Number that counts up from `from` to `to` once on mount (instant under reduced motion / calm). */
export function CountUp({ from, to, decimals = 2, ms = 650, className = '', format }: { from: number; to: number; decimals?: number; ms?: number; className?: string; format?: (v: number) => string }) {
  const calm = useCalm();
  const [v, setV] = useState(calm ? to : from);
  const raf = useRef(0);
  useEffect(() => {
    if (calm || !Number.isFinite(from) || from === to) {
      setV(to);
      return;
    }
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - (1 - k) ** 3;
      setV(from + (to - from) * e);
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [from, to, ms, calm]);
  return <span className={`num ${className}`}>{format ? format(v) : fmtPrice(v, decimals)}</span>;
}

/** SVG sparkline that draws itself left → right. */
export function DrawSpark({ data, up, width = 96, height = 26, delay = 0, baseline }: { data: number[]; up: boolean; width?: number; height?: number; delay?: number; baseline?: number }) {
  const calm = useCalm();
  if (data.length < 2) return <svg width={width} height={height} aria-hidden />;
  const min = Math.min(...data, baseline ?? Infinity), max = Math.max(...data, baseline ?? -Infinity);
  const span = max - min || 1;
  const x = (i: number) => (i / (data.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const d = data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const color = up ? 'var(--up)' : 'var(--down)';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
      {baseline !== undefined ? <line x1="0" x2={width} y1={y(baseline)} y2={y(baseline)} stroke="var(--border-strong)" strokeDasharray="2 3" /> : null}
      <path d={`${d}L${x(data.length - 1)},${height}L1,${height}Z`} fill={color} opacity={0.08} />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        style={calm ? undefined : { strokeDasharray: 1, strokeDashoffset: 1, animation: `spark-draw 700ms cubic-bezier(.2,.8,.2,1) ${delay}ms forwards` }}
      />
    </svg>
  );
}

/** Staggered "page being set" reveal; all sections land within 800 ms. */
export function Reveal({ i, children, className = '' }: { i: number; children: ReactNode; className?: string }) {
  const calm = useCalm();
  return (
    <div className={`${calm ? '' : 'brief-reveal'} ${className}`} style={calm ? undefined : { animationDelay: `${Math.min(i * 55, 480)}ms` }}>
      {children}
    </div>
  );
}

/** Designed empty / "connect a provider" state: icon, one sentence, optional actions. */
export function EmptyCard({ text, icon = 'sparkle', action, onAction, secondary }: { text: string; icon?: string; action?: string; onAction?: () => void; secondary?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-dashed border-line bg-bg-2/30 px-4 py-4">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-panel-hover text-faint"><Icon name={icon} size={14} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-dim">{text}</p>
        {action || secondary ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {action ? <button onClick={onAction} className="rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-medium text-text hover:bg-accent/20">{action}</button> : null}
            {secondary}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Pill({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'up' | 'down' | 'warn' | 'accent'; title?: string }) {
  const cls = { neutral: 'border-line text-dim', up: 'border-up/40 text-up', down: 'border-down/40 text-down', warn: 'border-warn/40 text-warn', accent: 'border-accent/40 text-accent' }[tone];
  return <span title={title} className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${cls}`}>{children}</span>;
}

/** 📌 marker for anything touching the user's book, watchlist or playbooks. */
export function PinChip({ label = 'In your book' }: { label?: string }) {
  return <span className="inline-flex items-center gap-1 rounded-full bg-accent/12 px-1.5 py-px text-[10px] font-semibold text-accent" title={label}><span aria-hidden>📌</span>{label}</span>;
}
