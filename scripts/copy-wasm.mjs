// Copies MediaPipe's WASM runtime next to the app so nothing is fetched from a CDN.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('public/mediapipe', { recursive: true });
cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'public/mediapipe', { recursive: true });
console.log('Copied MediaPipe wasm to public/mediapipe');
