// Time mapping between two clips for synchronized playback: phase warp, real-time at an event, and DTW.

import type { Events, EventCode } from './types';
import type { Body } from './body';

export type SyncMode = 'phase' | 'event' | 'dtw';

export interface ClipTiming {
  n: number;
  fps: number;
  events: Events;
}

/**
 * A shared "master" timeline in A's real time. mapAtoB(tA) gives the matching time in B.
 * Phase mode: piecewise-linear between matched events so both reach each event together.
 */
const ORDER: EventCode[] = ['FM', 'PKH', 'HS', 'FS', 'MER', 'BR', 'MIR', 'END'];

function anchors(a: ClipTiming, b: ClipTiming): [number, number][] {
  const pts: [number, number][] = [[0, 0]];
  for (const k of ORDER) {
    const ta = a.events[k] / a.fps, tb = b.events[k] / b.fps;
    const last = pts[pts.length - 1];
    if (ta > last[0] && tb > last[1]) pts.push([ta, tb]);
  }
  const endA = (a.n - 1) / a.fps, endB = (b.n - 1) / b.fps;
  const last = pts[pts.length - 1];
  if (endA > last[0] && endB > last[1]) pts.push([endA, endB]);
  return pts;
}

function piecewise(pts: [number, number][], t: number): number {
  if (pts.length < 2) return t;
  if (t <= pts[0][0]) return pts[0][1] + (t - pts[0][0]);
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + ((t - x0) * (y1 - y0)) / (x1 - x0);
    }
  }
  const [xl, yl] = pts[pts.length - 1];
  return yl + (t - xl);
}

export function makeSync(mode: SyncMode, a: ClipTiming, b: ClipTiming, opts: { event?: EventCode; bodyA?: Body; bodyB?: Body } = {}): (tA: number) => number {
  if (mode === 'event') {
    const ev = opts.event ?? 'FS';
    const off = b.events[ev] / b.fps - a.events[ev] / a.fps;
    return (t) => t + off;
  }
  if (mode === 'dtw' && opts.bodyA && opts.bodyB) {
    const path = dtwPath(opts.bodyA, opts.bodyB);
    return (t) => piecewise(path, t);
  }
  const pts = anchors(a, b);
  return (t) => piecewise(pts, t);
}

/** Feature vector per frame: normalised joint angles and positions (scale-free). */
function features(b: Body, rate: number): { f: number[][]; t: number[] } {
  const step = Math.max(1, Math.round(b.fps / rate));
  const f: number[][] = [], t: number[] = [];
  for (let i = 0; i < b.n; i += step) {
    const rel = (s: keyof Body['u']) => [b.u[s][i] - b.u.hipC[i], b.v[s][i] - b.v.hipC[i]];
    f.push([...rel('leadKnee'), ...rel('leadAnkle'), ...rel('throwWrist'), ...rel('throwElbow'), ...rel('gloveWrist'), ...rel('shC'), ...rel('backAnkle')]);
    t.push(b.t[i]);
  }
  return { f, t };
}

/** Dynamic time warping (Sakoe-Chiba band) on pose features; returns monotone (tA, tB) anchor pairs. */
export function dtwPath(A: Body, B: Body, rate = 60): [number, number][] {
  const fa = features(A, rate), fb = features(B, rate);
  const n = fa.f.length, m = fb.f.length;
  const band = Math.max(Math.abs(n - m) + 5, Math.round(Math.max(n, m) * 0.25));
  const INF = 1e18;
  const D = new Float64Array((n + 1) * (m + 1)).fill(INF);
  const idx = (i: number, j: number) => i * (m + 1) + j;
  D[0] = 0;
  const dist = (x: number[], y: number[]) => { let s = 0; for (let k = 0; k < x.length; k++) s += (x[k] - y[k]) ** 2; return Math.sqrt(s); };
  for (let i = 1; i <= n; i++) {
    const jc = Math.round((i * m) / n);
    for (let j = Math.max(1, jc - band); j <= Math.min(m, jc + band); j++) {
      const c = dist(fa.f[i - 1], fb.f[j - 1]);
      D[idx(i, j)] = c + Math.min(D[idx(i - 1, j)], D[idx(i, j - 1)], D[idx(i - 1, j - 1)]);
    }
  }
  const path: [number, number][] = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    path.push([fa.t[i - 1], fb.t[j - 1]]);
    const diag = D[idx(i - 1, j - 1)], up = D[idx(i - 1, j)], left = D[idx(i, j - 1)];
    if (diag <= up && diag <= left) { i--; j--; } else if (up < left) i--; else j--;
  }
  path.reverse();
  // keep strictly increasing in both coordinates
  const out: [number, number][] = [];
  for (const p of path) {
    const last = out[out.length - 1];
    if (!last || (p[0] > last[0] && p[1] > last[1])) out.push(p);
  }
  return out;
}
