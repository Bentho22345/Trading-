// Exports: CSV/JSON of metrics and time series, comparison CSV, composite video, full backup/restore.

import { METRICS } from '../core/catalog';
import type { Comparison } from '../core/compare';
import { resolvedEvents } from '../core/types';
import { db } from '../db/db';
import type { RuntimeClip } from '../state/store';
import type { Playback } from './components/playback';

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');

export function clipMetricsRows(c: RuntimeClip) {
  const a = c.analysis!;
  return METRICS.map((d) => ({ key: d.key, label: d.label, unit: d.unit, value: a.metrics[d.key]?.value, confidence: a.metrics[d.key]?.tier, view: a.view }));
}

export function exportClipCsv(c: RuntimeClip) {
  const a = c.analysis!;
  const ev = resolvedEvents(a);
  const lines = ['metric,label,unit,value,confidence,view', ...clipMetricsRows(c).map((r) => [r.key, r.label, r.unit, r.value?.toFixed(3), r.confidence, r.view].map(csvCell).join(','))];
  lines.push('', 'event,frame,time_ms_from_FS', ...Object.entries(ev).map(([k, f]) => `${k},${f},${(((f - ev.FS) / a.fps) * 1000).toFixed(1)}`));
  const keys = Object.keys(a.series);
  lines.push('', ['frame', 't_s', ...keys].join(','));
  const n = c.full!.cleaned.t.length;
  for (let i = 0; i < n; i++) lines.push([i, c.full!.cleaned.t[i].toFixed(4), ...keys.map((k) => a.series[k][i].toFixed(3))].join(','));
  download(`${safe(c.record.name)}-mound-lab.csv`, lines.join('\n'), 'text/csv');
}

export function exportClipJson(c: RuntimeClip) {
  const a = c.analysis!;
  const tr = c.full!.cleaned;
  const json = {
    clip: { ...c.record, thumb: undefined },
    analysis: { ...a, series: Object.fromEntries(Object.entries(a.series).map(([k, v]) => [k, Array.from(v)])) },
    track: { fps: tr.fps, width: tr.width, height: tr.height, t: tr.t, x: tr.x.map((r) => Array.from(r)), y: tr.y.map((r) => Array.from(r)), c: tr.c.map((r) => Array.from(r)) },
  };
  download(`${safe(c.record.name)}-mound-lab.json`, JSON.stringify(json), 'application/json');
}

export function exportComparisonCsv(A: RuntimeClip, B: RuntimeClip, cmp: Comparison) {
  const lines = ['metric,unit,A,B,change,pct_change,status,ratio_to_threshold,confidence,root_cause'];
  for (const d of cmp.diffs) {
    const def = METRICS.find((m) => m.key === d.key)!;
    const f = cmp.findings.find((x) => x.key === d.key);
    lines.push([def.label, def.unit, d.a?.toFixed(3), d.b?.toFixed(3), d.delta?.toFixed(3), d.pctChange?.toFixed(1), d.status, d.ratio.toFixed(2), d.tier, f ? (f.isRoot ? 'root' : 'symptom') : ''].map(csvCell).join(','));
  }
  download(`compare-${safe(A.record.name)}-vs-${safe(B.record.name)}.csv`, lines.join('\n'), 'text/csv');
}

/** Record the synced compare canvases as a WebM/MP4 by playing them through once. */
export async function recordComposite(container: HTMLElement | null, pb: Playback, duration: number) {
  if (!container || typeof MediaRecorder === 'undefined') { alert('Video export needs MediaRecorder (Chrome, Edge, Firefox, Safari 14.1+).'); return; }
  const canvases = Array.from(container.querySelectorAll('canvas'));
  if (!canvases.length) return;
  const w = canvases.reduce((s, c) => s + c.width, 0), h = Math.max(...canvases.map((c) => c.height));
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d')!;
  const stream = out.captureStream(30);
  const mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((r) => { rec.onstop = () => r(); });
  pb.pause(); pb.setT(0); pb.setSpeed(0.25);
  rec.start(200);
  let raf = 0;
  const paint = () => { let x = 0; for (const c of canvases) { ctx.drawImage(c, x, 0); x += c.width; } raf = requestAnimationFrame(paint); };
  paint();
  pb.play();
  await new Promise((r) => setTimeout(r, (duration / 0.25) * 1000 + 400));
  cancelAnimationFrame(raf);
  rec.stop();
  await done;
  download(`mound-lab-compare.${(rec.mimeType || 'video/webm').includes('mp4') ? 'mp4' : 'webm'}`, new Blob(chunks, { type: rec.mimeType || 'video/webm' }), rec.mimeType || 'video/webm');
}

// ---------- full backup / restore (never trap user data)

async function blobToB64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64ToBlob = (s: string, type: string) => new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))], { type });

const typed = (o: unknown): unknown => {
  if (o instanceof Float32Array) return { __f32: Array.from(o) };
  if (o instanceof Uint8Array) return { __u8: Array.from(o) };
  if (Array.isArray(o)) return o.map(typed);
  if (o && typeof o === 'object' && !(o instanceof Blob)) return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typed(v)]));
  return o;
};
const untyped = (o: unknown): unknown => {
  if (Array.isArray(o)) return o.map(untyped);
  if (o && typeof o === 'object') {
    const r = o as Record<string, unknown>;
    if ('__f32' in r) return Float32Array.from(r.__f32 as number[]);
    if ('__u8' in r) return Uint8Array.from(r.__u8 as number[]);
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, untyped(v)]));
  }
  return o;
};

export async function backupAll(includeVideos: boolean) {
  const [clips, athletes, sessions, workload, annotations, markers, assignments, tracks] = await Promise.all([
    db.clips.toArray(), db.athletes.toArray(), db.sessions.toArray(), db.workload.toArray(), db.annotations.toArray(), db.markers.toArray(), db.assignments.toArray(), db.tracks.toArray(),
  ]);
  const videos: { id: string; type: string; data: string }[] = [];
  if (includeVideos) for (const v of await db.videos.toArray()) videos.push({ id: v.id, type: v.blob.type, data: await blobToB64(v.blob) });
  const clipsOut = await Promise.all(clips.map(async (c) => ({ ...c, thumb: c.thumb ? await blobToB64(c.thumb) : undefined })));
  const data = { app: 'mound-lab', version: 1, exportedAt: new Date().toISOString(), clips: clipsOut, athletes, sessions, workload, annotations, markers, assignments, tracks: typed(tracks), videos };
  download(`mound-lab-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
}

export async function restoreAll(file: File): Promise<number> {
  const data = JSON.parse(await file.text());
  if (data.app !== 'mound-lab') throw new Error('This is not a Mound Lab backup file.');
  await db.transaction('rw', [db.clips, db.athletes, db.sessions, db.workload, db.annotations, db.markers, db.assignments, db.tracks, db.videos], async () => {
    await db.clips.bulkPut(data.clips.map((c: { thumb?: string }) => ({ ...c, thumb: c.thumb ? b64ToBlob(c.thumb, 'image/jpeg') : undefined })));
    await db.athletes.bulkPut(data.athletes ?? []);
    await db.sessions.bulkPut(data.sessions ?? []);
    await db.workload.bulkPut(data.workload ?? []);
    await db.annotations.bulkPut(data.annotations ?? []);
    await db.markers.bulkPut(data.markers ?? []);
    await db.assignments.bulkPut(data.assignments ?? []);
    await db.tracks.bulkPut(untyped(data.tracks ?? []) as never[]);
    await db.videos.bulkPut((data.videos ?? []).map((v: { id: string; type: string; data: string }) => ({ id: v.id, blob: b64ToBlob(v.data, v.type) })));
  });
  return data.clips.length;
}
