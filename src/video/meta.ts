// Video metadata: duration, size, rotation, real frame rate (from the container), VFR and slow-motion hints.

import { readMp4Info } from './mp4';

export interface VideoMeta {
  durationS: number;
  width: number; // upright display size
  height: number;
  rotation: number;
  fpsMedia: number; // frames per second of media time
  fpsSource: 'container' | 'measured' | 'assumed';
  vfr: boolean;
  codec?: string;
  container: string;
  playable: boolean;
  /** Suggested slow-motion factor (real time = media time / factor). 1 for normal clips. */
  slowmoGuess: number;
  notes: string[];
}

export const SUPPORTED_HINT =
  'If your phone recorded in HEVC/H.265 and this browser can\'t play it, on iPhone set Settings → Camera → Formats → "Most Compatible", or export the clip as H.264 MP4 (e.g. with HandBrake or ffmpeg: ffmpeg -i in.mov -c:v libx264 -crf 18 out.mp4).';

function loadVideoElement(file: Blob): Promise<HTMLVideoElement> {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.src = URL.createObjectURL(file);
  return new Promise((res, rej) => {
    v.onloadedmetadata = () => res(v);
    v.onerror = () => rej(new Error('unplayable'));
    setTimeout(() => rej(new Error('timeout')), 15000);
  });
}

/** Estimate frame rate by playing briefly and watching presented media times (requestVideoFrameCallback). */
async function measureFps(v: HTMLVideoElement): Promise<number | null> {
  if (!('requestVideoFrameCallback' in v)) return null;
  const times: number[] = [];
  v.playbackRate = 0.25;
  await v.play().catch(() => undefined);
  await new Promise<void>((res) => {
    const step = (_: number, m: VideoFrameCallbackMetadata) => {
      times.push(m.mediaTime);
      if (times.length >= 20) res(); else v.requestVideoFrameCallback(step);
    };
    v.requestVideoFrameCallback(step);
    setTimeout(res, 4000);
  });
  v.pause();
  const d: number[] = [];
  for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) d.push(times[i] - times[i - 1]);
  if (d.length < 5) return null;
  d.sort((a, b) => a - b);
  const md = d[Math.floor(d.length / 2)];
  return md > 0 ? 1 / md : null;
}

export async function probeVideo(file: File): Promise<VideoMeta> {
  const notes: string[] = [];
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  let meta: VideoMeta | null = null;
  if (/^(mp4|m4v|mov)$/.test(ext) || /mp4|quicktime/.test(file.type)) {
    try {
      const { info } = await readMp4Info(file);
      const rot = info.rotation % 180 !== 0;
      meta = {
        durationS: info.durationS,
        width: rot ? info.height : info.width,
        height: rot ? info.width : info.height,
        rotation: info.rotation,
        fpsMedia: info.fps,
        fpsSource: 'container',
        vfr: info.vfr,
        codec: info.codec,
        container: ext || 'mp4',
        playable: true,
        slowmoGuess: 1,
        notes,
      };
      if (info.vfr) notes.push('Variable frame rate detected: frame times are read from the file, but avoid editing apps that re-time video.');
    } catch {
      notes.push('Could not read the MP4 container directly; using the browser player instead.');
    }
  }
  let v: HTMLVideoElement | null = null;
  try {
    v = await loadVideoElement(file);
  } catch {
    if (meta) meta.playable = false;
    else throw new Error(`This browser can't open "${file.name}". ${SUPPORTED_HINT}`);
  }
  if (!meta && v) {
    const fps = await measureFps(v);
    meta = {
      durationS: v.duration, width: v.videoWidth, height: v.videoHeight, rotation: 0,
      fpsMedia: fps ?? 30, fpsSource: fps ? 'measured' : 'assumed', vfr: false, container: ext || file.type,
      playable: true, slowmoGuess: 1, notes,
    };
    if (!fps) notes.push('Frame rate could not be measured; assuming 30 fps. Set it manually if you know it.');
  }
  if (v && meta && (!v.videoWidth || !v.videoHeight)) {
    meta.playable = false;
  }
  if (v) URL.revokeObjectURL(v.src);
  const m = meta!;
  if (m.codec && /^(hvc1|hev1)/.test(m.codec)) notes.push('HEVC video: some browsers (Firefox, many Android/Windows setups) can\'t decode it. ' + SUPPORTED_HINT);
  if (m.fpsMedia >= 100) notes.push(`High-speed capture (${Math.round(m.fpsMedia)} fps) — great for arm metrics.`);
  else if (m.fpsMedia < 50) notes.push(`${Math.round(m.fpsMedia)} fps is low for pitching: arm timing and release can be off by a frame (≈${Math.round(1000 / m.fpsMedia)} ms). If this is a slow-motion export, set "Clip speed" so times are real.`);
  if (m.fpsMedia > 0 && m.fpsMedia < 50 && m.durationS > 6) {
    // An exported iPhone slow-mo is usually 30 fps media time stretched 4–8×
    notes.push('Long 30 fps clip: if this is an exported slow-motion video, choose its slow-motion factor.');
  }
  return m;
}

export const CLIP_SPEEDS = [1, 2, 4, 8] as const;
