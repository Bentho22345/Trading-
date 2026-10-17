// End-to-end analysis: raw pose track → cleaned track → roles → scale → view → events → metrics.

import { assignRoles, cleanTrack, jn, other } from './clean';
import { buildBody, estimateScale, type Body } from './body';
import { detectEvents } from './events';
import { computeMetrics, computeSeries } from './metrics';
import { J, resolvedEvents, viewClass, type Analysis, type Events, type PoseTrack, type View } from './types';
import { median } from './signal';

export const ANALYSIS_VERSION = 1;

/**
 * Classify the camera view from the pose geometry.
 * Side views: the hips travel a long way across the image (≈0.5–0.9 body heights).
 * Front/back: the hips barely travel sideways; front shows the face (nose ahead of ears is not available, so we use
 * nose confidence vs. the throwing-side wrist at release). Open vs closed side: the throwing arm is the near arm on the
 * open side, so its joints are tracked with higher confidence than the glove arm's.
 */
export function classifyView(tr: PoseTrack, roles: ReturnType<typeof assignRoles>, heightPx: number): View {
  const n = tr.t.length;
  const hx = (i: number) => (tr.x[J.lHip][i] + tr.x[J.rHip][i]) / 2;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { lo = Math.min(lo, hx(i)); hi = Math.max(hi, hx(i)); }
  const travel = (hi - lo) / heightPx;
  const mc = (j: number) => median(Array.from(tr.c[j]));
  if (travel > 0.35) {
    const thr = mc(J[jn(roles.throw, 'Elbow')]) + mc(J[jn(roles.throw, 'Wrist')]);
    const glv = mc(J[jn(other(roles.throw), 'Elbow')]) + mc(J[jn(other(roles.throw), 'Wrist')]);
    return glv > thr + 0.15 ? 'side-closed' : 'side-open';
  }
  if (travel > 0.18) return 'oblique';
  // front vs back: the face is visible from home plate
  return mc(J.nose) > 0.5 ? 'front' : 'back';
}

export interface AnalyzeOptions {
  view?: View; // user override
  heightM?: number;
  editedEvents?: Partial<Events>;
}

export interface FullAnalysis {
  analysis: Analysis;
  body: Body;
  cleaned: PoseTrack;
  raw: PoseTrack;
}

export function analyzeTrack(raw: PoseTrack, opt: AnalyzeOptions = {}): FullAnalysis {
  const warnings: string[] = [];
  if (raw.t.length < Math.max(10, raw.fps * 0.5)) throw new Error('This clip is too short to contain a full pitch (need at least half a second).');
  const { track, swapped } = cleanTrack(raw);
  const roles = assignRoles(track);
  const scale = estimateScale(track, opt.heightM);
  if (!(scale.heightPx > 20)) throw new Error('Could not find a standing pitcher at the start of the clip.');
  const viewAuto = classifyView(track, roles, scale.heightPx);
  const view = opt.view ?? viewAuto;
  const body = buildBody(track, roles, scale);
  const det = detectEvents(body, viewClass(view));
  warnings.push(...det.warnings);
  if (swapped.length > raw.t.length * 0.1) warnings.push(`Left/right limbs were swapped on ${swapped.length} frames and corrected — check the skeleton.`);
  const filledFrac = track.filled ? track.filled.reduce((s, f) => s + f.reduce((a, b) => a + b, 0), 0) / (track.filled.length * raw.t.length) : 0;
  if (filledFrac > 0.1) warnings.push(`${Math.round(filledFrac * 100)}% of joint positions were low-confidence and filled in.`);
  const series = computeSeries(body);
  const events = { auto: det.events, edited: opt.editedEvents ?? {} };
  const metrics = computeMetrics(body, resolvedEvents({ events }), viewClass(view), series, track);
  return {
    analysis: { version: ANALYSIS_VERSION, view, viewAuto, fps: raw.fps, roles, scale, events, metrics, series, warnings },
    body,
    cleaned: track,
    raw,
  };
}

/** Recompute metrics after the user edits events or the view (fast; no re-cleaning). */
export function recompute(full: FullAnalysis, edited: Partial<Events>, view?: View): Analysis {
  const a = full.analysis;
  const v = view ?? a.view;
  const events = { auto: a.events.auto, edited };
  const metrics = computeMetrics(full.body, resolvedEvents({ events }), viewClass(v), a.series, full.cleaned);
  return { ...a, view: v, events, metrics };
}
