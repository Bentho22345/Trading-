// Motion-energy scanning for auto-trim (find the delivery in a clip) and bullpen auto-split (many pitches).

import { db, uid, type ClipRecord } from '../db/db';
import { useStore } from '../state/store';

/** Sample the video at a low rate and return per-sample motion energy (mean abs frame difference). */
export async function motionEnergy(file: Blob, rate = 10, onProgress?: (p: string) => void): Promise<{ t: number[]; e: number[] }> {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = URL.createObjectURL(file);
  try {
    await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error('Cannot read this video in the browser.')); });
    const w = 96, h = Math.max(1, Math.round((96 * v.videoHeight) / v.videoWidth));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const n = Math.floor(v.duration * rate);
    let prev: Uint8ClampedArray | null = null;
    const t: number[] = [], e: number[] = [];
    for (let i = 0; i < n; i++) {
      const tt = i / rate;
      await new Promise<void>((res) => { v.onseeked = () => res(); v.currentTime = tt; });
      ctx.drawImage(v, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let s = 0;
      if (prev) for (let k = 0; k < d.length; k += 4) s += Math.abs(d[k] - prev[k]) + Math.abs(d[k + 1] - prev[k + 1]);
      prev = d.slice();
      t.push(tt); e.push(s / (w * h));
      if (i % 20 === 0) onProgress?.(`Scanning ${Math.round((i / n) * 100)}%`);
    }
    return { t, e };
  } finally { URL.revokeObjectURL(v.src); }
}

/** Find bursts of motion separated by quiet periods. */
export function findBursts(t: number[], e: number[], minGapS = 2.5): { start: number; end: number; peak: number }[] {
  if (!e.length) return [];
  const sorted = [...e].sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length * 0.3)];
  const loud = sorted[Math.floor(sorted.length * 0.95)];
  const thr = quiet + (loud - quiet) * 0.35;
  const out: { start: number; end: number; peak: number }[] = [];
  let i = 0;
  while (i < e.length) {
    if (e[i] < thr) { i++; continue; }
    let j = i, pk = i;
    let lastHot = i;
    while (j < e.length && t[j] - t[lastHot] < minGapS) { if (e[j] >= thr) lastHot = j; if (e[j] > e[pk]) pk = j; j++; }
    out.push({ start: t[i], end: t[lastHot], peak: t[pk] });
    i = j;
  }
  // a pitch takes ~1–3 s; drop tiny blips
  return out.filter((b) => b.end - b.start >= 0.4);
}

/** Pre-set trim around the main delivery (~0.5 s before the motion through ~0.5 s after). */
export async function autoTrim(id: string): Promise<{ inS: number; outS: number } | null> {
  const v = await db.videos.get(id);
  const rec = await db.clips.get(id);
  if (!v || !rec) return null;
  const { t, e } = await motionEnergy(v.blob, 12);
  const bursts = findBursts(t, e, 1.5);
  if (!bursts.length) return null;
  const main = bursts.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  const trim = { inS: Math.max(0, main.start - 0.6), outS: Math.min(rec.meta.durationS, main.end + 0.6) };
  if (trim.outS - trim.inS < 1) return null;
  await useStore.getState().updateRecord(id, { trim });
  return trim;
}

/** Bullpen mode: one long video → one clip per pitch. Returns the number of clips created. */
export async function autoSplit(id: string, onProgress?: (p: string) => void): Promise<number> {
  const v = await db.videos.get(id);
  const rec = await db.clips.get(id);
  if (!v || !rec) throw new Error('Video not found');
  const { t, e } = await motionEnergy(v.blob, 10, onProgress);
  const bursts = findBursts(t, e, 3);
  if (bursts.length < 2) throw new Error(`Found ${bursts.length} pitch${bursts.length === 1 ? '' : 'es'} — nothing to split.`);
  const created: ClipRecord[] = [];
  for (const [k, b] of bursts.entries()) {
    const nid = uid();
    const r: ClipRecord = { ...rec, id: nid, name: `${rec.name} · pitch ${k + 1}`, createdAt: rec.createdAt + k, trim: { inS: Math.max(0, b.start - 0.6), outS: Math.min(rec.meta.durationS, b.end + 0.6) }, edits: {}, analyzedWith: undefined, tags: [...rec.tags, 'bullpen'] };
    await db.videos.put({ id: nid, blob: v.blob });
    await db.clips.put(r);
    created.push(r);
  }
  useStore.setState((s) => {
    const clips = { ...s.clips };
    for (const r of created) clips[r.id] = { id: r.id, kind: 'video', record: r, status: 'new' };
    return { clips, order: [...created.map((r) => r.id), ...s.order] };
  });
  return created.length;
}
