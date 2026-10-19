import { describe, expect, it } from 'vitest';
import { GOOD_DAY, OFF_DAY, generatePitch } from '../../src/core/synthetic';
import { analyzeTrack, recompute } from '../../src/core/analyze';
import { METRICS } from '../../src/core/catalog';
import { computeMetrics, computeSeries } from '../../src/core/metrics';
import type { Body } from '../../src/core/body';

describe('metrics recover injected parameters (side view)', () => {
  for (const p of [GOOD_DAY, OFF_DAY]) {
    const { analysis: a } = analyzeTrack(generatePitch(p).track);
    const m = (k: string) => a.metrics[k].value as number;
    it(`${p.name}: stride ≈ ${p.stride * 100}% ht`, () => expect(m('stride')).toBeCloseTo(p.stride * 100, -0.5));
    it(`${p.name}: lead knee at FS ≈ ${p.leadKneeFS}°`, () => expect(Math.abs(m('leadKneeFS') - p.leadKneeFS)).toBeLessThan(4));
    it(`${p.name}: lead knee at BR ≈ ${p.leadKneeBR}°`, () => expect(Math.abs(m('leadKneeBR') - p.leadKneeBR)).toBeLessThan(4));
    it(`${p.name}: trunk tilt at BR ≈ ${p.trunkTiltBR}°`, () => expect(Math.abs(m('trunkTiltBR') - p.trunkTiltBR)).toBeLessThan(3));
    it(`${p.name}: trunk tilt at FS ≈ ${p.trunkTiltFS}°`, () => expect(Math.abs(m('trunkTiltFS') - p.trunkTiltFS)).toBeLessThan(3));
    const forearm = (Math.asin(Math.sin((p.throwForearmFS * Math.PI) / 180)) * 180) / Math.PI;
    it(`${p.name}: forearm angle at FS ≈ ${forearm.toFixed(0)}°`, () => expect(Math.abs(m('forearmFS') - forearm)).toBeLessThan(6));
  }
});

describe('view gating', () => {
  const { analysis: a } = analyzeTrack(generatePitch(GOOD_DAY).track);
  it('every catalog metric gets a value or "na"', () => {
    for (const d of METRICS) expect(a.metrics[d.key]).toBeDefined();
  });
  it('front-only metrics are not measurable from the side', () => {
    for (const k of ['armSlot', 'latTiltBR', 'strideDir', 'releaseSide']) {
      expect(a.metrics[k].tier).toBe('na');
      expect(a.metrics[k].value).toBeNull();
    }
  });
  it('hip-shoulder separation from the side is low confidence', () => expect(a.metrics.sepFS.tier).toBe('low'));
  it('arm metrics downgrade at 30 fps', () => {
    const { analysis: lo } = analyzeTrack(generatePitch({ ...GOOD_DAY, fps: 30 }).track);
    expect(lo.metrics.forearmFS.tier === 'low' || lo.metrics.forearmFS.tier === 'na').toBe(true);
    expect(lo.metrics.stride.tier).toBe('high');
    expect(lo.warnings.join(' ')).toMatch(/frame rate/i);
  });
});

describe('editing events re-runs metrics', () => {
  it('moving foot strike changes stride-dependent metrics', () => {
    const full = analyzeTrack(generatePitch(GOOD_DAY).track);
    const fs = full.analysis.events.auto.FS;
    const edited = recompute(full, { FS: fs - 20 });
    expect(edited.events.edited.FS).toBe(fs - 20);
    expect(edited.metrics.stride.value).not.toBeCloseTo(full.analysis.metrics.stride.value as number, 1);
    expect(edited.metrics.tFsBr.value).toBeGreaterThan(full.analysis.metrics.tFsBr.value as number);
  });
});

describe('front-view geometry', () => {
  // Hand-built 1-frame body seen from home plate: RHP, arm side = +u.
  const n = 3;
  const seg = (u: number, v: number) => ({ u: new Float32Array(n).fill(u), v: new Float32Array(n).fill(v) });
  const parts = {
    nose: seg(-0.05, 0.85), hipC: seg(0, 0.45), shC: seg(-0.1, 0.75),
    leadHip: seg(-0.09, 0.45), backHip: seg(0.09, 0.45), leadKnee: seg(-0.1, 0.25), backKnee: seg(0.1, 0.25),
    leadAnkle: seg(-0.05, 0.04), backAnkle: seg(0, 0.04), leadHeel: seg(-0.05, 0), leadToe: seg(-0.05, 0), backHeel: seg(0, 0), backToe: seg(0, 0),
    throwSh: seg(0.02, 0.77), gloveSh: seg(-0.22, 0.73), throwElbow: seg(0.1, 0.9), gloveElbow: seg(-0.3, 0.6),
    throwWrist: seg(0.02 + 0.2 * Math.sin(Math.PI / 4), 0.77 + 0.2 * Math.cos(Math.PI / 4)), gloveWrist: seg(-0.2, 0.6),
  };
  const body = {
    n, fps: 240, t: [0, 1 / 240, 2 / 240],
    u: Object.fromEntries(Object.entries(parts).map(([k, s]) => [k, s.u])),
    v: Object.fromEntries(Object.entries(parts).map(([k, s]) => [k, s.v])),
    conf: Object.fromEntries(Object.keys(parts).map((k) => [k, new Float32Array(n).fill(0.9)])),
  } as unknown as Body;
  const ev = { FM: 0, PKH: 0, HS: 0, FS: 1, MER: 1, BR: 1, MIR: 2, END: 2 };
  const series = computeSeries(body);
  const m = computeMetrics(body, ev, 'F', series, { world: undefined } as never);
  it('arm slot is the shoulder→hand angle from vertical', () => expect(m.armSlot.value).toBeCloseTo(45, 0));
  it('lateral trunk tilt is positive toward the glove side', () => expect(m.latTiltBR.value).toBeCloseTo(18.4, 0));
  it('stride direction: landing toward the glove side is negative (open)', () => expect(m.strideDir.value).toBeCloseTo(-5, 1));
  it('side-only metrics are not measurable from the front', () => expect(m.stride.tier).toBe('na'));
});
