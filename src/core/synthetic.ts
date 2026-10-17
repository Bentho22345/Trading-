// Parametric synthetic pitcher (side view, open side) used for the regression suite and the demo.
// Everything is generated in body units (fraction of standing height H): u = forward toward the plate
// from the rubber, v = up from the ground. Joint positions are then projected to image pixels.

import { J, NJ, type EventCode, type PoseTrack, type JointName } from './types';

export interface PitchParams {
  name: string;
  hand: 'R' | 'L';
  fps: number;
  duration: number;
  times: Record<EventCode, number>; // seconds
  stride: number; // ankle-to-ankle at FS, fraction of H
  leadKneeFS: number; // lead knee flexion at FS (deg)
  leadKneeBR: number;
  trunkTiltFS: number; // forward trunk tilt (deg)
  trunkTiltBR: number;
  throwUpperFS: number; // upper-arm direction at FS (deg, 0 = toward plate, ccw, continuous)
  throwForearmFS: number; // forearm direction at FS
  gloveUpperBR: number;
  gloveForearmBR: number;
  legLiftAnkleV: number; // lead ankle height at PKH
  noise: number; // gaussian position noise, fraction of H
  dropouts: number; // number of low-confidence frames to inject
  swaps: number; // number of frames with left/right arm labels swapped
  seed: number;
  heightPx: number;
}

export const GOOD_DAY: PitchParams = {
  name: 'Good day',
  hand: 'R',
  fps: 240,
  duration: 2.6,
  times: { FM: 0.35, PKH: 1.0, HS: 1.08, FS: 1.55, MER: 1.665, BR: 1.7, MIR: 1.76, END: 2.25 },
  stride: 0.86,
  leadKneeFS: 46,
  leadKneeBR: 32,
  trunkTiltFS: 2,
  trunkTiltBR: 36,
  throwUpperFS: -175,
  throwForearmFS: -245,
  gloveUpperBR: -70,
  gloveForearmBR: 60,
  legLiftAnkleV: 0.4,
  noise: 0.0015,
  dropouts: 4,
  swaps: 3,
  seed: 7,
  heightPx: 420,
};

/** "Off day": shorter stride, late arm at foot strike, front knee collapsing, upright trunk, glove flying open. */
export const OFF_DAY: PitchParams = {
  ...GOOD_DAY,
  name: 'Off day',
  times: { FM: 0.35, PKH: 1.0, HS: 1.08, FS: 1.52, MER: 1.65, BR: 1.69, MIR: 1.75, END: 2.22 },
  stride: 0.76,
  leadKneeFS: 47,
  leadKneeBR: 54,
  trunkTiltBR: 23,
  throwUpperFS: -160,
  throwForearmFS: -175,
  gloveUpperBR: -10,
  gloveForearmBR: -30,
  seed: 11,
};

const T = 0.245, S = 0.246; // thigh, shank
const UA = 0.186, FA = 0.146; // upper arm, forearm
const TRUNK = 0.29, HW = 0.18, SW = 0.25;
const ANKLE_H = 0.04;

// ---------- interpolation helpers ----------
/** Monotone cubic (Fritsch–Carlson) interpolation through keyframes. */
export function monotone(keys: [number, number][]): (t: number) => number {
  const k = [...keys].sort((a, b) => a[0] - b[0]);
  const n = k.length;
  const xs = k.map((p) => p[0]), ys = k.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1e-9));
  const m: number[] = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  m[0] = 0; m[n - 1] = 0;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); m[i] = tau * a * d[i]; m[i + 1] = tau * b * d[i]; }
  }
  return (t: number) => {
    if (t <= xs[0]) return ys[0];
    if (t >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (t > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const s = (t - xs[i]) / h;
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
  };
}

function erf(x: number): number {
  // Abramowitz–Stegun 7.1.26
  const s = Math.sign(x), a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(1e-12, next()), v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { next, gauss };
}

type P2 = [number, number];
const dirv = (degA: number): P2 => [Math.cos((degA * Math.PI) / 180), Math.sin((degA * Math.PI) / 180)];
const add = (a: P2, b: P2, s = 1): P2 => [a[0] + b[0] * s, a[1] + b[1] * s];

/** Two-link IK: knee/elbow position with the joint bent toward +u (bend = +1) side. */
function ik(root: P2, end: P2, l1: number, l2: number, bend: 1 | -1): P2 {
  const dx = end[0] - root[0], dy = end[1] - root[1];
  const d = Math.min(Math.hypot(dx, dy), l1 + l2 - 1e-6);
  const base = Math.atan2(dy, dx);
  const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const a = Math.acos(Math.max(-1, Math.min(1, cosA)));
  // rotate so the joint lies on the forward side when the limb hangs downward
  const ang = base + bend * a;
  return [root[0] + l1 * Math.cos(ang), root[1] + l1 * Math.sin(ang)];
}

/** Hip-to-ankle distance for a given knee flexion. */
const legReach = (flexDeg: number) => Math.sqrt(T * T + S * S + 2 * T * S * Math.cos((flexDeg * Math.PI) / 180));

export interface SyntheticPitch {
  params: PitchParams;
  track: PoseTrack; // noisy, labelled like a pose model would
  clean: PoseTrack; // noise-free
  truth: Record<EventCode, number>; // frame indices
  /** Body-unit positions per frame for rendering the demo body. */
  body: Record<JointName, P2>[];
}

export function generatePitch(p: PitchParams): SyntheticPitch {
  const tm = p.times;
  const n = Math.round(p.duration * p.fps);
  const r = rng(p.seed);
  const pelvisRot = monotone([[0, 0], [tm.PKH, -5], [tm.FS, 30], [tm.BR, 90], [tm.END, 120]]);
  const trunkRot = monotone([[0, 0], [tm.PKH, -10], [tm.FS, 0], [tm.MER, 70], [tm.BR, 95], [tm.END, 150]]);
  const tilt = monotone([[0, 0], [tm.FM, 0], [tm.PKH, -4], [tm.FS, p.trunkTiltFS], [tm.MER, (p.trunkTiltFS + p.trunkTiltBR) / 2 + 4], [tm.BR, p.trunkTiltBR], [tm.MIR, p.trunkTiltBR + 8], [tm.END, p.trunkTiltBR + 2], [p.duration, p.trunkTiltBR + 2]]);

  // Pelvis: x keyframed, y solved from lead-knee flexion after foot strike
  const offFS = (HW / 2) * Math.cos((pelvisRot(tm.FS) * Math.PI) / 180);
  const dxFS = 0.33, dxBR = 0.12;
  const hipXFS = p.stride - dxFS - offFS;
  const hipYFS = ANKLE_H + Math.sqrt(legReach(p.leadKneeFS) ** 2 - dxFS ** 2);
  const hipX = monotone([[0, 0.07], [tm.FM, 0.07], [tm.PKH, 0.03], [tm.FS, hipXFS], [tm.BR, p.stride - dxBR], [tm.MIR, p.stride - 0.05], [tm.END, p.stride + 0.05], [p.duration, p.stride + 0.05]]);
  const hipYpre = monotone([[0, 0.52], [tm.FM, 0.52], [tm.PKH, 0.53], [tm.FS, hipYFS]]);
  const leadFlex = monotone([[tm.FS, p.leadKneeFS], [tm.BR, p.leadKneeBR], [tm.MIR, p.leadKneeBR - 2], [tm.END, Math.max(10, p.leadKneeBR - 15)], [p.duration, Math.max(10, p.leadKneeBR - 15)]]);

  // Lead ankle path
  const pkhAnkleU = 0.17;
  const leadPre = { x: monotone([[0, 0.15], [tm.FM, 0.15], [tm.PKH, pkhAnkleU]]), y: monotone([[0, ANKLE_H], [tm.FM, ANKLE_H], [tm.PKH, p.legLiftAnkleV]]) };

  // Throwing arm angles
  const thrUpperPre = monotone([[0, -80], [tm.HS, -80], [tm.HS + 0.15, -130], [tm.FS, p.throwUpperFS], [tm.MER, -190]]);
  const thrForePre = monotone([[0, 40], [tm.HS, 40], [tm.HS + 0.18, -100], [tm.FS, p.throwForearmFS], [tm.MER, -185]]);
  const projUpper = monotone([[0, 1], [tm.FS, 1], [tm.MER, 0.85], [tm.BR, 1], [p.duration, 1]]);
  const sigma = 0.017;
  const u0 = (tm.MER - tm.BR) / sigma;
  const whip = (t: number) => (erf((t - tm.BR) / sigma) - erf(u0)) / (1 - erf(u0));
  const upperMER = thrUpperPre(tm.MER), foreMER = thrForePre(tm.MER);
  const upperFT = -420, foreFT = -460;

  // Glove arm
  const gloveUpper = monotone([[0, -80], [tm.HS, -80], [tm.HS + 0.2, -20], [tm.FS, 10], [tm.BR, p.gloveUpperBR], [tm.END, -85], [p.duration, -85]]);
  const gloveFore = monotone([[0, 40], [tm.HS, 40], [tm.HS + 0.2, 10], [tm.FS, 20], [tm.BR, p.gloveForearmBR], [tm.END, 75], [p.duration, 75]]);

  const body: Record<JointName, P2>[] = [];
  let backAnkle: P2 = [0, ANKLE_H];
  let backAnkleBR: P2 | null = null;
  for (let i = 0; i < n; i++) {
    const t = i / p.fps;
    const pr = pelvisRot(t), trr = trunkRot(t);
    const hipOff = (HW / 2) * Math.cos((pr * Math.PI) / 180);
    const shOff = (SW / 2) * Math.cos((trr * Math.PI) / 180);

    // lead ankle
    let leadAnkle: P2;
    if (t <= tm.PKH) leadAnkle = [leadPre.x(t), leadPre.y(t)];
    else if (t < tm.FS) {
      const s = (t - tm.PKH) / (tm.FS - tm.PKH);
      const g = (1 - Math.cos(Math.PI * 0.9 * s)) / (1 - Math.cos(Math.PI * 0.9));
      const h = (1 - s) ** 2 * (1 + 2 * s);
      leadAnkle = [pkhAnkleU + (p.stride - pkhAnkleU) * g, ANKLE_H + (p.legLiftAnkleV - ANKLE_H) * h];
    } else leadAnkle = [p.stride, ANKLE_H];

    // pelvis
    const hx = hipX(t);
    let hy: number;
    if (t < tm.FS) hy = hipYpre(t);
    else {
      const leadHipX = hx + hipOff;
      const dx = Math.min(Math.abs(p.stride - leadHipX), legReach(leadFlex(t)) - 1e-4);
      hy = ANKLE_H + Math.sqrt(legReach(leadFlex(t)) ** 2 - dx * dx);
    }
    const hipC: P2 = [hx, hy];
    const leadHip: P2 = [hx + hipOff, hy];
    const backHip: P2 = [hx - hipOff, hy];

    // back ankle: on the rubber until the leg is fully extended, then dragged; recovers in follow-through
    if (t <= tm.BR) {
      const dist = Math.hypot(backHip[0] - backAnkle[0], backHip[1] - backAnkle[1]);
      const maxL = T + S - 0.004;
      if (dist > maxL) {
        const k = (dist - maxL) / dist;
        backAnkle = [backAnkle[0] + (backHip[0] - backAnkle[0]) * k, Math.max(ANKLE_H, backAnkle[1] + (backHip[1] - backAnkle[1]) * k)];
      }
      backAnkleBR = backAnkle;
    } else {
      const b0 = backAnkleBR ?? backAnkle;
      const s = Math.min(1, (t - tm.BR) / (tm.END - tm.BR));
      const e = s * s * (3 - 2 * s);
      backAnkle = [b0[0] + (p.stride - 0.05 - b0[0]) * e, ANKLE_H + 0.18 * Math.sin(Math.PI * e)];
      const dist = Math.hypot(backHip[0] - backAnkle[0], backHip[1] - backAnkle[1]);
      if (dist > T + S - 0.004) {
        const k = (dist - (T + S - 0.004)) / dist;
        backAnkle = [backAnkle[0] + (backHip[0] - backAnkle[0]) * k, backAnkle[1] + (backHip[1] - backAnkle[1]) * k];
      }
    }
    const leadKnee = ik(leadHip, leadAnkle, T, S, 1);
    const backKnee = ik(backHip, backAnkle, T, S, 1);

    // trunk and head
    const tl = tilt(t);
    const trunkDir = dirv(90 - tl);
    const shC = add(hipC, trunkDir, TRUNK);
    const leadSh: P2 = [shC[0] + shOff, shC[1]];
    const backSh: P2 = [shC[0] - shOff, shC[1]];
    const nose = add(add(shC, trunkDir, 0.115), dirv(-tl), 0.035);

    // throwing arm (back shoulder)
    let ua: number, fa: number;
    if (t <= tm.MER) { ua = thrUpperPre(t); fa = thrForePre(t); }
    else { const w = whip(t); ua = upperMER + (upperFT - upperMER) * w; fa = foreMER + (foreFT - foreMER) * w; }
    let thrElbow = add(backSh, dirv(ua), UA * projUpper(t));
    let thrWrist = add(thrElbow, dirv(fa), FA);
    let gElbow = add(leadSh, dirv(gloveUpper(t)), UA);
    let gWrist = add(gElbow, dirv(gloveFore(t)), FA);

    // hands together at the chest before (and just after) hand break
    const chest = add(add(shC, trunkDir, -0.1), dirv(-tl), 0.13);
    const blend = t <= tm.HS ? 0 : Math.min(1, (t - tm.HS) / 0.12);
    if (blend < 1) {
      const e = blend * blend * (3 - 2 * blend);
      const tw: P2 = [chest[0] + (thrWrist[0] - chest[0]) * e, chest[1] + (thrWrist[1] - chest[1]) * e];
      const gw: P2 = [chest[0] + 0.01 + (gWrist[0] - chest[0] - 0.01) * e, chest[1] + (gWrist[1] - chest[1]) * e];
      thrWrist = tw; gWrist = gw;
      thrElbow = ik(backSh, thrWrist, UA, FA, -1);
      gElbow = ik(leadSh, gWrist, UA, FA, -1);
    }

    const foot = (a: P2, planted: boolean): [P2, P2] => {
      const heel: P2 = [a[0] - 0.035, a[1] - 0.035];
      const toe: P2 = [a[0] + 0.105, planted ? Math.max(0.004, a[1] - 0.035) : a[1] - 0.035];
      return [heel, toe];
    };
    const [lHeel, lToe] = foot(leadAnkle, t >= tm.FS || t <= tm.FM);
    const [bHeel, bToe] = foot(backAnkle, t <= tm.BR);

    const lead: 'l' | 'r' = p.hand === 'R' ? 'l' : 'r';
    const back: 'l' | 'r' = lead === 'l' ? 'r' : 'l';
    const fr = {} as Record<JointName, P2>;
    fr.nose = nose;
    fr[`${lead}Shoulder`] = leadSh; fr[`${back}Shoulder`] = backSh;
    fr[`${back}Elbow`] = thrElbow; fr[`${back}Wrist`] = thrWrist;
    fr[`${lead}Elbow`] = gElbow; fr[`${lead}Wrist`] = gWrist;
    fr[`${lead}Hip`] = leadHip; fr[`${back}Hip`] = backHip;
    fr[`${lead}Knee`] = leadKnee; fr[`${back}Knee`] = backKnee;
    fr[`${lead}Ankle`] = leadAnkle; fr[`${back}Ankle`] = backAnkle;
    fr[`${lead}Heel`] = lHeel; fr[`${back}Heel`] = bHeel;
    fr[`${lead}Toe`] = lToe; fr[`${back}Toe`] = bToe;
    body.push(fr);
  }

  const width = 1280, height = 720;
  const dir = p.hand === 'R' ? 1 : -1;
  const x0 = dir === 1 ? 230 : width - 230;
  const groundY = 650;
  const mk = (noisy: boolean): PoseTrack => {
    const x = Array.from({ length: NJ }, () => new Float32Array(n));
    const y = Array.from({ length: NJ }, () => new Float32Array(n));
    const c = Array.from({ length: NJ }, () => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      for (const [name, idx] of Object.entries(J) as [JointName, number][]) {
        const [u, v] = body[i][name];
        const nx = noisy ? r.gauss() * p.noise : 0, ny = noisy ? r.gauss() * p.noise : 0;
        x[idx][i] = x0 + dir * (u + nx) * p.heightPx;
        y[idx][i] = groundY - (v + ny) * p.heightPx;
        c[idx][i] = 0.95;
      }
    }
    if (noisy) {
      for (let k = 0; k < p.dropouts; k++) {
        const i = Math.floor(r.next() * n);
        const j = Math.floor(r.next() * NJ);
        x[j][i] += (r.next() - 0.5) * 120; y[j][i] += (r.next() - 0.5) * 120; c[j][i] = 0.05;
      }
      for (let k = 0; k < p.swaps; k++) {
        const i = Math.floor(n * (0.4 + 0.5 * r.next()));
        for (const [a, b] of [['lElbow', 'rElbow'], ['lWrist', 'rWrist']] as const) {
          const ja = J[a], jb = J[b];
          [x[ja][i], x[jb][i]] = [x[jb][i], x[ja][i]];
          [y[ja][i], y[jb][i]] = [y[jb][i], y[ja][i]];
        }
      }
    }
    return { fps: p.fps, width, height, t: Array.from({ length: n }, (_, i) => i / p.fps), x, y, c, model: 'synthetic' };
  };

  const truth = Object.fromEntries(Object.entries(tm).map(([k, v]) => [k, Math.round(v * p.fps)])) as Record<EventCode, number>;
  // peak leg lift is defined by the geometry (highest lead knee relative to the hips), not the keyframe time
  const leadSide = p.hand === 'R' ? 'l' : 'r';
  let best = -Infinity;
  for (let i = 0; i < truth.FS; i++) {
    const b = body[i];
    const rel = b[`${leadSide}Knee`][1] - (b.lHip[1] + b.rHip[1]) / 2;
    if (rel > best) { best = rel; truth.PKH = i; }
  }
  return { params: p, track: mk(true), clean: mk(false), truth, body };
}

/** Resample a synthetic pitch's parameters to a different frame rate. */
export const atFps = (p: PitchParams, fps: number): PitchParams => ({ ...p, fps });
