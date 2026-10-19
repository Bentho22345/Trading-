// Clip quality score: how much to trust this clip's numbers, and exactly what to change when filming next time.

import type { Body } from './body';
import type { Analysis, PoseTrack } from './types';
import { resolvedEvents, viewClass } from './types';

export interface QualityFactor { key: string; label: string; score: number; value: string; advice?: string }
export interface Quality { score: number; grade: 'A' | 'B' | 'C' | 'D'; factors: QualityFactor[] }

export interface PixelStats { brightness?: number; sharpness?: number } // 0–255 mean luma; Laplacian variance

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const lerp = (v: number, lo: number, hi: number) => clamp01((v - lo) / (hi - lo));

export function clipQuality(a: Analysis, tr: PoseTrack, body: Body, opts: { lostFrames?: number; sourceHeight?: number; pixels?: PixelStats } = {}): Quality {
  const f: QualityFactor[] = [];
  const ev = resolvedEvents(a);
  // frame rate
  const fps = a.fps;
  f.push({ key: 'fps', label: 'Frame rate', value: `${Math.round(fps)} fps`, score: fps >= 200 ? 1 : fps >= 110 ? 0.85 : fps >= 55 ? 0.55 : 0.25,
    advice: fps < 110 ? 'Use the phone\'s slow-motion mode (120–240 fps): the arm moves ~1 m between frames at 30 fps.' : undefined });
  // pitcher size in source pixels
  const srcScale = opts.sourceHeight ? opts.sourceHeight / tr.height : 1;
  const hp = a.scale.heightPx * srcScale;
  f.push({ key: 'size', label: 'Pitcher size on screen', value: `${Math.round(hp)} px tall (${Math.round((a.scale.heightPx / tr.height) * 100)}% of the frame)`, score: lerp(hp, 70, 380),
    advice: hp < 250 ? 'Move closer or zoom in so the pitcher fills about half the frame height (leave room for the stride). Far cameras work, but every pixel helps accuracy.' : undefined });
  // tracking confidence over the delivery
  const segs: (keyof Body['conf'])[] = ['leadKnee', 'leadAnkle', 'throwElbow', 'throwWrist', 'hipC', 'shC'];
  let sum = 0, cnt = 0;
  for (let i = ev.FM; i <= Math.min(ev.MIR, body.n - 1); i++) for (const s of segs) { sum += body.conf[s][i]; cnt++; }
  const conf = cnt ? sum / cnt : 0;
  const filled = tr.filled ? tr.filled.reduce((s, x) => s + x.reduce((p, q) => p + q, 0), 0) / (tr.filled.length * tr.t.length) : 0;
  const lost = (opts.lostFrames ?? 0) / tr.t.length;
  f.push({ key: 'tracking', label: 'Tracking confidence', value: `${Math.round(conf * 100)}% avg · ${Math.round(filled * 100)}% filled${lost ? ` · lost ${Math.round(lost * 100)}%` : ''}`, score: clamp01(lerp(conf, 0.45, 0.85) - filled * 1.5 - lost * 2),
    advice: conf < 0.7 || filled > 0.08 ? 'Contrast helps tracking: avoid baggy clothes that match the background, shoot in good light, and keep netting out of the shot.' : undefined });
  // camera view
  const v = a.view;
  const vs = v === 'side-open' ? 1 : v === 'front' ? 0.85 : v === 'side-closed' ? 0.75 : v === 'back' ? 0.6 : 0.4;
  f.push({ key: 'view', label: 'Camera angle', value: v, score: vs,
    advice: viewClass(v) === 'O' ? 'Square the camera up: perpendicular to the rubber→plate line (side) or straight behind the plate (front).' : v === 'back' ? 'From behind (center field) arm slot and side bend are measurable, but stride, trunk tilt and velocity need a side view.' : v === 'side-closed' ? 'Film from the open side (RHP: third-base side) so the throwing arm isn\'t hidden behind the body.' : undefined });
  // steadiness: the back ankle should not move during the set (camera shake / handheld)
  const k = Math.max(3, Math.min(ev.FM, Math.round(fps * 0.4)));
  const xs = Array.from(body.u.backAnkle.subarray(0, k)), ys = Array.from(body.v.backAnkle.subarray(0, k));
  const sd = (arr: number[]) => { const m = arr.reduce((p, q) => p + q, 0) / arr.length; return Math.sqrt(arr.reduce((p, q) => p + (q - m) ** 2, 0) / arr.length); };
  const shake = Math.hypot(sd(xs), sd(ys)) * 100;
  f.push({ key: 'steady', label: 'Camera steadiness', value: `${shake.toFixed(1)}% ht jitter in the set`, score: 1 - lerp(shake, 0.4, 2),
    advice: shake > 1 ? 'Use a tripod or lean the phone on something solid — camera movement shows up as body movement.' : undefined });
  if (opts.pixels?.brightness !== undefined) {
    const b = opts.pixels.brightness;
    f.push({ key: 'light', label: 'Lighting', value: `${Math.round((b / 255) * 100)}% brightness`, score: b < 45 ? 0.2 : b < 70 ? 0.6 : b > 225 ? 0.5 : 1,
      advice: b < 70 ? 'Too dark: film in brighter light — dark video blurs fast motion.' : b > 225 ? 'Very bright/backlit: keep the sun behind the camera.' : undefined });
  }
  if (opts.pixels?.sharpness !== undefined) {
    const s = opts.pixels.sharpness;
    f.push({ key: 'sharp', label: 'Sharpness', value: s.toFixed(0), score: lerp(s, 20, 160),
      advice: s < 60 ? 'Soft/blurry image: clean the lens, tap to focus on the pitcher, and use more light (faster shutter).' : undefined });
  }
  const weights: Record<string, number> = { fps: 1.2, size: 1, tracking: 1.5, view: 1, steady: 0.8, light: 0.6, sharp: 0.6 };
  let ws = 0, wsum = 0;
  for (const x of f) { ws += x.score * (weights[x.key] ?? 1); wsum += weights[x.key] ?? 1; }
  const score = Math.round((ws / wsum) * 100);
  return { score, grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D', factors: f };
}
