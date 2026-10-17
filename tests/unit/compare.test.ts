import { describe, expect, it } from 'vitest';
import { GOOD_DAY, OFF_DAY, generatePitch } from '../../src/core/synthetic';
import { analyzeTrack } from '../../src/core/analyze';
import { compareAnalyses, compareGroups, pooledVariability } from '../../src/core/compare';
import { makeSync } from '../../src/core/sync';
import { resolvedEvents } from '../../src/core/types';

const good = analyzeTrack(generatePitch(GOOD_DAY).track);
const off = analyzeTrack(generatePitch(OFF_DAY).track);
const c = compareAnalyses(good.analysis, off.analysis);
const status = (k: string) => c.diffs.find((d) => d.key === k)!.status;

describe('good day vs off day', () => {
  // the five injected faults
  for (const k of ['stride', 'forearmFS', 'kneeBlock', 'trunkTiltBR', 'gloveDistBR']) {
    it(`flags injected change: ${k}`, () => expect(['changed', 'big']).toContain(status(k)));
  }
  // things that were not changed and are not downstream of the changes
  for (const k of ['legLift', 'tFmPkh', 'leadKneeFS', 'trunkTiltFS', 'handBreakHeight', 'hipSink', 'layback', 'handBreakTiming']) {
    it(`does not flag unchanged metric: ${k}`, () => expect(status(k)).toBe('steady'));
  }
  it('lists the injected root causes as roots', () => {
    const roots = c.findings.filter((f) => f.isRoot).map((f) => f.key);
    for (const k of ['stride', 'forearmFS', 'kneeBlock', 'gloveDistBR']) expect(roots).toContain(k);
  });
  it('labels downstream effects as symptoms', () => {
    const f = c.findings.find((x) => x.key === 'extension')!;
    expect(f.isRoot).toBe(false);
    expect(f.causedBy).toContain('stride');
    expect(c.findings.find((x) => x.key === 'leadKneeBR')!.causedBy).toContain('kneeBlock');
  });
  it('ranks roots before symptoms', () => {
    const firstSymptom = c.findings.findIndex((f) => !f.isRoot);
    const lastRoot = c.findings.map((f) => f.isRoot).lastIndexOf(true);
    expect(lastRoot).toBeLessThan(firstSymptom);
  });
  it('verdict names the biggest change and every finding has a cue or drills where catalogued', () => {
    expect(c.verdict.headline).toMatch(/^Biggest change:/);
    for (const f of c.findings.filter((x) => x.isRoot)) expect(f.what.length).toBeGreaterThan(10);
  });
  it('flags the late arm as a stress-associated pattern on B only', () => {
    expect(c.flags.some((f) => f.clip === 'B' && f.key === 'forearmFS' && f.stress)).toBe(true);
    expect(c.flags.some((f) => f.clip === 'A' && f.key === 'forearmFS')).toBe(false);
  });
  it('same clip vs itself → no findings', () => {
    const self = compareAnalyses(good.analysis, good.analysis);
    expect(self.findings).toHaveLength(0);
    expect(self.verdict.headline).toMatch(/No meaningful changes/);
  });
});

describe('noise awareness', () => {
  const reps = [1, 2, 3, 4].map((seed) => analyzeTrack(generatePitch({ ...GOOD_DAY, seed, noise: 0.004 }).track).analysis);
  it('repeat pitches of the same delivery are not flagged as changed', () => {
    const r = compareAnalyses(reps[0], reps[1], { variability: pooledVariability([reps]) });
    expect(r.findings.filter((f) => f.def.views.S === 'high')).toHaveLength(0);
  });
  it('group compare: session averages still find the injected changes', () => {
    const offs = [5, 6, 7].map((seed) => analyzeTrack(generatePitch({ ...OFF_DAY, seed }).track).analysis);
    const g = compareGroups(reps, offs);
    expect(g.thresholdSource).toBe('athlete');
    expect(['changed', 'big']).toContain(g.diffs.find((d) => d.key === 'stride')!.status);
    expect(g.diffs.find((d) => d.key === 'stride')!.aSpread).toBeGreaterThanOrEqual(0);
  });
});

describe('setup check', () => {
  it('warns about different frame rates', () => {
    const lo = analyzeTrack(generatePitch({ ...GOOD_DAY, fps: 60 }).track).analysis;
    const r = compareAnalyses(good.analysis, lo);
    expect(r.setup.ok).toBe(false);
    expect(r.setup.warnings.join(' ')).toMatch(/Frame rates differ/);
  });
  it('warns about camera distance', () => {
    const far = analyzeTrack(generatePitch({ ...GOOD_DAY, heightPx: 300 }).track).analysis;
    expect(compareAnalyses(good.analysis, far).setup.warnings.join(' ')).toMatch(/camera distance/);
  });
});

describe('sync', () => {
  const ta = { n: good.body.n, fps: good.body.fps, events: resolvedEvents(good.analysis) };
  const tb = { n: off.body.n, fps: off.body.fps, events: resolvedEvents(off.analysis) };
  it('phase sync maps every event of A onto the same event of B', () => {
    const f = makeSync('phase', ta, tb);
    for (const k of ['PKH', 'FS', 'BR'] as const) expect(f(ta.events[k] / ta.fps)).toBeCloseTo(tb.events[k] / tb.fps, 5);
  });
  it('event sync is a pure offset at foot strike', () => {
    const f = makeSync('event', ta, tb, { event: 'FS' });
    expect(f(ta.events.FS / 240)).toBeCloseTo(tb.events.FS / 240, 6);
    expect(f(1) - f(0)).toBeCloseTo(1, 6);
  });
  it('DTW sync is monotone and lands foot strike near foot strike', () => {
    const f = makeSync('dtw', ta, tb, { bodyA: good.body, bodyB: off.body });
    let prev = -Infinity;
    for (let t = 0; t < 2.5; t += 0.01) { const y = f(t); expect(y).toBeGreaterThanOrEqual(prev); prev = y; }
    expect(Math.abs(f(ta.events.FS / 240) - tb.events.FS / 240)).toBeLessThan(0.06);
  });
});
