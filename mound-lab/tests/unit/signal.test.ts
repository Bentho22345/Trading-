import { describe, expect, it } from 'vitest';
import { derivative, fillGaps, filtfilt, angle3 } from '../../src/core/signal';
import { fixSwaps, cloneTrack } from '../../src/core/clean';
import { GOOD_DAY, generatePitch } from '../../src/core/synthetic';
import { J } from '../../src/core/types';

describe('signal', () => {
  it('filtfilt passes low frequencies with no lag and removes high ones', () => {
    const fs = 240, n = 480;
    const slow = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 2 * i) / fs));
    const fast = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 60 * i) / fs));
    const f1 = filtfilt(slow, 12, fs), f2 = filtfilt(fast, 12, fs);
    for (let i = 50; i < n - 50; i++) expect(Math.abs(f1[i] - slow[i])).toBeLessThan(0.02);
    expect(Math.max(...Array.from(f2.slice(50, -50)).map(Math.abs))).toBeLessThan(0.05);
  });
  it('fillGaps interpolates linearly and marks frames', () => {
    const v = Float32Array.from([0, 99, 99, 3]);
    const f = fillGaps(v, (i) => i === 1 || i === 2);
    expect(Array.from(v)).toEqual([0, 1, 2, 3]);
    expect(Array.from(f)).toEqual([0, 1, 1, 0]);
  });
  it('derivative of a ramp', () => {
    const d = derivative([0, 1, 2, 3, 4], 10);
    expect(d[2]).toBeCloseTo(10);
  });
  it('angle3 right angle', () => expect(angle3(1, 0, 0, 0, 0, 1)).toBeCloseTo(90));
});

describe('left/right swap correction', () => {
  it('undoes injected arm-label swaps', () => {
    const s = generatePitch({ ...GOOD_DAY, swaps: 6, noise: 0.001, dropouts: 0 });
    const tr = cloneTrack(s.track);
    const swapped = fixSwaps(tr);
    expect(swapped.length).toBeGreaterThanOrEqual(6);
    let maxErr = 0;
    for (let i = 0; i < tr.t.length; i++) maxErr = Math.max(maxErr, Math.abs(tr.x[J.rWrist][i] - s.clean.x[J.rWrist][i]));
    expect(maxErr).toBeLessThan(15);
  });
});
