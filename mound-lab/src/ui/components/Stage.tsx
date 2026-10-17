// A responsive canvas that redraws via a callback whenever its inputs (or async frames) change.

import { useEffect, useRef, useState } from 'react';

export function Stage({ draw, deps, aspect = 16 / 9, onPointer, label, hud, sources = [] }: {
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  deps: unknown[];
  aspect?: number;
  onPointer?: (kind: 'down' | 'move' | 'up', x: number, y: number, w: number, h: number) => void;
  label: string;
  hud?: React.ReactNode;
  sources?: ({ subscribe(cb: () => void): () => void } | undefined)[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 640, h: 360 });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const c = ref.current!;
    const ro = new ResizeObserver(() => setSize({ w: c.clientWidth, h: c.clientHeight }));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    let pending = false;
    const cb = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; setTick((t) => t + 1); }); } };
    const offs = sources.map((s) => s?.subscribe(cb));
    return () => offs.forEach((off) => off?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, sources);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0d10'; ctx.fillRect(0, 0, size.w, size.h);
    draw(ctx, size.w, size.h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, size, tick]);
  const ptr = (kind: 'down' | 'move' | 'up') => (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onPointer) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (kind === 'down') e.currentTarget.setPointerCapture(e.pointerId);
    onPointer(kind, e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  };
  return (
    <div className="player" style={{ aspectRatio: String(aspect) }}>
      <canvas ref={ref} role="img" aria-label={label} onPointerDown={ptr('down')} onPointerMove={ptr('move')} onPointerUp={ptr('up')} />
      {hud && <div className="hud">{hud}</div>}
    </div>
  );
}
