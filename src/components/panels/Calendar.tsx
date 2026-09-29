'use client';
import { memo, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { EconEvent } from '@shared/types';
import { useStore } from '@/lib/store';
import { useNow, useCalm } from '@/lib/hooks';
import { countdown, flag, clockTime } from '@/lib/format';
import { Panel, Segmented, SkeletonRows, StreamBadge, SourceStamp, EmptyState } from '../ui';

function Importance({ n }: { n: 1 | 2 | 3 }) {
  return (
    <span className="flex gap-0.5" aria-label={`Importance ${n} of 3`}>
      {[1, 2, 3].map((i) => (
        <span key={i} className="h-2 w-1 rounded-sm" style={{ background: i <= n ? (n === 3 ? 'var(--down)' : n === 2 ? 'var(--warn)' : 'var(--text-faint)') : 'var(--border-strong)' }} />
      ))}
    </span>
  );
}

const fmtV = (v: number | null, unit: string) => (v === null ? '—' : `${v}${unit}`);

function verdict(e: EconEvent): 'beat' | 'miss' | 'inline' | null {
  if (e.actual === null || e.consensus === null) return null;
  const d = (e.actual - e.consensus) * (e.lowerIsBetter ? -1 : 1);
  return Math.abs(d) < 1e-9 ? 'inline' : d > 0 ? 'beat' : 'miss';
}

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

const Row = memo(function Row({ e, now }: { e: EconEvent; now: number }) {
  const calm = useCalm();
  const v = verdict(e);
  const past = e.time <= now;
  const soon = !past && e.importance === 3 && e.time - now <= 60_000;
  return (
    <li className={`grid grid-cols-[42px_18px_1fr_auto] items-center gap-2 rounded-md px-1.5 py-1 text-[11px] ${soon ? 'soft-pulse bg-warn/5' : ''} ${past && e.actual === null ? 'opacity-60' : ''}`}>
      <span className="num text-faint">{clockTime(e.time)}</span>
      <span aria-label={e.country}>{flag(e.country)}</span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Importance n={e.importance} />
          <span className="truncate text-text" title={`${e.currency} ${e.title}`}>{e.title}</span>
        </div>
        <div className="num text-[10px] text-faint">cons {fmtV(e.consensus, e.unit)} · prev {fmtV(e.previous, e.unit)}</div>
      </div>
      <div className="num w-16 text-right">
        <AnimatePresence mode="popLayout" initial={false}>
          {e.actual !== null ? (
            <motion.span
              key="a"
              initial={calm ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={calm ? { duration: 0.15 } : { type: 'spring', stiffness: 400, damping: 22 }}
              className={`inline-block rounded px-1 font-semibold ${v === 'beat' ? 'bg-up/15 text-up' : v === 'miss' ? 'bg-down/15 text-down' : 'text-text'}`}
              title={v ? `Actual ${v === 'inline' ? 'in line with' : v === 'beat' ? 'beat' : 'missed'} consensus` : undefined}
            >
              {fmtV(e.actual, e.unit)}
            </motion.span>
          ) : past ? (
            <span key="p" className="text-faint">pending</span>
          ) : (
            <span key="c" className="text-faint">{countdown(e.time - now, false)}</span>
          )}
        </AnimatePresence>
      </div>
    </li>
  );
});

export function CalendarPanel() {
  const cal = useStore((s) => s.calendar);
  const hydrated = useStore((s) => s.hydrated);
  const status = useStore((s) => s.statuses.find((x) => x.id === 'calendar'));
  const [range, setRange] = useState<'today' | 'week'>('today');
  const [minImp, setMinImp] = useState<'1' | '2' | '3'>('1');
  const now = useNow(1000);

  const groups = useMemo(() => {
    const d0 = new Date(now || Date.now());
    d0.setHours(0, 0, 0, 0);
    const start = d0.getTime();
    const end = range === 'today' ? start + 86400_000 : start + 7 * 86400_000;
    const list = cal.filter((e) => e.time >= (range === 'today' ? start : start - 86400_000 * d0.getDay()) && e.time < end && e.importance >= +minImp);
    const by = new Map<string, EconEvent[]>();
    for (const e of list) {
      const k = new Date(e.time).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      by.set(k, [...(by.get(k) ?? []), e]);
    }
    return [...by];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cal, range, minImp, Math.floor((now || 0) / 60_000)]);

  return (
    <Panel title="Economic calendar" accent="var(--macro)" right={<StreamBadge id="calendar" />}>
      <NextEventCard />
      <div className="my-2 flex items-center justify-between gap-2">
        <Segmented label="Calendar range" value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'week', label: 'This week' }]} />
        <Segmented label="Minimum importance" value={minImp} onChange={setMinImp} options={[{ value: '1', label: 'All' }, { value: '2', label: '●●' }, { value: '3', label: '●●●' }]} />
      </div>
      {!hydrated ? (
        <SkeletonRows n={6} />
      ) : !groups.length ? (
        <EmptyState title="Nothing scheduled" body={range === 'today' ? 'Switch to “This week” to see upcoming releases.' : undefined} />
      ) : (
        <div className="max-h-[340px] overflow-y-auto pr-1">
          {groups.map(([day, events]) => (
            <div key={day} className="mb-1.5">
              <div className="sticky top-0 z-10 bg-panel-solid/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-faint backdrop-blur">{day}</div>
              <ul>{events.map((e) => <Row key={e.id} e={e} now={now} />)}</ul>
            </div>
          ))}
        </div>
      )}
      <SourceStamp className="mt-2" source={status?.provider ?? 'Calendar'} ts={status?.lastUpdate} mock={status?.mock} />
    </Panel>
  );
}
