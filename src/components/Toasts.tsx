'use client';
import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore, type Toast } from '@/lib/store';
import { useCalm } from '@/lib/hooks';
import { Icon } from './ui';

/** A tiny, tasteful particle burst for fired alerts (transform/opacity only). */
function Burst() {
  const calm = useCalm();
  if (calm) return null;
  return (
    <span className="pointer-events-none absolute left-4 top-4" aria-hidden>
      {Array.from({ length: 10 }, (_, i) => {
        const a = (i / 10) * Math.PI * 2;
        return (
          <motion.span
            key={i}
            className="absolute h-1 w-1 rounded-full"
            style={{ background: i % 2 ? 'var(--warn)' : 'var(--accent)' }}
            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
            animate={{ x: Math.cos(a) * 26, y: Math.sin(a) * 26, opacity: 0, scale: 0.4 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          />
        );
      })}
    </span>
  );
}

function ToastItem({ t }: { t: Toast }) {
  const dismiss = useStore((s) => s.dismissToast);
  useEffect(() => {
    const id = setTimeout(() => dismiss(t.id), t.kind === 'alert' ? 9000 : 4500);
    return () => clearTimeout(id);
  }, [t, dismiss]);
  const color = t.kind === 'alert' ? 'var(--warn)' : t.kind === 'error' ? 'var(--down)' : 'var(--accent)';
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      className="glass pointer-events-auto relative flex w-80 items-start gap-2.5 overflow-visible rounded-xl bg-panel-solid/95 px-3 py-2.5"
      role="status"
    >
      {t.kind === 'alert' ? <Burst /> : null}
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full" style={{ background: `color-mix(in oklab, ${color} 20%, transparent)`, color }}>
        <Icon name={t.kind === 'alert' ? 'bell' : t.kind === 'error' ? 'x' : 'sparkle'} size={11} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-text">{t.title}</div>
        {t.body ? <div className="mt-0.5 text-[11px] leading-snug text-dim">{t.body}</div> : null}
      </div>
      <button onClick={() => dismiss(t.id)} className="text-faint hover:text-text" aria-label="Dismiss"><Icon name="x" size={12} /></button>
    </motion.div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-10 right-4 z-[70] flex flex-col items-end gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => <ToastItem key={t.id} t={t} />)}
      </AnimatePresence>
    </div>
  );
}
