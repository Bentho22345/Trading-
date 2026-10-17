// Main-thread side of pose tracking: decode frames, cache JPEG previews, run the worker, assemble a PoseTrack.

import PoseWorker from './pose.worker?worker';
import type { WorkerIn, WorkerOut } from './pose.worker';
import { extractFrames } from '../video/frames';
import { MEDIAPIPE_INDEX, NJ, type PoseTrack } from '../core/types';

export type PoseModel = 'full' | 'lite';

export interface PoseRunOptions {
  startS: number;
  endS: number;
  fpsMedia: number;
  slowmo: number; // real = media / slowmo
  model: PoseModel;
  signal?: AbortSignal;
  pick?: { x: number; y: number };
  onProgress?: (p: { done: number; total: number; etaS: number | null; stage: string }) => void;
}

export interface PoseRunResult {
  track: PoseTrack;
  frames: Blob[]; // JPEG preview of every analysed frame
  method: 'webcodecs' | 'seek';
  delegate: string;
  lostFrames: number;
}

let worker: Worker | null = null;
let workerModel: PoseModel | null = null;
let workerDelegate = '';

function call(w: Worker, msg: WorkerIn, transfer: Transferable[] = []) {
  w.postMessage(msg, transfer);
}

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
    call(w, { type: 'init', wasmBase: base + 'mediapipe', modelUrl: `${base}models/pose_landmarker_${model}.task`, delegate: 'GPU', numPoses: 3 });
  });
  worker = w; workerModel = model;
  return w;
}

export async function runPose(file: Blob, opt: PoseRunOptions): Promise<PoseRunResult> {
  opt.onProgress?.({ done: 0, total: 0, etaS: null, stage: 'Loading pose model…' });
  const w = await getWorker(opt.model);
  call(w, { type: 'reset', pick: opt.pick });
  const results = new Map<number, { lm: Float32Array; world: Float32Array | null; found: boolean }>();
  const times: number[] = [];
  const frames: Blob[] = [];
  let dims = { w: 0, h: 0 };
  let total = 0;
  let inflight = 0;
  let workerError: Error | null = null;
  let wake: (() => void) | null = null;
  w.onmessage = (e: MessageEvent<WorkerOut>) => {
    const m = e.data;
    if (m.type === 'result') { results.set(m.id, { lm: m.lm, world: m.world, found: m.found }); inflight--; }
    else if (m.type === 'error') { workerError = new Error(m.message); inflight--; }
    wake?.();
  };
  const waitBelow = async (k: number) => {
    while (inflight >= k) {
      if (workerError) throw workerError;
      await new Promise<void>((r) => { wake = r; });
      wake = null;
    }
  };
  const t0 = performance.now();
  const preview = new OffscreenCanvas(1, 1);
  const pctx = preview.getContext('2d')!;
  const { method } = await extractFrames(file, {
    startS: opt.startS,
    endS: opt.endS,
    fps: opt.fpsMedia,
    maxSide: 1280,
    signal: opt.signal,
    onTotal: (n) => { total = n; },
    onFrame: async ({ bitmap, tMedia, index }) => {
      if (index === 0 && times.length) { times.length = 0; frames.length = 0; results.clear(); call(w, { type: 'reset', pick: opt.pick }); }
      if (opt.signal?.aborted) { bitmap.close(); throw new DOMException('Cancelled', 'AbortError'); }
      dims = { w: bitmap.width, h: bitmap.height };
      // JPEG preview for frame-accurate playback (≤ 720 px on the long side)
      const s = Math.min(1, 720 / Math.max(bitmap.width, bitmap.height));
      preview.width = Math.round(bitmap.width * s); preview.height = Math.round(bitmap.height * s);
      pctx.drawImage(bitmap, 0, 0, preview.width, preview.height);
      frames[index] = await preview.convertToBlob({ type: 'image/jpeg', quality: 0.78 });
      times[index] = tMedia;
      await waitBelow(3);
      inflight++;
      call(w, { type: 'frame', id: index, bitmap, tMs: tMedia * 1000 }, [bitmap]);
      const done = index + 1;
      const el = (performance.now() - t0) / 1000;
      opt.onProgress?.({ done, total, etaS: total ? (el / done) * (total - done) : null, stage: 'Tracking the pitcher…' });
    },
  });
  await waitBelow(1);
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
    const r = results.get(i);
    if (!r || !r.found) { lost++; continue; }
    for (let j = 0; j < NJ; j++) {
      const k = MEDIAPIPE_INDEX[j];
      x[j][i] = r.lm[k * 3] * dims.w;
      y[j][i] = r.lm[k * 3 + 1] * dims.h;
      c[j][i] = r.lm[k * 3 + 2];
      if (r.world) { hasWorld = true; wx[j][i] = r.world[k * 3]; wy[j][i] = r.world[k * 3 + 1]; wz[j][i] = r.world[k * 3 + 2]; }
    }
  }
  const t = times.map((tm) => (tm - times[0]) / opt.slowmo);
  const fps = (opt.fpsMedia * opt.slowmo);
  const track: PoseTrack = {
    fps, width: dims.w, height: dims.h, t, x, y, c, model: `mediapipe-pose-${opt.model}`,
    world: hasWorld ? { x: wx, y: wy, z: wz } : undefined,
  };
  return { track, frames, method, delegate: workerDelegate, lostFrames: lost };
}
