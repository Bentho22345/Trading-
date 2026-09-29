'use client';
import { forwardRef, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { motion, useMotionValue, useSpring } from 'framer-motion';
import { useNow, useCalm } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import { useStore } from '@/lib/store';
import type { StreamId } from '@shared/types';

// ------------------------------------------------------------------ icons (inline, 16px, stroke)
const paths: Record<string, ReactNode> = {
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  up: <path d="M12 5l6 8H6z" fill="currentColor" stroke="none" />,
  down: <path d="M12 19l-6-8h12z" fill="currentColor" stroke="none" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  bookmark: <path d="M6 4h12v16l-6-4-6 4z" />,
  external: <><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  command: <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />,
  bell: <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></>,
  focus: <><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" /><circle cx="12" cy="12" r="3" /></>,
  grip: <><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 4.4-1" /></>,
  layout: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>,
  timeline: <><path d="M12 3v18" /><circle cx="12" cy="7" r="2" /><circle cx="12" cy="15" r="2" /><path d="M14 7h6M4 15h6" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  keyboard: <><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
};

export function Icon({ name, size = 16, className = '' }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {paths[name]}
    </svg>
  );
}

// ------------------------------------------------------------------ chips
export function Chip({ children, className = '', title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-dim ${className}`}>
      {children}
    </span>
  );
}

export function DelayChip({ min }: { min: number }) {
  if (!min) return null;
  return <Chip className="border-warn/40 text-warn" title={`Data is delayed by up to ${min} minutes`}>{min}m delayed</Chip>;
}

export function DemoChip() {
  return <Chip className="border-accent/40 text-accent" title="Simulated demo data (mock mode)">demo</Chip>;
}

/** "source · 12s ago" freshness stamp used on every panel */
export function SourceStamp({ source, ts, delayedMin = 0, mock, className = '' }: { source: string; ts: number | null | undefined; delayedMin?: number; mock?: boolean; className?: string }) {
  const now = useNow(1000);
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 text-[10px] text-faint ${className}`}>
      <span className="truncate">{source}</span>
      {ts ? <span className="num">· {timeAgo(ts, now)} ago</span> : null}
      {mock ? <DemoChip /> : null}
      <DelayChip min={delayedMin} />
    </span>
  );
}

/** Staleness indicator for a panel, driven by the worker's stream status */
export function StreamBadge({ id }: { id: StreamId }) {
  const s = useStore((st) => st.statuses.find((x) => x.id === id));
  const now = useNow(1000);
  if (!s) return null;
  if (s.state === 'live') return s.mock ? <DemoChip /> : <DelayChip min={s.delayedMin} />;
  const color = s.state === 'down' ? 'text-down border-down/40' : 'text-warn border-warn/40';
  return (
    <Chip className={color} title={s.message ?? s.provider}>
      {s.state === 'connecting' ? 'connecting' : s.state}
      {s.lastUpdate ? <span className="num normal-case"> · {timeAgo(s.lastUpdate, now)}</span> : null}
    </Chip>
  );
}

// ------------------------------------------------------------------ panel
export function Panel({ title, accent, right, children, className = '', id, bodyClass = '' }: { title: ReactNode; accent?: string; right?: ReactNode; children: ReactNode; className?: string; id?: string; bodyClass?: string }) {
  return (
    <section id={id} className={`glass relative flex flex-col rounded-xl ${className}`} aria-label={typeof title === 'string' ? title : undefined}>
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-dim">
          {accent ? <span className="h-3 w-[3px] rounded-full" style={{ background: accent }} /> : null}
          {title}
        </h2>
        <div className="flex items-center gap-1.5">{right}</div>
      </header>
      <div className={`p-3 ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = 'sm', label }: { value: T; options: { value: T; label: ReactNode; accent?: string }[]; onChange: (v: T) => void; size?: 'sm' | 'md'; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="relative inline-flex rounded-lg border border-line bg-bg-2/60 p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={`relative z-10 whitespace-nowrap rounded-md font-medium transition-colors ${size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'} ${active ? 'text-text' : 'text-faint hover:text-dim'}`}
          >
            {active && (
              <motion.span layoutId={`seg-${label}`} className="absolute inset-0 -z-10 rounded-md border border-line-strong bg-panel-hover" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
            )}
            <span className="inline-flex items-center gap-1.5">
              {o.accent ? <span className="h-1.5 w-1.5 rounded-full" style={{ background: o.accent }} /> : null}
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function SkeletonRows({ n = 4 }: { n?: number }) {
  return (
    <div className="space-y-2" aria-busy>
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center">
      <div className="text-xs font-medium text-dim">{title}</div>
      {body ? <div className="mt-1 text-[11px] text-faint">{body}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------------ buttons
/** Primary button with a subtle magnetic pull toward the cursor. */
export function MagneticButton({ children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const calm = useCalm();
  const ref = useRef<HTMLButtonElement>(null);
  const x = useSpring(useMotionValue(0), { stiffness: 300, damping: 20 });
  const y = useSpring(useMotionValue(0), { stiffness: 300, damping: 20 });
  return (
    <motion.button
      ref={ref}
      style={{ x, y }}
      onMouseMove={(e) => {
        if (calm || !ref.current) return;
        const r = ref.current.getBoundingClientRect();
        x.set((e.clientX - r.left - r.width / 2) * 0.18);
        y.set((e.clientY - r.top - r.height / 2) * 0.25);
      }}
      onMouseLeave={() => {
        x.set(0);
        y.set(0);
      }}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white shadow-[0_6px_20px_-8px_var(--accent)] transition-[filter] hover:brightness-110 disabled:opacity-50 ${className}`}
      {...(rest as object)}
    >
      {children}
    </motion.button>
  );
}

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }>(function IconButton(
  { label, active, className = '', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={`inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-lg border px-1.5 text-dim transition-colors hover:border-line-strong hover:text-text ${active ? 'border-accent/50 bg-accent/10 text-text' : 'border-line'} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="num rounded border border-line bg-bg-2 px-1 py-px text-[10px] text-dim">{children}</kbd>;
}
