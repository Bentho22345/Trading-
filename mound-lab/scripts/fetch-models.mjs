// Downloads the pose models once so the app serves them itself (no CDN at runtime):
//  - MediaPipe Pose Landmarker (full/lite): precise 33-point landmarks
//  - MoveNet MultiPose Lightning + Thunder (Apache-2.0, TF.js format, via the MIT-licensed
//    @vladmandic/human-models npm package): finds every person, from any side — including from behind
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';

mkdirSync('public/models', { recursive: true });

const base = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
for (const m of ['full', 'lite']) {
  const out = `public/models/pose_landmarker_${m}.task`;
  if (existsSync(out)) continue;
  try {
    const res = await fetch(`${base}/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log('Downloaded', out);
  } catch (e) {
    console.warn(`Could not download ${out}: ${e.message}. Pose tracking needs it; place it there manually.`);
  }
}

const MOVENET = ['movenet-multipose.json', 'movenet-multipose.bin', 'movenet-thunder.json', 'movenet-thunder.bin'];
if (!MOVENET.every((f) => existsSync(`public/models/${f}`))) {
  try {
    const res = await fetch('https://registry.npmjs.org/@vladmandic/human-models/-/human-models-3.0.4.tgz');
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    // stream-untar: keep only the four MoveNet files
    const gunzip = Readable.fromWeb(res.body).pipe(createGunzip());
    let buf = Buffer.alloc(0), want = null, remaining = 0, pad = 0, parts = [];
    const found = new Set();
    for await (const chunk of gunzip) {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (remaining > 0) {
          const take = Math.min(remaining, buf.length);
          if (want) parts.push(buf.subarray(0, take));
          buf = buf.subarray(take); remaining -= take;
          if (remaining > 0) break;
          if (want) { writeFileSync(`public/models/${want}`, Buffer.concat(parts)); found.add(want); console.log('Extracted', want); }
          want = null; parts = [];
          continue;
        }
        if (pad > 0) { const take = Math.min(pad, buf.length); buf = buf.subarray(take); pad -= take; if (pad > 0) break; continue; }
        if (buf.length < 512) break;
        const header = buf.subarray(0, 512);
        buf = buf.subarray(512);
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        if (!name) continue;
        const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
        const file = name.split('/').pop();
        want = name.startsWith('package/models/') && MOVENET.includes(file) ? file : null;
        remaining = size; pad = (512 - (size % 512)) % 512; parts = [];
        if (size === 0) { remaining = 0; want = null; }
      }
      if (found.size === MOVENET.length) break;
    }
    if (found.size < MOVENET.length) throw new Error('package did not contain all MoveNet files');
  } catch (e) {
    console.warn(`Could not download MoveNet models: ${e.message}. Person finding falls back to MediaPipe only.`);
  }
}
