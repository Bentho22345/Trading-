/// <reference lib="webworker" />
// Pose estimation worker: MediaPipe Pose Landmarker (VIDEO mode) + person lock across frames.

import { FilesetResolver, PoseLandmarker, type NormalizedLandmark, type Landmark } from '@mediapipe/tasks-vision';

declare const self: DedicatedWorkerGlobalScope;

export type WorkerIn =
  | { type: 'init'; wasmBase: string; modelUrl: string; delegate: 'GPU' | 'CPU'; numPoses: number }
  | { type: 'reset'; pick?: { x: number; y: number } }
  | { type: 'frame'; id: number; bitmap: ImageBitmap; tMs: number };

export type WorkerOut =
  | { type: 'ready'; delegate: string }
  | { type: 'error'; message: string; id?: number }
  | { type: 'result'; id: number; found: boolean; lm: Float32Array; world: Float32Array | null; people: number };

let landmarker: PoseLandmarker | null = null;
let lastBox: [number, number, number, number] | null = null;
let pick: { x: number; y: number } | undefined;
let lastTs = -1;

function bbox(lms: NormalizedLandmark[]): [number, number, number, number] {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of lms) {
    if ((p.visibility ?? 1) < 0.3) continue;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return [x0, y0, Math.max(x0, x1), Math.max(y0, y1)];
}
function iou(a: number[], b: number[]) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

function choose(poses: NormalizedLandmark[][]): number {
  if (!poses.length) return -1;
  const boxes = poses.map(bbox);
  if (lastBox) {
    let best = -1, bi = -1;
    boxes.forEach((b, i) => { const s = iou(b, lastBox!); if (s > best) { best = s; bi = i; } });
    return best > 0.05 ? bi : -1;
  }
  if (pick) {
    const i = boxes.findIndex((b) => pick!.x >= b[0] && pick!.x <= b[2] && pick!.y >= b[1] && pick!.y <= b[3]);
    if (i >= 0) return i;
  }
  // largest, most central full-body person
  let best = -Infinity, bi = 0;
  boxes.forEach((b, i) => {
    const area = (b[2] - b[0]) * (b[3] - b[1]);
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    const s = area * (1.2 - Math.hypot(cx - 0.5, cy - 0.5));
    if (s > best) { best = s; bi = i; }
  });
  return bi;
}

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      const vision = await FilesetResolver.forVisionTasks(msg.wasmBase);
      const make = (delegate: 'GPU' | 'CPU') =>
        PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: msg.modelUrl, delegate },
          runningMode: 'VIDEO',
          numPoses: msg.numPoses,
          minPoseDetectionConfidence: 0.4,
          minPosePresenceConfidence: 0.4,
          minTrackingConfidence: 0.4,
          canvas: typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : undefined,
        });
      let used: string = msg.delegate;
      try {
        landmarker = await make(msg.delegate);
      } catch {
        used = 'CPU';
        landmarker = await make('CPU');
      }
      self.postMessage({ type: 'ready', delegate: used } satisfies WorkerOut);
    } else if (msg.type === 'reset') {
      lastBox = null; pick = msg.pick; lastTs = -1;
    } else if (msg.type === 'frame') {
      if (!landmarker) throw new Error('Pose model not loaded');
      const ts = Math.max(lastTs + 1, Math.round(msg.tMs)); // MediaPipe needs strictly increasing timestamps
      lastTs = ts;
      const res = landmarker.detectForVideo(msg.bitmap, ts);
      msg.bitmap.close();
      const k = choose(res.landmarks);
      const lm = new Float32Array(33 * 3);
      let world: Float32Array | null = null;
      if (k >= 0) {
        const L = res.landmarks[k];
        lastBox = bbox(L);
        for (let j = 0; j < 33; j++) { lm[j * 3] = L[j].x; lm[j * 3 + 1] = L[j].y; lm[j * 3 + 2] = L[j].visibility ?? 0.5; }
        const W: Landmark[] | undefined = res.worldLandmarks?.[k];
        if (W) { world = new Float32Array(33 * 3); for (let j = 0; j < 33; j++) { world[j * 3] = W[j].x; world[j * 3 + 1] = W[j].y; world[j * 3 + 2] = W[j].z; } }
      }
      const out: WorkerOut = { type: 'result', id: msg.id, found: k >= 0, lm, world, people: res.landmarks.length };
      self.postMessage(out, world ? [lm.buffer, world.buffer] : [lm.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: (err as Error).message ?? String(err), id: msg.type === 'frame' ? msg.id : undefined } satisfies WorkerOut);
    if (msg.type === 'frame') msg.bitmap.close?.();
  }
};
