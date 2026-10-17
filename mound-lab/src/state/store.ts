// App state: clips (demo + imported), A/B slots, analysis runs, settings.

import { create } from 'zustand';
import { analyzeTrack, recompute, type FullAnalysis } from '../core/analyze';
import { GOOD_DAY, OFF_DAY, generatePitch, type PitchParams } from '../core/synthetic';
import type { Analysis, Events, View } from '../core/types';
import { db, hashFile, trackKey, uid, type ClipRecord } from '../db/db';
import { probeVideo, type VideoMeta } from '../video/meta';
import { JpegFrames, SyntheticFrames, type FrameSource } from '../ui/frameSource';
import type { PoseModel } from '../pose/pipeline';

export type ClipStatus = 'new' | 'analyzing' | 'ready' | 'error';

export interface RuntimeClip {
  id: string;
  kind: 'video' | 'demo';
  record: ClipRecord;
  status: ClipStatus;
  progress?: { done: number; total: number; etaS: number | null; stage: string };
  error?: string;
  full?: FullAnalysis;
  analysis?: Analysis;
  source?: FrameSource;
  file?: Blob;
  url?: string; // object URL for preview playback
  abort?: AbortController;
  info?: string[];
}

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  units: 'imperial' | 'metric';
  youth: boolean;
  model: PoseModel;
  reducedMotion: boolean;
  apiKey?: string;
  aiModel: string;
  handedness: 'R' | 'L';
}

const DEFAULT_SETTINGS: Settings = { theme: 'system', units: 'imperial', youth: false, model: 'full', reducedMotion: false, aiModel: 'claude-opus-5-5', handedness: 'R' };

interface State {
  clips: Record<string, RuntimeClip>;
  order: string[];
  slotA?: string;
  slotB?: string;
  settings: Settings;
  toasts: { id: string; text: string; kind: 'info' | 'error' }[];
  loaded: boolean;
  init(): Promise<void>;
  importFiles(files: File[], target?: 'A' | 'B'): Promise<void>;
  setSlot(slot: 'A' | 'B', id?: string): void;
  swapSlots(): void;
  analyze(id: string, opts?: { pick?: { x: number; y: number } }): Promise<void>;
  cancel(id: string): void;
  editEvents(id: string, edits: Partial<Events>): void;
  setView(id: string, view?: View): void;
  updateRecord(id: string, patch: Partial<ClipRecord>): Promise<void>;
  removeClip(id: string): Promise<void>;
  setSettings(p: Partial<Settings>): void;
  toast(text: string, kind?: 'info' | 'error'): void;
}

const DEMO_ATHLETE = 'demo-athlete';
let initPromise: Promise<void> | null = null;

function demoClip(id: string, p: PitchParams, name: string, sessionId: string, daysAgo: number, tags: string[], starred = false): RuntimeClip {
  const s = generatePitch(p);
  const full = analyzeTrack(s.track, { heightM: 1.85 });
  const meta: VideoMeta = { durationS: p.duration, width: 1280, height: 720, rotation: 0, fpsMedia: p.fps, fpsSource: 'container', vfr: false, container: 'synthetic', playable: false, slowmoGuess: 1, notes: [] };
  const record: ClipRecord = {
    id, name, createdAt: Date.now() - daysAgo * 86400000, hash: id, size: 0, meta, trim: { inS: 0, outS: p.duration }, slowmo: 1,
    edits: {}, tags: ['demo', ...tags], athleteId: DEMO_ATHLETE, sessionId, pitchType: 'FB', heightM: 1.85, starred,
  };
  return {
    id, kind: 'demo', record, status: 'ready', full, analysis: full.analysis,
    source: new SyntheticFrames(s.clean, p.heightPx, 650, p.hand === 'R' ? 'r' : 'l'),
  };
}

function buildDemo(): RuntimeClip[] {
  const out = [
    demoClip('demo-good', GOOD_DAY, 'Demo · Good day (best)', 'demo-s1', 14, ['best'], true),
    demoClip('demo-off', OFF_DAY, 'Demo · Off day', 'demo-s2', 0, ['off-day']),
  ];
  // extra repeats give the demo athlete real pitch-to-pitch variability and two sessions for group compare
  [3, 4].forEach((seed, k) => out.push(demoClip(`demo-good-${k + 2}`, { ...GOOD_DAY, seed, stride: GOOD_DAY.stride + (k ? 0.01 : -0.008), trunkTiltBR: GOOD_DAY.trunkTiltBR + (k ? -1.5 : 1) }, `Demo · Good day #${k + 2}`, 'demo-s1', 14, [])));
  [5, 6].forEach((seed, k) => out.push(demoClip(`demo-off-${k + 2}`, { ...OFF_DAY, seed, stride: OFF_DAY.stride + (k ? 0.012 : -0.006), leadKneeBR: OFF_DAY.leadKneeBR + (k ? -2 : 1.5) }, `Demo · Off day #${k + 2}`, 'demo-s2', 0, [])));
  return out;
}

function loadSettings(): Settings {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('mound-settings') ?? '{}') }; } catch { return DEFAULT_SETTINGS; }
}

const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i;

export const useStore = create<State>((set, get) => ({
  clips: {},
  order: [],
  settings: loadSettings(),
  toasts: [],
  loaded: false,

  async init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
    const demo = buildDemo();
    const clips: Record<string, RuntimeClip> = {};
    for (const c of demo) clips[c.id] = c;
    let recs: ClipRecord[] = [];
    try { recs = await db.clips.orderBy('createdAt').reverse().toArray(); } catch (e) { console.warn('IndexedDB unavailable', e); }
    for (const r of recs) clips[r.id] = { id: r.id, kind: 'video', record: r, status: 'new' };
    // merge: clips imported while the library was loading must survive
    set((s) => {
      const merged = { ...clips, ...s.clips };
      const order = [...new Set([...s.order, ...recs.map((r) => r.id), ...demo.map((d) => d.id)])];
      return { clips: merged, order, slotA: s.slotA ?? 'demo-good', slotB: s.slotB ?? 'demo-off', loaded: true };
    });
    try {
      if (!(await db.athletes.get(DEMO_ATHLETE))) await db.athletes.put({ id: DEMO_ATHLETE, name: 'Demo Pitcher (synthetic)', throws: 'R', heightCm: 185, birthYear: 2007, level: 'High school', createdAt: Date.now() });
    } catch { /* storage may be unavailable */ }
    // restore cached analyses in the background
    for (const r of recs) if (r.analyzedWith) void get().analyze(r.id).catch(() => undefined);
    })();
    return initPromise;
  },

  async importFiles(files, target) {
    await get().init();
    const vids = files.filter((f) => VIDEO_RE.test(f.name) || f.type.startsWith('video/'));
    if (!vids.length) { get().toast('Those files are not videos. Drop MP4, MOV or WebM clips.', 'error'); return; }
    const ids: string[] = [];
    for (const f of vids) {
      const id = uid();
      const pending: RuntimeClip = {
        id, kind: 'video', status: 'new', file: f, url: URL.createObjectURL(f),
        record: { id, name: f.name.replace(/\.[^.]+$/, ''), createdAt: Date.now(), hash: '', size: f.size, meta: { durationS: 0, width: 0, height: 0, rotation: 0, fpsMedia: 30, fpsSource: 'assumed', vfr: false, container: '', playable: true, slowmoGuess: 1, notes: [] }, trim: { inS: 0, outS: 0 }, slowmo: 1, edits: {}, tags: [] },
        progress: { done: 0, total: 0, etaS: null, stage: 'Reading video…' },
      };
      set((s) => ({ clips: { ...s.clips, [id]: pending }, order: [id, ...s.order] }));
      ids.push(id);
      try {
        const [meta, hash] = await Promise.all([probeVideo(f), hashFile(f)]);
        const rec: ClipRecord = { ...pending.record, meta, hash, trim: { inS: 0, outS: meta.durationS }, slowmo: meta.slowmoGuess };
        // auto-trim very long clips to the first 8 s; bullpen splitting is a separate tool
        if (meta.durationS > 12) rec.trim = { inS: 0, outS: Math.min(meta.durationS, 8) };
        const thumb = await makeThumb(f, Math.min(meta.durationS / 2, 1));
        rec.thumb = thumb ?? undefined;
        await db.videos.put({ id, blob: f });
        await db.clips.put(rec);
        set((s) => ({ clips: { ...s.clips, [id]: { ...s.clips[id], record: rec, progress: undefined, info: meta.notes } } }));
        // auto-trim to the delivery in the background (motion energy); the user can still adjust it
        if (meta.playable && meta.durationS > 3.5 && meta.durationS < 30) void import('../ui/bullpen').then((m) => m.autoTrim(id)).catch(() => undefined);
      } catch (e) {
        set((s) => ({ clips: { ...s.clips, [id]: { ...s.clips[id], status: 'error', error: (e as Error).message, progress: undefined } } }));
      }
    }
    if (target && ids.length === 1) get().setSlot(target, ids[0]);
    else if (ids.length >= 2 && !target) { get().setSlot('A', ids[0]); get().setSlot('B', ids[1]); }
    else if (ids.length === 1 && !target) {
      const { slotA, slotB, clips } = get();
      const isDemo = (x?: string) => !x || clips[x]?.kind === 'demo';
      if (isDemo(slotA)) get().setSlot('A', ids[0]); else if (isDemo(slotB)) get().setSlot('B', ids[0]); else get().setSlot('B', ids[0]);
    }
    get().toast(`${ids.length} clip${ids.length > 1 ? 's' : ''} loaded`);
  },

  setSlot(slot, id) { set(slot === 'A' ? { slotA: id } : { slotB: id }); },
  swapSlots() { set((s) => ({ slotA: s.slotB, slotB: s.slotA })); },

  async analyze(id, opts) {
    const c = get().clips[id];
    if (!c || c.kind === 'demo' || c.status === 'analyzing') return;
    const rec = c.record;
    const model = get().settings.model;
    const abort = new AbortController();
    const patch = (p: Partial<RuntimeClip>) => set((s) => ({ clips: { ...s.clips, [id]: { ...s.clips[id], ...p } } }));
    patch({ status: 'analyzing', error: undefined, abort, progress: { done: 0, total: 0, etaS: null, stage: 'Preparing…' } });
    try {
      const key = trackKey(rec, model);
      let cached = await db.tracks.get(key);
      let frames = (await db.frames.get(key))?.frames;
      if (!cached || !frames || opts?.pick) {
        const file = c.file ?? (await db.videos.get(id))?.blob;
        if (!file) throw new Error('The video file for this clip is missing from storage. Re-import it.');
        const { runPose } = await import('../pose/pipeline');
        const r = await runPose(file, {
          startS: rec.trim.inS, endS: rec.trim.outS, fpsMedia: rec.meta.fpsMedia, slowmo: rec.slowmo, model, signal: abort.signal, pick: opts?.pick,
          onProgress: (p) => patch({ progress: p }),
        });
        cached = { id: key, track: r.track };
        frames = r.frames;
        await db.tracks.put(cached);
        await db.frames.put({ id: key, frames });
        const notes: string[] = [];
        if (r.method === 'seek') notes.push('Frames were read by seeking (slower, approximate timing) because this browser could not decode the file directly.');
        if (r.lostFrames > r.track.t.length * 0.15) notes.push(`The pitcher was not found on ${r.lostFrames} of ${r.track.t.length} frames — check lighting and framing.`);
        patch({ info: [...(c.info ?? []), ...notes] });
        await get().updateRecord(id, { analyzedWith: model });
      }
      const full = analyzeTrack(cached.track, { view: rec.view, heightM: rec.heightM, editedEvents: rec.edits });
      const a = full.analysis;
      // slow-motion sanity check: a real FS→BR is ~120–200 ms
      const fsbr = a.metrics.tFsBr?.value;
      if (fsbr && rec.slowmo === 1 && fsbr > 450) a.warnings.push(`Foot strike to release took ${Math.round(fsbr)} ms — about ${Math.round(fsbr / 150)}× longer than normal. If this is a slow-motion clip, set its clip speed so the times are real.`);
      patch({ status: 'ready', full, analysis: a, source: new JpegFrames(frames, cached.track.width, cached.track.height), progress: undefined, abort: undefined });
    } catch (e) {
      const cancelled = (e as DOMException).name === 'AbortError';
      patch({ status: cancelled ? 'new' : 'error', error: cancelled ? undefined : (e as Error).message, progress: undefined, abort: undefined });
      if (!cancelled) get().toast(`Analysis failed: ${(e as Error).message}`, 'error');
    }
  },

  cancel(id) { get().clips[id]?.abort?.abort(); },

  editEvents(id, edits) {
    const c = get().clips[id];
    if (!c?.full) return;
    const analysis = recompute(c.full, edits);
    set((s) => ({ clips: { ...s.clips, [id]: { ...c, analysis, record: { ...c.record, edits } } } }));
    if (c.kind === 'video') void db.clips.update(id, { edits });
  },

  setView(id, view) {
    const c = get().clips[id];
    if (!c?.full) return;
    const full = analyzeTrack(c.full.raw, { view, heightM: c.record.heightM, editedEvents: c.record.edits });
    set((s) => ({ clips: { ...s.clips, [id]: { ...c, full, analysis: full.analysis, record: { ...c.record, view } } } }));
    if (c.kind === 'video') void db.clips.update(id, { view });
  },

  async updateRecord(id, patch) {
    const c = get().clips[id];
    if (!c) return;
    const record = { ...c.record, ...patch };
    set((s) => ({ clips: { ...s.clips, [id]: { ...s.clips[id], record } } }));
    if (c.kind === 'video') await db.clips.put(record);
  },

  async removeClip(id) {
    const c = get().clips[id];
    if (!c) return;
    if (c.url) URL.revokeObjectURL(c.url);
    set((s) => {
      const clips = { ...s.clips };
      delete clips[id];
      return { clips, order: s.order.filter((x) => x !== id), slotA: s.slotA === id ? undefined : s.slotA, slotB: s.slotB === id ? undefined : s.slotB };
    });
    if (c.kind === 'video') await Promise.all([db.clips.delete(id), db.videos.delete(id)]);
  },

  setSettings(p) {
    const settings = { ...get().settings, ...p };
    try { localStorage.setItem('mound-settings', JSON.stringify(settings)); } catch { /* private mode */ }
    set({ settings });
  },

  toast(text, kind = 'info') {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 8000 : 3500);
  },
}));

async function makeThumb(f: Blob, t: number): Promise<Blob | null> {
  try {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(f);
    await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(); setTimeout(rej, 8000); });
    await new Promise<void>((res) => { v.onseeked = () => res(); v.currentTime = t; setTimeout(res, 3000); });
    const s = 240 / Math.max(v.videoWidth, v.videoHeight);
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    URL.revokeObjectURL(v.src);
    return await new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.7));
  } catch { return null; }
}

/** Object URL for previewing a stored clip's video. */
export async function clipVideoUrl(c: RuntimeClip): Promise<string | null> {
  if (c.url) return c.url;
  if (c.kind !== 'video') return null;
  const v = await db.videos.get(c.id);
  if (!v) return null;
  const url = URL.createObjectURL(v.blob);
  useStore.setState((s) => ({ clips: { ...s.clips, [c.id]: { ...s.clips[c.id], url } } }));
  return url;
}
