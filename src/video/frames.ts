// Frame extraction: WebCodecs (frame-accurate, fast) with a <video>-seeking fallback.

import { extractSamples } from './mp4';

export interface FrameOut {
  bitmap: ImageBitmap; // upright, scaled to maxSide
  tMedia: number; // seconds (media time)
  index: number;
}

export interface ExtractOptions {
  startS: number;
  endS: number;
  maxSide: number; // longest side of the produced bitmaps
  fps: number; // media frame rate (used by the seek fallback)
  signal?: AbortSignal;
  onFrame: (f: FrameOut) => Promise<void>;
  onTotal?: (n: number) => void;
  /** Only frames for which this returns true become bitmaps (the rest are decoded and dropped). */
  keep?: (index: number) => boolean;
  /** Extra clockwise rotation chosen by the user (on top of the file's own rotation). */
  rotate?: number;
}

const isMp4Like = (f: Blob & { name?: string }) => /\.(mp4|m4v|mov)$/i.test(f.name ?? '') || /mp4|quicktime/.test(f.type);

export function canUseWebCodecs() {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

function drawUpright(frame: VideoFrame, rotation: number, maxSide: number): Promise<ImageBitmap> {
  const w = frame.displayWidth, h = frame.displayHeight;
  const rot = rotation % 180 !== 0;
  const ow = rot ? h : w, oh = rot ? w : h;
  const s = Math.min(1, maxSide / Math.max(ow, oh));
  const cw = Math.round(ow * s), ch = Math.round(oh * s);
  if (!rotation) return createImageBitmap(frame, { resizeWidth: cw, resizeHeight: ch, resizeQuality: 'medium' });
  const c = new OffscreenCanvas(cw, ch);
  const ctx = c.getContext('2d')!;
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(frame, (-w * s) / 2, (-h * s) / 2, w * s, h * s);
  return createImageBitmap(c);
}

/** Decode frames with WebCodecs. Throws if the codec is unsupported so the caller can fall back. */
export async function extractWithWebCodecs(file: Blob, opt: ExtractOptions): Promise<number> {
  const { info, samples } = await extractSamples(file, opt.startS, opt.endS);
  const rotation = (((info.rotation + (opt.rotate ?? 0)) % 360) + 360) % 360;
  const config: VideoDecoderConfig = { codec: info.codec, codedWidth: info.width, codedHeight: info.height, description: info.description };
  const sup = await VideoDecoder.isConfigSupported(config);
  if (!sup.supported) throw new Error(`This browser can't decode ${info.codec} with WebCodecs.`);
  const startUs = opt.startS * 1e6 - 500, endUs = opt.endS * 1e6 + 500;
  const inRange = samples.filter((s) => s.ts >= startUs && s.ts <= endUs).length;
  opt.onTotal?.(inRange);
  const queue: VideoFrame[] = [];
  let decodeError: Error | null = null;
  const decoder = new VideoDecoder({
    output: (f) => { if (f.timestamp >= startUs && f.timestamp <= endUs) queue.push(f); else f.close(); },
    error: (e) => { decodeError = e instanceof Error ? e : new Error(String(e)); },
  });
  decoder.configure(config);
  let index = 0;
  const drain = async (all: boolean) => {
    // frames come out in presentation order
    while (queue.length > (all ? 0 : 2)) {
      const f = queue.shift()!;
      try {
        const i = index++;
        if (opt.keep && !opt.keep(i)) continue;
        const bitmap = await drawUpright(f, rotation, opt.maxSide);
        await opt.onFrame({ bitmap, tMedia: f.timestamp / 1e6, index: i });
      } finally { f.close(); }
    }
  };
  try {
    for (const s of samples) {
      if (opt.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (decodeError) throw decodeError;
      decoder.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.ts, duration: s.dur, data: s.data }));
      while (decoder.decodeQueueSize > 6) await new Promise((r) => setTimeout(r, 1));
      await new Promise((r) => setTimeout(r, 0)); // let outputs land
      await drain(false);
    }
    await decoder.flush();
    await drain(true);
  } finally {
    queue.forEach((f) => f.close());
    if (decoder.state !== 'closed') decoder.close();
  }
  if (decodeError) throw decodeError;
  return index;
}

/** Fallback: seek a <video> element frame by frame. Slower, timestamps approximate. */
export async function extractWithSeeking(file: Blob, opt: ExtractOptions): Promise<number> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  try {
    await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error('This browser cannot decode this video file. Export it as H.264 MP4 ("Most Compatible" on iPhone) or VP9 WebM, or try Chrome/Edge/Safari.')); });
    const rot = (((opt.rotate ?? 0) % 360) + 360) % 360;
    const w = v.videoWidth, h = v.videoHeight;
    const s = Math.min(1, opt.maxSide / Math.max(w, h));
    const sw = Math.round(w * s), sh = Math.round(h * s);
    const c = rot % 180 ? new OffscreenCanvas(sh, sw) : new OffscreenCanvas(sw, sh);
    const ctx = c.getContext('2d')!;
    const end = Math.min(opt.endS, v.duration);
    const n = Math.max(1, Math.floor((end - opt.startS) * opt.fps));
    opt.onTotal?.(n);
    for (let i = 0; i < n; i++) {
      if (opt.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (opt.keep && !opt.keep(i)) continue;
      const t = opt.startS + (i + 0.5) / opt.fps; // aim at the middle of the frame interval
      await new Promise<void>((res) => { v.onseeked = () => res(); v.currentTime = t; });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.drawImage(v, -sw / 2, -sh / 2, sw, sh);
      await opt.onFrame({ bitmap: await createImageBitmap(c), tMedia: opt.startS + i / opt.fps, index: i });
    }
    return n;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function extractFrames(file: Blob, opt: ExtractOptions): Promise<{ n: number; method: 'webcodecs' | 'seek' }> {
  if (canUseWebCodecs() && isMp4Like(file as Blob & { name?: string })) {
    try {
      return { n: await extractWithWebCodecs(file, opt), method: 'webcodecs' };
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') throw e;
      console.warn('WebCodecs path failed, falling back to seeking:', e);
    }
  }
  return { n: await extractWithSeeking(file, opt), method: 'seek' };
}
