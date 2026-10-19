// Copies the MediaPipe and TensorFlow.js WASM runtimes next to the app so nothing is fetched from a CDN.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('public/mediapipe', { recursive: true });
cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'public/mediapipe', { recursive: true });
mkdirSync('public/tfjs', { recursive: true });
// threaded build needs cross-origin isolation, which a static host doesn't give: SIMD + plain only
for (const f of ['tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm']) cpSync(`node_modules/@tensorflow/tfjs-backend-wasm/dist/${f}`, `public/tfjs/${f}`);
console.log('Copied MediaPipe and TensorFlow.js wasm to public/');
