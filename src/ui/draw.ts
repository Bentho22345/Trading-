// Canvas drawing helpers: fitting, skeleton overlays, trails, angle labels, difference arrows.

import { BONES, J, type Analysis, type JointName, type PoseTrack } from '../core/types';
import { jn, other } from '../core/clean';

export interface Affine { sx: number; sy: number; tx: number; ty: number } // track px → canvas px

export function fit(srcW: number, srcH: number, dstW: number, dstH: number): Affine & { w: number; h: number } {
  const s = Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * s, h = srcH * s;
  return { sx: s, sy: s, tx: (dstW - w) / 2, ty: (dstH - h) / 2, w, h };
}

export const compose = (a: Affine, b: Affine): Affine => ({ sx: a.sx * b.sx, sy: a.sy * b.sy, tx: a.sx * b.tx + a.tx, ty: a.sy * b.ty + a.ty }); // a∘b

/** Map B's pixel space into A's pixel space: same rubber point, same ground line, same body height; mirror if needed. */
export function normalizeBtoA(a: Analysis, b: Analysis): Affine {
  const k = a.scale.heightPx / b.scale.heightPx;
  const m = a.roles.dir === b.roles.dir ? 1 : -1;
  return { sx: m * k, sy: k, tx: a.scale.originX - m * k * b.scale.originX, ty: a.scale.groundY - k * b.scale.groundY };
}

export const pt = (tr: PoseTrack, j: number, i: number, T: Affine): [number, number] => [tr.x[j][i] * T.sx + T.tx, tr.y[j][i] * T.sy + T.ty];

export interface SkeletonStyle {
  color: string;
  width?: number;
  alpha?: number;
  jointRadius?: number;
  showConfidence?: boolean;
  highlight?: Partial<Record<JointName, string>>;
}

export function drawSkeleton(ctx: CanvasRenderingContext2D, tr: PoseTrack, i: number, T: Affine, st: SkeletonStyle) {
  i = Math.max(0, Math.min(tr.t.length - 1, Math.round(i)));
  ctx.save();
  ctx.globalAlpha = st.alpha ?? 1;
  ctx.lineCap = 'round';
  ctx.lineWidth = st.width ?? 3;
  for (const [a, b] of BONES) {
    const ja = J[a], jb = J[b];
    const conf = Math.min(tr.c[ja][i], tr.c[jb][i]);
    const filled = tr.filled?.[ja]?.[i] || tr.filled?.[jb]?.[i];
    ctx.strokeStyle = st.color;
    ctx.setLineDash(filled || (st.showConfidence && conf < 0.5) ? [4, 4] : []);
    const [x1, y1] = pt(tr, ja, i, T), [x2, y2] = pt(tr, jb, i, T);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.setLineDash([]);
  const r = st.jointRadius ?? 3.5;
  for (const [name, j] of Object.entries(J) as [JointName, number][]) {
    const [x, y] = pt(tr, j, i, T);
    ctx.fillStyle = st.highlight?.[name] ?? st.color;
    ctx.beginPath(); ctx.arc(x, y, st.highlight?.[name] ? r * 1.8 : r, 0, Math.PI * 2); ctx.fill();
    if (st.showConfidence && tr.c[j][i] < 0.5) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke(); }
  }
  // head
  const [nx, ny] = pt(tr, J.nose, i, T);
  ctx.strokeStyle = st.color; ctx.lineWidth = st.width ?? 3;
  ctx.beginPath(); ctx.arc(nx, ny, 9 * Math.abs(T.sy), 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

export function drawTrail(ctx: CanvasRenderingContext2D, tr: PoseTrack, j: number, from: number, to: number, T: Affine, color: string) {
  from = Math.max(0, from); to = Math.min(tr.t.length - 1, to);
  if (to <= from) return;
  ctx.save();
  ctx.lineWidth = 2; ctx.lineCap = 'round';
  for (let i = from + 1; i <= to; i++) {
    ctx.globalAlpha = 0.15 + 0.75 * ((i - from) / (to - from));
    ctx.strokeStyle = color;
    const [x1, y1] = pt(tr, j, i - 1, T), [x2, y2] = pt(tr, j, i, T);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.restore();
}

export function label(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string) {
  ctx.save();
  ctx.font = '600 12px "IBM Plex Mono", monospace';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(x, y - 13, w, 17);
  ctx.fillStyle = color; ctx.fillText(text, x + 4, y);
  ctx.restore();
}

/** Angle labels for the key joints of the current frame (from analysis series). */
export function drawAngleLabels(ctx: CanvasRenderingContext2D, tr: PoseTrack, a: Analysis, i: number, T: Affine, color: string) {
  i = Math.max(0, Math.min(tr.t.length - 1, Math.round(i)));
  const s = a.series;
  const at = (seg: string) => pt(tr, J[seg as JointName], i, T);
  const lk = at(jn(a.roles.lead, 'Knee'));
  const el = at(jn(a.roles.throw, 'Elbow'));
  const hip = at(jn(other(a.roles.lead), 'Hip'));
  if (s.leadKneeFlex) label(ctx, lk[0] + 8, lk[1], `knee ${Math.round(s.leadKneeFlex[i])}°`, color);
  if (s.elbowFlex) label(ctx, el[0] + 8, el[1], `elbow ${Math.round(s.elbowFlex[i])}°`, color);
  if (s.trunkTilt) label(ctx, hip[0] + 8, hip[1] - 18, `trunk ${Math.round(s.trunkTilt[i])}°`, color);
}

export function arrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string) {
  const a = Math.atan2(y2 - y1, x2 - x1), h = 8;
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - h * Math.cos(a - 0.45), y2 - h * Math.sin(a - 0.45));
  ctx.lineTo(x2 - h * Math.cos(a + 0.45), y2 - h * Math.sin(a + 0.45));
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

/**
 * View transform for the players. With `zoom`, frames the pitcher (all joints between `from` and `to`,
 * padded) instead of the whole picture — essential for far cameras where the pitcher is a few % of the frame.
 */
export function pitcherView(tr: PoseTrack, from: number, to: number, w: number, h: number, zoom: boolean): Affine & { w: number; h: number } {
  if (!zoom) return fit(tr.width, tr.height, w, h);
  const xs: number[] = [], ys: number[] = [];
  const step = Math.max(1, Math.floor((to - from) / 60));
  for (let i = Math.max(0, from); i <= Math.min(tr.t.length - 1, to); i += step) for (let j = 0; j < tr.x.length; j++) { xs.push(tr.x[j][i]); ys.push(tr.y[j][i]); }
  if (!xs.length) return fit(tr.width, tr.height, w, h);
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
  let x0 = q(xs, 0.01), x1 = q(xs, 0.99), y0 = q(ys, 0.01), y1 = q(ys, 0.99);
  const pad = 0.18 * Math.max(x1 - x0, y1 - y0);
  x0 -= pad; x1 += pad; y0 -= pad * 1.4; y1 += pad * 0.6;
  // match the canvas aspect so nothing is stretched
  const bw = x1 - x0, bh = y1 - y0, ar = w / h;
  if (bw / bh < ar) { const nw = bh * ar; x0 -= (nw - bw) / 2; x1 = x0 + nw; } else { const nh = bw / ar; y0 -= (nh - bh) / 2; y1 = y0 + nh; }
  const s = Math.min(w / (x1 - x0), h / (y1 - y0));
  if (s * tr.width <= w * 1.05) return fit(tr.width, tr.height, w, h); // zooming wouldn't help
  return { sx: s, sy: s, tx: -x0 * s, ty: -y0 * s, w: tr.width * s, h: tr.height * s };
}

export const isSmallPitcher = (heightPx: number, frameH: number) => heightPx < 0.42 * frameH;
