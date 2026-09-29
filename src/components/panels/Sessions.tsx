'use client';
import { useMemo } from 'react';
import { sessionStates, intersect, isFxWeekend } from '@shared/sessions';
import { useNow } from '@/lib/hooks';
import { countdown } from '@/lib/format';
import { Panel } from '../ui';

const COLORS: Record<string, string> = { sydney: 'var(--macro)', tokyo: 'var(--reg)', london: 'var(--fx)', newyork: 'var(--eq)' };

/** 24h timeline in the viewer's local time, with a live "now" marker and session overlaps. */
export function SessionsPanel() {
  const now = useNow(1000);
  const { dayStart, dayEnd, states, overlaps } = useMemo(() => {
    const d = new Date(now || Date.now());
    d.setHours(0, 0, 0, 0);
    const dayStart = d.getTime();
    const dayEnd = dayStart + 86400_000;
    const states = sessionStates(now || Date.now(), dayStart, dayEnd);
    const by = Object.fromEntries(states.map((s) => [s.def.id, s.windows]));
    const overlaps = [
      { label: 'London–NY', w: intersect(by.london, by.newyork), hot: true },
      { label: 'Tokyo–London', w: intersect(by.tokyo, by.london), hot: false },
      { label: 'Sydney–Tokyo', w: intersect(by.sydney, by.tokyo), hot: false },
    ];
    return { dayStart, dayEnd, states, overlaps };
    // recompute windows once a minute; the marker moves every second below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.floor((now || 0) / 60_000)]);

  if (!now) return <Panel title="Market sessions" accent="var(--macro)"><div className="skeleton h-40" /></Panel>;
  const pos = (t: number) => `${Math.max(0, Math.min(100, ((t - dayStart) / (dayEnd - dayStart)) * 100))}%`;
  const weekend = isFxWeekend(now);
  const ldnNy = overlaps[0].w.find((w) => now >= w.start && now < w.end);

  return (
    <Panel
      title="Market sessions"
      accent="var(--macro)"
      right={<span className="num text-[10px] text-faint">{new Date(now).toLocaleTimeString([], { hour12: false })} local</span>}
    >
      {weekend ? <div className="mb-2 rounded-md border border-warn/30 bg-warn/10 px-2 py-1 text-[11px] text-warn">FX market closed for the weekend</div> : null}
      {ldnNy ? (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-fx/30 bg-fx/10 px-2 py-1 text-[11px] text-fx">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-fx text-fx" /> London–NY overlap · peak FX liquidity · ends in <span className="num">{countdown(ldnNy.end - now)}</span>
        </div>
      ) : null}
      <div className="relative">
        {/* hour grid */}
        <div className="relative mb-1 ml-[76px] h-3 text-[9px] text-faint">
          {[0, 6, 12, 18].map((h) => (
            <span key={h} className="num absolute -translate-x-1/2" style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, '0')}</span>
          ))}
        </div>
        <div className="space-y-1.5">
          {states.map((s) => (
            <div key={s.def.id} className="flex items-center gap-2">
              <div className="w-[68px] shrink-0">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-text">
                  <span className={`h-1.5 w-1.5 rounded-full ${s.open ? 'live-dot' : ''}`} style={{ background: s.open ? COLORS[s.def.id] : 'var(--text-faint)', color: COLORS[s.def.id] }} />
                  {s.def.label}
                </div>
                <div className="num text-[9px] text-faint">{s.open ? 'closes' : 'opens'} {countdown(s.nextChange - now, false)}</div>
              </div>
              <div className="relative h-5 flex-1 overflow-hidden rounded-md bg-bg-2/70">
                {s.windows.map((w) => (
                  <div
                    key={w.start}
                    className="absolute inset-y-0.5 rounded"
                    style={{ left: pos(w.start), width: `calc(${pos(w.end)} - ${pos(w.start)})`, background: `color-mix(in oklab, ${COLORS[s.def.id]} ${s.open ? 45 : 22}%, transparent)`, border: `1px solid color-mix(in oklab, ${COLORS[s.def.id]} 40%, transparent)` }}
                  />
                ))}
              </div>
            </div>
          ))}
          {/* overlaps row */}
          <div className="flex items-center gap-2">
            <div className="w-[68px] shrink-0 text-[10px] text-faint">Overlaps</div>
            <div className="relative h-3 flex-1 rounded bg-bg-2/40">
              {overlaps.flatMap((o) =>
                o.w.map((w) => (
                  <div key={`${o.label}${w.start}`} title={o.label} className="absolute inset-y-0.5 rounded-sm" style={{ left: pos(w.start), width: `calc(${pos(w.end)} - ${pos(w.start)})`, background: o.hot ? 'var(--fx)' : 'var(--text-faint)', opacity: o.hot ? 0.85 : 0.4 }} />
                )),
              )}
            </div>
          </div>
        </div>
        {/* now marker */}
        <div className="pointer-events-none absolute bottom-0 top-4 ml-[76px] w-[calc(100%-76px)]">
          <div className="absolute inset-y-0 w-px bg-text/80 shadow-[0_0_8px_var(--text)]" style={{ left: pos(now) }}>
            <div className="absolute -left-[3px] -top-1 h-[7px] w-[7px] rounded-full bg-text" />
          </div>
        </div>
      </div>
    </Panel>
  );
}
