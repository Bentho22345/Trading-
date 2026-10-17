// Frame sources for the canvas players: cached JPEG frames from analysis, or a rendered synthetic pitcher.

import { J, type JointName, type PoseTrack } from '../core/types';

export interface FrameSource {
  n: number;
  width: number; // coordinate space of the pose track
  height: number;
  /** Draws frame i into the rect. Returns false if the exact frame wasn't ready (a nearby one was drawn). */
  draw(ctx: CanvasRenderingContext2D, i: number, dx: number, dy: number, dw: number, dh: number): boolean;
  prefetch(i: number): void;
  /** Subscribe to "a frame finished decoding"; returns an unsubscribe function. */
  subscribe(cb: () => void): () => void;
}

export class JpegFrames implements FrameSource {
  n: number;
  private cache = new Map<number, ImageBitmap>();
  private pending = new Set<number>();
  private order: number[] = [];
  private listeners = new Set<() => void>();
  subscribe(cb: () => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  constructor(private blobs: Blob[], public width: number, public height: number, private max = 90) {
    this.n = blobs.length;
  }
  prefetch(i: number) {
    i = Math.max(0, Math.min(this.n - 1, Math.round(i)));
    if (this.cache.has(i) || this.pending.has(i) || !this.blobs[i]) return;
    this.pending.add(i);
    createImageBitmap(this.blobs[i]).then((bm) => {
      this.pending.delete(i);
      this.cache.set(i, bm);
      this.order.push(i);
      while (this.order.length > this.max) {
        const old = this.order.shift()!;
        this.cache.get(old)?.close();
        this.cache.delete(old);
      }
      this.listeners.forEach((l) => l());
    }).catch(() => this.pending.delete(i));
  }
  draw(ctx: CanvasRenderingContext2D, i: number, dx: number, dy: number, dw: number, dh: number) {
    i = Math.max(0, Math.min(this.n - 1, Math.round(i)));
    for (let k = 1; k <= 4; k++) this.prefetch(i + k);
    let bm = this.cache.get(i);
    const exact = !!bm;
    if (!bm) {
      this.prefetch(i);
      for (let d = 1; d < 30 && !bm; d++) bm = this.cache.get(i - d) ?? this.cache.get(i + d);
    }
    if (bm) ctx.drawImage(bm, dx, dy, dw, dh);
    else { ctx.fillStyle = '#111'; ctx.fillRect(dx, dy, dw, dh); }
    return exact;
  }
}

const LIMBS: [JointName, JointName, number][] = [
  ['lHip', 'lKnee', 0.055], ['lKnee', 'lAnkle', 0.045], ['rHip', 'rKnee', 0.055], ['rKnee', 'rAnkle', 0.045],
  ['lShoulder', 'lElbow', 0.04], ['lElbow', 'lWrist', 0.035], ['rShoulder', 'rElbow', 0.04], ['rElbow', 'rWrist', 0.035],
  ['lAnkle', 'lToe', 0.03], ['rAnkle', 'rToe', 0.03],
];

/** Renders a simple athletic figure on a field background from a clean synthetic track. */
export class SyntheticFrames implements FrameSource {
  n: number;
  width: number;
  height: number;
  constructor(private tr: PoseTrack, private heightPx: number, private groundY: number, private throwSide: 'l' | 'r') {
    this.n = tr.t.length; this.width = tr.width; this.height = tr.height;
  }
  prefetch() {}
  subscribe() { return () => undefined; }
  draw(ctx: CanvasRenderingContext2D, i: number, dx: number, dy: number, dw: number, dh: number) {
    i = Math.max(0, Math.min(this.n - 1, Math.round(i)));
    const sx = dw / this.width, sy = dh / this.height;
    const P = (j: JointName): [number, number] => [dx + this.tr.x[J[j]][i] * sx, dy + this.tr.y[J[j]][i] * sy];
    // background: sky, outfield, mound
    const g = ctx.createLinearGradient(0, dy, 0, dy + dh);
    g.addColorStop(0, '#9fb7c9'); g.addColorStop(0.55, '#c8d6df'); g.addColorStop(0.56, '#4e7a45'); g.addColorStop(1, '#3a5f34');
    ctx.fillStyle = g; ctx.fillRect(dx, dy, dw, dh);
    const gy = dy + this.groundY * sy;
    ctx.fillStyle = '#a7774f';
    ctx.beginPath(); ctx.ellipse(dx + dw * 0.38, gy + 8 * sy, dw * 0.42, 40 * sy, 0, Math.PI, 0); ctx.fill();
    ctx.fillRect(dx, gy, dw, dy + dh - gy);
    ctx.fillStyle = '#f4f1ea'; ctx.fillRect(dx + 200 * sx, gy - 3 * sy, 60 * sx, 5 * sy); // rubber
    const H = this.heightPx * sy;
    const lw = (f: number) => Math.max(2, f * H);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const far = this.throwSide === 'r' ? 'l' : 'r';
    // far limbs first (darker), then torso, then near limbs
    const drawLimb = (a: JointName, b: JointName, w: number, col: string) => {
      const [x1, y1] = P(a), [x2, y2] = P(b);
      ctx.strokeStyle = col; ctx.lineWidth = lw(w); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    };
    for (const [a, b, w] of LIMBS) if (a.startsWith(far)) drawLimb(a, b, w, a.includes('Hip') || a.includes('Knee') || a.includes('Ankle') ? '#5a5f6b' : '#6b4b3a');
    // torso
    const [ls, rs, lh, rh] = [P('lShoulder'), P('rShoulder'), P('lHip'), P('rHip')];
    ctx.fillStyle = '#e9eef5'; ctx.strokeStyle = '#e9eef5'; ctx.lineWidth = lw(0.05);
    ctx.beginPath(); ctx.moveTo(...ls); ctx.lineTo(...rs); ctx.lineTo(...rh); ctx.lineTo(...lh); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#1d2a44';
    ctx.beginPath(); ctx.moveTo(...lh); ctx.lineTo(...rh); ctx.lineTo(rh[0], rh[1] + lw(0.03)); ctx.lineTo(lh[0], lh[1] + lw(0.03)); ctx.closePath(); ctx.fill();
    // head + cap
    const [nx, ny] = P('nose');
    const sc: [number, number] = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2];
    const hx = nx - (nx - sc[0]) * 0.25, hy = ny + 0.01 * H;
    ctx.fillStyle = '#c99a78'; ctx.beginPath(); ctx.arc(hx, hy, 0.062 * H, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1d2a44'; ctx.beginPath(); ctx.arc(hx, hy - 0.012 * H, 0.064 * H, Math.PI, 0); ctx.fill();
    for (const [a, b, w] of LIMBS) if (!a.startsWith(far)) drawLimb(a, b, w, a.includes('Hip') || a.includes('Knee') || a.includes('Ankle') ? '#d9dde5' : '#c99a78');
    // glove + ball
    const gl = P(`${far}Wrist` as JointName);
    ctx.fillStyle = '#7a4a22'; ctx.beginPath(); ctx.arc(gl[0], gl[1], 0.035 * H, 0, Math.PI * 2); ctx.fill();
    const bw = P(`${this.throwSide}Wrist` as JointName);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(bw[0], bw[1], 0.016 * H, 0, Math.PI * 2); ctx.fill();
    return true;
  }
}
