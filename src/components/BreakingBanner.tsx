'use client';
import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '@/lib/store';
import { useCalm, useNow } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import { Icon, DemoChip } from './ui';

export function BreakingBanner() {
  const b = useStore((s) => s.breaking);
  const set = useStore((s) => s.set);
  const calm = useCalm();
  const now = useNow(1000);

  // auto-dismiss after 45s so it never lingers over the feed all day
  useEffect(() => {
    if (!b) return;
    const t = setTimeout(() => useStore.getState().breaking?.id === b.id && set({ breaking: null }), 45_000);
    return () => clearTimeout(t);
  }, [b, set]);

  return (
    <AnimatePresence>
      {b && (
        <motion.div
          key={b.id}
          role="alert"
          aria-live="assertive"
          initial={calm ? { opacity: 0 } : { y: -80, opacity: 0 }}
          animate={calm ? { opacity: 1 } : { y: 0, opacity: 1 }}
          exit={calm ? { opacity: 0 } : { y: -80, opacity: 0 }}
          transition={calm ? { duration: 0.15 } : { type: 'spring', stiffness: 380, damping: 32 }}
          className="pointer-events-auto absolute left-1/2 top-2 z-50 w-[min(760px,calc(100%-1.5rem))] -translate-x-1/2"
        >
          <div className="glass relative overflow-hidden rounded-xl border-down/40 bg-panel-solid/90 shadow-2xl">
            <div className="pulse-line absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[var(--down)] to-transparent" />
            <div className="flex items-start gap-3 px-4 py-3">
              <span className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-md bg-down/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-down">
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-down text-down" /> Breaking
              </span>
              <div className="min-w-0 flex-1">
                <button
                  className="text-left text-sm font-semibold leading-snug text-text hover:underline"
                  onClick={() => set({ selectedId: b.id, timelineId: b.id, breaking: null })}
                >
                  {b.headline}
                </button>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-faint">
                  <span>{b.source}</span>
                  {b.articles.length > 1 ? <span>· {b.articles.length} sources</span> : null}
                  <span className="num">· {timeAgo(b.publishedAt, now)} ago</span>
                  <span className="num">· impact {b.impact}</span>
                  {b.demo ? <DemoChip /> : null}
                </div>
              </div>
              <button onClick={() => set({ breaking: null })} className="rounded-md p-1 text-faint hover:bg-panel-hover hover:text-text" aria-label="Dismiss breaking news">
                <Icon name="x" size={14} />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
