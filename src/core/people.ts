// Multi-person tracking and pitcher identification.
//
// A clip can contain a runner, a batter, a catcher, an umpire or a coach. Picking "the biggest person in the
// first frame" fails whenever one of them is closer to the camera. Instead every person is tracked through a
// low-rate scan of the whole clip, and the pitcher is the person whose motion looks like a pitch:
//   - starts (nearly) still in a set position,
//   - ONE big knee lift on ONE leg (a runner alternates both legs over and over),
//   - then a short burst toward the plate (a runner keeps moving fast the whole time),
//   - and the fastest arm in the clip.
// All quantities are normalised by that person's own height in pixels, so it works the same whether the
// pitcher fills the frame (side view) or is small and far away (center-field camera).

/** MediaPipe 33-landmark indices used here. */
export const MP = { nose: 0, lSh: 11, rSh: 12, lWr: 15, rWr: 16, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28 } as const;

/** Person id of a region the user marked by hand (followed frame to frame instead of found by the scan). */
export const MANUAL_ID = -1;

export type Box = [number, number, number, number]; // x0, y0, x1, y1 in frame pixels

export interface Detection {
  box: Box;
  /** 33 × (x, y, visibility) in frame pixels. */
  kp: Float32Array;
}

export interface Tracklet {
  id: number;
  samples: number[]; // scan sample indices where the person was seen
  t: number[]; // seconds
  boxes: Box[];
  kps: Float32Array[];
  misses: number;
}

export type PersonRole = 'pitcher' | 'runner' | 'other';

export interface PersonSummary {
  id: number;
  role: PersonRole;
  score: number;
  reasons: string[];
  /** Box at the middle of the person's presence (for the "switch person" picker). */
  box: Box;
  heightFrac: number; // person height / frame height
  presence: number; // fraction of scan samples
}

export function boxOf(kp: Float32Array, minVis = 0.3): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j < 33; j++) {
    if (kp[j * 3 + 2] < minVis) continue;
    const x = kp[j * 3], y = kp[j * 3 + 1];
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (!Number.isFinite(x0)) return [0, 0, 0, 0];
  // landmarks stop at the forehead and ankles/feet; pad a little so the box covers the whole body
  const h = y1 - y0;
  return [x0 - 0.06 * h, y0 - 0.12 * h, x1 + 0.06 * h, y1 + 0.04 * h];
}

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return u > 0 ? inter / u : 0;
}

const bh = (b: Box) => Math.max(1, b[3] - b[1]);
const cx = (b: Box) => (b[0] + b[2]) / 2;
const cy = (b: Box) => (b[1] + b[3]) / 2;

/** Similarity between a detection and a track's predicted box: IoU, or centre distance for fast movers. */
function affinity(pred: Box, d: Box): number {
  const i = iou(pred, d);
  const dist = Math.hypot(cx(pred) - cx(d), cy(pred) - cy(d)) / bh(pred);
  const sizeRatio = Math.min(bh(pred), bh(d)) / Math.max(bh(pred), bh(d));
  if (sizeRatio < 0.5) return 0;
  return Math.max(i, dist < 0.5 ? 0.5 - dist : 0);
}

/** Non-maximum suppression: drop detections that overlap a bigger one (tiles see the same person twice). */
export function nms(dets: Detection[], thr = 0.5): Detection[] {
  const sorted = [...dets].sort((a, b) => bh(b.box) * (b.box[2] - b.box[0]) - bh(a.box) * (a.box[2] - a.box[0]));
  const out: Detection[] = [];
  for (const d of sorted) {
    const inside = out.some((o) => iou(o.box, d.box) > thr || containment(d.box, o.box) > 0.8);
    if (!inside) out.push(d);
  }
  return out;
}

function containment(inner: Box, outer: Box) {
  const ix = Math.max(0, Math.min(inner[2], outer[2]) - Math.max(inner[0], outer[0]));
  const iy = Math.max(0, Math.min(inner[3], outer[3]) - Math.max(inner[1], outer[1]));
  const a = (inner[2] - inner[0]) * (inner[3] - inner[1]);
  return a > 0 ? (ix * iy) / a : 0;
}

/** Predict where a track's box will be at time t (constant velocity from its last two observations). */
export function predictBox(tr: Tracklet, t: number): Box {
  const n = tr.boxes.length;
  const last = tr.boxes[n - 1];
  if (n < 2) return last;
  const prev = tr.boxes[n - 2];
  const dt = tr.t[n - 1] - tr.t[n - 2] || 1;
  const k = (t - tr.t[n - 1]) / dt;
  return last.map((v, i) => v + (v - prev[i]) * k) as Box;
}

/** Greedy association of this sample's detections to existing tracks; unmatched detections start new tracks. */
export class PeopleTracker {
  tracks: Tracklet[] = [];
  private nextId = 1;
  constructor(private maxMisses = 8) {}

  active(): Tracklet[] {
    return this.tracks.filter((t) => t.misses <= this.maxMisses);
  }

  update(sample: number, t: number, dets: Detection[], minHeightPx = 12) {
    const active = this.active();
    const preds = active.map((tr) => predictBox(tr, t));
    const pairs: { a: number; d: number; s: number }[] = [];
    active.forEach((_, a) => dets.forEach((det, d) => { const s = affinity(preds[a], det.box); if (s > 0.15) pairs.push({ a, d, s }); }));
    pairs.sort((x, y) => y.s - x.s);
    const usedA = new Set<number>(), usedD = new Set<number>();
    for (const p of pairs) {
      if (usedA.has(p.a) || usedD.has(p.d)) continue;
      usedA.add(p.a); usedD.add(p.d);
      const tr = active[p.a];
      tr.samples.push(sample); tr.t.push(t); tr.boxes.push(dets[p.d].box); tr.kps.push(dets[p.d].kp); tr.misses = 0;
    }
    active.forEach((tr, a) => { if (!usedA.has(a)) tr.misses++; });
    dets.forEach((det, d) => {
      if (usedD.has(d) || bh(det.box) < minHeightPx) return;
      this.tracks.push({ id: this.nextId++, samples: [sample], t: [t], boxes: [det.box], kps: [det.kp], misses: 0 });
    });
  }
}

// ---------------------------------------------------------------- pitcher scoring

function median(a: number[]) {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
}

/** Count separated peaks above a level (used to tell one leg lift from a running gait). */
function countPeaks(v: number[], level: number, minGap: number): number {
  let n = 0, last = -Infinity, above = false;
  for (let i = 0; i < v.length; i++) {
    if (v[i] >= level && !above) { if (i - last >= minGap) n++; above = true; last = i; }
    else if (v[i] < level * 0.6) above = false;
  }
  return n;
}

export interface PitcherScore { score: number; role: PersonRole; reasons: string[] }

/** Drop samples where the box size jumps (detector switched to someone else or merged two people). */
function cleanSamples(tr: Tracklet): Tracklet {
  const n = tr.boxes.length;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    const win = tr.boxes.slice(Math.max(0, i - 3), Math.min(n, i + 4)).map(bh);
    const m = median(win);
    if (Math.abs(bh(tr.boxes[i]) - m) / m < 0.3) keep.push(i);
  }
  return { ...tr, samples: keep.map((i) => tr.samples[i]), t: keep.map((i) => tr.t[i]), boxes: keep.map((i) => tr.boxes[i]), kps: keep.map((i) => tr.kps[i]) };
}

export function scorePerson(trIn: Tracklet, totalSamples: number, frameH: number): PitcherScore {
  const tr = cleanSamples(trIn);
  const n = tr.boxes.length;
  const reasons: string[] = [];
  if (n < 4) return { score: -10, role: 'other', reasons: ['seen too briefly'] };
  const H = median(tr.boxes.map(bh));
  const g = (kp: Float32Array, j: number, axis: 0 | 1) => kp[j * 3 + axis];
  const vis = (kp: Float32Array, j: number) => kp[j * 3 + 2];
  const hipY = tr.kps.map((k) => (g(k, MP.lHip, 1) + g(k, MP.rHip, 1)) / 2);
  const hipX = tr.kps.map((k) => (g(k, MP.lHip, 0) + g(k, MP.rHip, 0)) / 2);
  // knee height above hip, in body heights (y grows downward)
  const liftL = tr.kps.map((k, i) => (vis(k, MP.lKnee) > 0.2 ? (hipY[i] - g(k, MP.lKnee, 1)) / H : NaN));
  const liftR = tr.kps.map((k, i) => (vis(k, MP.rKnee) > 0.2 ? (hipY[i] - g(k, MP.rKnee, 1)) / H : NaN));
  // keypoint jitter on a tiny person can look like a lift: median-filter each knee over 3 samples (a real lift
  // lasts ~0.3 s, ~9 samples, and survives)
  const smooth = (v: number[]) => v.map((x, i) => {
    if (!Number.isFinite(x)) return x;
    const w = [v[i - 1], x, v[i + 1]].filter((y) => y !== undefined && Number.isFinite(y)) as number[];
    return w.length === 3 ? median(w) : x;
  });
  liftL.splice(0, n, ...smooth(liftL));
  liftR.splice(0, n, ...smooth(liftR));
  // a real leg lift lasts ~0.3 s: require the knee to stay up for two samples in a row
  const sustained = (v: number[]) => { let m = -Infinity; for (let i = 1; i < v.length; i++) if (Number.isFinite(v[i]) && Number.isFinite(v[i - 1])) m = Math.max(m, Math.min(v[i], v[i - 1])); return m; };
  const rise = (v: number[]) => { const base = median(v.slice(0, Math.max(3, Math.round(n * 0.2)))); const mx = sustained(v); return { base, rise: Number.isFinite(mx) ? mx - base : 0 }; };
  const rl = rise(liftL), rr = rise(liftR);
  const leadIsL = rl.rise >= rr.rise;
  const best = leadIsL ? rl : rr;
  const other = leadIsL ? rr : rl;
  const lead = leadIsL ? liftL : liftR;
  const trail = leadIsL ? liftR : liftL;

  // 1. leg lift: a pitcher's knee rises ~0.2–0.35 body heights toward hip level
  const liftScore = Math.max(0, Math.min(1, (best.rise - 0.06) / 0.16));
  if (liftScore > 0.5) reasons.push('clear leg lift');

  // 2. one lift on one leg vs. alternating strides
  const dtS = (tr.t[n - 1] - tr.t[0]) / Math.max(1, n - 1) || 1 / 30;
  const minGap = Math.max(2, Math.round(0.25 / dtS));
  const level = best.base + 0.6 * best.rise;
  const peaksLead = countPeaks(lead.map((v) => (Number.isFinite(v) ? v : -9)), level, minGap);
  const peaksTrail = countPeaks(trail.map((v) => (Number.isFinite(v) ? v : -9)), other.base + 0.6 * best.rise, minGap);
  const totalPeaks = peaksLead + peaksTrail;
  // only meaningful when the knees actually rise (a still person's jitter crosses any tiny threshold)
  const gaitPenalty = best.rise < 0.08 ? 0 : totalPeaks >= 3 ? 1 : totalPeaks === 2 && peaksTrail >= 1 ? 0.6 : 0;
  if (gaitPenalty >= 1) reasons.push('alternating leg lifts (running/walking gait)');

  // 3. starts still: hip speed during the first quarter of the person's presence
  // (hips median-filtered over 3 samples: keypoint jitter on a tiny far-away person must not look like running)
  const med3 = (v: number[]) => v.map((x, i) => (i === 0 || i === v.length - 1 ? x : median([v[i - 1], x, v[i + 1]])));
  const hx = med3(hipX), hy = med3(hipY);
  const speed: number[] = [];
  for (let i = 1; i < n; i++) speed.push(Math.hypot(hx[i] - hx[i - 1], hy[i] - hy[i - 1]) / H / Math.max(1e-3, tr.t[i] - tr.t[i - 1]));
  const q = Math.max(2, Math.round(speed.length * 0.25));
  const startSpeed = median(speed.slice(0, q));
  const stillScore = startSpeed < 0.35 ? 1 : startSpeed < 1 ? 0.5 : 0;
  if (stillScore === 1) reasons.push('starts still (set position)');

  // 4. sustained travel: fraction of time moving faster than 1.4 body heights per second
  const fastFrac = speed.filter((s) => s > 1.4).length / Math.max(1, speed.length);
  const runner = fastFrac > 0.4 || (gaitPenalty >= 1 && fastFrac > 0.2);
  if (runner) reasons.push(`moving fast ${Math.round(fastFrac * 100)}% of the time`);

  // 5. fastest arm: peak wrist speed (body heights per second)
  // second-highest wrist speed: one glitchy frame can't fake a fast arm, a real arm whip spans ~2 samples
  const ws: number[] = [];
  for (let i = 1; i < n; i++) {
    const dt = Math.max(1e-3, tr.t[i] - tr.t[i - 1]);
    if (dt > 0.12) continue; // gap in the track
    for (const j of [MP.lWr, MP.rWr]) {
      if (vis(tr.kps[i], j) < 0.3 || vis(tr.kps[i - 1], j) < 0.3) continue;
      ws.push(Math.hypot(g(tr.kps[i], j, 0) - g(tr.kps[i - 1], j, 0), g(tr.kps[i], j, 1) - g(tr.kps[i - 1], j, 1)) / H / dt);
    }
  }
  ws.sort((a, b) => b - a);
  const wrist = ws.length >= 2 ? ws[1] : 0;
  const armScore = Math.max(0, Math.min(1, (wrist - 4) / 8));
  if (armScore > 0.5) reasons.push('very fast arm');

  const presence = n / Math.max(1, totalSamples);
  const sizeFrac = H / frameH;
  let score = 3 * liftScore + 2 * stillScore + 2 * armScore + 1.5 * presence + 0.6 * Math.min(1, sizeFrac / 0.4) - 3 * gaitPenalty - (runner ? 4 : 0);
  if (liftScore > 0.5 && armScore > 0.4 && peaksLead === 1) score += 1.5; // the full signature of a pitch
  const role: PersonRole = runner ? 'runner' : 'other';
  return { score, role, reasons };
}

/**
 * Re-join fragments of the same person (a track breaks when someone walks in front or the detector misses
 * a few frames): a fragment that starts shortly after another ends, where that one was heading, at a similar size.
 */
export function stitchTracks(tracks: Tracklet[], maxGapS = 1.2): Tracklet[] {
  const list = tracks.map((t) => ({ ...t, samples: [...t.samples], t: [...t.t], boxes: [...t.boxes], kps: [...t.kps] })).sort((a, b) => a.t[0] - b.t[0]);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (const b of list) {
      for (const a of list) {
        if (a === b) continue;
        const aEnd = a.t[a.t.length - 1], bStart = b.t[0];
        if (bStart <= aEnd || bStart - aEnd > maxGapS) continue;
        const pred = predictBox(a, bStart), first = b.boxes[0], last = a.boxes[a.boxes.length - 1];
        const size = Math.min(bh(last), bh(first)) / Math.max(bh(last), bh(first));
        const dist = Math.min(Math.hypot(cx(pred) - cx(first), cy(pred) - cy(first)), Math.hypot(cx(last) - cx(first), cy(last) - cy(first))) / bh(last);
        if (size > 0.7 && dist < 0.6) {
          a.samples.push(...b.samples); a.t.push(...b.t); a.boxes.push(...b.boxes); a.kps.push(...b.kps);
          list.splice(list.indexOf(b), 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return list;
}

export interface PitcherChoice { pitcherId: number | null; people: PersonSummary[] }

export function choosePitcher(tracksIn: Tracklet[], totalSamples: number, frameH: number, pickedId?: number, frameW?: number): PitcherChoice {
  const tracks = stitchTracks(tracksIn).filter((t) => t.boxes.length >= 2);
  const sizes = tracks.map((t) => median(t.boxes.map(bh)));
  const maxSize = Math.max(1, ...sizes);
  const people: PersonSummary[] = tracks
    .map((t, k) => {
      const s = scorePerson(t, totalSamples, frameH);
      const mid = t.boxes[Math.floor(t.boxes.length / 2)];
      // tie-breakers between people who both move like a pitch (e.g. batter vs pitcher from center field):
      // the pitcher is usually the biggest person in a broadcast/behind view and near the middle of the frame
      let score = s.score + 0.8 * (sizes[k] / maxSize);
      if (frameW) score += 0.5 * Math.max(0, 1 - Math.abs(median(t.boxes.map(cx)) / frameW - 0.5) * 2);
      return { id: t.id, role: s.role, score, reasons: s.reasons, box: mid, heightFrac: bh(mid) / frameH, presence: t.boxes.length / Math.max(1, totalSamples) };
    })
    .sort((a, b) => b.score - a.score);
  let pitcherId: number | null = null;
  if (pickedId !== undefined && people.some((p) => p.id === pickedId)) pitcherId = pickedId;
  else if (people.length && people[0].score > -5) pitcherId = people[0].id;
  for (const p of people) if (p.id === pitcherId) p.role = 'pitcher';
  return { pitcherId, people };
}

/**
 * Pitcher filmed from behind (center-field camera): shoulders clearly visible but no face on most samples.
 * MediaPipe's detector needs a face, so the tracking pass lets MoveNet lead for these clips.
 */
export function isBackView(tr: Pick<Tracklet, 'kps'>): boolean {
  let seen = 0, back = 0;
  for (const k of tr.kps) {
    const sh = Math.min(k[MP.lSh * 3 + 2], k[MP.rSh * 3 + 2]);
    if (sh < 0.35) continue;
    seen++;
    const face = Math.max(k[MP.nose * 3 + 2], k[2 * 3 + 2], k[5 * 3 + 2]);
    if (face < 0.3) back++;
  }
  return seen >= 4 && back / seen > 0.5;
}

/** Box of a track at any time, linearly interpolated between scan samples (held at the ends). */
export function boxAt(tr: Pick<Tracklet, 't' | 'boxes'>, t: number): Box {
  const n = tr.t.length;
  if (t <= tr.t[0]) return tr.boxes[0];
  if (t >= tr.t[n - 1]) return tr.boxes[n - 1];
  let i = 1;
  while (tr.t[i] < t) i++;
  const k = (t - tr.t[i - 1]) / (tr.t[i] - tr.t[i - 1] || 1);
  return tr.boxes[i - 1].map((v, j) => v + (tr.boxes[i][j] - v) * k) as Box;
}

/**
 * Square crop around the pitcher for the full-rate pass. The box is the union of nearby scan boxes
 * (so the stride and arm path stay inside), expanded, and clamped to stay mostly inside the frame.
 */
export function cropFor(tr: Pick<Tracklet, 't' | 'boxes'>, t: number, frameW: number, frameH: number, window = 0.12, expand = 1.55): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = -2; k <= 2; k++) {
    const b = boxAt(tr, t + (k * window) / 2);
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
  }
  const side = Math.min(Math.max(frameW, frameH), Math.max(96, Math.max(x1 - x0, y1 - y0) * expand));
  let cxv = (x0 + x1) / 2, cyv = (y0 + y1) / 2;
  // keep the crop on screen where possible (padding outside is allowed but wastes pixels)
  cxv = Math.max(Math.min(cxv, frameW - side / 2), side / 2);
  cyv = Math.max(Math.min(cyv, frameH - side / 2), side / 2);
  if (side >= frameW) cxv = frameW / 2;
  if (side >= frameH) cyv = frameH / 2;
  return [cxv - side / 2, cyv - side / 2, cxv + side / 2, cyv + side / 2];
}

/**
 * Square zoom tiles of a given side, overlapping by half a tile, covering the frame. The pose detector needs a
 * person to fill at least ~20% of the image it sees (measured: 12–16% → missed, 22%+ → found), so tiles of side
 * S find people from ~0.2·S up to ~0.5·S tall. A pyramid of sides covers everyone from tiny to frame-filling.
 */
export function tileGrid(w: number, h: number, side: number): Box[] {
  side = Math.min(side, Math.max(w, h));
  const step = side / 2;
  const nx = Math.max(1, Math.ceil((w - side) / step) + 1), ny = Math.max(1, Math.ceil((h - side) / step) + 1);
  const out: Box[] = [];
  for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) {
    const x0 = nx === 1 ? (w - side) / 2 : Math.min(gx * step, w - side);
    const y0 = ny === 1 ? (h - side) / 2 : Math.min(gy * step, h - side);
    out.push([x0, y0, x0 + side, y0 + side]);
  }
  return out;
}

/** Tile pyramid for finding small people: frame-height squares, then half and (optionally) third height. */
export function zoomTiles(w: number, h: number, deep = false): Box[] {
  const sides = deep ? [h, h / 2, h / 3] : [h, h / 2];
  return sides.flatMap((s) => tileGrid(w, h, s));
}
