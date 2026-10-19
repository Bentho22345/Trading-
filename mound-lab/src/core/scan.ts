// Pure helpers shared by the pose pipeline and tests: the scan result, MoveNet → MediaPipe keypoint layout,
// and applying the user's tap/box to a scan.

import { boxAt, iou, MANUAL_ID, type Box, type PersonSummary } from './people';

export interface ScanResult {
  frameW: number;
  frameH: number;
  totalSamples: number;
  tracks: { id: number; t: number[]; boxes: Box[] }[];
  people: PersonSummary[];
  pitcherId: number | null;
  smallPeople: boolean;
  /** The pitcher is filmed from behind (no face visible). */
  backView?: boolean;
  /** MediaPipe could not find the pitcher on most probe frames (from behind, tiny or blurred). */
  mediapipeWeak?: boolean;
  /** Per person: fraction of probe frames on which MediaPipe found them. */
  probes?: Record<number, number>;
  /** Which model found the people. */
  finder?: 'movenet' | 'mediapipe';
}

/** A region the user marked around the pitcher (normalised 0–1), at clip time t (seconds from trim start). */
export interface PickRegion { x0: number; y0: number; x1: number; y1: number; t: number }

/** COCO-17 keypoint → MediaPipe-33 index. */
const COCO_TO_MP = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
/**
 * MoveNet scores run lower than MediaPipe visibilities for the same quality of point (a clear joint is ~0.4–0.8);
 * stretch them so the app's confidence thresholds (0.3 = usable, 0.5 = solid) mean the same thing for both.
 */
export const moveConf = (s: number) => Math.max(0, Math.min(0.99, s * 1.3));

/** MoveNet person (COCO-17, normalised to the crop) → MediaPipe-33 layout in frame pixels. */
export function cocoToMp(people: Float32Array, p: number, region: Box): Float32Array {
  const w = region[2] - region[0], h = region[3] - region[1];
  const kp = new Float32Array(99);
  for (let j = 0; j < 17; j++) {
    const m = COCO_TO_MP[j];
    kp[m * 3] = region[0] + people[p * 52 + j * 3] * w;
    kp[m * 3 + 1] = region[1] + people[p * 52 + j * 3 + 1] * h;
    kp[m * 3 + 2] = moveConf(people[p * 52 + j * 3 + 2]);
  }
  // face points MoveNet doesn't have: at the nose, invisible
  for (const m of [1, 3, 4, 6, 9, 10]) { kp[m * 3] = kp[0]; kp[m * 3 + 1] = kp[1]; kp[m * 3 + 2] = 0; }
  // hands: at the wrists, invisible
  for (const [m, wr] of [[17, 15], [19, 15], [21, 15], [18, 16], [20, 16], [22, 16]]) { kp[m * 3] = kp[wr * 3]; kp[m * 3 + 1] = kp[wr * 3 + 1]; kp[m * 3 + 2] = 0; }
  // heel/toe: at the ankle with almost no confidence (the cleaner fills them from the ankle track)
  for (const [m, an] of [[29, 27], [31, 27], [30, 28], [32, 28]]) { kp[m * 3] = kp[an * 3]; kp[m * 3 + 1] = kp[an * 3 + 1]; kp[m * 3 + 2] = Math.min(0.05, kp[an * 3 + 2]); }
  return kp;
}

/** Apply the user's tap/box to a scan: choose the person there, or follow the marked region if nobody was found. */
export function applyPick(scan: ScanResult, pick: PickRegion): ScanResult {
  const W = scan.frameW, H = scan.frameH;
  const box: Box = [pick.x0 * W, pick.y0 * H, pick.x1 * W, pick.y1 * H];
  const isTap = box[2] - box[0] < 0.02 * W && box[3] - box[1] < 0.02 * H;
  const px = (box[0] + box[2]) / 2, py = (box[1] + box[3]) / 2;
  let hit: number | null = null, bestScore = 0;
  for (const tr of scan.tracks) {
    if (tr.t[0] > pick.t + 0.5 || tr.t[tr.t.length - 1] < pick.t - 0.5) continue;
    const b = boxAt(tr, pick.t);
    let s: number;
    if (isTap) {
      const inside = px >= b[0] && px <= b[2] && py >= b[1] && py <= b[3];
      const d = Math.hypot(px - (b[0] + b[2]) / 2, py - (b[1] + b[3]) / 2) / Math.max(1, b[3] - b[1]);
      s = inside ? 2 - d : d < 1 ? 1 - d : 0;
    } else s = iou(b, box) + (px >= b[0] && px <= b[2] && py >= b[1] && py <= b[3] ? 0.1 : 0);
    if (s > bestScore) { bestScore = s; hit = tr.id; }
  }
  if (hit !== null && bestScore > (isTap ? 0.2 : 0.2)) {
    const people = scan.people.map((p) => ({ ...p, role: p.id === hit ? 'pitcher' as const : p.role === 'pitcher' ? 'other' as const : p.role }));
    return { ...scan, people, pitcherId: hit };
  }
  // nobody found there: follow the marked region (a tap gets a box about half the frame tall)
  const side = 0.5 * H;
  const mbox: Box = isTap ? [px - side * 0.35, py - side / 2, px + side * 0.35, py + side / 2] : box;
  const others = scan.people.filter((p) => p.id !== MANUAL_ID).map((p) => ({ ...p, role: p.role === 'pitcher' ? 'other' as const : p.role }));
  const manual: PersonSummary = { id: MANUAL_ID, role: 'pitcher', score: 0, reasons: ['marked by you'], box: mbox, heightFrac: (mbox[3] - mbox[1]) / H, presence: 1 };
  return {
    ...scan,
    tracks: [...scan.tracks.filter((t) => t.id !== MANUAL_ID), { id: MANUAL_ID, t: [pick.t], boxes: [mbox] }],
    people: [manual, ...others], pitcherId: MANUAL_ID,
  };
}

