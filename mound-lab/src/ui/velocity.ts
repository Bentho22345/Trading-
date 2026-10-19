// Browser glue for pitch velocity: render the frames right after release, convert to grayscale, track the ball.

import { estimateBallSpeed, type GrayFrame, type VeloEstimate } from '../core/ballspeed';
import { jn } from '../core/clean';
import { J, resolvedEvents, viewClass } from '../core/types';
import type { RuntimeClip } from '../state/store';

export const DEFAULT_HEIGHT_M = 1.83;

/** Scale factor from track pixels to the grayscale analysis frames (≤ 720 px on the long side). */
export function grayScaleFor(width: number, height: number) {
  return Math.min(1, 720 / Math.max(width, height));
}

export async function grayFrame(clip: RuntimeClip, i: number, w: number, h: number): Promise<GrayFrame> {
  const bm = await clip.source!.bitmapAt(i);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bm, 0, 0, w, h);
  bm.close();
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let k = 0, p = 0; k < g.length; k++, p += 4) g[k] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
  return { w, h, data: g };
}

export async function measureVelocity(clip: RuntimeClip): Promise<VeloEstimate> {
  const a = clip.analysis, full = clip.full;
  if (!a || !full || !clip.source) return { mph: null, low: null, high: null, method: 'none', points: [], notes: ['Analyse the clip first.'] };
  if (viewClass(a.view) !== 'S') {
    return { mph: null, low: null, high: null, method: 'none', points: [], notes: ['Velocity needs a side view: from the front or behind, the ball flies toward or away from the camera and its speed can\'t be measured from one video.'] };
  }
  const tr = full.cleaned;
  const ev = resolvedEvents(a);
  const n = tr.t.length;
  const span = Math.ceil(a.fps * 0.07) + 2; // ~70 ms of flight after release
  const from = Math.max(0, ev.BR - 1), to = Math.min(n - 1, ev.BR + span);
  const s = grayScaleFor(tr.width, tr.height);
  const w = Math.round(tr.width * s), h = Math.round(tr.height * s);
  const frames: GrayFrame[] = [];
  for (let i = from; i <= to; i++) frames.push(await grayFrame(clip, i, w, h));
  const wr = J[jn(a.roles.throw, 'Wrist')];
  const heightKnown = !!clip.record.heightM;
  const heightM = clip.record.heightM ?? DEFAULT_HEIGHT_M;
  const bodyPx = a.scale.heightPx * s;
  const pxPerM = bodyPx / heightM;
  const r = estimateBallSpeed({
    frames,
    release: { x: tr.x[wr][ev.BR] * s, y: tr.y[wr][ev.BR] * s },
    dir: a.roles.dir,
    ballDiamPx: 0.074 * pxPerM,
    bodyHeightPx: bodyPx,
    fps: a.fps,
    pxPerM,
    heightKnown,
  });
  // report ball positions in clip frame numbers and track pixels so the player can draw them
  r.points = r.points.map((p) => ({ ...p, k: from + p.k, x: p.x / s, y: p.y / s }));
  return r;
}

/** Brightness and sharpness of the pitcher region at foot strike (for the clip-quality score). */
export async function pixelStats(clip: RuntimeClip): Promise<{ brightness: number; sharpness: number } | null> {
  const a = clip.analysis, full = clip.full;
  if (!a || !full || !clip.source) return null;
  const tr = full.cleaned;
  const s = grayScaleFor(tr.width, tr.height);
  const w = Math.round(tr.width * s), h = Math.round(tr.height * s);
  const g = await grayFrame(clip, resolvedEvents(a).FS, w, h);
  // pitcher box from the skeleton at foot strike
  const i = resolvedEvents(a).FS;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j < tr.x.length; j++) { x0 = Math.min(x0, tr.x[j][i]); x1 = Math.max(x1, tr.x[j][i]); y0 = Math.min(y0, tr.y[j][i]); y1 = Math.max(y1, tr.y[j][i]); }
  const bx0 = Math.max(1, Math.floor(x0 * s)), bx1 = Math.min(w - 2, Math.ceil(x1 * s)), by0 = Math.max(1, Math.floor(y0 * s)), by1 = Math.min(h - 2, Math.ceil(y1 * s));
  if (bx1 <= bx0 || by1 <= by0) return null;
  let sum = 0, n = 0, lap = 0, lap2 = 0;
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
    const k = y * w + x, v = g.data[k];
    sum += v; n++;
    const L = 4 * v - g.data[k - 1] - g.data[k + 1] - g.data[k - w] - g.data[k + w];
    lap += L; lap2 += L * L;
  }
  const mean = lap / n;
  return { brightness: sum / n, sharpness: lap2 / n - mean * mean };
}
