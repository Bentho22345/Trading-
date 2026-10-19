import { describe, expect, it } from 'vitest';
import { GOOD_DAY, OFF_DAY, generatePitch, atFps } from '../../src/core/synthetic';
import { analyzeTrack } from '../../src/core/analyze';
import { resolvedEvents, type EventCode } from '../../src/core/types';

// Tolerances: key events (the ones metrics hang on) must be within ±2 frames. Onset-type events are
// inherently fuzzy (they depend on a threshold on a slow signal) and are held to a time tolerance instead.
const FRAME_TOL: EventCode[] = ['PKH', 'FS', 'MER', 'BR'];
const MS_TOL: Partial<Record<EventCode, number>> = { FM: 45, HS: 30, MIR: 40, END: 350 };

for (const p of [GOOD_DAY, OFF_DAY, { ...GOOD_DAY, hand: 'L' as const, name: 'Lefty good day' }]) {
  for (const fps of [240, 120, 60]) {
    describe(`${p.name} @${fps} fps`, () => {
      const s = generatePitch(atFps(p, fps));
      const { analysis } = analyzeTrack(s.track);
      const ev = resolvedEvents(analysis);
      it('assigns roles from the data', () => {
        expect(analysis.roles.lead).toBe(p.hand === 'R' ? 'L' : 'R');
        expect(analysis.roles.throw).toBe(p.hand);
        expect(analysis.roles.dir).toBe(p.hand === 'R' ? 1 : -1);
        expect(analysis.view.startsWith('side')).toBe(true);
      });
      for (const k of FRAME_TOL) {
        it(`detects ${k} within ±2 frames`, () => expect(Math.abs(ev[k] - s.truth[k])).toBeLessThanOrEqual(2));
      }
      for (const [k, ms] of Object.entries(MS_TOL) as [EventCode, number][]) {
        it(`detects ${k} within ±${ms} ms`, () => expect((Math.abs(ev[k] - s.truth[k]) / fps) * 1000).toBeLessThanOrEqual(ms));
      }
      it('events are in order', () => {
        const order: EventCode[] = ['FM', 'PKH', 'FS', 'MER', 'BR', 'MIR', 'END'];
        for (let i = 1; i < order.length; i++) expect(ev[order[i]]).toBeGreaterThanOrEqual(ev[order[i - 1]]);
      });
    });
  }
}
