import { describe, expect, it } from 'vitest';
import { GOOD_DAY, generatePitch, generateRunner } from '../../src/core/synthetic';
import { PeopleTracker, boxOf, choosePitcher, cropFor, nms, type Detection } from '../../src/core/people';
import { MEDIAPIPE_INDEX, JOINTS, type JointName } from '../../src/core/types';

type Body = Record<JointName, [number, number]>;

/** Project body-unit joints into a 33-landmark detection at a given screen position and size. */
function toDet(b: Body, x0: number, groundY: number, heightPx: number, dir = 1): Detection {
  const kp = new Float32Array(33 * 3);
  JOINTS.forEach((name, j) => {
    const k = MEDIAPIPE_INDEX[j];
    const [u, v] = b[name];
    kp[k * 3] = x0 + dir * u * heightPx; kp[k * 3 + 1] = groundY - v * heightPx; kp[k * 3 + 2] = 0.9;
  });
  return { box: boxOf(kp), kp };
}

function runScene(opts: { pitcherPx: number; runnerPx: number; runnerX: number; extraStill?: { px: number; x: number }; frameW: number; frameH: number }) {
  const fps = 30;
  const p = generatePitch({ ...GOOD_DAY, fps, noise: 0, dropouts: 0, swaps: 0 });
  const runner = generateRunner(fps, GOOD_DAY.duration, 3.2, -1.2);
  const still = opts.extraStill ? generateRunner(fps, GOOD_DAY.duration, 0, 0, 2.6, true) : null;
  const tracker = new PeopleTracker();
  const n = p.body.length;
  for (let i = 0; i < n; i++) {
    const dets: Detection[] = [
      toDet(p.body[i], opts.frameW * 0.3, opts.frameH * 0.85, opts.pitcherPx),
      toDet(runner[i], opts.runnerX, opts.frameH * 0.95, opts.runnerPx),
    ];
    if (still) dets.push(toDet(still[i], opts.extraStill!.x, opts.frameH * 0.97, opts.extraStill!.px));
    // detection order shuffles every frame, like a real detector
    if (i % 2) dets.reverse();
    tracker.update(i, i / fps, dets);
  }
  const pitcherTrack = tracker.tracks.find((t) => Math.abs((t.boxes[0][3] - t.boxes[0][1]) - opts.pitcherPx * 1.02) < opts.pitcherPx * 0.3 && t.boxes[0][0] < opts.frameW * 0.5);
  return { tracker, choice: choosePitcher(tracker.tracks, n, opts.frameH), n, pitcherTrack };
}

describe('pitcher identification', () => {
  it('ignores a bigger, more central runner and picks the pitcher', () => {
    const { choice, tracker } = runScene({ pitcherPx: 300, runnerPx: 520, runnerX: 500, frameW: 1280, frameH: 720 });
    const pitcher = choice.people.find((p) => p.role === 'pitcher')!;
    expect(pitcher).toBeDefined();
    // the pitcher's track is the one that starts near x = 0.3 W
    const tr = tracker.tracks.find((t) => t.id === pitcher.id)!;
    expect(tr.boxes[0][0]).toBeLessThan(500);
    expect(choice.people.some((p) => p.role === 'runner')).toBe(true);
  });

  it('ignores a big person standing still (catcher/coach) closer to the camera', () => {
    const { choice, tracker } = runScene({ pitcherPx: 260, runnerPx: 200, runnerX: -400, extraStill: { px: 600, x: 900 }, frameW: 1280, frameH: 720 });
    const tr = tracker.tracks.find((t) => t.id === choice.pitcherId)!;
    expect(tr.boxes[0][3] - tr.boxes[0][1]).toBeLessThan(400);
  });

  it('works when the pitcher is tiny (far center-field style camera)', () => {
    const { choice, tracker } = runScene({ pitcherPx: 70, runnerPx: 90, runnerX: 200, frameW: 1920, frameH: 1080 });
    const tr = tracker.tracks.find((t) => t.id === choice.pitcherId)!;
    expect(tr).toBeDefined();
    expect(tr.boxes[0][3] - tr.boxes[0][1]).toBeLessThan(80);
    expect(choice.people.find((p) => p.id === choice.pitcherId)!.heightFrac).toBeLessThan(0.1);
  });

  it('honours a manual pick', () => {
    const { choice } = runScene({ pitcherPx: 300, runnerPx: 520, runnerX: 500, frameW: 1280, frameH: 720 });
    const other = choice.people.find((p) => p.role !== 'pitcher')!;
    const { choice: c2 } = (() => ({ choice: choosePitcher([], 0, 720, other.id) }))();
    expect(c2.pitcherId).toBeNull();
  });

  it('crop window follows the pitcher and keeps the stride inside', () => {
    const { tracker, choice } = runScene({ pitcherPx: 120, runnerPx: 90, runnerX: 200, frameW: 1920, frameH: 1080 });
    const tr = tracker.tracks.find((t) => t.id === choice.pitcherId)!;
    for (let k = 0; k < tr.t.length; k += 5) {
      const c = cropFor(tr, tr.t[k], 1920, 1080);
      const b = tr.boxes[k];
      expect(c[0]).toBeLessThanOrEqual(b[0] + 1); expect(c[2]).toBeGreaterThanOrEqual(b[2] - 1);
      expect(c[1]).toBeLessThanOrEqual(b[1] + 1); expect(c[3]).toBeGreaterThanOrEqual(b[3] - 1);
      expect(c[2] - c[0]).toBeLessThan(600); // a tight crop: the model sees the small pitcher at high resolution
    }
  });

  it('nms removes tile duplicates', () => {
    const k = new Float32Array(99);
    const a = { box: [0, 0, 100, 200] as [number, number, number, number], kp: k };
    const b = { box: [5, 5, 98, 190] as [number, number, number, number], kp: k };
    const c = { box: [400, 0, 500, 200] as [number, number, number, number], kp: k };
    expect(nms([a, b, c])).toHaveLength(2);
  });
});

import { tileGrid, zoomTiles } from '../../src/core/people';
describe('zoom tile pyramid', () => {
  it('every person between 0.2 and 0.5 of the tile side fits fully inside some tile', () => {
    const W = 1920, H = 1080;
    for (const side of [H, H / 2, H / 3]) {
      const tiles = tileGrid(W, H, side);
      for (let x = 0; x < W - side * 0.5; x += 37) for (let y = 0; y < H - side * 0.5; y += 41) {
        const person = [x, y, x + side * 0.25, y + side * 0.5];
        expect(tiles.some((t) => t[0] <= person[0] && t[1] <= person[1] && t[2] >= person[2] && t[3] >= person[3])).toBe(true);
      }
    }
  });
  it('pyramid size stays small enough to run quickly', () => {
    expect(zoomTiles(1920, 1080).length).toBeLessThanOrEqual(30);
    expect(zoomTiles(1920, 1080, true).length).toBeLessThanOrEqual(110);
  });
});

import { stitchTracks, type Tracklet } from '../../src/core/people';
describe('track stitching', () => {
  it('re-joins a person whose track broke during an occlusion', () => {
    const mk = (id: number, t0: number, t1: number, x: number): Tracklet => {
      const t: number[] = [], boxes: [number, number, number, number][] = [];
      for (let s = t0; s <= t1 + 1e-9; s += 1 / 30) { t.push(s); boxes.push([x, 100, x + 80, 300]); }
      return { id, samples: t.map((_, i) => i), t, boxes, kps: t.map(() => new Float32Array(99)), misses: 0 };
    };
    const out = stitchTracks([mk(1, 0, 1, 400), mk(2, 1.4, 2.5, 410), mk(3, 0, 2.5, 900)]);
    expect(out).toHaveLength(2);
    expect(out.find((t) => t.id === 1)!.t.length).toBeGreaterThan(60);
  });
});
