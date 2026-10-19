import { describe, expect, it } from 'vitest';
import { estimateBallSpeed, manualBallSpeed, MPH_PER_MS, type GrayFrame } from '../../src/core/ballspeed';

/** Draw a scene: textured background, a moving "arm" blob that decelerates and drops, and a ball flying at constant speed. */
function scene(opts: { mph: number; fps: number; heightPx: number; heightM: number; nFrames: number; seed?: number; dir?: 1 | -1; noBall?: boolean }) {
  const w = 720, h = 405;
  const pxPerM = opts.heightPx / opts.heightM;
  const vPxF = ((opts.mph / MPH_PER_MS) * pxPerM) / opts.fps;
  const dir = opts.dir ?? 1;
  const rel = { x: dir > 0 ? 260 : 460, y: 170 };
  const d = 0.04 * opts.heightPx;
  let s = opts.seed ?? 3;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const bg = new Uint8Array(w * h);
  for (let i = 0; i < bg.length; i++) bg[i] = 90 + ((i * 7919) % 37) + Math.floor(rnd() * 6);
  const frames: GrayFrame[] = [];
  for (let k = 0; k < opts.nFrames; k++) {
    const data = bg.slice();
    for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, data[i] + (rnd() - 0.5) * 6));
    const disk = (x: number, y: number, r: number, v: number) => {
      for (let yy = Math.floor(y - r); yy <= y + r; yy++) for (let xx = Math.floor(x - r); xx <= x + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if ((xx - x) ** 2 + (yy - y) ** 2 <= r * r) data[yy * w + xx] = v;
      }
    };
    // forearm/hand: big blob that follows through, decelerating and dropping
    const t = k - 1;
    disk(rel.x + dir * (vPxF * 0.6) * Math.max(0, t) * Math.exp(-0.25 * Math.max(0, t)), rel.y + 4 * Math.max(0, t) ** 1.5, d * 1.6, 200);
    if (!opts.noBall && k >= 1) disk(rel.x + dir * vPxF * t, rel.y + 0.05 * vPxF * t, d / 2, 245);
    frames.push({ w, h, data });
  }
  return { frames, release: rel, dir, d, pxPerM };
}

describe('ball speed from video', () => {
  for (const [mph, fps] of [[85, 240], [72, 240], [60, 120], [90, 120]] as const) {
    it(`recovers ${mph} mph at ${fps} fps within 3%`, () => {
      const sc = scene({ mph, fps, heightPx: 400, heightM: 1.85, nFrames: Math.ceil(fps * 0.05) + 2 });
      const r = estimateBallSpeed({ frames: sc.frames, release: sc.release, dir: sc.dir, ballDiamPx: sc.d, bodyHeightPx: 400, fps, pxPerM: sc.pxPerM, heightKnown: true });
      expect(r.method).toBe('ball');
      expect(Math.abs(r.mph! - mph) / mph).toBeLessThan(0.03);
      expect(r.low!).toBeLessThan(r.mph!); expect(r.high!).toBeGreaterThan(r.mph!);
    });
  }
  it('works for a lefty throwing the other way', () => {
    const sc = scene({ mph: 80, fps: 240, heightPx: 400, heightM: 1.85, nFrames: 14, dir: -1 });
    const r = estimateBallSpeed({ frames: sc.frames, release: sc.release, dir: -1, ballDiamPx: sc.d, bodyHeightPx: 400, fps: 240, pxPerM: sc.pxPerM, heightKnown: true });
    expect(Math.abs(r.mph! - 80)).toBeLessThan(2.4);
  });
  it('reports nothing instead of guessing when there is no ball', () => {
    const sc = scene({ mph: 80, fps: 240, heightPx: 400, heightM: 1.85, nFrames: 14, noBall: true });
    const r = estimateBallSpeed({ frames: sc.frames, release: sc.release, dir: 1, ballDiamPx: sc.d, bodyHeightPx: 400, fps: 240, pxPerM: sc.pxPerM, heightKnown: true });
    expect(r.mph).toBeNull();
    expect(r.notes.join(' ')).toMatch(/ball/);
  });
  it('refuses at 30 fps', () => {
    const sc = scene({ mph: 80, fps: 30, heightPx: 400, heightM: 1.85, nFrames: 6 });
    expect(estimateBallSpeed({ frames: sc.frames, release: sc.release, dir: 1, ballDiamPx: sc.d, bodyHeightPx: 400, fps: 30, pxPerM: sc.pxPerM, heightKnown: true }).mph).toBeNull();
  });
  it('widens the range when height is assumed', () => {
    const sc = scene({ mph: 80, fps: 240, heightPx: 400, heightM: 1.85, nFrames: 14 });
    const base = { frames: sc.frames, release: sc.release, dir: 1 as const, ballDiamPx: sc.d, bodyHeightPx: 400, fps: 240, pxPerM: sc.pxPerM };
    const known = estimateBallSpeed({ ...base, heightKnown: true }), guess = estimateBallSpeed({ ...base, heightKnown: false });
    expect(guess.high! - guess.low!).toBeGreaterThan(known.high! - known.low!);
  });
  it('manual marking: two clicks give the speed', () => {
    const pxPerM = 400 / 1.85, fps = 240;
    const v = ((85 / MPH_PER_MS) * pxPerM) / fps;
    const r = manualBallSpeed({ k: 2, x: 100, y: 50 }, { k: 8, x: 100 + 6 * v, y: 50 }, fps, pxPerM, true);
    expect(r.mph!).toBeCloseTo(85, 1);
  });
});
