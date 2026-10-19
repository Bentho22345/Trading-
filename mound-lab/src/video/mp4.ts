// MP4/MOV demuxing with mp4box.js: metadata (real frame rate, rotation, VFR) and encoded samples for WebCodecs.

import { createFile, DataStream, Endianness, MP4BoxBuffer, type ISOFile, type Movie, type Sample } from 'mp4box';

const CHUNK = 4 * 1024 * 1024;

export interface Mp4Info {
  codec: string;
  width: number;
  height: number;
  rotation: number; // degrees clockwise to display upright
  durationS: number;
  nbSamples: number;
  fps: number; // average sample rate of the file
  vfr: boolean;
  trackId: number;
  timescale: number;
  description?: Uint8Array;
}

function rotationFromMatrix(m: ArrayLike<number> | undefined): number {
  if (!m || m.length < 5) return 0;
  // matrix is [a b u c d v x y w] in 16.16 fixed point
  const a = m[0] / 65536, b = m[1] / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}

function descriptionOf(file: ISOFile, trackId: number): Uint8Array | undefined {
  const trak = file.getTrackById(trackId) as unknown as { mdia: { minf: { stbl: { stsd: { entries: Record<string, { write: (s: DataStream) => void } | undefined>[] } } } } };
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array((stream as unknown as { buffer: ArrayBuffer }).buffer, 8);
    }
  }
  return undefined;
}

function sttsDeltas(file: ISOFile, trackId: number): { counts: number[]; deltas: number[] } {
  try {
    const trak = file.getTrackById(trackId) as unknown as { mdia: { minf: { stbl: { stts: { sample_counts: number[]; sample_deltas: number[] } } } } };
    const s = trak.mdia.minf.stbl.stts;
    return { counts: Array.from(s.sample_counts), deltas: Array.from(s.sample_deltas) };
  } catch {
    return { counts: [], deltas: [] };
  }
}

async function feed(file: ISOFile, blob: Blob, until: () => boolean, from = 0): Promise<number> {
  let offset = from;
  while (offset < blob.size && !until()) {
    const buf = (await blob.slice(offset, offset + CHUNK).arrayBuffer()) as ArrayBuffer;
    const mb = MP4BoxBuffer.fromArrayBuffer(buf, offset);
    const next = file.appendBuffer(mb, offset + buf.byteLength >= blob.size);
    offset = typeof next === 'number' && next > offset ? next : offset + buf.byteLength;
  }
  return offset;
}

export async function readMp4Info(blob: Blob): Promise<{ info: Mp4Info; file: ISOFile; offset: number }> {
  const file = createFile();
  let movie: Movie | undefined;
  let error: string | undefined;
  file.onReady = (m: Movie) => { movie = m; };
  file.onError = (_m: string, e: string) => { error = e; };
  const offset = await feed(file, blob, () => !!movie || !!error);
  if (!movie) throw new Error(error ?? 'No video track metadata found (is this an MP4/MOV file?).');
  const vt = movie.videoTracks[0];
  if (!vt) throw new Error('This file has no video track.');
  const durationS = vt.duration / vt.timescale || movie.duration / movie.timescale;
  const { counts, deltas } = sttsDeltas(file, vt.id);
  let vfr = false;
  // the capture rate is the typical frame interval (count-weighted median), not the average: phones drop
  // frames in low light, which makes the average look like e.g. "49 fps" for a 60 fps recording
  let medianDelta = 0;
  if (deltas.length) {
    const pairs = deltas.map((d, i) => [d, counts[i]] as const).sort((a, b) => a[0] - b[0]);
    const half = pairs.reduce((sum, p) => sum + p[1], 0) / 2;
    let acc = 0;
    for (const [d, c] of pairs) { acc += c; if (acc >= half) { medianDelta = d; break; } }
  }
  if (deltas.length > 1) {
    const total = counts.reduce((s, c) => s + c, 0);
    const mean = counts.reduce((s, c, i) => s + c * deltas[i], 0) / total;
    const varr = counts.reduce((s, c, i) => s + c * (deltas[i] - mean) ** 2, 0) / total;
    vfr = Math.sqrt(varr) / mean > 0.05;
  }
  const info: Mp4Info = {
    codec: vt.codec,
    width: vt.video?.width ?? vt.track_width,
    height: vt.video?.height ?? vt.track_height,
    rotation: rotationFromMatrix(vt.matrix as unknown as ArrayLike<number>),
    durationS,
    nbSamples: vt.nb_samples,
    fps: medianDelta > 0 ? vt.timescale / medianDelta : vt.nb_samples / durationS,
    vfr,
    trackId: vt.id,
    timescale: vt.timescale,
    description: descriptionOf(file, vt.id),
  };
  return { info, file, offset };
}

export interface EncodedSample {
  ts: number; // presentation time, µs
  dur: number; // µs
  key: boolean;
  data: Uint8Array;
}

/**
 * Extract the encoded samples needed to decode [startS, endS]: everything from the last keyframe
 * at or before startS through endS. Uses the parsed sample table (offset/size per sample) to read
 * only those bytes from the file, so it works whether the index is at the start or the end of the
 * file and never holds the whole video in memory.
 */
export async function extractSamples(blob: Blob, startS: number, endS: number): Promise<{ info: Mp4Info; samples: EncodedSample[] }> {
  const { info, file } = await readMp4Info(blob);
  const trak = file.getTrackById(info.trackId) as unknown as { samples?: Sample[] };
  const table = trak.samples ?? [];
  if (!table.length) throw new Error('This file has no readable video samples.');
  const startUs = startS * 1e6, endUs = endS * 1e6;
  // normalise so the first presented frame is t = 0 (B-frame composition offsets otherwise shift every time)
  let minCts = Infinity;
  for (const s of table) minCts = Math.min(minCts, s.cts);
  const tsOf = (s: Sample) => ((s.cts - minCts) * 1e6) / s.timescale;
  // decode order = table order; find the last keyframe at/before start
  let first = 0;
  for (let i = 0; i < table.length; i++) if (table[i].is_sync && tsOf(table[i]) <= startUs) first = i;
  // include every sample up to the last one presented before endS (B-frames can reorder, so scan all)
  let last = first;
  for (let i = first; i < table.length; i++) if (tsOf(table[i]) <= endUs + 1e3) last = i;
  const out: EncodedSample[] = [];
  // read contiguous runs in ~4 MB chunks
  let i = first;
  while (i <= last) {
    const runStart = table[i].offset;
    let j = i;
    while (j + 1 <= last && table[j + 1].offset === table[j].offset + table[j].size && table[j + 1].offset + table[j + 1].size - runStart < CHUNK) j++;
    const runEnd = table[j].offset + table[j].size;
    const buf = new Uint8Array(await blob.slice(runStart, runEnd).arrayBuffer());
    for (let k = i; k <= j; k++) {
      const s = table[k];
      out.push({ ts: tsOf(s), dur: (s.duration * 1e6) / s.timescale, key: s.is_sync, data: buf.subarray(s.offset - runStart, s.offset - runStart + s.size) });
    }
    i = j + 1;
  }
  return { info, samples: out };
}
