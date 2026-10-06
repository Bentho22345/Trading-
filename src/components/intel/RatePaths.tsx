'use client';
import type { RatePath, Speaker } from '@shared/v2';
import { useIntel } from '@/lib/v2';
import { IntelPanel } from './shell';
import { ProbBar } from '../brief/sections';

function lean(v: number) {
  const pct = ((v + 1) / 2) * 100;
  return (
    <span className="relative inline-block h-1.5 w-16 rounded-full" style={{ background: 'linear-gradient(90deg, var(--up), var(--text-faint), var(--down))' }} title={`${v > 0.15 ? 'Hawkish' : v < -0.15 ? 'Dovish' : 'Centrist'} lean (${v.toFixed(1)})`}>
      <span className="absolute -top-0.5 h-2.5 w-1 rounded-sm bg-text" style={{ left: `calc(${pct}% - 2px)` }} />
    </span>
  );
}

export function RatePathsPanel() {
  const speakers = useIntel<Speaker[]>('speakers');
  return (
    <IntelPanel<RatePath[]> k="ratePaths" title="Rate-path probabilities" accent="var(--rates)">
      {(paths) => (
        <>
          <div className="space-y-3">
            {paths.map((p) => (
              <div key={p.bank}>
                <div className="mb-1 flex items-baseline justify-between text-xs"><span className="font-semibold text-text">{p.name}</span><span className="num text-faint">{p.rate.toFixed(2)}%</span></div>
                {p.meetings.map((m) => (
                  <div key={m.date} className="mb-1 grid grid-cols-[3.4rem_1fr_2.4rem] items-center gap-2">
                    <span className="num text-[10px] text-faint">{m.date.slice(5)}</span>
                    <ProbBar m={m} />
                    <span className={`num text-right text-[10px] ${m.delta > 0 ? 'text-up' : m.delta < 0 ? 'text-down' : 'text-faint'}`} title="Change in the leading probability since yesterday">{m.delta ? `${m.delta > 0 ? '▲' : '▼'}${Math.abs(m.delta)}` : '·'}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {speakers?.data?.length ? (
            <div className="mt-3 border-t border-line pt-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Speaker tracker</div>
              <ul className="space-y-1 text-[11px]">
                {speakers.data.slice(0, 7).map((s) => (
                  <li key={s.name} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-dim"><span className="text-text">{s.name}</span> · {s.bank}</span>
                    {s.next ? <span className="num shrink-0 text-faint">{new Date(s.next.time).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</span> : null}
                    {lean(s.lean)}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[10px] text-faint">Lean is editable reference data (server/data/speakers.json): dove ← → hawk.</p>
            </div>
          ) : null}
        </>
      )}
    </IntelPanel>
  );
}
