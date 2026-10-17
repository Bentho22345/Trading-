// Computes every metric in the catalog from a body-unit track + events, gated by camera view and frame rate.

import type { Body } from './body';
import { METRICS, type MetricDef } from './catalog';
import type { Events, MetricValue, Metrics, PoseTrack, Tier, ViewClass } from './types';
import { angle3, derivative, deg, filtfilt } from './signal';

const TIERS: Tier[] = ['high', 'medium', 'low', 'na'];
export const downgrade = (t: Tier, steps = 1): Tier => (t === 'na' ? 'na' : TIERS[Math.min(2, TIERS.indexOf(t) + steps)]);

export function computeSeries(b: Body): Record<string, Float32Array> {
  const { n, u, v, fps } = b;
  const s: Record<string, Float32Array> = {};
  const flex = (a: string, m: string, c: string) => {
    const out = new Float32Array(n);
    const U = u as Record<string, Float32Array>, V = v as Record<string, Float32Array>;
    for (let i = 0; i < n; i++) out[i] = 180 - angle3(U[a][i], V[a][i], U[m][i], V[m][i], U[c][i], V[c][i]);
    return out;
  };
  s.leadKneeFlex = flex('leadHip', 'leadKnee', 'leadAnkle');
  s.backKneeFlex = flex('backHip', 'backKnee', 'backAnkle');
  s.elbowFlex = flex('throwSh', 'throwElbow', 'throwWrist');
  s.trunkTilt = new Float32Array(n);
  s.forearm = new Float32Array(n);
  s.handHeight = new Float32Array(n);
  s.handTrail = new Float32Array(n);
  s.gloveDist = new Float32Array(n);
  s.kneeRelHip = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s.trunkTilt[i] = deg(Math.atan2(u.shC[i] - u.hipC[i], v.shC[i] - v.hipC[i]));
    const fx = u.throwWrist[i] - u.throwElbow[i], fy = v.throwWrist[i] - v.throwElbow[i];
    s.forearm[i] = deg(Math.asin(Math.max(-1, Math.min(1, fy / (Math.hypot(fx, fy) || 1)))));
    s.handHeight[i] = v.throwWrist[i] * 100;
    s.handTrail[i] = (u.throwSh[i] - u.throwWrist[i]) * 100;
    s.gloveDist[i] = Math.hypot(u.gloveWrist[i] - u.shC[i], v.gloveWrist[i] - v.shC[i]) * 100;
    s.kneeRelHip[i] = (v.leadKnee[i] - v.hipC[i]) * 100;
  }
  s.hipSpeed = derivative(u.hipC, fps);
  const wu = derivative(u.throwWrist, fps), wv = derivative(v.throwWrist, fps);
  s.handSpeed = wu.map((x, i) => Math.hypot(x, wv[i]));
  // knee extension velocity: smooth the angle a bit more before differentiating
  const kf = n > 8 ? filtfilt(s.leadKneeFlex, Math.min(12, fps * 0.4), fps) : s.leadKneeFlex;
  s.kneeExtVel = derivative(kf, fps).map((x) => -x);
  return s;
}

export const SERIES_INFO: Record<string, { label: string; unit: string }> = {
  leadKneeFlex: { label: 'Front knee bend', unit: '°' },
  backKneeFlex: { label: 'Back knee bend', unit: '°' },
  elbowFlex: { label: 'Elbow bend', unit: '°' },
  trunkTilt: { label: 'Trunk tilt (toward plate +)', unit: '°' },
  forearm: { label: 'Forearm angle (hand above elbow +)', unit: '°' },
  handHeight: { label: 'Hand height', unit: '% ht' },
  handTrail: { label: 'Hand behind shoulder', unit: '% ht' },
  gloveDist: { label: 'Glove distance from chest', unit: '% ht' },
  kneeRelHip: { label: 'Front knee height vs hip', unit: '% ht' },
  hipSpeed: { label: 'Hip speed toward plate', unit: 'ht/s' },
  handSpeed: { label: 'Hand speed (in plane)', unit: 'ht/s' },
  kneeExtVel: { label: 'Front knee extension speed', unit: '°/s' },
};

function tierFor(def: MetricDef, view: ViewClass, fps: number, has3d: boolean): Tier {
  let tier: Tier = def.views[view] ?? 'na';
  if (tier === 'na' && has3d && def.views['3D']) tier = def.views['3D'];
  if (tier !== 'na' && def.fpsSensitive) {
    if (fps < 50) tier = downgrade(tier, 2);
    else if (fps < 100) tier = downgrade(tier, 1);
  }
  return tier;
}

/** Pelvis/trunk yaw from monocular world landmarks (3D estimate). */
function separation3d(tr: PoseTrack, i: number): number | null {
  const w = tr.world;
  if (!w) return null;
  // indices into our joint list
  const L_SH = 1, R_SH = 2, L_HIP = 7, R_HIP = 8;
  const yaw = (a: number, b: number) => deg(Math.atan2(w.z[b][i] - w.z[a][i], w.x[b][i] - w.x[a][i]));
  let d = yaw(L_HIP, R_HIP) - yaw(L_SH, R_SH);
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.abs(d);
}

export function computeMetrics(b: Body, ev: Events, view: ViewClass, series: Record<string, Float32Array>, tr: PoseTrack): Metrics {
  const { u, v, fps } = b;
  const ms = (a: number, c: number) => ((b.t[c] - b.t[a]) * 1000);
  const pct = (x: number) => x * 100;
  const { FM, PKH, HS, FS, MER, BR, MIR } = ev;
  const has3d = !!tr.world;

  // front-view lateral sign: + = throwing-arm side (shoulders are square to the camera at release)
  const sgn = Math.sign(u.throwSh[BR] - u.gloveSh[BR]) || 1;

  const raw: Record<string, number | null> = {
    legLift: pct(v.leadKnee[PKH] - v.hipC[PKH]),
    balancePKH: pct(u.nose[PKH] - u.backAnkle[PKH]),
    tFmPkh: ms(FM, PKH),
    tPkhFs: ms(PKH, FS),
    handBreakTiming: ms(PKH, HS),
    handBreakHeight: pct(v.throwWrist[HS]),
    stride: pct(u.leadAnkle[FS] - u.backAnkle[0]),
    comSpeed: (() => { let m = -Infinity; for (let i = PKH; i <= FS; i++) m = Math.max(m, series.hipSpeed[i]); return m; })(),
    hipSink: pct(v.hipC[PKH] - v.hipC[FS]),
    leadKneeFS: series.leadKneeFlex[FS],
    backKneeFS: series.backKneeFlex[FS],
    trunkTiltFS: series.trunkTilt[FS],
    elbowFlexFS: series.elbowFlex[FS],
    forearmFS: series.forearm[FS],
    elbowHeightFS: pct(v.throwElbow[FS] - v.throwSh[FS]),
    sepFS: (() => {
      // foreshortening estimate: rotation = acos(apparent width / width at set)
      const w = (a: Float32Array, c: Float32Array, i: number) => Math.abs(a[i] - c[i]);
      const k = Math.max(1, Math.min(FM, Math.round(fps * 0.2)));
      let hip0 = 0, sh0 = 0;
      for (let i = 0; i < k; i++) { hip0 += w(u.leadHip, u.backHip, i); sh0 += w(u.throwSh, u.gloveSh, i); }
      hip0 /= k; sh0 /= k;
      if (hip0 < 0.03 || sh0 < 0.05) return null; // hips/shoulders not wide enough at the set to estimate rotation
      const pr = deg(Math.acos(Math.min(1, w(u.leadHip, u.backHip, FS) / hip0)));
      const trr = deg(Math.acos(Math.min(1, w(u.throwSh, u.gloveSh, FS) / sh0)));
      return pr - trr;
    })(),
    tFsMer: ms(FS, MER),
    tFsBr: ms(FS, BR),
    layback: series.handTrail[MER],
    leadKneeBR: series.leadKneeFlex[BR],
    kneeBlock: series.leadKneeFlex[FS] - series.leadKneeFlex[BR],
    kneeExtVel: (() => { let m = -Infinity; const hi = Math.min(b.n - 1, BR + Math.round(fps * 0.05)); for (let i = FS; i <= hi; i++) m = Math.max(m, series.kneeExtVel[i]); return m; })(),
    trunkTiltBR: series.trunkTilt[BR],
    elbowFlexBR: series.elbowFlex[BR],
    releaseHeight: pct(v.throwWrist[BR]),
    extension: pct(u.throwWrist[BR] - u.backAnkle[0]),
    headAtBR: pct(u.nose[BR] - u.leadAnkle[BR]),
    handSpeed: (() => { let m = 0; for (let i = Math.max(0, BR - Math.round(fps * 0.05)); i <= Math.min(b.n - 1, BR + Math.round(fps * 0.03)); i++) m = Math.max(m, series.handSpeed[i]); return m; })(),
    gloveDistBR: series.gloveDist[BR],
    armSlot: deg(Math.atan2(sgn * (u.throwWrist[BR] - u.throwSh[BR]), v.throwWrist[BR] - v.throwSh[BR])),
    latTiltFS: deg(Math.atan2(-sgn * (u.shC[FS] - u.hipC[FS]), v.shC[FS] - v.hipC[FS])),
    latTiltBR: deg(Math.atan2(-sgn * (u.shC[BR] - u.hipC[BR]), v.shC[BR] - v.hipC[BR])),
    strideDir: pct(sgn * (u.leadAnkle[FS] - u.backAnkle[0])),
    releaseSide: pct(sgn * (u.throwWrist[BR] - u.backAnkle[0])),
    headLatBR: pct(-sgn * (u.nose[BR] - u.leadAnkle[BR])),
    sep3dMax: (() => {
      if (!has3d) return null;
      let m = -Infinity;
      for (let i = PKH; i <= BR; i++) { const s = separation3d(tr, i); if (s !== null) m = Math.max(m, s); }
      return Number.isFinite(m) ? m : null;
    })(),
    decelDist: (() => { let d = 0; for (let i = BR + 1; i <= MIR; i++) d += Math.hypot(u.throwWrist[i] - u.throwWrist[i - 1], v.throwWrist[i] - v.throwWrist[i - 1]); return pct(d); })(),
  };

  // event-level joint confidence check: downgrade a metric when the joints it needs were filled/low confidence
  const lowConfAt = (i: number, segs: (keyof Body['conf'])[]) => segs.some((s) => b.conf[s][Math.max(0, Math.min(b.n - 1, i))] < 0.5);
  const needs: Record<string, [number, (keyof Body['conf'])[]]> = {
    forearmFS: [FS, ['throwElbow', 'throwWrist']], elbowFlexFS: [FS, ['throwElbow', 'throwWrist']], elbowHeightFS: [FS, ['throwElbow']],
    elbowFlexBR: [BR, ['throwElbow', 'throwWrist']], releaseHeight: [BR, ['throwWrist']], extension: [BR, ['throwWrist']],
    leadKneeFS: [FS, ['leadKnee', 'leadAnkle']], leadKneeBR: [BR, ['leadKnee', 'leadAnkle']], stride: [FS, ['leadAnkle']],
    gloveDistBR: [BR, ['gloveWrist']], armSlot: [BR, ['throwWrist']], layback: [MER, ['throwWrist']],
  };

  const out: Metrics = {};
  for (const def of METRICS) {
    let tier = tierFor(def, view, fps, has3d);
    const val = raw[def.key];
    let note: string | undefined;
    if (tier !== 'na' && needs[def.key] && lowConfAt(...needs[def.key])) {
      tier = downgrade(tier);
      note = 'Tracking was uncertain for this joint at this moment.';
    }
    const ok = tier !== 'na' && val !== null && val !== undefined && Number.isFinite(val);
    out[def.key] = { value: ok ? (val as number) : null, tier: ok ? tier : 'na', note: !ok && tier !== 'na' ? 'Could not be computed for this clip.' : note } satisfies MetricValue;
  }
  void HS;
  return out;
}
