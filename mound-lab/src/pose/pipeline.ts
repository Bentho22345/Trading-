// Main-thread side of pose tracking.
//
// Pass 1 — "find the pitcher": decode the clip, look at ~30 frames per second, find EVERY person (whole frame,
//   zoom tiles when people are small, and a zoomed crop around each person already being tracked), link them
//   into tracks, and score each track for "looks like a pitch" (see core/people.ts). Runners, batters,
//   catchers and coaches are rejected even if they are bigger or more central than the pitcher.
// Pass 2 — "track the pitcher": decode every frame and run the pose model on a square crop that follows the
//   pitcher. The model always sees the pitcher large, whether they fill the frame (side view) or are a few
//   dozen pixels tall (center-field camera), and other people mostly stay outside the crop.

import PoseWorker from './pose.worker?worker';
import type { WorkerIn, WorkerOut } from './pose.worker';
import { extractFrames } from '../video/frames';
import { MEDIAPIPE_INDEX, NJ, type PoseTrack } from '../core/types';
import { PeopleTracker, boxOf, choosePitcher, stitchTracks, cropFor, iou, nms, predictBox, zoomTiles, type Box, type Detection, type PersonSummary } from '../core/people';

export type PoseModel = 'full' | 'lite';

export interface ScanResult {
  frameW: number;
  frameH: number;
  totalSamples: number;
  tracks: { id: number; t: number[]; boxes: Box[] }[];
  people: PersonSummary[];
  pitcherId: number | null;
  smallPeople: boolean;
}

export interface PoseRunOptions {
  startS: number;
  endS: number;
  fpsMedia: number;
  slowmo: number; // real = media / slowmo
  model: PoseModel;
  rotate?: number;
  signal?: AbortSignal;
  /** Re-use a previous scan (switching person without re-scanning). */
  scan?: ScanResult;
  personId?: number;
  pick?: { x: number; y: number }; // normalised point the user tapped
  onProgress?: (p: { done: number; total: number; etaS: number | null; stage: string }) => void;
}

export interface PoseRunResult {
  track: PoseTrack;
  frames: Blob[]; // JPEG preview of every analysed frame
  method: 'webcodecs' | 'seek';
  delegate: string;
  lostFrames: number;
  scan: ScanResult;
}

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

/** Crop a square/rect region of a frame (may extend past the edges) and resize it for the model. */
function crop(src: ImageBitmap, b: Box, size: number): Promise<ImageBitmap> {
  const sw = b[2] - b[0], sh = b[3] - b[1];
  const s = size / Math.max(sw, sh);
  return createImageBitmap(src, Math.round(b[0]), Math.round(b[1]), Math.max(1, Math.round(sw)), Math.max(1, Math.round(sh)), {
    resizeWidth: Math.max(1, Math.round(sw * s)), resizeHeight: Math.max(1, Math.round(sh * s)), resizeQuality: 'medium',
  });
}

/** Convert a worker result (normalised to the crop) into frame-pixel detections. */
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

const squareAround = (b: Box, scale: number, min: number): Box => {
  const side = Math.max(min, Math.max(b[2] - b[0], b[3] - b[1]) * scale);
  const x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2;
  return [x - side / 2, y - side / 2, x + side / 2, y + side / 2];
};

async function scanPeople(w: Worker, file: Blob, opt: PoseRunOptions, report: (done: number, total: number) => void): Promise<ScanResult> {
  const step = Math.max(1, Math.round(opt.fpsMedia / 30));
  const tracker = new PeopleTracker(10);
  let frameW = 0, frameH = 0, sample = 0, total = 0, smallPeople = false;
  await extractFrames(file, {
    startS: opt.startS, endS: opt.endS, fps: opt.fpsMedia, maxSide: 1920, rotate: opt.rotate, signal: opt.signal,
    keep: (i) => i % step === 0,
    onTotal: (n) => { total = Math.ceil(n / step); },
    onFrame: async ({ bitmap, tMedia }) => {
      try {
        frameW = bitmap.width; frameH = bitmap.height;
        const t = tMedia - opt.startS;
        // one big, clearly visible person and nobody else so far: half the scan rate is plenty
        if (sample > 6 && sample % 2 === 1 && sample % 8 !== 0 && !smallPeople && tracker.tracks.length === 1) { sample++; report(sample, total); return; }
        const full: Box = [0, 0, frameW, frameH];
        let dets: Detection[] = [];
        const active = tracker.active();
        // whole-frame search: at the start, regularly, and whenever nobody is being tracked
        if (sample === 0 || sample % 8 === 0 || !active.length) {
          const r = await call(w, 'detect', await createImageBitmap(bitmap));
          dets.push(...toDetections(r, full));
          // small people (far camera, e.g. center field): search a pyramid of zoomed tiles
          const biggest = Math.max(0, ...dets.map((d) => (d.box[3] - d.box[1]) / frameH));
          if (sample === 0 && biggest < 0.35) smallPeople = true;
          if (smallPeople && (sample === 0 || sample % 16 === 0 || !active.length)) {
            const tileSearch = async (deep: boolean) => {
              for (const tile of zoomTiles(frameW, frameH, deep)) dets.push(...toDetections(await call(w, 'detect', await crop(bitmap, tile, 448)), tile));
            };
            await tileSearch(false);
            if (!dets.length) await tileSearch(true); // nothing yet: look for very small people too
          }
        }
        // zoomed crop around everyone already being tracked: keeps small and fast people locked on
        for (const tr of active) {
          const region = squareAround(predictBox(tr, t), 2.2, 96);
          const r = await call(w, 'detect', await crop(bitmap, region, 384));
          dets.push(...toDetections(r, region));
        }
        dets = nms(dets.filter((d) => d.box[3] - d.box[1] > 8));
        tracker.update(sample, t, dets, Math.max(10, frameH * 0.03));
        sample++;
        report(sample, total);
      } finally {
        bitmap.close();
      }
    },
  });
  const stitched = stitchTracks(tracker.tracks);
  const choice = choosePitcher(stitched, sample, frameH, opt.personId);
  let pitcherId = choice.pitcherId;
  if (opt.pick && opt.personId === undefined) {
    // the user tapped someone: the track whose box contains the tap (in the first sample it appears)
    const px = opt.pick.x * frameW, py = opt.pick.y * frameH;
    const hit = stitched.find((tr) => tr.boxes.some((b) => px >= b[0] && px <= b[2] && py >= b[1] && py <= b[3]));
    if (hit) { pitcherId = hit.id; for (const p of choice.people) p.role = p.id === hit.id ? 'pitcher' : p.role === 'pitcher' ? 'other' : p.role; }
  }
  return {
    frameW, frameH, totalSamples: sample, smallPeople,
    tracks: stitched.filter((t) => t.boxes.length >= 2).map((t) => ({ id: t.id, t: t.t, boxes: t.boxes })),
    people: choice.people, pitcherId,
  };
}

export async function runPose(file: Blob, opt: PoseRunOptions): Promise<PoseRunResult> {
  opt.onProgress?.({ done: 0, total: 0, etaS: null, stage: 'Loading pose model…' });
  const w = await getWorker(opt.model);
  w.postMessage({ type: 'reset' } satisfies WorkerIn);
  const t0 = performance.now();

  // ---- pass 1
  let scan = opt.scan;
  if (!scan || (opt.personId === undefined && opt.pick)) {
    scan = await scanPeople(w, file, opt, (d, n) => opt.onProgress?.({ done: d, total: n, etaS: null, stage: 'Finding the pitcher…' }));
  } else if (opt.personId !== undefined) {
    const people = scan.people.map((p) => ({ ...p, role: p.id === opt.personId ? 'pitcher' as const : p.role === 'pitcher' ? 'other' as const : p.role }));
    scan = { ...scan, people, pitcherId: opt.personId };
  }
  const pitcher = scan.tracks.find((t) => t.id === scan!.pitcherId);
  if (!pitcher) throw new Error('No person could be found in this clip. Check that the whole pitcher is visible and well lit, or tap the pitcher with "Pick the pitcher…".');

  // ---- pass 2
  const times: number[] = [];
  const frames: Blob[] = [];
  const results: (Detection & { world?: Float32Array } | null)[] = [];
  let dims = { w: 0, h: 0 };
  let total = 0, lastIndex = -1;
  const preview = new OffscreenCanvas(1, 1);
  const pctx = preview.getContext('2d')!;
  const t1 = performance.now();
  const inflight: Promise<void>[] = [];
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
      const cropped = await crop(bitmap, region, 448);
      bitmap.close();
      times[index] = tMedia;
      // keep up to 3 frames in flight to the worker
      const job = (async () => {
        const r = await call(w, 'track', cropped, t * 1000);
        const dets = toDetections(r, region);
        let best: (typeof dets)[number] | null = null, bestS = 0.08;
        for (const d of dets) { const sc = iou(d.box, expected); if (sc > bestS) { bestS = sc; best = d; } }
        results[index] = best;
        frames[index] = await jpeg;
      })();
      inflight.push(job);
      if (inflight.length >= 3) await inflight.shift();
      const done = index + 1;
      const el = (performance.now() - t1) / 1000;
      opt.onProgress?.({ done, total, etaS: total ? (el / done) * (total - done) : null, stage: 'Tracking the pitcher…' });
    },
  });
  await Promise.all(inflight);
  void t0;

  const n = times.length;
  if (n < 5) throw new Error('No frames could be read from this clip.');
  const x = Array.from({ length: NJ }, () => new Float32Array(n));
  const y = Array.from({ length: NJ }, () => new Float32Array(n));
  const c = Array.from({ length: NJ }, () => new Float32Array(n));
  const wx = Array.from({ length: NJ }, () => new Float32Array(n));
  const wy = Array.from({ length: NJ }, () => new Float32Array(n));
  const wz = Array.from({ length: NJ }, () => new Float32Array(n));
  let lost = 0, hasWorld = false;
  for (let i = 0; i < n; i++) {
    const r = results[i];
    if (!r) { lost++; continue; }
    for (let j = 0; j < NJ; j++) {
      const k = MEDIAPIPE_INDEX[j];
      x[j][i] = r.kp[k * 3]; y[j][i] = r.kp[k * 3 + 1]; c[j][i] = r.kp[k * 3 + 2];
      if (r.world) { hasWorld = true; wx[j][i] = r.world[k * 3]; wy[j][i] = r.world[k * 3 + 1]; wz[j][i] = r.world[k * 3 + 2]; }
    }
  }
  const t = times.map((tm) => (tm - times[0]) / opt.slowmo);
  const track: PoseTrack = {
    fps: opt.fpsMedia * opt.slowmo, width: dims.w, height: dims.h, t, x, y, c, model: `mediapipe-pose-${opt.model}`,
    world: hasWorld ? { x: wx, y: wy, z: wz } : undefined,
  };
  return { track, frames, method, delegate: workerDelegate, lostFrames: lost, scan };
}

function pitcherBoxAt(tr: { t: number[]; boxes: Box[] }, t: number): Box {
  // generous expected box: the pitcher's interpolated box, widened for the stride and arm
  const n = tr.t.length;
  let i = 0;
  while (i < n - 1 && tr.t[i + 1] < t) i++;
  const a = tr.boxes[i], b = tr.boxes[Math.min(n - 1, i + 1)];
  const k = n > 1 && tr.t[Math.min(n - 1, i + 1)] !== tr.t[i] ? Math.max(0, Math.min(1, (t - tr.t[i]) / (tr.t[i + 1] - tr.t[i]))) : 0;
  const bx = a.map((v, j) => v + (b[j] - v) * k) as Box;
  const h = bx[3] - bx[1];
  return [bx[0] - 0.25 * h, bx[1] - 0.1 * h, bx[2] + 0.25 * h, bx[3] + 0.05 * h];
}
