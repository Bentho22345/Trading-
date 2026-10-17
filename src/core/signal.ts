// Signal processing: zero-lag Butterworth filtering, gap filling and derivatives.

/** 2nd-order Butterworth low-pass coefficients (bilinear transform with prewarping). */
export function butter2(cutoffHz: number, fs: number) {
  const fc = Math.min(cutoffHz, fs * 0.45);
  const wc = Math.tan((Math.PI * fc) / fs);
  const k1 = Math.SQRT2 * wc;
  const k2 = wc * wc;
  const a0 = 1 + k1 + k2;
  const b = [k2 / a0, (2 * k2) / a0, k2 / a0];
  const a = [1, (2 * (k2 - 1)) / a0, (1 - k1 + k2) / a0];
  return { b, a };
}

function lfilter(b: number[], a: number[], x: ArrayLike<number>): Float64Array {
  const n = x.length;
  const y = new Float64Array(n);
  // initialise state at steady state of the first sample to avoid start-up transients
  const x0 = x[0] ?? 0;
  let x1 = x0, x2 = x0, y1 = x0, y2 = x0;
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const yi = b[0] * xi + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    y[i] = yi;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
  }
  return y;
}

/** Forward-backward (zero-phase) Butterworth low-pass with reflection padding. */
export function filtfilt(x: ArrayLike<number>, cutoffHz: number, fs: number): Float32Array {
  const n = x.length;
  if (n < 4) return Float32Array.from(x as ArrayLike<number>);
  const { b, a } = butter2(cutoffHz, fs);
  const pad = Math.min(n - 1, Math.max(6, Math.round((fs / cutoffHz) * 1.5)));
  const ext = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) ext[i] = 2 * x[0] - x[pad - i];
  for (let i = 0; i < n; i++) ext[pad + i] = x[i];
  for (let i = 0; i < pad; i++) ext[pad + n + i] = 2 * x[n - 1] - x[n - 2 - i];
  const f = lfilter(b, a, ext);
  f.reverse();
  const g = lfilter(b, a, f);
  g.reverse();
  return Float32Array.from(g.subarray(pad, pad + n));
}

/** Linear interpolation over frames where `bad[i]` is true. Returns which frames were filled. */
export function fillGaps(v: Float32Array, bad: (i: number) => boolean): Uint8Array {
  const n = v.length;
  const filled = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    if (!bad(i)) { i++; continue; }
    let j = i;
    while (j < n && bad(j)) j++;
    const left = i - 1, right = j;
    for (let k = i; k < j; k++) {
      if (left >= 0 && right < n) v[k] = v[left] + ((v[right] - v[left]) * (k - left)) / (right - left);
      else if (left >= 0) v[k] = v[left];
      else if (right < n) v[k] = v[right];
      filled[k] = 1;
    }
    i = j;
  }
  return filled;
}

/** Central-difference derivative per second. */
export function derivative(v: ArrayLike<number>, fs: number): Float32Array {
  const n = v.length;
  const d = new Float32Array(n);
  if (n < 2) return d;
  for (let i = 1; i < n - 1; i++) d[i] = ((v[i + 1] - v[i - 1]) * fs) / 2;
  d[0] = (v[1] - v[0]) * fs;
  d[n - 1] = (v[n - 1] - v[n - 2]) * fs;
  return d;
}

export function median(a: ArrayLike<number>): number {
  const s = Array.from(a).filter((v) => Number.isFinite(v)).sort((p, q) => p - q);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function argmax(a: ArrayLike<number>, from = 0, to = a.length - 1): number {
  let best = -Infinity, bi = Math.max(0, from);
  for (let i = Math.max(0, from); i <= Math.min(to, a.length - 1); i++) if (a[i] > best) { best = a[i]; bi = i; }
  return bi;
}

export function argmin(a: ArrayLike<number>, from = 0, to = a.length - 1): number {
  let best = Infinity, bi = Math.max(0, from);
  for (let i = Math.max(0, from); i <= Math.min(to, a.length - 1); i++) if (a[i] < best) { best = a[i]; bi = i; }
  return bi;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const deg = (r: number) => (r * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;

/** Interior angle at b (degrees) formed by a-b-c. */
export function angle3(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const ux = ax - bx, uy = ay - by, vx = cx - bx, vy = cy - by;
  const d = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (d === 0) return NaN;
  return deg(Math.acos(clamp((ux * vx + uy * vy) / d, -1, 1)));
}

export function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
}
export function sd(a: number[]): number {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
