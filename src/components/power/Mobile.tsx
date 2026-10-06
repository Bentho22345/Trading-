'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Brief } from '@shared/v2';
import { connect } from '@/lib/socket';
import { useSettings } from '@/lib/settings';
import { useStore } from '@/lib/store';
import { useV2, api } from '@/lib/v2';
import { useNow } from '@/lib/hooks';
import { countdown, fmtPct, flag, timeAgo } from '@/lib/format';
import { TickerStrip } from '../TickerStrip';
import { ConnectionStatus } from '../ConnectionStatus';
import { Toasts } from '../Toasts';
import { ThemeSync } from '../layout/ThemeSync';

/** Installable PWA companion: ticker, next event, top stories, alerts, cached brief. */
export function MobileCompanion() {
  const hydrate = useSettings((s) => s.hydrate);
  const clusters = useStore((s) => s.clusters);
  const calendar = useStore((s) => s.calendar);
  const alerts = useV2((s) => s.alertHistory);
  const exposure = useV2((s) => s.exposure);
  const now = useNow(1000);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    hydrate();
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
    void api<Brief & { offline?: boolean }>('/api/briefs/latest?kind=morning').then((b) => { if (b && !b.offline) setBrief(b); else setOffline(true); }).catch(() => setOffline(true));
    return connect();
  }, [hydrate]);
  const next = useMemo(() => calendar.find((e) => e.time > now && e.importance === 3), [calendar, now]);
  const top = useMemo(() => [...clusters].filter((c) => now - c.receivedAt < 12 * 3600_000).sort((a, b) => b.impact - a.impact).slice(0, 8), [clusters, now]);
  return (
    <>
      <ThemeSync />
      <div className="flex min-h-dvh flex-col bg-bg pb-6" style={{ overflowY: 'auto', height: '100dvh' }}>
        <header className="flex items-center justify-between px-4 py-3"><span className="text-sm font-bold tracking-[0.3em] text-text">PULSE</span><ConnectionStatus /></header>
        <TickerStrip />
        {offline ? <p className="mx-4 mt-2 rounded-lg border border-warn/40 px-3 py-2 text-xs text-warn">Offline — showing the last cached brief.</p> : null}
        {exposure?.rows.length ? <div className="mx-4 mt-3 flex justify-between rounded-xl border border-line px-3 py-2 text-sm"><span className="text-dim">Day P&amp;L</span><span className={`num font-semibold ${exposure.pnlDay >= 0 ? 'text-up' : 'text-down'}`}>{exposure.pnlDay >= 0 ? '+' : '−'}${Math.abs(exposure.pnlDay).toLocaleString()}</span></div> : null}
        {next ? (
          <div className="mx-4 mt-3 rounded-xl border border-line p-3">
            <div className="text-[10px] uppercase tracking-wider text-faint">Next high-impact</div>
            <div className="mt-1 flex items-center justify-between"><span className="text-sm text-text">{flag(next.country)} {next.title}</span><span className="num text-lg text-warn">{countdown(next.time - now)}</span></div>
            <div className="text-[11px] text-faint">cons {next.consensus ?? '—'}{next.unit} · prev {next.previous ?? '—'}{next.unit}</div>
          </div>
        ) : null}
        {brief ? (
          <a href="/?brief=1" className="mx-4 mt-3 block rounded-xl border border-line p-3">
            <div className="text-[10px] uppercase tracking-wider text-faint">Morning brief · {brief.date}</div>
            <div className="mt-1 font-serif text-lg leading-snug text-text">{brief.headline}</div>
            <p className="mt-1 line-clamp-4 font-serif text-sm text-dim">{brief.take.text}</p>
          </a>
        ) : null}
        <section className="mx-4 mt-4">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-faint">Top stories</div>
          <ul className="space-y-2">{top.map((c) => <li key={c.id}><a href={c.url} target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-line px-3 py-2"><div className="text-sm text-text">{c.headline}</div><div className="text-[11px] text-faint">{c.source} · {timeAgo(c.publishedAt, now)} ago · impact {c.impact}</div></a></li>)}</ul>
        </section>
        <section className="mx-4 mt-4">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-faint">Alerts</div>
          {alerts.length ? <ul className="space-y-1">{alerts.slice(0, 10).map((a) => <li key={a.id} className="text-xs text-dim">{new Date(a.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {a.message}</li>)}</ul> : <p className="text-xs text-faint">No alerts in this session.</p>}
        </section>
        <p className="mx-4 mt-6 text-[10px] text-faint">Informational only — not investment advice. <a href="/" className="underline">Open the full terminal</a></p>
      </div>
      <Toasts />
    </>
  );
}
void fmtPct;
