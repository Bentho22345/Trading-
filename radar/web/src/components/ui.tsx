'use client';
import { useState } from 'react';
import type { Token } from '@/lib/api';
import { ago } from '@/lib/format';

export function Panel({ title, right, children, className = '' }: {
  title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`glass flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl ${className}`}>
      <header className="panel-head flex min-h-10 items-center justify-between gap-2 px-3.5 py-2">
        <h2 className="text-[12.5px] font-semibold tracking-tight text-fg/95">{title}</h2>
        <div className="flex items-center gap-2 text-[11px] text-mute">{right}</div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

export function Copy({ text, label = 'Copy CA' }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.preventDefault(); e.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); });
      }}
      className={`rounded-lg border px-2 py-0.5 text-[11px] transition active:scale-95 ${ok ? 'border-up/40 bg-up/10 text-up' : 'border-white/10 bg-white/5 hover:border-accent hover:text-accent'}`}
      title={text}
    >
      {ok ? 'Copied ✓' : label}
    </button>
  );
}

/** "as of" stamp that turns amber/red as data ages. Every number on screen carries one of these. */
export function AsOf({ ts, now, staleAfter = 60, source }: { ts?: number | null; now: number; staleAfter?: number; source?: string }) {
  if (!ts) return <span className="text-down">no data</span>;
  const age = now - ts;
  const cls = age > staleAfter * 5 ? 'text-down' : age > staleAfter ? 'text-warn' : 'text-mute';
  return <span className={cls} title={new Date(ts * 1000).toLocaleString()}>{source ? `${source} · ` : ''}{ago(ts, now)} ago{age > staleAfter * 5 ? ' · STALE' : ''}</span>;
}

type Flag = { label: string; bad: boolean | null; title: string };

export function safetyFlags(t: Partial<Token>): Flag[] {
  const known = t.safety_as_of != null;
  return [
    { label: 'MINT', bad: known ? !!t.mint_authority : null, title: known ? (t.mint_authority ? `Mint authority ACTIVE: ${t.mint_authority}` : 'Mint authority revoked') : 'No safety report yet' },
    { label: 'FRZ', bad: known ? !!t.freeze_authority : null, title: known ? (t.freeze_authority ? `Freeze authority ACTIVE: ${t.freeze_authority}` : 'Freeze authority revoked') : 'No safety report yet' },
    { label: 'LP', bad: t.lp_locked_pct == null ? null : t.lp_locked_pct < 90, title: t.lp_locked_pct == null ? 'LP lock unknown' : `LP locked/burned ${t.lp_locked_pct.toFixed(0)}%` },
    { label: 'T10', bad: t.top10_pct == null ? null : t.top10_pct > 30, title: t.top10_pct == null ? 'Holder concentration unknown' : `Top-10 holders own ${t.top10_pct.toFixed(1)}% (excl. AMM)` },
  ];
}

export function SafetyFlags({ t }: { t: Partial<Token> }) {
  if (t.rugged) return <span className="rounded bg-down/20 px-1 text-down">RUGGED</span>;
  return (
    <span className="inline-flex gap-0.5">
      {safetyFlags(t).map((f) => (
        <span key={f.label} title={f.title}
          className={`rounded-md px-1.5 py-px text-[10px] font-medium ${f.bad == null ? 'bg-line text-mute' : f.bad ? 'bg-down/20 text-down' : 'bg-up/15 text-up'}`}>
          {f.label}
        </span>
      ))}
    </span>
  );
}

export function TokenIcon({ src, symbol, size = 20 }: { src?: string | null; symbol?: string; size?: number }) {
  const [err, setErr] = useState(false);
  if (!src || err)
    return (
      <span style={{ width: size, height: size }} className="inline-flex shrink-0 items-center justify-center rounded-full bg-line text-[9px] text-mute">
        {(symbol || '?').slice(0, 2)}
      </span>
    );
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setErr(true)} className="shrink-0 rounded-full" style={{ width: size, height: size }} />;
}

export function Dot({ status }: { status: string }) {
  const c = status === 'ok' || status === 'connected' ? 'bg-up shadow-[0_0_8px_var(--color-up)]' : status === 'pending' || status === 'saved' ? 'bg-mute' : status === 'stale' || status === 'degraded' ? 'bg-warn' : 'bg-down';
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${c}`} />;
}

export const DISCLAIMER = 'Signals are probabilistic. Most memecoins go to zero. Only risk money you can lose.';
