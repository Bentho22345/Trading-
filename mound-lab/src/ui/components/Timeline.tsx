import { useEffect, useRef } from 'react';
import { EVENT_CODES, EVENT_LABELS, type EventCode } from '../../core/types';
import { useCssColors } from './common';
import { SPEEDS, type Playback } from './playback';

export interface TimelineEvent { code: EventCode; t: number; color: string; row: 0 | 1; edited?: boolean }

export function Timeline({ duration, pb, events, onSeek }: { duration: number; pb: Playback; events: TimelineEvent[]; onSeek?: (t: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const col = useCssColors();
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const X = (t: number) => 8 + ((w - 16) * t) / Math.max(1e-6, duration);
    ctx.fillStyle = col.line; ctx.fillRect(8, h / 2 - 2, w - 16, 4);
    if (pb.loop) { ctx.fillStyle = col.accent + '33'; ctx.fillRect(X(pb.loop[0]), 4, X(pb.loop[1]) - X(pb.loop[0]), h - 8); }
    ctx.font = '600 11px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'center';
    // labels that would overlap are staggered (layback, release and end of decel are only ~40 ms apart)
    const lastX: Record<number, number> = { 0: -1e9, 1: -1e9 };
    const lane: Record<number, number> = { 0: 0, 1: 0 };
    for (const e of [...events].sort((p, q) => p.t - q.t)) {
      const x = X(e.t);
      const y0 = e.row === 0 ? 4 : h / 2 + 2, y1 = e.row === 0 ? h / 2 - 2 : h - 14;
      ctx.strokeStyle = e.color; ctx.lineWidth = 2;
      ctx.setLineDash(e.edited ? [3, 2] : []);
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = e.color;
      lane[e.row] = x - lastX[e.row] < 26 ? (lane[e.row] + 1) % 3 : 0;
      lastX[e.row] = x;
      const ty = (e.row === 0 ? h / 2 + 12 : h - 2) - lane[e.row] * (e.row === 0 ? -0 : 0);
      ctx.textAlign = lane[e.row] === 1 ? 'left' : lane[e.row] === 2 ? 'right' : 'center';
      ctx.fillText(e.code, x + (lane[e.row] === 1 ? 3 : lane[e.row] === 2 ? -3 : 0), ty);
      ctx.textAlign = 'center';
    }
    const x = X(pb.t);
    ctx.fillStyle = col.text; ctx.fillRect(x - 1.5, 0, 3, h);
    ctx.beginPath(); ctx.moveTo(x - 6, 0); ctx.lineTo(x + 6, 0); ctx.lineTo(x, 7); ctx.fill();
  }, [duration, pb.t, pb.loop, events, col]);

  const seekFromEvent = (clientX: number) => {
    const c = ref.current!;
    const r = c.getBoundingClientRect();
    const t = ((clientX - r.left - 8) / (r.width - 16)) * duration;
    const tt = Math.max(0, Math.min(duration, t));
    pb.pause(); pb.setT(tt); onSeek?.(tt);
  };
  return (
    <div
      className="timeline"
      role="slider"
      aria-label="Timeline"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration * 1000)}
      aria-valuenow={Math.round(pb.t * 1000)}
      tabIndex={0}
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); seekFromEvent(e.clientX); }}
      onPointerMove={(e) => { if (e.buttons) seekFromEvent(e.clientX); }}
    >
      <canvas ref={ref} />
    </div>
  );
}

export function EventButtons({ pb, eventTimes }: { pb: Playback; eventTimes: Partial<Record<EventCode, number>> }) {
  const jump = (k: EventCode) => { const t = eventTimes[k]; if (t !== undefined) { pb.pause(); pb.setT(t); } };
  return (
    <div className="event-buttons" role="group" aria-label="Jump to event">
      {EVENT_CODES.map((k, i) => (
        <button key={k} className="small" onClick={() => jump(k)} disabled={eventTimes[k] === undefined} title={`${EVENT_LABELS[k]} (${i + 1})`}>{k}</button>
      ))}
      <button className="small ghost" onClick={() => {
        if (pb.loop) pb.setLoop(null);
        else if (eventTimes.FS !== undefined && eventTimes.MIR !== undefined) pb.setLoop([Math.max(0, (eventTimes.PKH ?? eventTimes.FS) - 0.05), eventTimes.MIR + 0.05]);
      }}>{pb.loop ? 'Loop off' : 'Loop leg lift → finish'}</button>
    </div>
  );
}

/** Play/step/speed controls. With `split`, the event buttons are rendered separately by the caller. */
export function TransportBar({ pb, fps, eventTimes, tour, setTour, extra, split }: {
  pb: Playback; fps: number; eventTimes: Partial<Record<EventCode, number>>; tour?: boolean; setTour?: (v: boolean) => void; extra?: React.ReactNode; split?: boolean;
}) {
  return (
    <div className="stack" style={{ marginTop: 6 }}>
      <div className="controls">
        <button className="icon" onClick={() => pb.step(-1)} aria-label="Previous frame" title="Previous frame (←)">◀︎|</button>
        <button className="primary" onClick={pb.toggle} aria-label={pb.playing ? 'Pause' : 'Play'} title="Play/pause (space)" style={{ minWidth: 84 }}>{pb.playing ? 'Pause' : 'Play'}</button>
        <button className="icon" onClick={() => pb.step(1)} aria-label="Next frame" title="Next frame (→)">|▶︎</button>
        <div className="seg" role="group" aria-label="Speed">
          {SPEEDS.map((s) => <button key={s} aria-pressed={pb.speed === s} onClick={() => pb.setSpeed(s)}>{s}×</button>)}
        </div>
        <span className="mono small muted" aria-live="off">{(pb.t * 1000).toFixed(0)} ms · frame {Math.round(pb.t * fps)}</span>
        {setTour && <label className="small row tight hide-phone"><input type="checkbox" checked={!!tour} onChange={(e) => setTour(e.target.checked)} /> Pause at events</label>}
        {extra}
      </div>
      {!split && <EventButtons pb={pb} eventTimes={eventTimes} />}
    </div>
  );
}
