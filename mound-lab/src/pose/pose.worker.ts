/// <reference lib="webworker" />
// Pose estimation worker: MediaPipe Pose Landmarker.
//  - 'detect': IMAGE mode, finds every person in a frame, tile or crop (used by the person scan).
//  - 'track' : VIDEO mode on a crop that follows the chosen pitcher (temporal smoothing, fast).
// Landmarks are returned normalised to the image that was sent; the main thread maps them back.

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

declare const self: DedicatedWorkerGlobalScope;

export type WorkerIn =
  | { type: 'init'; wasmBase: string; modelUrl: string; delegate: 'GPU' | 'CPU' }
  | { type: 'reset' }
  | { type: 'detect'; id: number; bitmap: ImageBitmap }
  | { type: 'track'; id: number; bitmap: ImageBitmap; tMs: number };

export type WorkerOut =
  | { type: 'ready'; delegate: string }
  | { type: 'error'; message: string; id?: number }
  /** poses: n × 33 × (x, y, visibility), normalised; world: n × 33 × (x, y, z) metres (hip-centred). */
  | { type: 'result'; id: number; n: number; poses: Float32Array; world: Float32Array };

let image: PoseLandmarker | null = null;
let video: PoseLandmarker | null = null;
let lastTs = 0;
let epoch = 0;

async function create(vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>, modelUrl: string, delegate: 'GPU' | 'CPU', mode: 'IMAGE' | 'VIDEO', numPoses: number) {
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: modelUrl, delegate },
    runningMode: mode,
    numPoses,
    minPoseDetectionConfidence: 0.35,
    minPosePresenceConfidence: 0.35,
    minTrackingConfidence: 0.4,
    canvas: typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : undefined,
  });
}

function pack(res: ReturnType<PoseLandmarker['detect']>): { n: number; poses: Float32Array; world: Float32Array } {
  const n = res.landmarks.length;
  const poses = new Float32Array(n * 99), world = new Float32Array(n * 99);
  for (let p = 0; p < n; p++) {
    const L = res.landmarks[p], W = res.worldLandmarks?.[p];
    for (let j = 0; j < 33; j++) {
      poses[p * 99 + j * 3] = L[j].x; poses[p * 99 + j * 3 + 1] = L[j].y; poses[p * 99 + j * 3 + 2] = L[j].visibility ?? 0.5;
      if (W) { world[p * 99 + j * 3] = W[j].x; world[p * 99 + j * 3 + 1] = W[j].y; world[p * 99 + j * 3 + 2] = W[j].z; }
    }
  }
  return { n, poses, world };
}

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      const vision = await FilesetResolver.forVisionTasks(msg.wasmBase);
      let used: string = msg.delegate;
      try {
        image = await create(vision, msg.modelUrl, msg.delegate, 'IMAGE', 5);
        video = await create(vision, msg.modelUrl, msg.delegate, 'VIDEO', 2);
      } catch {
        used = 'CPU';
        image = await create(vision, msg.modelUrl, 'CPU', 'IMAGE', 5);
        video = await create(vision, msg.modelUrl, 'CPU', 'VIDEO', 2);
      }
      self.postMessage({ type: 'ready', delegate: used } satisfies WorkerOut);
    } else if (msg.type === 'reset') {
      // jump the clock so VIDEO-mode tracking never carries over from the previous clip
      epoch = lastTs + 60_000;
    } else if (msg.type === 'detect' || msg.type === 'track') {
      if (!image || !video) throw new Error('Pose model not loaded');
      let res;
      if (msg.type === 'detect') res = image.detect(msg.bitmap);
      else {
        const ts = Math.max(lastTs + 1, Math.round(epoch + msg.tMs)); // VIDEO mode needs strictly increasing timestamps
        lastTs = ts;
        res = video.detectForVideo(msg.bitmap, ts);
      }
      msg.bitmap.close();
      const out = pack(res);
      self.postMessage({ type: 'result', id: msg.id, ...out } satisfies WorkerOut, [out.poses.buffer, out.world.buffer]);
    }
  } catch (err) {
    if (msg.type === 'detect' || msg.type === 'track') msg.bitmap.close?.();
    self.postMessage({ type: 'error', message: (err as Error).message ?? String(err), id: 'id' in msg ? msg.id : undefined } satisfies WorkerOut);
  }
};
