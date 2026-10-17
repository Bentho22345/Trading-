// Canvas line chart (handles thousands of points) with event lines, a cursor and click-to-seek.

import { useEffect, useRef } from 'react';
import { useCssColors } from './common';

export interface ChartSeries { t: ArrayLike<number>; y: ArrayLike<number>; color: string; label: string; dashed?: boolean }
export interface ChartEvent { t: number; label: string; color?: string }

export function LineChart({ series, events = [], cursor, unit, onSeek, height = 190, xLabel = 's from foot strike', title }: {
  series: ChartSeries[]; events?: ChartEvent[]; cursor?: number; unit: string; onSeek?: (t: number) => void; height?: number; xLabel?: string; title?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const col = useCssColors();
  const box = useRef({ x0: 0, x1: 1, padL: 44, w: 1 });
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of series) for (let i = 0; i < s.t.length; i++) {
      const y = s.y[i];
      if (!Number.isFinite(y)) continue;
      x0 = Math.min(x0, s.t[i]); x1 = Math.max(x1, s.t[i]); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (!Number.isFinite(x0)) return;
    const pad = (y1 - y0) * 0.08 || 1; y0 -= pad; y1 += pad;
    const padL = 44, padB = 20, padT = 8, padR = 8;
    box.current = { x0, x1, padL, w: w - padL - padR };
    const X = (t: number) => padL + ((t - x0) / (x1 - x0 || 1)) * (w - padL - padR);
    const Y = (v: number) => padT + (1 - (v - y0) / (y1 - y0 || 1)) * (h - padT - padB);
    // grid
    ctx.strokeStyle = col.line; ctx.lineWidth = 1; ctx.fillStyle = col.text3; ctx.font = '11px "IBM Plex Mono", monospace';
    const step = niceStep((y1 - y0) / 4);
    for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) {
      ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(w - padR, Y(v)); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillText(fmt(v), padL - 4, Y(v) + 3);
    }
    const xs = niceStep((x1 - x0) / 6);
    ctx.textAlign = 'center';
    for (let v = Math.ceil(x0 / xs) * xs; v <= x1; v += xs) ctx.fillText(fmt(v), X(v), h - 5);
    if (y0 < 0 && y1 > 0) { ctx.strokeStyle = col.text3; ctx.beginPath(); ctx.moveTo(padL, Y(0)); ctx.lineTo(w - padR, Y(0)); ctx.stroke(); }
    // events
    ctx.font = '600 11px "Barlow Condensed", sans-serif';
    for (const e of events) {
      if (e.t < x0 || e.t > x1) continue;
      ctx.strokeStyle = e.color ?? col.text3; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(e.t), padT); ctx.lineTo(X(e.t), h - padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = e.color ?? col.text3; ctx.fillText(e.label, X(e.t), padT + 9);
    }
    // series
    for (const s of series) {
      ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.setLineDash(s.dashed ? [5, 4] : []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < s.t.length; i++) {
        const y = s.y[i];
        if (!Number.isFinite(y)) { started = false; continue; }
        if (!started) { ctx.moveTo(X(s.t[i]), Y(y)); started = true; } else ctx.lineTo(X(s.t[i]), Y(y));
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (cursor !== undefined && cursor >= x0 && cursor <= x1) {
      ctx.strokeStyle = col.text; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(X(cursor), padT); ctx.lineTo(X(cursor), h - padB); ctx.stroke();
    }
  }, [series, events, cursor, col]);
  return (
    <figure style={{ margin: 0 }}>
      {title && <figcaption className="small" style={{ fontWeight: 600, marginBottom: 2 }}>{title} <span className="faint">({unit}; x: {xLabel})</span></figcaption>}
      <canvas
        ref={ref}
        className="chart"
        style={{ height }}
        role="img"
        aria-label={`${title ?? 'Chart'}: ${series.map((s) => s.label).join(' vs ')}`}
        onClick={(e) => {
          if (!onSeek) return;
          const r = e.currentTarget.getBoundingClientRect();
          const b = box.current;
          onSeek(b.x0 + ((e.clientX - r.left - b.padL) / b.w) * (b.x1 - b.x0));
        }}
      />
      <div className="legend">{series.map((s) => <span key={s.label}><i style={{ background: s.color }} />{s.label}</span>)}</div>
    </figure>
  );
}

/** Angle–angle (x vs y) plot of two series over the delivery. */
export function AngleAngle({ sets, xLabel, yLabel, height = 220 }: { sets: { x: ArrayLike<number>; y: ArrayLike<number>; color: string; label: string; from: number; to: number; mark?: number }[]; xLabel: string; yLabel: string; height?: number }) {
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
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of sets) for (let i = s.from; i <= s.to; i++) { x0 = Math.min(x0, s.x[i]); x1 = Math.max(x1, s.x[i]); y0 = Math.min(y0, s.y[i]); y1 = Math.max(y1, s.y[i]); }
    if (!Number.isFinite(x0)) return;
    const p = 36;
    const X = (v: number) => p + ((v - x0) / (x1 - x0 || 1)) * (w - p - 8);
    const Y = (v: number) => 8 + (1 - (v - y0) / (y1 - y0 || 1)) * (h - p - 8);
    ctx.fillStyle = col.text3; ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.fillText(`${fmt(y1)}`, 2, 14); ctx.fillText(`${fmt(y0)}`, 2, h - p);
    ctx.textAlign = 'center'; ctx.fillText(`${fmt(x0)}`, p, h - p + 14); ctx.fillText(`${fmt(x1)}`, w - 20, h - p + 14);
    ctx.fillText(xLabel, w / 2, h - 6);
    for (const s of sets) {
      ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = s.from; i <= s.to; i++) (i === s.from ? ctx.moveTo : ctx.lineTo).call(ctx, X(s.x[i]), Y(s.y[i]));
      ctx.stroke();
      if (s.mark !== undefined) { ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(X(s.x[s.mark]), Y(s.y[s.mark]), 5, 0, Math.PI * 2); ctx.fill(); }
    }
  }, [sets, col, xLabel]);
  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="small" style={{ fontWeight: 600 }}>{yLabel} vs {xLabel} <span className="faint">(foot strike → finish; dot = release)</span></figcaption>
      <canvas ref={ref} className="chart" style={{ height }} role="img" aria-label={`${yLabel} versus ${xLabel}`} />
      <div className="legend">{sets.map((s) => <span key={s.label}><i style={{ background: s.color }} />{s.label}</span>)}</div>
    </figure>
  );
}

function niceStep(raw: number) {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));
