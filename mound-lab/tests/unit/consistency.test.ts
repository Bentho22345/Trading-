import { describe, expect, it } from 'vitest';
import { GOOD_DAY, OFF_DAY, generatePitch } from '../../src/core/synthetic';
import { analyzeTrack } from '../../src/core/analyze';
import { sessionReport } from '../../src/core/consistency';

const reps = [1, 2, 3, 4, 5].map((seed) => analyzeTrack(generatePitch({ ...GOOD_DAY, seed }).track).analysis);
const mixed = [reps[0], reps[1], analyzeTrack(generatePitch(OFF_DAY).track).analysis, reps[2]];

describe('session consistency', () => {
  it('repeat pitches of one delivery are rated repeatable', () => {
    const r = sessionReport(reps);
    expect(r.rows.length).toBeGreaterThan(4);
    expect(r.rows.every((x) => x.rating !== 'inconsistent')).toBe(true);
    expect(r.score!).toBeGreaterThan(70);
    expect(r.release).toHaveLength(5);
  });
  it('one off-day pitch in the bullpen makes it less consistent', () => {
    const r = sessionReport(mixed);
    expect(r.score!).toBeLessThan(sessionReport(reps).score!);
    expect(r.rows.some((x) => x.rating === 'inconsistent')).toBe(true);
  });
  it('best pitch: fastest when velocities exist, else best mechanics (never the off-day pitch)', () => {
    expect(sessionReport(mixed, [84, 85, 88, 83]).best!.index).toBe(2);
    expect(sessionReport(mixed).best!.index).not.toBe(2);
  });
});
