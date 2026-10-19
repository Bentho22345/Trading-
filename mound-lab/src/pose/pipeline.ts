// Main-thread side of pose tracking. Two models work together:
//  - MoveNet (TensorFlow.js): finds EVERY person in one pass and sees people from any side, including a pitcher
//    filmed from behind (center-field camera). MediaPipe's person detector keys on the face and misses them.
//  - MediaPipe Pose Landmarker: precise 33-point landmarks + 3D estimate for the full-rate tracking pass.
//
// Pass 1 — "find the pitcher": decode the clip, look at ~30 frames per second, find every person (whole frame,
//   zoom tiles when people are small, and a zoomed crop around each person already being tracked), link them
//   into tracks, and score each track for "looks like a pitch" (see core/people.ts). Runners, batters,
//   catchers and coaches are rejected even if they are bigger or more central than the pitcher.
// Pass 2 — "track the pitcher": decode every frame and run the pose model on a square crop that follows the
//   pitcher. MediaPipe is the main tracker; any frame it misses is filled by MoveNet Thunder on the same crop.
//   From behind (or when MediaPipe keeps losing the pitcher) MoveNet Thunder becomes the main tracker.

import PoseWorker from './pose.worker?worker';
import MoveWorker from './movenet.worker?worker';
import type { WorkerIn, WorkerOut } from './pose.worker';
import type { MoveIn, MoveOut } from './movenet.worker';
import { extractFrames } from '../video/frames';
export { MANUAL_ID } from '../core/people';
import { MEDIAPIPE_INDEX, NJ, type PoseTrack } from '../core/types';
import { PeopleTracker, boxAt, boxOf, choosePitcher, stitchTracks, cropFor, iou, nms, predictBox, zoomTiles, isBackView, MANUAL_ID, type Box, type Detection } from '../core/people';
import { applyPick, cocoToMp, type PickRegion, type ScanResult } from '../core/scan';
export { applyPick, cocoToMp, type PickRegion, type ScanResult };

export type PoseModel = 'full' | 'lite';
/** auto: MediaPipe with MoveNet filling its misses, MoveNet from behind. */
export type PoseEngine = 'auto' | 'mediapipe' | 'movenet';

export interface PoseRunOptions {
  startS: number;
  endS: number;
  fpsMedia: number;
  slowmo: number; // real = media / slowmo
  model: PoseModel;
  engine?: PoseEngine;
  rotate?: number;
  signal?: AbortSignal;
  /** Re-use a previous scan (switching person or marking the pitcher without re-scanning). */
  scan?: ScanResult;
  personId?: number;
  /** The user tapped (zero-size region) or dragged a box around the pitcher. */
  pick?: PickRegion;
  onProgress?: (p: { done: number; total: number; etaS: number | null; stage: string }) => void;
}

export interface PoseRunResult {
  track: PoseTrack;
  frames: Blob[]; // JPEG preview of every analysed frame
  method: 'webcodecs' | 'seek';
  delegate: string;
  lostFrames: number;
  /** Frames whose pose came from MoveNet (behind view, or MediaPipe missed them). */
  moveFrames: number;
  scan: ScanResult;
}

// ---------------------------------------------------------------- MediaPipe worker

let worker: Worker | null = null;
let workerModel: PoseModel | null = null;
let workerDelegate = '';

type Result = { n: number; poses: Float32Array; world: Float32Array };
const pending = new Map<number, { res: (r: Result) => void; rej: (e: Error) => void }>();
let nextId = 1;

async function getWorker(model: PoseModel): Promise<Worker> {
  if (worker && workerModel === model) return worker;
  worker?.terminate();
  const w = new PoseWorker();
  const base = new URL('./', document.baseURI).href;
  await new Promise<void>((res, rej) => {
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      if (e.data.type === 'ready') { workerDelegate = e.data.delegate; res(); }
      else if (e.data.type === 'error') rej(new Error(`Could not load the pose model: ${e.data.message}`));
    };
    w.onerror = (e) => rej(new Error(`Pose worker failed to start: ${e.message}`));
    w.postMessage({ type: 'init', wasmBase: base + 'mediapipe', modelUrl: `${base}models/pose_landmarker_${model}.task`, delegate: 'GPU' } satisfies WorkerIn);
  });
  w.onmessage = (e: MessageEvent<WorkerOut>) => {
    const m = e.data;
    if (m.type === 'result') { pending.get(m.id)?.res(m); pending.delete(m.id); }
    else if (m.type === 'error' && m.id !== undefined) { pending.get(m.id)?.rej(new Error(m.message)); pending.delete(m.id); }
  };
  worker = w; workerModel = model;
  return w;
}

function call(w: Worker, kind: 'detect' | 'track', bitmap: ImageBitmap, tMs = 0): Promise<Result> {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    const msg: WorkerIn = kind === 'detect' ? { type: 'detect', id, bitmap } : { type: 'track', id, bitmap, tMs };
    w.postMessage(msg, [bitmap]);
  });
}

// ---------------------------------------------------------------- MoveNet worker

let move: Worker | null = null;
let moveLoading: Promise<Worker | null> | null = null;
let moveBackend = '';
type MoveResult = { n: number; people: Float32Array };
const movePending = new Map<number, { res: (r: MoveResult) => void; rej: (e: Error) => void }>();

/** MoveNet worker, or null if it can't run here (then everything falls back to MediaPipe). */
function getMove(): Promise<Worker | null> {
  if (move) return Promise.resolve(move);
  if (moveLoading) return moveLoading;
  moveLoading = (async () => {
    const w = new MoveWorker();
    try {
      await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => rej(new Error('MoveNet took too long to load')), 90_000);
        w.onmessage = (e: MessageEvent<MoveOut>) => {
          if (e.data.type === 'ready') { clearTimeout(timer); moveBackend = e.data.backend; res(); }
          else if (e.data.type === 'error') { clearTimeout(timer); rej(new Error(e.data.message)); }
        };
        w.onerror = (e) => { clearTimeout(timer); rej(new Error(e.message)); };
        w.postMessage({ type: 'init', base: new URL('./', document.baseURI).href } satisfies MoveIn);
      });
    } catch (e) {
      console.warn('MoveNet unavailable, using MediaPipe only:', e);
      w.terminate();
      return null; // moveLoading stays set: don't retry on every clip
    }
    w.onmessage = (e: MessageEvent<MoveOut>) => {
      const m = e.data;
      if (m.type === 'result') { movePending.get(m.id)?.res(m); movePending.delete(m.id); }
      else if (m.type === 'error' && m.id !== undefined) { movePending.get(m.id)?.rej(new Error(m.message)); movePending.delete(m.id); }
    };
    move = w;
    return w;
  })();
  return moveLoading;
}

function moveCall(w: Worker, kind: 'multi' | 'single', bitmap: ImageBitmap, minScore?: number): Promise<MoveResult> {
  const id = nextId++;
  return new Promise((res, rej) => {
    movePending.set(id, { res, rej });
    const msg: MoveIn = kind === 'multi' ? { type: 'multi', id, bitmap, minScore } : { type: 'single', id, bitmap };
    w.postMessage(msg, [bitmap]);
  });
}

/** Throw away the workers after a model error so the next run starts from a clean graph. */
export function resetPoseWorker() {
  worker?.terminate();
  worker = null; workerModel = null;
  for (const p of pending.values()) p.rej(new Error('Pose worker restarted'));
  pending.clear();
  if (move) {
    move.terminate(); move = null; moveLoading = null;
    for (const p of movePending.values()) p.rej(new Error('MoveNet worker restarted'));
    movePending.clear();
  }
}

// ---------------------------------------------------------------- helpers

/** Crop a region of a frame (may extend past the edges — that part stays empty) and resize it for the model. */
function crop(src: ImageBitmap, b: Box, size: number): ImageBitmap {
  const sw = b[2] - b[0], sh = b[3] - b[1];
  const s = size / Math.max(sw, sh);
  const c = new OffscreenCanvas(Math.max(1, Math.round(sw * s)), Math.max(1, Math.round(sh * s)));
  // canvas drawing (not createImageBitmap resize options, which Safari ignores)
  c.getContext('2d')!.drawImage(src, b[0], b[1], sw, sh, 0, 0, c.width, c.height);
  return c.transferToImageBitmap();
}

/** Copy a bitmap, optionally shrunk (the worker takes ownership of what it is sent). */
function copy(src: ImageBitmap, maxSide = Infinity): ImageBitmap {
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = new OffscreenCanvas(Math.round(src.width * s), Math.round(src.height * s));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c.transferToImageBitmap();
}

/** Convert a MediaPipe result (normalised to the crop) into frame-pixel detections. */
function toDetections(r: Result, region: Box): Detection[] {
  const out: Detection[] = [];
  const w = region[2] - region[0], h = region[3] - region[1];
  for (let p = 0; p < r.n; p++) {
    const kp = new Float32Array(99);
    for (let j = 0; j < 33; j++) {
      kp[j * 3] = region[0] + r.poses[p * 99 + j * 3] * w;
      kp[j * 3 + 1] = region[1] + r.poses[p * 99 + j * 3 + 1] * h;
      kp[j * 3 + 2] = r.poses[p * 99 + j * 3 + 2];
    }
    const det = { box: boxOf(kp), kp } as Detection & { world?: Float32Array };
    det.world = r.world.slice(p * 99, p * 99 + 99);
    out.push(det);
  }
  return out;
}

function moveDetections(r: MoveResult, region: Box): Detection[] {
  const out: Detection[] = [];
  for (let p = 0; p < r.n; p++) {
    const kp = cocoToMp(r.people, p, region);
    out.push({ box: boxOf(kp), kp });
  }
  return out;
}

const squareAround = (b: Box, scale: number, min: number): Box => {
  const side = Math.max(min, Math.max(b[2] - b[0], b[3] - b[1]) * scale);
  const x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2;
  return [x - side / 2, y - side / 2, x + side / 2, y + side / 2];
};

// ---------------------------------------------------------------- pass 1: find the pitcher

async function scanPeople(w: Worker, mv: Worker | null, file: Blob, opt: PoseRunOptions, report: (done: number, total: number) => void): Promise<ScanResult> {
  const step = Math.max(1, Math.round(opt.fpsMedia / 30));
  let tracker = new PeopleTracker(10);
  let frameW = 0, frameH = 0, sample = 0, total = 0, smallPeople = false, lastIndex = -1;
  const mpProbe = new Map<number, { tries: number; hits: number }>();
  // MoveNet looks at the whole frame in one cheap pass; MediaPipe runs the landmark model per person found
  const detect = async (bm: ImageBitmap, region: Box, size: number, tile = false): Promise<Detection[]> => {
    if (mv) return moveDetections(await moveCall(mv, 'multi', crop(bm, region, size), tile ? 0.1 : 0.12), region);
    return toDetections(await call(w, 'detect', crop(bm, region, Math.max(size, 448))), region);
  };
  await extractFrames(file, {
    startS: opt.startS, endS: opt.endS, fps: opt.fpsMedia, maxSide: 1920, rotate: opt.rotate, signal: opt.signal,
    keep: (i) => i % step === 0,
    onTotal: (n) => { total = Math.ceil(n / step); },
    onFrame: async ({ bitmap, tMedia, index }) => {
      try {
        if (index <= lastIndex) { tracker = new PeopleTracker(10); sample = 0; mpProbe.clear(); } // decoder fell back and restarted
        lastIndex = index;
        frameW = bitmap.width; frameH = bitmap.height;
        const t = tMedia - opt.startS;
        const active = tracker.active();
        // one big, clearly visible person and nobody else so far: half the scan rate is plenty
        if (sample > 6 && sample % 2 === 1 && sample % 8 !== 0 && !smallPeople && tracker.tracks.length === 1 && active.length === 1) { sample++; report(sample, total); return; }
        const full: Box = [0, 0, frameW, frameH];
        let dets: Detection[] = [];
        // whole-frame search: at the start, regularly, and whenever nobody is being tracked
        // MoveNet sees everyone in one cheap pass, so it looks at the whole frame every sample
        let fullDets: Detection[] = [];
        if (mv || sample === 0 || sample % 8 === 0 || !active.length) {
          fullDets = await detect(bitmap, full, mv ? 256 : 448);
          dets.push(...fullDets);
          // nobody tracked yet: ask MediaPipe too (it sees some faces/poses MoveNet scores low, and vice versa)
          if (mv && !active.length) dets.push(...toDetections(await call(w, 'detect', copy(bitmap, 640)), full));
          // small people (far camera, e.g. center field): search a pyramid of zoomed tiles
          const biggest = Math.max(0, ...dets.map((d) => (d.box[3] - d.box[1]) / frameH));
          if (sample === 0 && biggest < 0.35) smallPeople = true;
          if (smallPeople && (sample === 0 || sample % 16 === 0 || !active.length)) {
            const before = dets.length;
            const tileSearch = async (deep: boolean) => {
              for (const tile of zoomTiles(frameW, frameH, deep)) dets.push(...await detect(bitmap, tile, mv ? 256 : 448, true));
            };
            await tileSearch(false);
            if (dets.length === before && (sample === 0 || !active.length)) await tileSearch(true); // look for very small people too
          }
        }
        // zoomed crop around everyone already being tracked: keeps small, fast and back-turned people locked on
        // Busy frames (broadcast views with fielders): the most likely pitchers (big, central) every sample,
        // the rest every third sample. A big person the whole-frame pass already sees clearly needs no zoom.
        const prio = (b: Box) => (b[3] - b[1]) / frameH + 0.3 * (1 - Math.abs((b[0] + b[2]) / 2 / frameW - 0.5) * 2);
        const ranked = active.map((tr) => ({ tr, b: predictBox(tr, t) })).sort((x, y) => prio(y.b) - prio(x.b));
        for (const [k, { tr, b }] of ranked.entries()) {
          if (k >= 4 && (sample + tr.id) % 3 !== 0) continue;
          if (b[3] - b[1] > 0.45 * frameH && fullDets.some((d) => iou(d.box, b) > 0.4)) continue;
          const region = squareAround(b, 2.2, 96);
          dets.push(...await detect(bitmap, region, mv ? 256 : 384));
        }
        dets = nms(dets.filter((d) => d.box[3] - d.box[1] > 8));
        tracker.update(sample, t, dets, Math.max(10, frameH * 0.03));
        // Can MediaPipe see each person? Its detector needs a face, so from behind (or tiny / blurred) it often
        // can't — then MoveNet should lead the tracking pass from the first frame.
        if (mv && sample % 6 === 3) {
          // the three most likely pitchers seen this sample (big, central)
          const seen = tracker.tracks.filter((tr) => tr.samples[tr.samples.length - 1] === sample)
            .map((tr) => ({ tr, b: tr.boxes[tr.boxes.length - 1] })).sort((x, y) => prio(y.b) - prio(x.b)).slice(0, 3);
          for (const { tr, b } of seen) {
            const region = squareAround(b, 1.6, 96);
            const found = toDetections(await call(w, 'detect', crop(bitmap, region, 448)), region).some((d) => iou(d.box, b) > 0.3);
            const p = mpProbe.get(tr.id) ?? { tries: 0, hits: 0 };
            p.tries++; if (found) p.hits++;
            mpProbe.set(tr.id, p);
          }
        }
        sample++;
        report(sample, total);
      } finally {
        bitmap.close();
      }
    },
  });
  const stitched = stitchTracks(tracker.tracks);
  const choice = choosePitcher(stitched, sample, frameH, opt.personId, frameW);
  const pitcher = stitched.find((t) => t.id === choice.pitcherId);
  const probe = pitcher ? mpProbe.get(pitcher.id) : undefined;
  return {
    frameW, frameH, totalSamples: sample, smallPeople, finder: mv ? 'movenet' : 'mediapipe',
    backView: pitcher ? isBackView(pitcher) : false,
    mediapipeWeak: !!probe && probe.tries >= 2 && probe.hits / probe.tries < 0.5,
    probes: Object.fromEntries([...mpProbe].map(([id, p]) => [id, p.tries ? p.hits / p.tries : 0])),
    tracks: stitched.filter((t) => t.boxes.length >= 2).map((t) => ({ id: t.id, t: t.t, boxes: t.boxes })),
    people: choice.people, pitcherId: choice.pitcherId,
  };
}

// ---------------------------------------------------------------- run

export async function runPose(file: Blob, opt: PoseRunOptions): Promise<PoseRunResult> {
  opt.onProgress?.({ done: 0, total: 0, etaS: null, stage: 'Loading pose models…' });
  const engine = opt.engine ?? 'auto';
  const [w, mv] = await Promise.all([getWorker(opt.model), engine === 'mediapipe' ? Promise.resolve(null) : getMove()]);
  w.postMessage({ type: 'reset' } satisfies WorkerIn);

  // ---- pass 1
  let scan = opt.scan;
  if (!scan) {
    scan = await scanPeople(w, mv, file, opt, (d, n) => opt.onProgress?.({ done: d, total: n, etaS: null, stage: 'Finding the pitcher…' }));
  }
  if (opt.pick) scan = applyPick(scan, opt.pick);
  else if (opt.personId !== undefined && scan.tracks.some((t) => t.id === opt.personId)) {
    const people = scan.people.map((p) => ({ ...p, role: p.id === opt.personId ? 'pitcher' as const : p.role === 'pitcher' ? 'other' as const : p.role }));
    scan = { ...scan, people, pitcherId: opt.personId };
  }
  const found = scan.tracks.find((t) => t.id === scan!.pitcherId);
  if (!found) throw new Error('No person could be found in this clip. Use "Mark the pitcher…" and drag a box around them, or check that the whole pitcher is visible and well lit.');
  // a marked region is followed: each frame's pose moves the crop for the next frames
  const manual = found.id === MANUAL_ID;
  const pitcher = { t: [...found.t], boxes: [...found.boxes] };
  const follow = (t: number, b: Box) => {
    let i = pitcher.t.length;
    while (i > 0 && pitcher.t[i - 1] > t) i--;
    pitcher.t.splice(i, 0, t); pitcher.boxes.splice(i, 0, b);
  };

  // which model leads: MoveNet from behind (MediaPipe needs a face to find the body), MediaPipe otherwise
  const mpRate = scan.probes?.[found.id];
  const weak = found.id === MANUAL_ID ? false : mpRate !== undefined ? mpRate < 0.5 : !!(scan.backView || scan.mediapipeWeak);
  let primary: 'mp' | 'move' = mv && (engine === 'movenet' || (engine === 'auto' && weak)) ? 'move' : 'mp';
  const recent: boolean[] = []; // did MediaPipe find the pitcher on recent frames?

  // ---- pass 2
  const times: number[] = [];
  const frames: Blob[] = [];
  type Res = Detection & { world?: Float32Array; move?: boolean };
  const results: (Res | null)[] = [];
  let dims = { w: 0, h: 0 };
  let total = 0, lastIndex = -1;
  const preview = new OffscreenCanvas(1, 1);
  const pctx = preview.getContext('2d')!;
  const t1 = performance.now();
  const inflight: Promise<void>[] = [];

  const thunder = async (bitmap: ImageBitmap, region: Box, expected: Box): Promise<Res | null> => {
    if (!mv) return null;
    // a MoveNet failure only loses this frame, never the whole run
    const r = await moveCall(mv, 'single', crop(bitmap, region, 256)).catch((e) => { console.warn('MoveNet Thunder failed on a frame:', e); return null; });
    if (!r) return null;
    if (!r.n || r.people[51] < 0.2) return null;
    const kp = cocoToMp(r.people, 0, region);
    const box = boxOf(kp);
    if (box[3] - box[1] < 4 || iou(box, expected) < 0.05) return null;
    return { box, kp, move: true };
  };

  const { method } = await extractFrames(file, {
    startS: opt.startS, endS: opt.endS, fps: opt.fpsMedia, maxSide: 1920, rotate: opt.rotate, signal: opt.signal,
    onTotal: (n) => { total = n; },
    onFrame: async ({ bitmap, tMedia, index }) => {
      if (index <= lastIndex) { times.length = 0; frames.length = 0; results.length = 0; } // decoder fell back and restarted
      lastIndex = index;
      if (opt.signal?.aborted) { bitmap.close(); throw new DOMException('Cancelled', 'AbortError'); }
      dims = { w: bitmap.width, h: bitmap.height };
      const t = tMedia - opt.startS;
      // JPEG preview for frame-accurate playback (≤ 720 px on the long side)
      const s = Math.min(1, 720 / Math.max(bitmap.width, bitmap.height));
      preview.width = Math.round(bitmap.width * s); preview.height = Math.round(bitmap.height * s);
      pctx.drawImage(bitmap, 0, 0, preview.width, preview.height);
      const jpeg = preview.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
      const region = cropFor(pitcher, t, bitmap.width, bitmap.height);
      const expected = pitcherBoxAt(pitcher, t);
      times[index] = tMedia;
      // keep up to 3 frames in flight
      const job = (async () => {
        try {
          let best: Res | null = null;
          if (primary === 'mp') {
            const r = await call(w, 'track', crop(bitmap, region, 448), t * 1000);
            let bestS = 0.08;
            for (const d of toDetections(r, region)) { const sc = iou(d.box, expected); if (sc > bestS) { bestS = sc; best = d; } }
            recent.push(!!best); if (recent.length > 24) recent.shift();
            // MediaPipe keeps losing this pitcher (back turned, odd angle, blur): let MoveNet lead from here
            if (engine === 'auto' && mv && recent.length >= 24 && recent.filter(Boolean).length < 12) primary = 'move';
          }
          if (!best) best = await thunder(bitmap, region, expected);
          results[index] = best;
          if (best && manual) follow(t, best.box);
          frames[index] = await jpeg;
        } finally { bitmap.close(); }
      })();
      inflight.push(job);
      if (inflight.length >= 3) await inflight.shift();
      const done = index + 1;
      const el = (performance.now() - t1) / 1000;
      opt.onProgress?.({ done, total, etaS: total ? (el / done) * (total - done) : null, stage: manual ? 'Following the marked pitcher…' : 'Tracking the pitcher…' });
    },
  });
  await Promise.all(inflight);

  if (times.length < 5) throw new Error('No frames could be read from this clip.');
  // Variable frame rate (phones drop frames): put everything on an even timeline at the typical frame
  // interval, interpolating joints between the real frames, so every speed and timing is right.
  const intervals = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0).sort((a, b) => a - b);
  const dtMed = intervals[Math.floor(intervals.length / 2)] || 1 / opt.fpsMedia;
  const uneven = intervals.length > 4 && (intervals[Math.floor(intervals.length * 0.9)] > dtMed * 1.4 || Math.abs(1 / dtMed - opt.fpsMedia) / opt.fpsMedia > 0.08);
  let fpsMedia = opt.fpsMedia;
  if (uneven) {
    fpsMedia = 1 / dtMed;
    const t0g = times[0], t1g = times[times.length - 1];
    const m = Math.floor((t1g - t0g) / dtMed) + 1;
    const gTimes: number[] = [], gFrames: Blob[] = [], gRes: typeof results = [];
    let j = 0;
    for (let k = 0; k < m; k++) {
      const tg = t0g + k * dtMed;
      while (j < times.length - 2 && times[j + 1] <= tg) j++;
      const a = j, b = Math.min(times.length - 1, j + 1);
      const u = times[b] > times[a] ? Math.max(0, Math.min(1, (tg - times[a]) / (times[b] - times[a]))) : 0;
      gTimes.push(tg);
      gFrames.push(frames[u < 0.5 ? a : b]);
      const ra = results[a], rb = results[b];
      if (ra && rb) {
        const kp = new Float32Array(99);
        for (let q = 0; q < 99; q++) kp[q] = q % 3 === 2 ? Math.min(ra.kp[q], rb.kp[q]) : ra.kp[q] + (rb.kp[q] - ra.kp[q]) * u;
        let world: Float32Array | undefined;
        if (ra.world && rb.world) { world = new Float32Array(99); for (let q = 0; q < 99; q++) world[q] = ra.world[q] + (rb.world[q] - ra.world[q]) * u; }
        gRes.push({ box: ra.box, kp, world, move: ra.move || rb.move });
      } else gRes.push(u < 0.5 ? ra : rb);
    }
    times.length = 0; times.push(...gTimes);
    frames.length = 0; frames.push(...gFrames);
    results.length = 0; results.push(...gRes);
  }
  const n = times.length;
  const x = Array.from({ length: NJ }, () => new Float32Array(n));
  const y = Array.from({ length: NJ }, () => new Float32Array(n));
  const c = Array.from({ length: NJ }, () => new Float32Array(n));
  let lost = 0, moveFrames = 0;
  for (let i = 0; i < n; i++) {
    const r = results[i];
    if (!r) { lost++; continue; }
    if (r.move) moveFrames++;
    for (let j = 0; j < NJ; j++) {
      const k = MEDIAPIPE_INDEX[j];
      x[j][i] = r.kp[k * 3]; y[j][i] = r.kp[k * 3 + 1]; c[j][i] = r.kp[k * 3 + 2];
    }
  }
  // 3D estimate only when MediaPipe produced it on nearly every frame; short gaps take the nearest frame's
  const withWorld = results.filter((r) => r?.world).length;
  let world: PoseTrack['world'];
  if (withWorld >= 0.9 * (n - lost) && withWorld > 0) {
    const wx = Array.from({ length: NJ }, () => new Float32Array(n));
    const wy = Array.from({ length: NJ }, () => new Float32Array(n));
    const wz = Array.from({ length: NJ }, () => new Float32Array(n));
    const nearest = (i: number) => { for (let d = 0; d < n; d++) { if (results[i - d]?.world) return results[i - d]!.world!; if (results[i + d]?.world) return results[i + d]!.world!; } return null; };
    for (let i = 0; i < n; i++) {
      const wd = results[i]?.world ?? nearest(i);
      if (!wd) continue;
      for (let j = 0; j < NJ; j++) { const k = MEDIAPIPE_INDEX[j]; wx[j][i] = wd[k * 3]; wy[j][i] = wd[k * 3 + 1]; wz[j][i] = wd[k * 3 + 2]; }
    }
    world = { x: wx, y: wy, z: wz };
  }
  const t = times.map((tm) => (tm - times[0]) / opt.slowmo);
  const usedMove = moveFrames / Math.max(1, n - lost);
  const modelName = usedMove > 0.9 ? 'movenet-thunder' : usedMove > 0.02 ? `mediapipe-pose-${opt.model}+movenet-thunder` : `mediapipe-pose-${opt.model}`;
  const track: PoseTrack = { fps: fpsMedia * opt.slowmo, width: dims.w, height: dims.h, t, x, y, c, model: modelName, world };
  const delegate = mv && moveFrames ? `${workerDelegate} + MoveNet ${moveBackend}` : workerDelegate;
  return { track, frames, method, delegate, lostFrames: lost, moveFrames, scan };
}

function pitcherBoxAt(tr: { t: number[]; boxes: Box[] }, t: number): Box {
  // generous expected box: the pitcher's interpolated box, widened for the stride and arm
  const bx = boxAt(tr, t);
  const h = bx[3] - bx[1];
  return [bx[0] - 0.25 * h, bx[1] - 0.1 * h, bx[2] + 0.25 * h, bx[3] + 0.05 * h];
}
