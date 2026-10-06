'use client';
import type { EconEvent, NewsCluster } from '@shared/types';

const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** Clean text for Slack / Bloomberg IB. */
export function storyForChat(c: NewsCluster): string {
  const assets = [...c.tickers, ...c.currencies.filter((x) => x.length === 6)].slice(0, 4).join(' ');
  return [`*${c.headline}*`, c.tldr ?? c.summary.slice(0, 220), c.why ? `Why it matters: ${c.why}` : '', `${c.source}${c.articles.length > 1 ? ` +${c.articles.length - 1}` : ''} · ${fmtTime(c.publishedAt)} · impact ${c.impact}${assets ? ` · ${assets}` : ''}`, c.url].filter(Boolean).join('\n');
}

export function eventForChat(e: EconEvent): string {
  return `${e.currency} ${e.title}: ${e.actual ?? '—'}${e.unit} vs ${e.consensus ?? '—'}${e.unit} cons (prev ${e.previous ?? '—'}${e.unit}) · ${fmtTime(e.time)} · ${e.source}`;
}

export async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

function cssVar(n: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fallback;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width > max && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Crisp 2x PNG share card with source attribution and the disclaimer watermark. */
export async function shareCard(opts: { kicker: string; title: string; body?: string; meta: string; accent?: string; filename: string }) {
  const W = 1200, H = 630, s = 2;
  const c = document.createElement('canvas');
  c.width = W * s; c.height = H * s;
  const ctx = c.getContext('2d')!;
  ctx.scale(s, s);
  const bg = cssVar('--panel-solid', '#11111d'), text = cssVar('--text', '#e8e8f2'), dim = cssVar('--text-dim', '#a2a2bb'), faint = cssVar('--text-faint', '#6b6b86'), accent = opts.accent ?? cssVar('--accent', '#8b8bff');
  ctx.fillStyle = cssVar('--bg', '#07070d'); ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(40, 40, W - 80, H - 80, 24); ctx.fill();
  ctx.fillStyle = accent; ctx.fillRect(40, 80, 6, 60);
  ctx.font = '700 20px ui-sans-serif, system-ui'; ctx.fillStyle = text; ctx.fillText('P U L S E', 80, 95);
  ctx.font = '600 18px ui-sans-serif, system-ui'; ctx.fillStyle = accent; ctx.fillText(opts.kicker.toUpperCase(), 80, 130);
  ctx.font = '600 48px Georgia, "Times New Roman", serif'; ctx.fillStyle = text;
  let y = 200;
  for (const l of wrap(ctx, opts.title, W - 180).slice(0, 4)) { ctx.fillText(l, 80, y); y += 58; }
  if (opts.body) {
    ctx.font = '24px ui-sans-serif, system-ui'; ctx.fillStyle = dim; y += 10;
    for (const l of wrap(ctx, opts.body, W - 180).slice(0, 4)) { ctx.fillText(l, 80, y); y += 34; }
  }
  ctx.font = '20px ui-monospace, monospace'; ctx.fillStyle = faint; ctx.fillText(opts.meta, 80, H - 110);
  ctx.font = '16px ui-sans-serif, system-ui'; ctx.fillText('Informational only — not investment advice. Source attribution as shown.', 80, H - 75);
  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = opts.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n');
}
