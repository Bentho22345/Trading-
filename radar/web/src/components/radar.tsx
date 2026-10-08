'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ago, pct, price, usd } from '@/lib/format';
import { tokenLinks } from '@/lib/links';
import { Copy, DISCLAIMER } from './ui';

export function VerdictBadge({ v, size = 'sm' }: { v?: string; size?: 'sm' | 'lg' }) {
  const cls = v === 'BUY' ? 'bg-up/20 text-up border-up/50' : v === 'WATCH' ? 'bg-warn/15 text-warn border-warn/50' : 'bg-down/15 text-down border-down/50';
  const label = v === 'BUY' ? 'BUY SIGNAL' : v || '—';
  return <span className={`inline-block rounded border font-bold ${cls} ${size === 'lg' ? 'px-2 py-0.5 text-sm' : 'px-1 text-[10px]'}`}>{label}</span>;
}

/** Single-series sparkline; hover shows the value at each point. */
export function Spark({ data, w = 120, h = 28, label = 'per min' }: { data: number[]; w?: number; h?: number; label?: string }) {
  const [hi, setHi] = useState<number | null>(null);
  if (!data?.length) return <span className="text-mute">—</span>;
  const max = Math.max(1, ...data);
  const step = w / Math.max(1, data.length - 1);
  const pts = data.map((d, i) => `${(i * step).toFixed(1)},${(h - 2 - (d / max) * (h - 4)).toFixed(1)}`).join(' ');
  return (
    <span className="relative inline-block" onMouseLeave={() => setHi(null)}>
      <svg width={w} height={h} className="overflow-visible" role="img" aria-label={`sparkline, max ${max} ${label}`}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGElement).getBoundingClientRect(); setHi(Math.max(0, Math.min(data.length - 1, Math.round((e.clientX - r.left) / step)))); }}>
        <polyline points={pts} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hi != null && <circle cx={hi * step} cy={h - 2 - (data[hi] / max) * (h - 4)} r={4} fill="var(--color-accent)" stroke="var(--color-panel)" strokeWidth={2} />}
      </svg>
      {hi != null && <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-panel2 px-1 text-[10px] text-fg">{data[hi]} {label} · {data.length - 1 - hi}m ago</span>}
    </span>
  );
}

export function SubBars({ subs }: { subs: Record<string, number | null> }) {
  return (
    <div className="grid grid-cols-5 gap-1">
      {Object.entries(subs || {}).map(([k, v]) => (
        <div key={k} title={v == null ? `${k}: no data (counts as 0)` : `${k}: ${v}`}>
          <div className="text-[9px] uppercase text-mute">{k.replace('_', ' ')}</div>
          <div className="h-1.5 rounded bg-line"><div className={`h-1.5 rounded ${v == null ? '' : v >= 60 ? 'bg-up' : v >= 35 ? 'bg-warn' : 'bg-down'}`} style={{ width: `${Math.max(0, Math.min(100, v ?? 0))}%` }} /></div>
          <div className="num text-[10px]">{v == null ? 'n/a' : v.toFixed(0)}</div>
        </div>
      ))}
    </div>
  );
}

export function SignalCard({ s, now, compact = false }: { s: any; now: number; compact?: boolean }) {
  const p = s.plan || {};
  const reasons = s.reasons?.why ?? s.reasons ?? [];
  const risks = s.reasons?.risks ?? s.risks ?? [];
  const [open, setOpen] = useState(!compact);
  return (
    <article className={`rounded border bg-panel p-2 ${s.verdict === 'BUY' ? 'border-up/50' : 'border-line'}`}>
      <header className="flex flex-wrap items-center gap-2">
        <VerdictBadge v={s.verdict} size="lg" />
        <Link href={`/token?a=${s.token_address}`} className="font-bold hover:text-accent">{s.symbol || s.token_address.slice(0, 6)}</Link>
        <span className="text-mute">{s.name}</span>
        <span className="num">score <b>{s.score}</b></span>
        <span className="text-mute">{s.confidence} conf · grade <b className="text-fg">{s.risk_grade}</b></span>
        {s.category && <span className="rounded bg-panel2 px-1 text-[10px] text-mute">{s.category}</span>}
        {s.return_pct != null && <span className={`num ${s.return_pct >= 0 ? 'text-up' : 'text-down'}`} title="paper-trade result">paper {pct(s.return_pct)}{s.paper_closed ? ` (${s.exit_reason})` : ' open'}</span>}
        <span className="ml-auto text-[11px] text-mute">{ago(s.ts, now)} ago</span>
        {compact && <button onClick={() => setOpen(!open)} className="text-[11px] text-mute hover:text-fg">{open ? 'less' : 'more'}</button>}
      </header>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="leading-relaxed">{s.writeup}</p>
          {!!s.vetoes?.length && <p className="rounded bg-down/10 px-2 py-1 text-down">Hard veto: {s.vetoes.join(' · ')}</p>}
          {s.subscores && <SubBars subs={s.subscores} />}
          <div className="grid gap-2 md:grid-cols-2">
            <div>
              <h4 className="text-[10px] uppercase text-mute">Why</h4>
              <ul className="list-inside list-disc text-[12px]">{reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}{!reasons.length && <li className="text-mute">no supporting evidence</li>}</ul>
              {!!risks.length && (<><h4 className="mt-1 text-[10px] uppercase text-mute">Risks</h4>
                <ul className="list-inside list-disc text-[12px] text-warn">{risks.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></>)}
            </div>
            {p.entry_low != null && (
              <div className="num text-[12px]">
                <h4 className="text-[10px] uppercase text-mute">Plan</h4>
                <div>Entry zone {price(p.entry_low)} – {price(p.entry_high)}</div>
                <div>Size <b>{usd(p.size_usd, 2)}</b> ({p.size_pct}% of bankroll){p.blocked ? <span className="text-down"> · {p.blocked.join('; ')}</span> : null}</div>
                <div>Take profit: {(p.ladder || []).map((l: any) => `${l.sell_fraction * 100}% @ ${l.multiple}x (${price(l.price)})`).join(' · ')}</div>
                <div className="text-down">Stop {price(p.stop_price)} (−{p.stop_pct}%)</div>
                <div>Time stop {p.time_stop_hours}h · {p.invalidation}</div>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Copy text={s.token_address} />
            {tokenLinks(s.token_address).slice(0, 6).map((l) => <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="rounded border border-line px-1.5 py-0.5 text-[11px] hover:border-accent hover:text-accent">{l.label} ↗</a>)}
          </div>
          <p className="text-[10px] text-warn">⚠ {DISCLAIMER}</p>
        </div>
      )}
    </article>
  );
}

export function Stat({ k, v, cls = '', title }: { k: string; v: React.ReactNode; cls?: string; title?: string }) {
  return (
    <div className="rounded border border-line bg-panel px-2 py-1" title={title}>
      <div className="text-[10px] uppercase text-mute">{k}</div>
      <div className={`num text-sm ${cls}`}>{v}</div>
    </div>
  );
}

export function useAction() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<any>, ok = 'Done') => {
    try { const r = await fn(); setMsg({ ok: true, text: typeof r === 'string' ? r : ok }); return r; }
    catch (e: any) { setMsg({ ok: false, text: String(e.message || e) }); }
  };
  return { msg, run, Msg: () => msg ? <span className={`text-[11px] ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</span> : null };
}

export { api };
