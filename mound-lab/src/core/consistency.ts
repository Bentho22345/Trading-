// Session consistency: how repeatable a pitcher's delivery is across a bullpen, and which pitch was best.

import { METRIC_BY_KEY } from './catalog';
import type { Analysis } from './types';
import { mean, sd } from './signal';

export const CONSISTENCY_KEYS = ['releaseHeight', 'extension', 'stride', 'tFsBr', 'trunkTiltBR', 'kneeBlock', 'forearmFS', 'armSlot', 'latTiltBR'];

export interface ConsistencyRow { key: string; label: string; unit: string; mean: number; sd: number; n: number; rating: 'very repeatable' | 'repeatable' | 'inconsistent' }
export interface SessionReport { rows: ConsistencyRow[]; score: number | null; release: { ext: number; height: number; i: number }[]; best: { index: number; why: string } | null }

function closeness(key: string, v: number): number {
  const def = METRIC_BY_KEY[key];
  if (!def.ref) return 0;
  const { lo, hi } = def.ref;
  return -(v < lo ? lo - v : v > hi ? v - hi : 0) / def.threshold;
}

export function sessionReport(as: Analysis[], velos: (number | null | undefined)[] = []): SessionReport {
  const rows: ConsistencyRow[] = [];
  for (const key of CONSISTENCY_KEYS) {
    const vals = as.map((a) => a.metrics[key]).filter((m) => m && m.value !== null && m.tier !== 'na' && m.tier !== 'low').map((m) => m!.value as number);
    if (vals.length < 3) continue;
    const def = METRIC_BY_KEY[key];
    const s = sd(vals);
    // compare the spread with the metric's "changed" threshold (what we'd call a real change between two pitches)
    const rel = s / def.threshold;
    rows.push({ key, label: def.label, unit: def.unit, mean: mean(vals), sd: s, n: vals.length, rating: rel < 0.5 ? 'very repeatable' : rel < 1 ? 'repeatable' : 'inconsistent' });
  }
  const score = rows.length ? Math.round(100 * mean(rows.map((r) => Math.max(0, 1 - (r.sd / METRIC_BY_KEY[r.key].threshold) / 1.5)))) : null;
  const release = as.map((a, i) => ({ ext: a.metrics.extension?.value ?? NaN, height: a.metrics.releaseHeight?.value ?? NaN, i })).filter((p) => Number.isFinite(p.ext) && Number.isFinite(p.height));
  let best: SessionReport['best'] = null;
  if (as.length >= 2) {
    const haveVelo = velos.filter((v) => v).length >= Math.ceil(as.length / 2);
    if (haveVelo) {
      let bi = -1, bv = -Infinity;
      velos.forEach((v, i) => { if (v && v > bv) { bv = v; bi = i; } });
      if (bi >= 0) best = { index: bi, why: `fastest pitch (${bv.toFixed(0)} mph)` };
    } else {
      // mechanics: extension and front-leg block (more is better) + closeness to typical ranges
      const score = (a: Analysis) => {
        let s = 0;
        const g = (k: string) => a.metrics[k]?.value;
        if (g('extension') !== null && g('extension') !== undefined) s += (g('extension') as number) / METRIC_BY_KEY.extension.threshold;
        if (g('kneeBlock') !== null && g('kneeBlock') !== undefined) s += (g('kneeBlock') as number) / METRIC_BY_KEY.kneeBlock.threshold;
        for (const k of ['stride', 'trunkTiltBR', 'forearmFS', 'elbowHeightFS']) { const v = g(k); if (v !== null && v !== undefined) s += closeness(k, v); }
        return s;
      };
      let bi = 0, bs = -Infinity;
      as.forEach((a, i) => { const s = score(a); if (s > bs) { bs = s; bi = i; } });
      best = { index: bi, why: 'best mechanics (most extension and front-leg block, closest to typical positions)' };
    }
  }
  return { rows, score, release, best };
}
