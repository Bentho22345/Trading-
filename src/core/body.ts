// Converts a cleaned pixel track into semantic body-unit series (u forward toward the plate, v up, in body heights).

import { J, type PoseTrack, type Roles, type Scale } from './types';
import { jn, other } from './clean';
import { median } from './signal';

export type Seg =
  | 'nose' | 'hipC' | 'shC'
  | 'leadHip' | 'backHip' | 'leadKnee' | 'backKnee' | 'leadAnkle' | 'backAnkle' | 'leadHeel' | 'leadToe' | 'backHeel' | 'backToe'
  | 'throwSh' | 'gloveSh' | 'throwElbow' | 'gloveElbow' | 'throwWrist' | 'gloveWrist';

export interface Body {
  n: number;
  fps: number;
  t: number[];
  u: Record<Seg, Float32Array>;
  v: Record<Seg, Float32Array>;
  conf: Record<Seg, Float32Array>;
}

export function estimateScale(tr: PoseTrack, heightM?: number): Scale {
  const n = tr.t.length;
  const k = Math.min(n, Math.max(5, Math.round(tr.fps * 0.25)));
  const hs: number[] = [], gs: number[] = [], xs: number[] = [];
  for (let i = 0; i < k; i++) {
    const ankleY = (tr.y[J.lAnkle][i] + tr.y[J.rAnkle][i]) / 2;
    hs.push((ankleY - tr.y[J.nose][i]) / 0.89);
    const feet = [J.lHeel, J.rHeel, J.lToe, J.rToe].filter((j) => tr.c[j][i] > 0.3).map((j) => tr.y[j][i]);
    gs.push(feet.length ? Math.max(...feet) : Math.max(tr.y[J.lAnkle][i], tr.y[J.rAnkle][i]));
  }
  const heightPx = median(hs);
  let groundY = median(gs);
  // if there were no feet points, ankles sit ~4% of height above the ground
  if (!gs.length) groundY += 0.045 * heightPx;
  void xs;
  return { heightPx, groundY, originX: 0, heightM };
}

export function buildBody(tr: PoseTrack, roles: Roles, scale: Scale): Body {
  const n = tr.t.length;
  const back = other(roles.lead);
  const gl = other(roles.throw);
  const k = Math.min(n, Math.max(5, Math.round(tr.fps * 0.25)));
  const bj = J[jn(back, 'Ankle')];
  const originX = median(Array.from(tr.x[bj].subarray(0, k)));
  scale.originX = originX;
  const H = scale.heightPx;
  const toU = (x: number) => ((x - originX) * roles.dir) / H;
  const toV = (y: number) => (scale.groundY - y) / H;
  const map: Record<Exclude<Seg, 'hipC' | 'shC'>, number> = {
    nose: J.nose,
    leadHip: J[jn(roles.lead, 'Hip')], backHip: J[jn(back, 'Hip')],
    leadKnee: J[jn(roles.lead, 'Knee')], backKnee: J[jn(back, 'Knee')],
    leadAnkle: J[jn(roles.lead, 'Ankle')], backAnkle: J[jn(back, 'Ankle')],
    leadHeel: J[jn(roles.lead, 'Heel')], leadToe: J[jn(roles.lead, 'Toe')],
    backHeel: J[jn(back, 'Heel')], backToe: J[jn(back, 'Toe')],
    throwSh: J[jn(roles.throw, 'Shoulder')], gloveSh: J[jn(gl, 'Shoulder')],
    throwElbow: J[jn(roles.throw, 'Elbow')], gloveElbow: J[jn(gl, 'Elbow')],
    throwWrist: J[jn(roles.throw, 'Wrist')], gloveWrist: J[jn(gl, 'Wrist')],
  };
  const u = {} as Record<Seg, Float32Array>, v = {} as Record<Seg, Float32Array>, conf = {} as Record<Seg, Float32Array>;
  for (const [seg, j] of Object.entries(map) as [Seg, number][]) {
    u[seg] = new Float32Array(n); v[seg] = new Float32Array(n);
    for (let i = 0; i < n; i++) { u[seg][i] = toU(tr.x[j][i]); v[seg][i] = toV(tr.y[j][i]); }
    conf[seg] = tr.c[j];
  }
  const mid = (a: Seg, b: Seg): [Float32Array, Float32Array, Float32Array] => {
    const mu = new Float32Array(n), mv = new Float32Array(n), mc = new Float32Array(n);
    for (let i = 0; i < n; i++) { mu[i] = (u[a][i] + u[b][i]) / 2; mv[i] = (v[a][i] + v[b][i]) / 2; mc[i] = Math.min(conf[a][i], conf[b][i]); }
    return [mu, mv, mc];
  };
  [u.hipC, v.hipC, conf.hipC] = mid('leadHip', 'backHip');
  [u.shC, v.shC, conf.shC] = mid('throwSh', 'gloveSh');
  return { n, fps: tr.fps, t: tr.t, u, v, conf };
}
