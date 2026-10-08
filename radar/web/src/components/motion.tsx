'use client';
import { animate, AnimatePresence, motion, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

export { AnimatePresence, motion };

/** Number that counts to its new value. */
export function AnimatedNumber({ value, format = (v) => v.toFixed(0), className = '' }: { value: number | null | undefined; format?: (v: number) => string; className?: string }) {
  const mv = useMotionValue(value ?? 0);
  const text = useTransform(mv, (v) => format(v));
  useEffect(() => {
    if (value == null || !isFinite(value)) return;
    const c = animate(mv, value, { duration: 0.6, ease: 'easeOut' });
    return () => c.stop();
  }, [value, mv]);
  if (value == null || !isFinite(value)) return <span className={className}>—</span>;
  return <motion.span className={className}>{text}</motion.span>;
}

/** Wraps a value; briefly tints green/red when it changes. */
export function Flash({ value, children, className = '' }: { value: number | null | undefined; children: React.ReactNode; className?: string }) {
  const prev = useRef(value);
  const [cls, setCls] = useState('');
  useEffect(() => {
    if (value != null && prev.current != null && value !== prev.current) {
      setCls(value > prev.current ? 'tick-up' : 'tick-down');
      const t = setTimeout(() => setCls(''), 1000);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  return <span className={`inline-block px-0.5 ${cls} ${className}`}>{children}</span>;
}

/** Segmented chips with a sliding highlight. */
export function Chips<T extends string>({ value, options, onChange, id }: { value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void; id: string }) {
  return (
    <div className="relative inline-flex flex-wrap gap-0.5 rounded-xl border border-white/10 bg-white/[0.03] p-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`relative z-0 rounded-lg px-2.5 py-1 text-[12px] transition-colors ${value === o.value ? 'text-fg' : 'text-mute hover:text-fg'}`}>
          {value === o.value && (
            <motion.span layoutId={`chip-${id}`} className="absolute inset-0 -z-10 rounded-lg bg-gradient-to-r from-accent/30 to-accent2/25 ring-1 ring-white/10"
              transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
          )}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Area sparkline with gradient fill. */
export function AreaSpark({ data, w = 96, h = 28, up }: { data: number[]; w?: number; h?: number; up?: boolean }) {
  if (!data || data.length < 2) return <span className="inline-block skeleton opacity-40" style={{ width: Math.min(w, 96), height: h }} />;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const pts = data.map((d, i) => [(i / (data.length - 1)) * w, h - 3 - ((d - min) / span) * (h - 6)]);
  const line = pts.map((p) => p.join(',')).join(' ');
  const rising = up ?? data[data.length - 1] >= data[0];
  const color = rising ? 'var(--color-up)' : 'var(--color-down)';
  const gid = `g${Math.round(data[0] * 1e6) % 100000}${data.length}${rising ? 'u' : 'd'}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none" className="max-w-full overflow-visible" role="img" aria-label={`trend ${rising ? 'up' : 'down'}`}>
      <defs><linearGradient id={gid} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.35} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient></defs>
      <polygon points={`0,${h} ${line} ${w},${h}`} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.5} fill={color} />
    </svg>
  );
}

export const fadeUp = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -6 }, transition: { duration: 0.25 } };
