'use client';
import { useMemo, useState } from 'react';
import type { Exposure } from '@shared/v2';
import { useV2 } from '@/lib/v2';
import { fmtPrice } from '@/lib/format';
import { Panel, Segmented } from '../ui';
import { EmptyCard } from '../brief/bits';

const money = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** Squarified-ish treemap (slice-and-dice by size), absolute values sized, sign coloured. */
function Treemap({ items }: { items: { key: string; value: number }[] }) {
  const list = items.filter((i) => i.value !== 0).slice(0, 12);
  const total = list.reduce((s, i) => s + Math.abs(i.value), 0) || 1;
  const rects: { key: string; value: number; x: number; y: number; w: number; h: number }[] = [];
  let x = 0, y = 0, w = 100, h = 60, rest = list.slice();
  while (rest.length) {
    const horizontal = w >= h;
    const take = rest.splice(0, Math.max(1, Math.ceil(rest.length / 3)));
    const sum = take.reduce((s, i) => s + Math.abs(i.value), 0);
    const remaining = rest.reduce((s, i) => s + Math.abs(i.value), 0) + sum;
    const frac = sum / (remaining || 1);
    const band = horizontal ? w * frac : h * frac;
    let off = 0;
    for (const t of take) {
      const f = Math.abs(t.value) / (sum || 1);
      if (horizontal) { rects.push({ ...t, x, y: y + off, w: band, h: h * f }); off += h * f; }
      else { rects.push({ ...t, x: x + off, y, w: w * f, h: band }); off += w * f; }
    }
    if (horizontal) { x += band; w -= band; } else { y += band; h -= band; }
  }
  return (
    <svg viewBox="0 0 100 60" className="h-32 w-full" preserveAspectRatio="none" role="img" aria-label="Exposure treemap">
      {rects.map((r) => (
        <g key={r.key}>
          <rect x={r.x + 0.3} y={r.y + 0.3} width={Math.max(0, r.w - 0.6)} height={Math.max(0, r.h - 0.6)} rx={1} fill={r.value >= 0 ? 'var(--up)' : 'var(--down)'} opacity={0.18 + (Math.abs(r.value) / total) * 0.6} />
          {r.w > 10 && r.h > 6 ? <text x={r.x + 1.5} y={r.y + 5} fontSize="3.4" fill="var(--text)">{r.key}</text> : null}
        </g>
      ))}
    </svg>
  );
}

export function PortfolioPanel() {
  const e = useV2((s) => s.exposure) as Exposure | null;
  const privacy = useV2((s) => s.privacy);
  const [by, setBy] = useState<'byCurrency' | 'byClass' | 'bySector'>('byCurrency');
  const rows = useMemo(() => [...(e?.rows ?? [])].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)), [e]);
  if (!e || !e.rows.length) {
    return <Panel title="Portfolio & exposure" accent="var(--accent)"><EmptyCard text="Import positions to see live P&L, exposure by currency, asset class and sector, and stress tests." action="Import positions" onAction={() => useV2.getState().set({ settingsCenter: 'portfolio' })} /></Panel>;
  }
  return (
    <Panel title="Portfolio & exposure" accent="var(--accent)" right={<button onClick={() => useV2.getState().set({ privacy: !privacy })} className="text-[10px] text-faint hover:text-text" title="Privacy blur (P)">{privacy ? 'show' : 'hide'}</button>}>
      <div className={privacy ? 'select-none blur-sm' : ''}>
        <div className="grid grid-cols-3 gap-2 text-center">
          {([['Day', e.pnlDay], ['Overnight', e.pnlOvernight], ['Total', e.pnlTotal]] as const).map(([l, v]) => <div key={l} className="rounded-lg border border-line px-1 py-1.5"><div className="text-[10px] uppercase tracking-wider text-faint">{l}</div><div className={`num text-sm font-semibold ${v >= 0 ? 'text-up' : 'text-down'}`}>{money(v)}</div></div>)}
        </div>
        <div className="mt-3 flex items-center justify-between"><span className="text-[10px] font-semibold uppercase tracking-wider text-faint">Net exposure</span><Segmented label="Group by" value={by} onChange={setBy} options={[{ value: 'byCurrency', label: 'CCY' }, { value: 'byClass', label: 'Class' }, { value: 'bySector', label: 'Sector' }]} /></div>
        <Treemap items={e[by]} />
        <div className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-faint">What hurts me most? <span className="font-normal normal-case">simple linear estimates</span></div>
        <div className="mt-1 grid grid-cols-2 gap-1.5">
          {e.stress.map((s) => <div key={s.id} className="rounded-lg border border-line px-2 py-1.5" title={s.note}><div className="text-[10px] text-faint">{s.label}</div><div className={`num text-sm ${s.pnl >= 0 ? 'text-up' : 'text-down'}`}>{money(s.pnl)}</div></div>)}
        </div>
        <table className="mt-3 w-full text-[11px]"><tbody className="divide-y divide-line">
          {rows.slice(0, 12).map((r) => <tr key={r.id}><td className="py-1 text-text">{r.symbol}{r.mock ? <span className="text-faint"> · demo</span> : null}</td><td className="num py-1 text-right text-faint">{r.qty}</td><td className="num py-1 text-right text-dim">{r.price === null ? 'no price' : fmtPrice(r.price, 2)}</td><td className={`num py-1 text-right ${r.pnlDay >= 0 ? 'text-up' : 'text-down'}`}>{r.priced ? money(r.pnlDay) : '—'}</td></tr>)}
        </tbody></table>
      </div>
    </Panel>
  );
}
