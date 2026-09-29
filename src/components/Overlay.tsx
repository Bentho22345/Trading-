'use client';
import { useEffect, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useCalm } from '@/lib/hooks';

/** Modal / slide-over shell with backdrop, Esc to close and simple focus handling. */
export function Overlay({ open, onClose, children, side = 'center', label, width = 'max-w-2xl' }: { open: boolean; onClose: () => void; children: ReactNode; side?: 'center' | 'right' | 'top'; label: string; width?: string }) {
  const calm = useCalm();
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [open, onClose]);

  const variants = side === 'right'
    ? { initial: { x: calm ? 0 : '100%', opacity: calm ? 0 : 1 }, animate: { x: 0, opacity: 1 }, exit: { x: calm ? 0 : '100%', opacity: calm ? 0 : 1 } }
    : { initial: { opacity: 0, y: calm ? 0 : side === 'top' ? -12 : 12, scale: calm ? 1 : 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: calm ? 0 : 8, scale: calm ? 1 : 0.98 } };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={label}>
          <motion.div className="absolute inset-0 bg-black/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            {...variants}
            transition={calm ? { duration: 0.15 } : { type: 'spring', stiffness: 380, damping: 36 }}
            className={
              side === 'right'
                ? 'absolute inset-y-0 right-0 flex w-full max-w-[560px] flex-col border-l border-line bg-panel-solid/95 shadow-2xl backdrop-blur-xl'
                : `absolute left-1/2 ${side === 'top' ? 'top-[12vh]' : 'top-1/2 -translate-y-1/2'} w-[calc(100%-2rem)] -translate-x-1/2 ${width}`
            }
          >
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
