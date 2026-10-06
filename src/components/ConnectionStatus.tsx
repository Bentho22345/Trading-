'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/store';
import { useNow } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import { DelayChip, DemoChip } from './ui';

const STATE_COLOR = { live: 'var(--up)', stale: 'var(--warn)', connecting: 'var(--warn)', down: 'var(--down)' } as const;

export function ConnectionStatus() {
  const conn = useStore((s) => s.conn);
  const rtt = useStore((s) => s.rttMs);
  const statuses = useStore((s) => s.statuses);
  const lastMsgAt = useStore((s) => s.lastMsgAt);
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);

  const worst = statuses.some((s) => s.state === 'down') ? 'down' : statuses.some((s) => s.state !== 'live') ? 'stale' : 'live';
  const overall = conn !== 'open' ? (conn === 'connecting' ? 'connecting' : 'down') : worst;
  const color = STATE_COLOR[overall];
  // every external source failing at once almost always means the network blocks outbound requests
  const external = statuses.filter((s) => s.id !== 'banks');
  const allBlocked = conn === 'open' && external.length > 0 && external.every((s) => s.state === 'down');
  const label = conn === 'closed' ? 'Offline — reconnecting' : conn === 'connecting' ? 'Connecting' : allBlocked ? 'Sources unreachable' : overall === 'live' ? 'Live' : overall === 'down' ? 'Degraded' : 'Partially stale';

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 rounded-lg border border-line px-2 py-1 text-[11px] text-dim hover:border-line-strong" aria-expanded={open} aria-label={`Connection status: ${label}`}>
        <span className="live-dot h-2 w-2 rounded-full" style={{ background: color, color }} />
        <span className="hidden font-medium text-text md:inline">{label}</span>
        <span className="num">{rtt !== null ? `${rtt}ms` : '—'}</span>
      </button>
      {open && (
          <div
            className="fade-in glass absolute right-0 top-9 z-50 w-[360px] rounded-xl bg-panel-solid/95 p-3 text-xs"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold text-text">Data streams</span>
              <span className="num text-[10px] text-faint">browser ⇄ worker {rtt ?? '—'}ms · last msg {lastMsgAt ? timeAgo(lastMsgAt, now) : '—'}</span>
            </div>
            {conn === 'closed' ? (
              <div className="mb-2 rounded-md border border-down/30 bg-down/10 px-2 py-1.5 text-[11px] text-down">
                Can&apos;t reach the PULSE server. If you deployed to a static or serverless host (Netlify, Vercel, GitHub Pages), it can&apos;t run the live server: deploy to Render, Railway or Fly instead (see README → Deploying), or run <span className="num">npm run dev</span> locally.
              </div>
            ) : null}
            {allBlocked ? (
              <div className="mb-2 rounded-md border border-down/30 bg-down/10 px-2 py-1.5 text-[11px] text-down">
                No data source is reachable from the machine running PULSE. Its network (office/school Wi-Fi, VPN, firewall or a hosted preview) is blocking outbound requests. Run <span className="num">npm run doctor</span> there to see which sites are blocked.
              </div>
            ) : null}
            <ul className="divide-y divide-line">
              {statuses.map((s) => (
                <li key={s.id} className="flex items-start gap-2 py-1.5">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STATE_COLOR[s.state] }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-text">{s.label}</span>
                      {s.mock ? <DemoChip /> : null}
                      <DelayChip min={s.delayedMin} />
                    </div>
                    <div className="truncate text-[10px] text-faint" title={s.provider}>{s.provider}</div>
                    {s.message ? <div className="text-[10px] text-warn">{s.message}</div> : null}
                  </div>
                  <div className="num shrink-0 text-right text-[10px] text-faint">
                    <div className="capitalize" style={{ color: STATE_COLOR[s.state] }}>{s.state}</div>
                    <div>{s.lastUpdate ? `${timeAgo(s.lastUpdate, now)} ago` : '—'}</div>
                    {s.latencyMs !== null ? <div>{s.latencyMs}ms</div> : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
      )}
    </div>
  );
}
