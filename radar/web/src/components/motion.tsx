'use client';
import { animate, AnimatePresence, motion, useMotionValue, useTransform } from 'motion/react';
import { memo, useEffect, useId, useRef, useState } from 'react';

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
    <div className="relative inline-flex flex-wrap gap-0.5 rounded-full border border-white/10 bg-white/[0.03] p-1">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`relative z-0 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors duration-300 ${value === o.value ? 'text-black' : 'text-white/55 hover:text-white'}`}>
          {value === o.value && (
            <motion.span layoutId={`chip-${id}`} className="absolute inset-0 -z-10 rounded-full bg-white"
              transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
          )}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Area sparkline with gradient fill. */
export const AreaSpark = memo(function AreaSpark({ data, w = 96, h = 28, up }: { data: number[]; w?: number; h?: number; up?: boolean }) {
  const id = useId();
  if (!data || data.length < 2) return <span className="inline-block skeleton opacity-40" style={{ width: Math.min(w, 96), height: h }} />;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const pts = data.map((d, i) => [(i / (data.length - 1)) * w, h - 3 - ((d - min) / span) * (h - 6)]);
  const line = pts.map((p) => p.join(',')).join(' ');
  const rising = up ?? data[data.length - 1] >= data[0];
  const color = rising ? 'var(--color-up)' : 'var(--color-down)';
  const gid = `sp${id.replace(/:/g, '')}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none" className="max-w-full overflow-visible" role="img" aria-label={`trend ${rising ? 'up' : 'down'}`}>
      <defs><linearGradient id={gid} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.35} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient></defs>
      <polygon points={`0,${h} ${line} ${w},${h}`} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.5} fill={color} />
    </svg>
  );
}, (a, b) => a.data === b.data && a.w === b.w && a.h === b.h && a.up === b.up);

export const fadeUp = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -6 }, transition: { duration: 0.25 } };
