// Automatic event detection (FM, PKH, HS, FS, MER, BR, MIR, END) on a body-unit track.

import type { Body } from './body';
import type { Events, ViewClass } from './types';
import { argmax, argmin, derivative, median } from './signal';

export interface EventDebug {
  leadAnkleSpeed: Float32Array;
  wristSpeed: Float32Array;
}

function speed2(u: Float32Array, v: Float32Array, fs: number): Float32Array {
  const du = derivative(u, fs), dv = derivative(v, fs);
  return du.map((x, i) => Math.hypot(x, dv[i]));
}

export function detectEvents(b: Body, view: ViewClass): { events: Events; debug: EventDebug; warnings: string[] } {
  const { n, fps } = b;
  const warnings: string[] = [];
  const sec = (s: number) => Math.max(1, Math.round(s * fps));
  const last = n - 1;

  const wristSpeed = speed2(b.u.throwWrist, b.v.throwWrist, fps);
  const ankleVu = derivative(b.u.leadAnkle, fps);
  const ankleVv = derivative(b.v.leadAnkle, fps);
  const groundTol = 0.09;
  const ankleRest = median(Array.from(b.v.leadAnkle.subarray(0, Math.min(n, sec(0.25)))));

  // --- Ball release candidate first (global peak wrist speed) helps bound the search window.
  const brGlobal = argmax(wristSpeed, sec(0.2), last - 1);

  // --- Foot strike
  let fs: number;
  let leadAnkleSpeed: Float32Array;
  if (view === 'S' || view === 'O') {
    leadAnkleSpeed = ankleVu;
    const lo = Math.max(0, brGlobal - sec(0.8));
    const peak = argmax(ankleVu, lo, brGlobal);
    const thr = 0.15 * ankleVu[peak];
    fs = peak;
    for (let i = peak + 1; i <= brGlobal; i++) {
      if (ankleVu[i] < thr && b.v.leadAnkle[i] - ankleRest < groundTol) { fs = i; break; }
      fs = i;
    }
  } else {
    // front/back: the foot moves toward/away from the camera, so use vertical motion: the ankle comes
    // down from the leg lift and stops near the ground.
    leadAnkleSpeed = ankleVv.map((x) => -x);
    const lo = Math.max(0, brGlobal - sec(0.8));
    const peakDown = argmax(leadAnkleSpeed, lo, brGlobal);
    fs = peakDown;
    for (let i = peakDown + 1; i <= brGlobal; i++) {
      fs = i;
      if (Math.abs(ankleVv[i]) < 0.15 * leadAnkleSpeed[peakDown] && b.v.leadAnkle[i] - ankleRest < groundTol) break;
    }
  }

  // --- Ball release: peak throwing-wrist speed within 0.4 s after foot strike
  const br = argmax(wristSpeed, fs + 1, Math.min(last, fs + sec(0.4)));

  // --- Peak leg lift: highest lead knee relative to the hips, before foot strike
  const kneeRel = b.v.leadKnee.map((v, i) => v - b.v.hipC[i]);
  const pkh = argmax(kneeRel, Math.max(0, fs - sec(2)), Math.max(0, fs - 1));

  // --- First movement: walk back from the 10%-rise point while the knee is still rising
  const base = median(Array.from(kneeRel.subarray(0, Math.max(1, Math.min(pkh, sec(0.2))))));
  const rise = kneeRel[pkh] - base;
  let fm = 0;
  for (let i = pkh; i >= 0; i--) if (kneeRel[i] - base < 0.1 * rise) { fm = i; break; }
  const kv = derivative(kneeRel, fps);
  const kvPeak = Math.max(1e-6, kv[argmax(kv, fm, pkh)]);
  while (fm > 0 && kv[fm - 1] > 0.03 * kvPeak) fm--;

  // --- Hand separation: wrists apart after being together
  const handDist = b.u.throwWrist.map((u, i) => Math.hypot(u - b.u.gloveWrist[i], b.v.throwWrist[i] - b.v.gloveWrist[i]));
  const together = median(Array.from(handDist.subarray(fm, Math.max(fm + 1, pkh))));
  let hs = pkh;
  for (let i = fm; i < fs; i++) if (handDist[i] > together + 0.05) { hs = i; break; }
  // walk back to where the separation started growing
  while (hs > fm && handDist[hs - 1] > together + 0.01) hs--;

  // --- Max layback (2D proxy): wrist trailing the throwing shoulder the most between FS and BR
  let mer: number;
  if (view === 'S' || view === 'O') {
    // The hand moves back relative to the throwing shoulder while the arm lays back, then whips forward.
    // MER ≈ the last frame before the forward whip where the hand is not yet moving forward relative to the shoulder.
    const trail = b.u.throwWrist.map((u, i) => u - b.u.throwSh[i]);
    const relV = derivative(trail, fps);
    const pk = argmax(relV, fs, br);
    mer = -1;
    for (let i = pk; i >= fs; i--) if (relV[i] <= 0.1 * relV[pk]) { mer = i; break; }
    if (mer < 0) mer = argmin(trail, fs, br - 1);
  } else {
    // front: the hand is highest relative to the shoulder just before acceleration
    const above = b.v.throwWrist.map((v, i) => v - b.v.throwSh[i]);
    mer = argmax(above, fs, br - 1);
  }

  // --- End of deceleration: wrist speed falls below 25% of its peak after release
  let mir = Math.min(last, br + sec(0.08));
  for (let i = br + 1; i <= last; i++) if (wristSpeed[i] < 0.25 * wristSpeed[br]) { mir = i; break; }

  // --- Finish: hips nearly still
  const hipSpeed = speed2(b.u.hipC, b.v.hipC, fps);
  let end = last;
  for (let i = mir + 1; i <= last; i++) if (hipSpeed[i] < 0.12) { end = i; break; }

  if (rise < 0.04) warnings.push('No clear leg lift was found — this may not be a full pitching delivery, so the events (and every metric) may be wrong. Check the trim, or set the events by hand.');
  if (wristSpeed[br] < 4) warnings.push('The throwing hand never moves fast — this may not be a throw, or it is a slow-motion clip played at real time (set "Clip speed").');
  if (br - fs < sec(0.05)) warnings.push('Foot strike and release are very close together — check the events.');
  if (fps < 60) warnings.push('Low frame rate: release and layback timing can be off by a frame or more (one frame ≈ ' + Math.round(1000 / fps) + ' ms).');
  return { events: { FM: fm, PKH: pkh, HS: hs, FS: fs, MER: mer, BR: br, MIR: mir, END: end }, debug: { leadAnkleSpeed, wristSpeed }, warnings };
}
