// Image exports: a stroboscopic "multi-exposure" of the delivery, and an A-vs-B key-frame sheet.

import { EVENT_LABELS, resolvedEvents, type EventCode } from '../core/types';
import type { RuntimeClip } from '../state/store';
import { cssVar, drawSkeleton, fit, label } from './draw';

async function frameCanvas(clip: RuntimeClip, i: number, w: number, h: number) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  const bm = await clip.source!.bitmapAt(i);
  ctx.drawImage(bm, 0, 0, w, h);
  bm.close();
  return c;
}

async function download(c: OffscreenCanvas | HTMLCanvasElement, name: string) {
  const blob = c instanceof OffscreenCanvas ? await c.convertToBlob({ type: 'image/png' }) : await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');

/** Stroboscopic image: the pitcher at leg lift, foot strike, layback, release and finish in one picture. */
export async function exportStrobe(clip: RuntimeClip) {
  const tr = clip.full!.cleaned, a = clip.analysis!;
  const ev = resolvedEvents(a);
  const W = Math.min(1600, tr.width), H = Math.round((W * tr.height) / tr.width);
  const T = fit(tr.width, tr.height, W, H);
  const out = new OffscreenCanvas(W, H + 40);
  const ctx = out.getContext('2d')! as unknown as CanvasRenderingContext2D;
  const codes: EventCode[] = ['PKH', 'FS', 'MER', 'BR', 'MIR'];
  ctx.drawImage(await frameCanvas(clip, ev.END, W, H), 0, 0);
  // blend each event frame in turn so earlier positions show as ghosts
  for (const [n, k] of codes.entries()) {
    ctx.globalAlpha = 0.35 + 0.1 * n;
    ctx.drawImage(await frameCanvas(clip, ev[k], W, H), 0, 0);
  }
  ctx.globalAlpha = 1;
  const hues = ['#5b9bff', '#7bd389', '#ffd166', '#ff8f5a', '#e05cff'];
  codes.forEach((k, n) => {
    drawSkeleton(ctx, tr, ev[k], T, { color: hues[n], width: 3, jointRadius: 3 });
    const nose = [tr.x[0][ev[k]] * T.sx + T.tx, tr.y[0][ev[k]] * T.sy + T.ty];
    label(ctx, nose[0] - 20, nose[1] - 22, k, hues[n]);
  });
  ctx.fillStyle = '#111'; ctx.fillRect(0, H, W, 40);
  ctx.font = '600 16px "Barlow Condensed", sans-serif';
  codes.forEach((k, n) => { ctx.fillStyle = hues[n]; ctx.fillText(`${k} ${EVENT_LABELS[k]}`, 12 + n * (W / codes.length), H + 26); });
  await download(out, `${safe(clip.record.name)}-strobe.png`);
}

/** Side-by-side key-frame sheet: A on top, B below, one column per event. */
export async function exportKeyframeSheet(A: RuntimeClip, B: RuntimeClip, verdict?: string) {
  const codes: EventCode[] = ['PKH', 'FS', 'MER', 'BR', 'MIR'];
  const cw = 360, chA = Math.round((cw * A.full!.cleaned.height) / A.full!.cleaned.width), chB = Math.round((cw * B.full!.cleaned.height) / B.full!.cleaned.width);
  const head = verdict ? 64 : 34;
  const out = new OffscreenCanvas(cw * codes.length, head + chA + chB + 20);
  const ctx = out.getContext('2d')! as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = '#0f1114'; ctx.fillRect(0, 0, out.width, out.height);
  ctx.fillStyle = '#fff'; ctx.font = '700 22px "Barlow Condensed", sans-serif';
  ctx.fillText(`MOUND LAB · A: ${A.record.name}  vs  B: ${B.record.name}`, 12, 26);
  if (verdict) { ctx.font = '500 17px "IBM Plex Sans", sans-serif'; ctx.fillStyle = '#ffd166'; ctx.fillText(verdict.slice(0, 160), 12, 52); }
  const colA = cssVar('--a'), colB = cssVar('--b');
  for (const [row, clip, ch, col] of [[0, A, chA, colA], [1, B, chB, colB]] as const) {
    const ev = resolvedEvents(clip.analysis!);
    const tr = clip.full!.cleaned;
    for (const [n, k] of codes.entries()) {
      const y = head + (row ? chA : 0);
      ctx.drawImage(await frameCanvas(clip, ev[k], cw, ch), n * cw, y);
      const T = fit(tr.width, tr.height, cw, ch);
      drawSkeleton(ctx, tr, ev[k], { sx: T.sx, sy: T.sy, tx: T.tx + n * cw, ty: T.ty + y }, { color: col, width: 2, jointRadius: 2 });
      label(ctx, n * cw + 6, y + 18, `${row ? 'B' : 'A'} · ${k} ${EVENT_LABELS[k]}`, col);
    }
  }
  await download(out, `mound-lab-${safe(A.record.name)}-vs-${safe(B.record.name)}.png`);
}
