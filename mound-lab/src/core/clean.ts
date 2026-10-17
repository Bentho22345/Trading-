// Track post-processing: left/right swap correction, gap filling, zero-lag filtering, role assignment.

import { ARM_PAIRS, J, LEG_PAIRS, NJ, type JointName, type PoseTrack, type Roles } from './types';
import { argmax, derivative, fillGaps, filtfilt, median } from './signal';

export interface CleanOptions {
  minConf: number;
  cutoffTrunk: number; // Hz
  cutoffLimb: number;
  cutoffDistal: number; // wrists, ankles, feet
  swapRatio: number; // swap if swapped cost < ratio * kept cost
}
export const DEFAULT_CLEAN: CleanOptions = { minConf: 0.3, cutoffTrunk: 10, cutoffLimb: 14, cutoffDistal: 18, swapRatio: 0.7 };

export function cloneTrack(t: PoseTrack): PoseTrack {
  return {
    ...t,
    t: [...t.t],
    x: t.x.map((a) => a.slice()),
    y: t.y.map((a) => a.slice()),
    c: t.c.map((a) => a.slice()),
    filled: t.filled?.map((a) => a.slice()),
  };
}

function swapAt(tr: PoseTrack, i: number, pairs: [JointName, JointName][]) {
  for (const [a, b] of pairs) {
    const ja = J[a], jb = J[b];
    [tr.x[ja][i], tr.x[jb][i]] = [tr.x[jb][i], tr.x[ja][i]];
    [tr.y[ja][i], tr.y[jb][i]] = [tr.y[jb][i], tr.y[ja][i]];
    [tr.c[ja][i], tr.c[jb][i]] = [tr.c[jb][i], tr.c[ja][i]];
  }
}

/** Frame-to-frame left/right swap correction using a constant-velocity prediction. Returns frames swapped. */
export function fixSwaps(tr: PoseTrack, ratio = DEFAULT_CLEAN.swapRatio): number[] {
  const n = tr.t.length;
  const swapped: number[] = [];
  for (const pairs of [ARM_PAIRS, LEG_PAIRS]) {
    for (let i = 1; i < n; i++) {
      let keep = 0, swap = 0;
      for (const [a, b] of pairs) {
        const ja = J[a], jb = J[b];
        const pred = (j: number, axis: Float32Array[]) => (i >= 2 ? 2 * axis[j][i - 1] - axis[j][i - 2] : axis[j][i - 1]);
        const pax = pred(ja, tr.x), pay = pred(ja, tr.y), pbx = pred(jb, tr.x), pby = pred(jb, tr.y);
        keep += Math.hypot(tr.x[ja][i] - pax, tr.y[ja][i] - pay) + Math.hypot(tr.x[jb][i] - pbx, tr.y[jb][i] - pby);
        swap += Math.hypot(tr.x[jb][i] - pax, tr.y[jb][i] - pay) + Math.hypot(tr.x[ja][i] - pbx, tr.y[ja][i] - pby);
      }
      if (swap < ratio * keep && keep > 4) { swapAt(tr, i, pairs); swapped.push(i); }
    }
  }
  return swapped;
}

/** Remove single-frame spikes (outliers far from both neighbours' average) by marking them low-confidence. */
function despike(tr: PoseTrack, heightPx: number) {
  const n = tr.t.length;
  const lim = 0.08 * heightPx;
  for (let j = 0; j < NJ; j++) {
    for (let i = 1; i < n - 1; i++) {
      const mx = (tr.x[j][i - 1] + tr.x[j][i + 1]) / 2, my = (tr.y[j][i - 1] + tr.y[j][i + 1]) / 2;
      const nb = Math.hypot(tr.x[j][i - 1] - tr.x[j][i + 1], tr.y[j][i - 1] - tr.y[j][i + 1]);
      if (Math.hypot(tr.x[j][i] - mx, tr.y[j][i] - my) > lim + 1.5 * nb) tr.c[j][i] = Math.min(tr.c[j][i], 0.01);
    }
  }
}

const DISTAL = new Set<JointName>(['lWrist', 'rWrist', 'lAnkle', 'rAnkle', 'lHeel', 'rHeel', 'lToe', 'rToe']);
const LIMB = new Set<JointName>(['lElbow', 'rElbow', 'lKnee', 'rKnee']);

export function cleanTrack(raw: PoseTrack, opt: CleanOptions = DEFAULT_CLEAN): { track: PoseTrack; swapped: number[] } {
  const tr = cloneTrack(raw);
  const n = tr.t.length;
  const roughH = roughHeightPx(tr);
  despike(tr, roughH);
  // gap-fill before swap correction so outliers don't drive swaps
  const filled: Uint8Array[] = [];
  for (let j = 0; j < NJ; j++) {
    const bad = (i: number) => tr.c[j][i] < opt.minConf;
    const fx = fillGaps(tr.x[j], bad);
    fillGaps(tr.y[j], bad);
    filled.push(fx);
  }
  const swapped = fixSwaps(tr, opt.swapRatio);
  const names = Object.keys(J) as JointName[];
  for (let j = 0; j < NJ; j++) {
    const name = names[j];
    const fc = DISTAL.has(name) ? opt.cutoffDistal : LIMB.has(name) ? opt.cutoffLimb : opt.cutoffTrunk;
    if (n >= 8) {
      tr.x[j] = filtfilt(tr.x[j], fc, tr.fps);
      tr.y[j] = filtfilt(tr.y[j], fc, tr.fps);
    }
  }
  tr.filled = filled;
  return { track: tr, swapped };
}

/** Quick height guess (px) from the vertical extent of the body over the first frames. */
export function roughHeightPx(tr: PoseTrack): number {
  const n = Math.min(tr.t.length, Math.max(5, Math.round(tr.fps * 0.3)));
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    const top = tr.y[J.nose][i];
    const bot = Math.max(tr.y[J.lAnkle][i], tr.y[J.rAnkle][i]);
    vals.push((bot - top) / 0.89);
  }
  const h = median(vals);
  return Number.isFinite(h) && h > 10 ? h : tr.height * 0.6;
}

const side = (s: 'L' | 'R') => (s === 'L' ? 'l' : 'r');
export const jn = (s: 'L' | 'R', part: string) => `${side(s)}${part}` as JointName;
export const other = (s: 'L' | 'R'): 'L' | 'R' => (s === 'L' ? 'R' : 'L');

/**
 * Data-driven roles: lead leg = knee that lifts highest relative to the hips;
 * throwing arm = wrist with the highest peak speed; direction = where the lead ankle ends up.
 */
export function assignRoles(tr: PoseTrack): Roles {
  const n = tr.t.length;
  const hipY = (i: number) => (tr.y[J.lHip][i] + tr.y[J.rHip][i]) / 2;
  let lLift = -Infinity, rLift = -Infinity;
  for (let i = 0; i < n; i++) {
    lLift = Math.max(lLift, hipY(i) - tr.y[J.lKnee][i]);
    rLift = Math.max(rLift, hipY(i) - tr.y[J.rKnee][i]);
  }
  const lead: 'L' | 'R' = lLift >= rLift ? 'L' : 'R';
  const speedPeak = (j: number) => {
    const vx = derivative(tr.x[j], tr.fps), vy = derivative(tr.y[j], tr.fps);
    let m = 0;
    for (let i = 0; i < n; i++) m = Math.max(m, Math.hypot(vx[i], vy[i]));
    return m;
  };
  const thr: 'L' | 'R' = speedPeak(J.lWrist) >= speedPeak(J.rWrist) ? 'L' : 'R';
  const la = J[jn(lead, 'Ankle')], ba = J[jn(other(lead), 'Ankle')];
  const k = Math.max(1, Math.round(n * 0.08));
  const endLead = median(Array.from(tr.x[la].subarray(n - k)));
  const startBack = median(Array.from(tr.x[ba].subarray(0, k)));
  let dir: 1 | -1 = endLead - startBack >= 0 ? 1 : -1;
  // front/back views barely translate: fall back to hip travel sign
  if (Math.abs(endLead - startBack) < 0.05 * roughHeightPx(tr)) {
    const hx = (i: number) => (tr.x[J.lHip][i] + tr.x[J.rHip][i]) / 2;
    dir = hx(n - 1) - hx(0) >= 0 ? 1 : -1;
  }
  void argmax;
  return { lead, throw: thr, dir };
}
