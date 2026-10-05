'use client';
import { useMemo } from 'react';
import { useStore } from '@/lib/store';
import { useNow } from '@/lib/hooks';
import { countdown, flag, clockTime } from '@/lib/format';
import { EmptyState } from './ui';

const fmtV = (v: number | null, unit: string) => (v === null ? '—' : `${v}${unit}`);

/** Flip-style countdown: each changed digit re-mounts with a short rotateX animation. */
export function FlipCountdown({ ms }: { ms: number }) {
  const text = countdown(ms);
  return (
    <span className="num inline-flex" aria-label={text} style={{ perspective: 200 }}>
      {[...text].map((ch, i) => (
        <span key={`${i}-${ch}`} className="flip-digit" aria-hidden>{ch}</span>
      ))}
    </span>
  );
}

export function NextEventCard({ compact = false }: { compact?: boolean }) {
  const cal = useStore((s) => s.calendar);
  const now = useNow(1000);
  const next = useMemo(() => cal.find((e) => e.importance === 3 && e.time > now - 1000), [cal, now]);
  if (!now) return null;
  if (!next) return compact ? null : <EmptyState title="No high-importance releases scheduled" />;
  const ms = next.time - now;
  const final = ms <= 60_000;
  return (
    <div className={`relative flex items-center gap-3 rounded-lg border bg-bg-2/60 px-3 py-2 ${final ? 'soft-pulse border-warn/50' : 'border-line'}`}>
      <span className="text-lg" aria-hidden>{flag(next.country)}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-faint">Next high-impact{compact ? ' · calendar' : ''}</div>
        <div className="truncate text-[13px] font-medium text-text">{next.currency} {next.title}</div>
        <div className="num text-[10px] text-faint">cons {fmtV(next.consensus, next.unit)} · prev {fmtV(next.previous, next.unit)} · {clockTime(next.time)}</div>
      </div>
      <div className={`text-right text-lg font-semibold ${final ? 'text-warn' : 'text-text'}`}>
        <FlipCountdown ms={ms} />
      </div>
    </div>
  );
}
