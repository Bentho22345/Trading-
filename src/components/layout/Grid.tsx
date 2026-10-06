'use client';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NewsCluster } from '@shared/types';
import type { SmartFeed, WidgetInstance, Workspace } from '@shared/v2';
import { useDocs } from '@/lib/v2';
import { moveItem, resizeItem, gridHeight, COLS } from '@shared/grid';
import { useStore } from '@/lib/store';
import { useCalm } from '@/lib/hooks';
import { WIDGETS, setWidgets, undoLayout, redoLayout } from '@/lib/workspaces';
import { WIDGET_COMPONENTS } from './registry';
import { Icon } from '../ui';

const ROW = 30;
const GAP = 12;

type Drag = { id: string; mode: 'move' | 'resize'; startX: number; startY: number; orig: WidgetInstance; dx: number; dy: number };

export function popOut(w: WidgetInstance) {
  const cfg = encodeURIComponent(btoa(JSON.stringify(w.config ?? {})));
  window.open(`/popout?w=${w.type}&c=${cfg}&t=${encodeURIComponent(w.title ?? WIDGETS[w.type].label)}`, `pulse-${w.id}`, 'popup,width=520,height=720');
}

const Frame = memo(function Frame({ w, editing, primary, initialClusters, onPointerDown, onRemove, onConfig }: {
  w: WidgetInstance; editing: boolean; primary: boolean; initialClusters?: NewsCluster[];
  onPointerDown: (e: React.PointerEvent, w: WidgetInstance, mode: 'move' | 'resize') => void; onRemove: (id: string) => void; onConfig: (w: WidgetInstance) => void;
}) {
  const C = WIDGET_COMPONENTS[w.type];
  const meta = WIDGETS[w.type];
  return (
    <div className={`group/w relative h-full ${editing ? 'edit-target rounded-xl outline-2 outline-dashed outline-offset-2 outline-line-strong' : ''}`}>
      <div className={`widget-fill h-full overflow-hidden ${editing ? 'pointer-events-none select-none' : ''}`}>
        {C ? <C config={w.config} instanceId={w.id} primary={primary} initialClusters={initialClusters} /> : null}
      </div>
      {editing ? (
        <>
          <div onPointerDown={(e) => onPointerDown(e, w, 'move')} className="absolute inset-x-0 top-0 flex h-9 cursor-move touch-none items-center gap-2 rounded-t-xl border-b border-line bg-panel-solid px-3" role="button" aria-label={`Move ${meta.label}`}>
            <Icon name="grip" size={14} className="text-faint" />
            <span className="flex-1 truncate text-xs font-medium text-text">{w.title ?? meta.label}</span>
            <span className="num text-[10px] text-faint">{w.w}×{w.h}</span>
            {meta.configurable ? <button onPointerDown={(e) => e.stopPropagation()} onClick={() => onConfig(w)} className="text-faint hover:text-text" aria-label="Configure"><Icon name="settings" size={13} /></button> : null}
            <button onPointerDown={(e) => e.stopPropagation()} onClick={() => popOut(w)} className="text-faint hover:text-text" aria-label="Pop out"><Icon name="external" size={13} /></button>
            <button onPointerDown={(e) => e.stopPropagation()} onClick={() => onRemove(w.id)} className="text-faint hover:text-down" aria-label="Remove panel"><Icon name="x" size={13} /></button>
          </div>
          <div onPointerDown={(e) => onPointerDown(e, w, 'resize')} className="absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize touch-none" role="button" aria-label={`Resize ${meta.label}`}>
            <svg viewBox="0 0 20 20" className="h-full w-full text-dim"><path d="M18 8v10H8M18 13v5h-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </div>
        </>
      ) : (
        <button onClick={() => popOut(w)} className="absolute bottom-1.5 right-1.5 z-10 rounded-md border border-line bg-panel-solid/80 p-1 text-faint opacity-0 transition-opacity hover:text-text group-hover/w:opacity-100 focus:opacity-100" aria-label={`Pop out ${meta.label}`} title="Pop out into a new window">
          <Icon name="external" size={11} />
        </button>
      )}
    </div>
  );
});

function ConfigPopover({ w, onClose, onSave }: { w: WidgetInstance; onClose: () => void; onSave: (w: WidgetInstance) => void }) {
  const [title, setTitle] = useState(w.title ?? '');
  const [feed, setFeed] = useState((w.config.feed as string) ?? 'all');
  const [smart, setSmart] = useState((w.config.smartFeedId as string) ?? '');
  const [symbol, setSymbol] = useState((w.config.symbol as string) ?? 'EURUSD');
  const feeds = useDocs<SmartFeed>('smart_feeds');
  const input = 'w-full rounded-lg border border-line bg-bg-2 px-2 py-1 text-xs text-text';
  return (
    <div className="fixed inset-0 z-[65] grid place-items-center bg-black/40" onClick={onClose}>
      <div className="glass w-80 space-y-2 rounded-2xl bg-panel-solid p-4" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-semibold text-text">{WIDGETS[w.type].label}</div>
        <label className="block text-[11px] text-faint">Title<input className={input} value={title} placeholder={WIDGETS[w.type].label} onChange={(e) => setTitle(e.target.value)} /></label>
        {w.type === 'news' ? (
          <>
            <label className="block text-[11px] text-faint">Asset class<select className={input} value={feed} onChange={(e) => setFeed(e.target.value)}>{['all', 'fx', 'crypto', 'equities', 'macro', 'saved'].map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
            <label className="block text-[11px] text-faint">Smart feed<select className={input} value={smart} onChange={(e) => setSmart(e.target.value)}><option value="">None</option>{feeds.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
          </>
        ) : null}
        {w.type === 'chart' ? <label className="block text-[11px] text-faint">Symbol<input className={input} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></label> : null}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg border border-line px-2.5 py-1 text-xs text-dim">Cancel</button>
          <button onClick={() => onSave({ ...w, title: title || undefined, config: { ...w.config, ...(w.type === 'news' ? { feed: feed === 'all' ? undefined : feed, smartFeedId: smart || undefined } : {}), ...(w.type === 'chart' ? { symbol } : {}) } })} className="rounded-lg border border-accent/50 bg-accent/15 px-2.5 py-1 text-xs text-text">Save</button>
        </div>
      </div>
    </div>
  );
}

/** Free-form 12-column workspace: drag to move, drag the corner to resize, animated reflow. */
export function WorkspaceGrid({ ws, initialClusters }: { ws: Workspace; initialClusters?: NewsCluster[] }) {
  const editing = useStore((s) => s.layoutEditing);
  const calm = useCalm();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreviewState] = useState<WidgetInstance[] | null>(null);
  const previewRef = useRef<WidgetInstance[] | null>(null);
  const setPreview = (p: WidgetInstance[] | null) => {
    previewRef.current = p;
    setPreviewState(p);
  };
  const [configuring, setConfiguring] = useState<WidgetInstance | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const colW = (width - GAP * (COLS - 1)) / COLS;
  const px = useCallback((w: { x: number; y: number; w: number; h: number }) => ({ left: w.x * (colW + GAP), top: w.y * (ROW + GAP), width: w.w * colW + (w.w - 1) * GAP, height: w.h * ROW + (w.h - 1) * GAP }), [colW]);
  const items = preview ?? ws.widgets;
  const primaryNews = ws.widgets.find((w) => w.type === 'news' && !w.config.feed && !w.config.smartFeedId)?.id ?? null;

  // keyboard: undo / redo / Esc while editing
  useEffect(() => {
    if (!editing) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.getState().set({ layoutEditing: false });
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoLayout(ws);
        else undoLayout(ws);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [editing, ws]);

  const onPointerDown = useCallback((e: React.PointerEvent, w: WidgetInstance, mode: 'move' | 'resize') => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({ id: w.id, mode, startX: e.clientX, startY: e.clientY, orig: w, dx: 0, dy: 0 });
  }, []);

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      setDrag((d) => (d ? { ...d, dx, dy } : d));
      const o = drag.orig;
      const next = drag.mode === 'move'
        ? moveItem(ws.widgets, o.id, o.x + Math.round(dx / (colW + GAP)), o.y + Math.round(dy / (ROW + GAP)))
        : resizeItem(ws.widgets, o.id, o.w + Math.round(dx / (colW + GAP)), o.h + Math.round(dy / (ROW + GAP)));
      setPreview(next);
    };
    const up = () => {
      const p = previewRef.current;
      setPreview(null);
      setDrag(null);
      if (p) setWidgets(ws, p);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag?.id, drag?.mode, drag?.startX, drag?.startY, ws, colW]); // eslint-disable-line react-hooks/exhaustive-deps

  const height = gridHeight(items) * (ROW + GAP);
  const transition = calm ? undefined : 'transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1), width 260ms cubic-bezier(0.2, 0.8, 0.2, 1), height 260ms cubic-bezier(0.2, 0.8, 0.2, 1)';
  const target = drag ? items.find((i) => i.id === drag.id) : null;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden pb-6 pr-1">
      <div ref={box} className={`relative ${editing ? 'edit-dim' : ''}`} style={{ height: Math.max(height, 200) }}>
        {editing ? (
          <div aria-hidden className="pointer-events-none absolute inset-0 opacity-40" style={{ backgroundImage: `linear-gradient(to right, var(--border) 1px, transparent 1px)`, backgroundSize: `${colW + GAP}px ${ROW + GAP}px` }} />
        ) : null}
        {target ? <div className="absolute rounded-xl border-2 border-dashed border-accent/50 bg-accent/5" style={{ ...px(target), transition }} /> : null}
        {items.map((w) => {
          const p = px(w);
          const dragging = drag?.id === w.id;
          const live = dragging && drag ? (drag.mode === 'move' ? { ...px(drag.orig), left: px(drag.orig).left + drag.dx, top: px(drag.orig).top + drag.dy } : { ...px(drag.orig), width: Math.max(colW * 2, px(drag.orig).width + drag.dx), height: Math.max(ROW * 3, px(drag.orig).height + drag.dy) }) : p;
          return (
            <div key={w.id} id={`panel-${w.type}`} className={`absolute left-0 top-0 ${dragging ? 'z-20 opacity-90 shadow-2xl' : 'z-0'}`}
              style={{ transform: `translate(${live.left}px, ${live.top}px)`, width: live.width, height: live.height, transition: dragging ? 'none' : transition }}>
              <Frame w={w} editing={editing} primary={w.id === primaryNews} initialClusters={w.type === 'news' ? initialClusters : undefined} onPointerDown={onPointerDown}
                onRemove={(id) => setWidgets(ws, ws.widgets.filter((x) => x.id !== id))} onConfig={setConfiguring} />
            </div>
          );
        })}
      </div>
      {configuring ? <ConfigPopover w={configuring} onClose={() => setConfiguring(null)} onSave={(nw) => { setWidgets(ws, ws.widgets.map((x) => (x.id === nw.id ? nw : x))); setConfiguring(null); }} /> : null}
    </div>
  );
}
