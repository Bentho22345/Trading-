'use client';
import { useEffect, useState, type ComponentType } from 'react';
import { motion, Reorder, useDragControls } from 'framer-motion';
import { useSettings, PANEL_LABELS, type PanelId } from '@/lib/settings';
import { useStore } from '@/lib/store';
import { useCalm } from '@/lib/hooks';
import { SessionsPanel } from './panels/Sessions';
import { CalendarPanel } from './panels/Calendar';
import { BanksPanel } from './panels/Banks';
import { StrengthPanel, HeatmapPanel } from './panels/Fx';
import { CryptoPanel } from './panels/Crypto';
import { VolPanel } from './panels/Vol';
import { WatchlistPanel, AlertsPanel } from './panels/Watch';
import { Icon } from './ui';
import { MagneticButton } from './Magnetic';

export const PANELS: Record<PanelId, ComponentType> = {
  sessions: SessionsPanel, calendar: CalendarPanel, banks: BanksPanel, strength: StrengthPanel, heatmap: HeatmapPanel,
  crypto: CryptoPanel, vol: VolPanel, watchlist: WatchlistPanel, alerts: AlertsPanel,
};

/** Mount the side rails once the main thread is idle, so the feed paints first. */
function useIdleReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setReady(true), { timeout: 1200 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(() => setReady(true), 300);
    return () => clearTimeout(t);
  }, []);
  return ready;
}

function EditableItem({ id, side }: { id: PanelId; side: 'left' | 'right' }) {
  const controls = useDragControls();
  const layout = useSettings((s) => s.layout);
  const set = useSettings((s) => s.set);
  const hidden = layout.hidden.includes(id);
  const move = () => {
    const from = side, to = side === 'left' ? 'right' : 'left';
    set({ layout: { ...layout, [from]: layout[from].filter((p) => p !== id), [to]: [...layout[to], id] } });
  };
  const toggle = () => set({ layout: { ...layout, hidden: hidden ? layout.hidden.filter((p) => p !== id) : [...layout.hidden, id] } });
  return (
    <Reorder.Item value={id} dragListener={false} dragControls={controls} className="list-none">
      <div className={`glass flex items-center gap-2 rounded-xl px-3 py-2.5 ${hidden ? 'opacity-50' : ''}`}>
        <button onPointerDown={(e) => controls.start(e)} className="cursor-grab touch-none text-faint hover:text-text active:cursor-grabbing" aria-label={`Drag ${PANEL_LABELS[id]}`}><Icon name="grip" /></button>
        <span className="flex-1 text-xs font-medium text-text">{PANEL_LABELS[id]}</span>
        <button onClick={move} className="rounded-md px-1.5 py-0.5 text-[10px] text-faint hover:bg-panel-hover hover:text-text" title="Move to the other rail">{side === 'left' ? '→ right' : '← left'}</button>
        <button onClick={toggle} className="text-faint hover:text-text" aria-label={hidden ? 'Show panel' : 'Hide panel'}><Icon name={hidden ? 'eyeOff' : 'eye'} size={14} /></button>
      </div>
    </Reorder.Item>
  );
}

export function Rail({ panels, side, className = '' }: { panels: PanelId[]; side: 'left' | 'right'; className?: string }) {
  const editing = useStore((s) => s.layoutEditing);
  const layout = useSettings((s) => s.layout);
  const set = useSettings((s) => s.set);
  const calm = useCalm();
  const ready = useIdleReady();

  if (editing) {
    return (
      <div className={className}>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-faint">{side} rail</div>
        <Reorder.Group axis="y" values={layout[side]} onReorder={(v) => set({ layout: { ...layout, [side]: v } })} className="space-y-2">
          {layout[side].map((id) => <EditableItem key={id} id={id} side={side} />)}
        </Reorder.Group>
      </div>
    );
  }

  const visible = panels.filter((p) => !layout.hidden.includes(p));
  if (!ready) {
    return (
      <div className={`space-y-3 ${className}`} aria-busy>
        {visible.slice(0, 3).map((id) => <div key={id} className="glass h-64 rounded-xl p-3"><div className="skeleton mb-3 h-3 w-32" /><div className="skeleton h-40 w-full" /></div>)}
      </div>
    );
  }
  return (
    <motion.div
      className={`space-y-3 ${className}`}
      initial="hidden"
      animate="show"
      variants={{ hidden: {}, show: { transition: { staggerChildren: calm ? 0 : 0.06 } } }}
    >
      {visible.map((id) => {
        const P = PANELS[id];
        return (
          <motion.div key={id} id={`panel-${id}`} variants={{ hidden: { opacity: 0, y: calm ? 0 : 10 }, show: { opacity: 1, y: 0, transition: { duration: calm ? 0.1 : 0.32, ease: [0.22, 1, 0.36, 1] } } }}>
            <P />
          </motion.div>
        );
      })}
    </motion.div>
  );
}

export function LayoutEditBar() {
  const editing = useStore((s) => s.layoutEditing);
  const set = useStore((s) => s.set);
  const reset = () => useSettings.getState().set({ layout: { left: ['sessions', 'calendar', 'banks'], right: ['strength', 'heatmap', 'crypto', 'vol', 'watchlist', 'alerts'], hidden: [] } });
  if (!editing) return null;
  return (
    <div className="glass mb-3 flex items-center justify-between rounded-xl px-3 py-2 text-xs">
      <span className="text-dim">Drag panels to reorder, move them between rails, or hide them. Saved automatically.</span>
      <span className="flex gap-2">
        <button onClick={reset} className="rounded-md border border-line px-2 py-1 text-dim hover:text-text">Reset</button>
        <MagneticButton onClick={() => set({ layoutEditing: false })}>Done</MagneticButton>
      </span>
    </div>
  );
}
