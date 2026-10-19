// Pitch velocity from video: find the ball in the frames right after release and measure how far it travels.
//
// 1. For each frame k after release, a "double difference" (pixels that changed vs. BOTH the previous and the
//    next frame) isolates things that are only at that spot in frame k — a fast ball, not the body.
// 2. Connected blobs of roughly ball size, ahead of the release point and near release height, are candidates.
// 3. RANSAC fits a straight constant-velocity path through the candidates (one per frame). The hand also moves
//    fast at release but decelerates and drops, so it doesn't fit a long straight constant-speed line.
// 4. Speed = pixels per frame × frame rate ÷ pixels per metre (from the pitcher's height).
// Only valid from the SIDE: the ball must travel across the image, not toward or away from the camera.

export interface GrayFrame { w: number; h: number; data: Uint8Array }

export interface BallSearch {
  frames: GrayFrame[]; // consecutive frames starting one frame before release
  release: { x: number; y: number }; // throwing wrist at release, in frame pixels
  dir: 1 | -1; // direction toward the plate in the image
  ballDiamPx: number; // expected ball diameter in pixels
  bodyHeightPx: number;
  fps: number; // real-time frames per second
  pxPerM: number;
  heightKnown: boolean;
}

export interface BallPoint { k: number; x: number; y: number; area: number }

export interface VeloEstimate {
  mph: number | null;
  low: number | null;
  high: number | null;
  method: 'ball' | 'manual' | 'none';
  points: BallPoint[];
  notes: string[];
}

export const MPH_PER_MS = 2.23694;

function blobs(f0: GrayFrame, f1: GrayFrame, f2: GrayFrame, roi: [number, number, number, number], thr: number) {
  const { w } = f1;
  const [x0, y0, x1, y1] = roi.map(Math.round) as [number, number, number, number];
  const W = x1 - x0, H = y1 - y0;
  if (W <= 0 || H <= 0) return [];
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y + y0) * w + (x + x0);
    const a = f1.data[i];
    if (Math.abs(a - f0.data[i]) > thr && Math.abs(a - f2.data[i]) > thr) mask[y * W + x] = 1;
  }
  const out: { x: number; y: number; area: number; bw: number; bh: number }[] = [];
  const stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (mask[s] !== 1) continue;
    let area = 0, sx = 0, sy = 0, mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    stack.push(s); mask[s] = 2;
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % W, py = (p - px) / W;
      area++; sx += px; sy += py;
      mnx = Math.min(mnx, px); mxx = Math.max(mxx, px); mny = Math.min(mny, py); mxy = Math.max(mxy, py);
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= mask.length || mask[q] !== 1) continue;
        if ((q === p - 1 && px === 0) || (q === p + 1 && px === W - 1)) continue;
        mask[q] = 2; stack.push(q);
      }
    }
    out.push({ x: x0 + sx / area, y: y0 + sy / area, area, bw: mxx - mnx + 1, bh: mxy - mny + 1 });
  }
  return out;
}

export function estimateBallSpeed(s: BallSearch): VeloEstimate {
  const notes: string[] = [];
  const none = (why: string): VeloEstimate => ({ mph: null, low: null, high: null, method: 'none', points: [], notes: [...notes, why] });
  if (s.frames.length < 4) return none('Not enough frames after release (the clip ends too soon).');
  if (s.fps < 50) return none(`At ${Math.round(s.fps)} fps the ball is a long blur between frames — film at 120–240 fps to measure velocity.`);
  const f = s.frames[0];
  const d = Math.max(2, s.ballDiamPx);
  const A = Math.PI * (d / 2) ** 2;
  // search region: from just behind the release point toward the plate, ±0.35 body heights vertically
  const xa = s.dir > 0 ? s.release.x - 0.15 * s.bodyHeightPx : 0;
  const xb = s.dir > 0 ? f.w : s.release.x + 0.15 * s.bodyHeightPx;
  const roi: [number, number, number, number] = [Math.max(0, xa), Math.max(0, s.release.y - 0.35 * s.bodyHeightPx), Math.min(f.w, xb), Math.min(f.h, s.release.y + 0.35 * s.bodyHeightPx)];
  // plausible pitch speeds (25–110 mph) in pixels per frame
  const minPxF = (25 / MPH_PER_MS) * s.pxPerM / s.fps, maxPxF = (110 / MPH_PER_MS) * s.pxPerM / s.fps;
  const cand: BallPoint[] = [];
  for (let k = 1; k < s.frames.length - 1; k++) {
    for (const b of blobs(s.frames[k - 1], s.frames[k], s.frames[k + 1], roi, 28)) {
      const elong = Math.max(b.bw, b.bh) / Math.max(1, Math.min(b.bw, b.bh));
      if (b.area < 0.25 * A || b.area > 6 * A + maxPxF * d) continue;
      if (elong > 1.6 + maxPxF / d) continue;
      if (Math.max(b.bw, b.bh) > 2.5 * d + maxPxF) continue;
      cand.push({ k, x: b.x, y: b.y, area: b.area });
    }
  }
  if (cand.length < 3) return none('Could not see the ball after release (it may be blurred, too small, or hidden by the body).');
  // RANSAC over pairs: x = x0 + vx (k - k0), y likewise
  let best: { inl: BallPoint[]; vx: number; vy: number; err: number } | null = null;
  const tol = Math.max(2, 0.35 * d);
  for (let i = 0; i < cand.length; i++) for (let j = 0; j < cand.length; j++) {
    const p = cand[i], q = cand[j];
    if (q.k <= p.k) continue;
    const vx = (q.x - p.x) / (q.k - p.k), vy = (q.y - p.y) / (q.k - p.k);
    const sp = Math.hypot(vx, vy);
    if (Math.sign(vx) !== s.dir || sp < minPxF || sp > maxPxF || Math.abs(vy) > 0.45 * Math.abs(vx)) continue;
    // the line must start near the release point around release (frame 1)
    const xRel = p.x - vx * (p.k - 1), yRel = p.y - vy * (p.k - 1);
    if (Math.hypot(xRel - s.release.x, yRel - s.release.y) > 0.3 * s.bodyHeightPx + 2 * sp) continue;
    const byK = new Map<number, BallPoint>();
    let err = 0;
    for (const c of cand) {
      const ex = p.x + vx * (c.k - p.k), ey = p.y + vy * (c.k - p.k);
      const e = Math.hypot(c.x - ex, c.y - ey);
      if (e > tol) continue;
      const prev = byK.get(c.k);
      if (!prev || Math.hypot(prev.x - ex, prev.y - ey) > e) byK.set(c.k, c);
    }
    const inl = [...byK.values()];
    for (const c of inl) err += Math.hypot(c.x - (p.x + vx * (c.k - p.k)), c.y - (p.y + vy * (c.k - p.k)));
    if (!best || inl.length > best.inl.length || (inl.length === best.inl.length && err < best.err)) best = { inl, vx, vy, err };
  }
  if (!best || best.inl.length < 3) return none('Found moving blobs but none followed a straight, ball-like path from the hand.');
  // least-squares refit on inliers
  const pts = best.inl.sort((a, b) => a.k - b.k);
  const mk = pts.reduce((a, p) => a + p.k, 0) / pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length, my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const skk = pts.reduce((a, p) => a + (p.k - mk) ** 2, 0) || 1;
  const vx = pts.reduce((a, p) => a + (p.k - mk) * (p.x - mx), 0) / skk;
  const vy = pts.reduce((a, p) => a + (p.k - mk) * (p.y - my), 0) / skk;
  const pxPerFrame = Math.hypot(vx, vy);
  const mph = ((pxPerFrame * s.fps) / s.pxPerM) * MPH_PER_MS;
  // uncertainty: centroid error (±0.5 px per point over the span), depth plane (±4%), and height (±6% if unknown)
  const span = pts[pts.length - 1].k - pts[0].k || 1;
  const meas = (1.0 / (pxPerFrame * span)) ;
  const rel = Math.sqrt(meas ** 2 + 0.04 ** 2 + (s.heightKnown ? 0.02 : 0.06) ** 2);
  if (!s.heightKnown) notes.push("Athlete height not entered — assumed 6'0\" (1.83 m). Enter the real height for a tighter estimate.");
  if (pts.length < 4) notes.push('The ball was seen in only 3 frames, so treat this as rough.');
  return { mph, low: mph * (1 - rel), high: mph * (1 + rel), method: 'ball', points: pts, notes };
}

/** Velocity from two user-marked ball positions (frame index and pixel position). */
export function manualBallSpeed(a: { k: number; x: number; y: number }, b: { k: number; x: number; y: number }, fps: number, pxPerM: number, heightKnown: boolean): VeloEstimate {
  const dk = Math.abs(b.k - a.k);
  if (!dk) return { mph: null, low: null, high: null, method: 'none', points: [], notes: ['Mark the ball on two different frames.'] };
  const px = Math.hypot(b.x - a.x, b.y - a.y) / dk;
  const mph = ((px * fps) / pxPerM) * MPH_PER_MS;
  const rel = Math.sqrt((3 / (px * dk)) ** 2 + 0.04 ** 2 + (heightKnown ? 0.02 : 0.06) ** 2);
  return { mph, low: mph * (1 - rel), high: mph * (1 + rel), method: 'manual', points: [{ k: a.k, x: a.x, y: a.y, area: 0 }, { k: b.k, x: b.x, y: b.y, area: 0 }], notes: heightKnown ? [] : ["Assumed 6'0\" — enter the athlete's height for a tighter estimate."] };
}
