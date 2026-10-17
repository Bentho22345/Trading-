// Downloads the MediaPipe Pose Landmarker models once so the app serves them itself.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const base = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
const models = ['full', 'lite'];
mkdirSync('public/models', { recursive: true });
for (const m of models) {
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
