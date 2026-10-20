'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from '@/components/motion';
import { useLive } from '@/lib/live';

type T = { id: string; kind: string; title: string; body?: string; mint?: string | null; ts: number };

/** Every Autopilot trade (demo, self-driving or real) pops up wherever you are on the site. */
export function TradeToasts() {
  const path = usePathname();
  const [items, setItems] = useState<T[]>([]);
  const [off, setOff] = useState(false);
  useEffect(() => { try { setOff(localStorage.getItem('radar:toasts') === 'off'); } catch { /* private mode */ } }, []);
  useLive(({ ch, data }) => {
    if (off || ch !== 'intel' || data?.engine !== 'autopilot' || !['buy', 'sell', 'panic'].includes(data.kind)) return;
    const t: T = { id: `${data.ts}${data.title}`, kind: data.kind, title: data.title, body: data.body, mint: data.mint, ts: data.ts };
    setItems((xs) => [t, ...xs].slice(0, 4));
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 7000);
  });
  if (['/login', '/signup', '/verify', '/reset'].includes(path)) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[340px] max-w-[calc(100vw-32px)] flex-col gap-2">
      <AnimatePresence initial={false}>
        {items.map((t) => {
          const buy = t.kind === 'buy';
          const real = t.title.includes('REAL');
          return (
            <motion.div key={t.id} layout initial={{ opacity: 0, x: 60, scale: 0.96 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 60 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              className={`pointer-events-auto overflow-hidden rounded-2xl border bg-[var(--color-surface)]/95 shadow-[0_18px_50px_-20px_rgba(var(--glow),.8)] backdrop-blur-xl ${
                real ? 'border-down/50' : buy ? 'border-accent/50' : 'border-warn/40'}`}>
              <div className={`h-0.5 ${buy ? 'bg-accent' : 'bg-warn'}`} />
              <div className="flex items-start gap-3 px-3.5 py-3">
                <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-black ${buy ? 'bg-accent text-white' : 'bg-warn/20 text-warn'}`}>{buy ? '↗' : t.kind === 'panic' ? '■' : '↘'}</span>
                <div className="min-w-0 flex-1">
                  {t.mint ? <Link href={`/token?a=${t.mint}`} className="block truncate text-[13px] font-bold hover:underline">{t.title}</Link> : <b className="block truncate text-[13px]">{t.title}</b>}
                  {t.body && <p className="line-clamp-2 text-[11.5px] text-white/60">{t.body}</p>}
                </div>
                <button onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} className="text-white/35 hover:text-white" aria-label="Dismiss">✕</button>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
      {items.length > 0 && (
        <button onClick={() => { setOff(true); setItems([]); try { localStorage.setItem('radar:toasts', 'off'); } catch { /* ignore */ } }}
          className="pointer-events-auto self-end text-[10.5px] text-white/35 hover:text-white">Hide trade pop-ups</button>
      )}
    </div>
  );
}
