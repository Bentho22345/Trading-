import { describe, expect, it } from 'vitest';
import { applyPick, cocoToMp, moveConf, type ScanResult } from '../../src/core/scan';
import { MANUAL_ID, isBackView, type Box } from '../../src/core/people';

/** A MoveNet person: 17 × (x, y, score) + box score, normalised. */
function movePerson(scores: Partial<Record<number, number>> = {}, base = 0.6): Float32Array {
  const a = new Float32Array(52);
  for (let j = 0; j < 17; j++) { a[j * 3] = 0.4 + 0.01 * j; a[j * 3 + 1] = 0.1 + 0.05 * j; a[j * 3 + 2] = scores[j] ?? base; }
  a[51] = 0.5;
  return a;
}

describe('MoveNet → MediaPipe layout', () => {
  it('maps COCO joints to the MediaPipe indices in frame pixels', () => {
    const kp = cocoToMp(movePerson(), 0, [100, 200, 300, 600]);
    // COCO 9 (left wrist) → MP 15; x = 100 + 0.49 × 200, y = 200 + 0.55 × 400
    expect(kp[15 * 3]).toBeCloseTo(100 + 0.49 * 200, 3);
    expect(kp[15 * 3 + 1]).toBeCloseTo(200 + 0.55 * 400, 3);
    expect(kp[15 * 3 + 2]).toBeCloseTo(moveConf(0.6), 5);
    // COCO 16 (right ankle) → MP 28; heels/toes sit on the ankles with ~no confidence
    expect(kp[30 * 3]).toBe(kp[28 * 3]);
    expect(kp[32 * 3 + 2]).toBeLessThan(0.051);
    // face points MoveNet lacks are invisible
    expect(kp[1 * 3 + 2]).toBe(0);
  });
  it('stretches MoveNet scores onto the MediaPipe confidence scale', () => {
    expect(moveConf(0.23)).toBeCloseTo(0.3, 1);
    expect(moveConf(0.9)).toBeLessThan(1);
  });
});

describe('behind-view detection', () => {
  const person = (face: number, sh: number) => cocoToMp(movePerson({ 0: face, 1: face, 2: face, 5: sh, 6: sh }), 0, [0, 0, 100, 200]);
  it('flags a body with shoulders but no face', () => {
    expect(isBackView({ kps: Array.from({ length: 8 }, () => person(0.08, 0.6)) })).toBe(true);
  });
  it('does not flag a pitcher facing the camera', () => {
    expect(isBackView({ kps: Array.from({ length: 8 }, () => person(0.7, 0.6)) })).toBe(false);
  });
  it('turning during the delivery: mostly back-on still counts as behind', () => {
    const kps = [...Array.from({ length: 6 }, () => person(0.1, 0.6)), ...Array.from({ length: 3 }, () => person(0.6, 0.6))];
    expect(isBackView({ kps })).toBe(true);
  });
});

describe('marking the pitcher', () => {
  const box = (x: number, y: number, w: number, h: number): Box => [x, y, x + w, y + h];
  const scan: ScanResult = {
    frameW: 1920, frameH: 1080, totalSamples: 30, smallPeople: false, pitcherId: 1,
    tracks: [
      { id: 1, t: [0, 1, 2], boxes: [box(200, 300, 150, 500), box(220, 300, 150, 500), box(240, 300, 150, 500)] },
      { id: 2, t: [0, 1, 2], boxes: [box(1400, 400, 100, 300), box(1400, 400, 100, 300), box(1400, 400, 100, 300)] },
    ],
    people: [
      { id: 1, role: 'pitcher', score: 5, reasons: [], box: box(200, 300, 150, 500), heightFrac: 0.46, presence: 1 },
      { id: 2, role: 'other', score: 1, reasons: [], box: box(1400, 400, 100, 300), heightFrac: 0.28, presence: 1 },
    ],
  };
  it('a tap on another person switches to them', () => {
    const r = applyPick(scan, { x0: 1450 / 1920, y0: 550 / 1080, x1: 1450 / 1920, y1: 550 / 1080, t: 1 });
    expect(r.pitcherId).toBe(2);
    expect(r.people.find((p) => p.id === 2)!.role).toBe('pitcher');
    expect(r.people.find((p) => p.id === 1)!.role).toBe('other');
  });
  it('a box around a found person picks that person', () => {
    const r = applyPick(scan, { x0: 1390 / 1920, y0: 390 / 1080, x1: 1510 / 1920, y1: 710 / 1080, t: 0.5 });
    expect(r.pitcherId).toBe(2);
  });
  it('a box where nobody was found is followed by hand', () => {
    const r = applyPick(scan, { x0: 0.45, y0: 0.3, x1: 0.5, y1: 0.45, t: 1.2 });
    expect(r.pitcherId).toBe(MANUAL_ID);
    const tr = r.tracks.find((t) => t.id === MANUAL_ID)!;
    expect(tr.t).toEqual([1.2]);
    expect(tr.boxes[0][0]).toBeCloseTo(0.45 * 1920, 3);
    expect(r.people[0]).toMatchObject({ id: MANUAL_ID, role: 'pitcher' });
    expect(r.people.filter((p) => p.role === 'pitcher')).toHaveLength(1);
  });
});
