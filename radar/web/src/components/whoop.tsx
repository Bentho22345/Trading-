'use client';
import { animate, motion, useInView, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useRef } from 'react';

/** Whoop-style ring gauge: animated stroke on scroll-in, big condensed value in the middle. */
export function Ring({ value, max = 100, size = 120, stroke = 9, color = 'var(--color-up)', label, children, track = '#1d1d20' }: {
  value: number | null | undefined; max?: number; size?: number; stroke?: number; color?: string; label?: string; children?: React.ReactNode; track?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = value == null || !isFinite(value) ? 0 : Math.max(0, Math.min(1, value / max));
  return (
    <div className="relative inline-flex flex-col items-center" style={{ width: size }}>
      <svg ref={ref} width={size} height={size} className="-rotate-90" aria-label={label ? `${label}: ${value ?? 'no data'}` : undefined} role="img">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: inView ? c * (1 - pct) : c }}
          transition={{ duration: 1.4, ease: [0.2, 0.8, 0.2, 1] }} style={{ filter: `drop-shadow(0 0 6px ${color})` }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ height: size }}>{children}</div>
      {label && <span className="eyebrow mt-2 text-center">{label}</span>}
    </div>
  );
}

/** Fade-up on scroll into view; children stagger when `stagger` is set on a parent list. */
export function Reveal({ children, delay = 0, className = '', y = 24 }: { children: React.ReactNode; delay?: number; className?: string; y?: number }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.7, delay, ease: [0.2, 0.8, 0.2, 1] }}>
      {children}
    </motion.div>
  );
}

/** Counts up when scrolled into view. */
export function CountUp({ value, format = (v: number) => Math.round(v).toLocaleString(), className = '' }: { value: number | null | undefined; format?: (v: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => format(v));
  useEffect(() => {
    if (!inView || value == null || !isFinite(value)) return;
    const c = animate(mv, value, { duration: 1.6, ease: [0.2, 0.8, 0.2, 1] });
    return () => c.stop();
  }, [inView, value, mv]);
  if (value == null || !isFinite(value)) return <span ref={ref} className={className}>—</span>;
  return <motion.span ref={ref} className={className}>{text}</motion.span>;
}

/** Deterministic gradient avatar for a wallet address. */
export function WalletAvatar({ address, size = 36 }: { address: string; size?: number }) {
  let h = 0;
  for (let i = 0; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  const a = h % 360, b = (a + 60 + (h >> 8) % 120) % 360;
  return <span className="inline-block shrink-0 rounded-full ring-1 ring-white/10" style={{ width: size, height: size, background: `conic-gradient(from ${h % 360}deg, hsl(${a} 85% 55%), hsl(${b} 85% 50%), hsl(${a} 85% 55%))` }} />;
}

/** Cursor-follow highlight for .spotlight elements. */
export function onSpot(e: React.MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
}

export function money(v: number | null | undefined, signed = true): string {
  if (v == null || !isFinite(v)) return '—';
  const s = v < 0 ? '-' : signed && v > 0 ? '+' : '';
  const a = Math.abs(v);
  const n = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(0);
  return `${s}$${n}`;
}

export function SectionHead({ eyebrow, title, sub, right }: { eyebrow: string; title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <Reveal className="mb-6 flex flex-wrap items-end gap-4">
      <div className="min-w-0">
        <div className="eyebrow mb-2">{eyebrow}</div>
        <h2 className="display text-[44px] md:text-[64px]">{title}</h2>
        {sub && <p className="mt-2 max-w-2xl text-[15px] text-white/60">{sub}</p>}
      </div>
      {right && <div className="ml-auto">{right}</div>}
    </Reveal>
  );
}

/** Line chart of cumulative P&L (single series) with hover readout. */
export function PnlLine({ series, w = 600, h = 160 }: { series: [number, number][]; w?: number; h?: number }) {
  if (!series || series.length < 2) return <p className="py-8 text-center text-[12px] text-white/40">P&L history appears after closed trades.</p>;
  const ys = series.map((p) => p[1]);
  const min = Math.min(0, ...ys), max = Math.max(0, ...ys), span = max - min || 1;
  const x = (i: number) => (i / (series.length - 1)) * w;
  const y = (v: number) => h - 8 - ((v - min) / span) * (h - 16);
  const last = ys[ys.length - 1];
  const color = last >= 0 ? 'var(--color-up)' : 'var(--color-down)';
  const line = series.map((p, i) => `${x(i)},${y(p[1])}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none" role="img" aria-label="cumulative realized P&L">
      <defs><linearGradient id="pnlg" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.25} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient></defs>
      <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="#2a2a2e" strokeDasharray="4 4" />
      <motion.polygon points={`0,${h} ${line} ${w},${h}`} fill="url(#pnlg)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1 }} />
      <motion.polyline points={line} fill="none" stroke={color} strokeWidth={2.2} vectorEffect="non-scaling-stroke"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4, ease: [0.2, 0.8, 0.2, 1] }} />
    </svg>
  );
}

/** Shareable P&L card rendered to PNG in the browser (no server, no upload). */
export async function downloadPnlCard(o: { title: string; pnl: number; roi?: number | null; winRate?: number | null; tokens?: number; window: string; address: string; rank?: number | null; series?: [number, number][] }) {
  await document.fonts?.ready;
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 630;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, 1200, 630);
  const grd = g.createRadialGradient(600, -200, 50, 600, -200, 900); grd.addColorStop(0, 'rgba(77,124,254,.25)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 1200, 630);
  const up = o.pnl >= 0;
  g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '600 22px "Inter Variable", sans-serif'; g.fillText(`RADAR · ${o.window.toUpperCase()} P&L${o.rank ? ` · RANK #${o.rank}` : ''}`, 64, 86);
  g.fillStyle = '#fff'; g.font = '800 64px "Barlow Condensed", sans-serif'; g.fillText(o.title.toUpperCase(), 64, 160);
  g.fillStyle = up ? '#22e57a' : '#ff2d55'; g.font = '800 168px "Barlow Condensed", sans-serif'; g.fillText(money(o.pnl), 60, 330);
  g.font = '700 40px "Barlow Condensed", sans-serif'; g.fillStyle = '#fff';
  const stats = [['ROI', o.roi != null ? `${o.roi > 0 ? '+' : ''}${o.roi.toFixed(0)}%` : '—'], ['WIN RATE', o.winRate != null ? `${o.winRate.toFixed(0)}%` : '—'], ['TOKENS', `${o.tokens ?? '—'}`]];
  stats.forEach(([k, v], i) => { g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '600 18px "Inter Variable", sans-serif'; g.fillText(k, 64 + i * 230, 410); g.fillStyle = '#fff'; g.font = '700 54px "Barlow Condensed", sans-serif'; g.fillText(v, 64 + i * 230, 465); });
  if (o.series && o.series.length > 1) {
    const ys = o.series.map((p) => p[1]); const mn = Math.min(0, ...ys), mx = Math.max(0, ...ys), sp = mx - mn || 1;
    g.strokeStyle = up ? '#22e57a' : '#ff2d55'; g.lineWidth = 4; g.beginPath();
    o.series.forEach((p, i) => { const x = 760 + (i / (o.series!.length - 1)) * 380; const y = 470 - ((p[1] - mn) / sp) * 200; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
  }
  g.fillStyle = 'rgba(255,255,255,.35)'; g.font = '500 18px "Inter Variable", sans-serif';
  g.fillText(`${o.address.slice(0, 6)}…${o.address.slice(-6)} · ${new Date().toLocaleDateString()} · from on-chain trades Radar observed`, 64, 580);
  const a = document.createElement('a'); a.download = `radar-pnl-${o.address.slice(0, 6)}.png`; a.href = c.toDataURL('image/png'); a.click();
}
