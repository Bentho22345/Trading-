/// <reference lib="webworker" />
// MoveNet worker (TensorFlow.js):
//  - 'multi'  : MoveNet MultiPose Lightning — every person in one pass, from ANY side. MediaPipe's person
//               detector keys on the face, so it misses pitchers filmed from behind (center-field cameras).
//  - 'single' : MoveNet Thunder — accurate single-person keypoints inside a crop (fallback/primary from behind).
// Keypoints come back in COCO-17 order, normalised to the image that was sent.

import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-cpu';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import { loadGraphModel, type GraphModel } from '@tensorflow/tfjs-converter';

declare const self: DedicatedWorkerGlobalScope;

export type MoveIn =
  | { type: 'init'; base: string }
  | { type: 'multi'; id: number; bitmap: ImageBitmap; minScore?: number }
  | { type: 'single'; id: number; bitmap: ImageBitmap };

export type MoveOut =
  | { type: 'ready'; backend: string }
  | { type: 'error'; message: string; id?: number }
  /** people: n × (17 × (x, y, score) + box score), normalised to the sent image */
  | { type: 'result'; id: number; n: number; people: Float32Array };

let multi: GraphModel | null = null;
let single: Promise<GraphModel> | null = null;
let base = '';
/** Thunder (12 MB) loads on first use: many clips never need it. */
function getSingle() {
  single ??= loadGraphModel(`${base}models/movenet-thunder.json`).then((m) => {
    tf.tidy(() => { m.execute(tf.zeros([1, SIZE, SIZE, 3], 'int32')); });
    return m;
  });
  return single;
}
const SIZE = 256;
const canvas = new OffscreenCanvas(SIZE, SIZE);
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

/** Letterbox the bitmap into a 256×256 square; returns the mapping back to the bitmap's normalised coords. */
function letterbox(bm: ImageBitmap) {
  const s = SIZE / Math.max(bm.width, bm.height);
  const w = bm.width * s, h = bm.height * s;
  const ox = (SIZE - w) / 2, oy = (SIZE - h) / 2;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(bm, ox, oy, w, h);
  return { toX: (nx: number) => (nx * SIZE - ox) / w, toY: (ny: number) => (ny * SIZE - oy) / h };
}

function input(): tf.Tensor {
  return tf.tidy(() => tf.expandDims(tf.cast(tf.browser.fromPixels(canvas as unknown as HTMLCanvasElement), 'int32'), 0));
}

self.onmessage = async (e: MessageEvent<MoveIn>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      // GPU (WebGL) first; WASM SIMD is ~10× faster than plain JS where WebGL isn't available in a worker
      setWasmPaths(`${msg.base}tfjs/`);
      let backend = '';
      for (const b of ['webgl', 'wasm', 'cpu']) {
        try { if (await tf.setBackend(b)) { await tf.ready(); backend = b; break; } } catch { /* try the next one */ }
      }
      if (!backend) throw new Error('No TensorFlow.js backend could start');
      base = msg.base;
      multi = await loadGraphModel(`${base}models/movenet-multipose.json`);
      // warm up so the first real frame isn't slow
      tf.tidy(() => { multi!.execute(tf.zeros([1, SIZE, SIZE, 3], 'int32')); });
      self.postMessage({ type: 'ready', backend } satisfies MoveOut);
      return;
    }
    if (!multi) throw new Error('MoveNet not loaded');
    const thunder = msg.type === 'single' ? await getSingle() : null;
    const map = letterbox(msg.bitmap);
    msg.bitmap.close();
    const x = input();
    let out: Float32Array, n = 0;
    if (msg.type === 'multi') {
      const y = multi.execute(x) as tf.Tensor;
      const d = (await y.data()) as Float32Array; // [1, 6, 56]: 17 × (y, x, s), ymin, xmin, ymax, xmax, score
      y.dispose();
      const keep: number[] = [];
      for (let p = 0; p < 6; p++) if (d[p * 56 + 55] >= (msg.minScore ?? 0.12)) keep.push(p);
      out = new Float32Array(keep.length * 52);
      keep.forEach((p, k) => {
        for (let j = 0; j < 17; j++) {
          out[k * 52 + j * 3] = map.toX(d[p * 56 + j * 3 + 1]);
          out[k * 52 + j * 3 + 1] = map.toY(d[p * 56 + j * 3]);
          out[k * 52 + j * 3 + 2] = d[p * 56 + j * 3 + 2];
        }
        out[k * 52 + 51] = d[p * 56 + 55];
      });
      n = keep.length;
    } else {
      const y = thunder!.execute(x) as tf.Tensor;
      const d = (await y.data()) as Float32Array; // [1, 1, 17, 3]: (y, x, s)
      y.dispose();
      out = new Float32Array(52);
      let sum = 0;
      for (let j = 0; j < 17; j++) { out[j * 3] = map.toX(d[j * 3 + 1]); out[j * 3 + 1] = map.toY(d[j * 3]); out[j * 3 + 2] = d[j * 3 + 2]; sum += d[j * 3 + 2]; }
      out[51] = sum / 17;
      n = 1;
    }
    x.dispose();
    self.postMessage({ type: 'result', id: msg.id, n, people: out } satisfies MoveOut, [out.buffer]);
  } catch (err) {
    if (msg.type !== 'init') msg.bitmap.close?.();
    self.postMessage({ type: 'error', message: (err as Error).message ?? String(err), id: msg.type !== 'init' ? msg.id : undefined } satisfies MoveOut);
  }
};
