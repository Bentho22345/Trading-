'use client';
import { useState } from 'react';
import type { CorrelationMatrix, RegimeState } from '@shared/v2';
import { useStore } from '@/lib/store';
import { fmtPct, fmtPrice } from '@/lib/format';
import { Panel, DelayChip, Segmented } from '../ui';
import { IntelPanel } from './shell';

const CMDTY = [['GOLD', 'Gold'], ['SILVER', 'Silver'], ['WTI', 'WTI'], ['BRENT', 'Brent'], ['NATGAS', 'Nat gas'], ['COPPER', 'Copper'], ['DXY', 'DXY']] as const;

export function CrossAssetPanel() {
  const quotes = useStore((s) => s.quotes);
  const sparks = useStore((s) => s.sparks);
  const delay = Math.max(0, ...CMDTY.map(([s]) => quotes[s]?.delayedMin ?? 0));
  return (
    <Panel title="Commodities & dollar" accent="var(--cmdty)" right={<DelayChip min={delay} />}>
      <div className="grid grid-cols-2 gap-2">
        {CMDTY.map(([s, n]) => {
          const q = quotes[s];
          const sp = sparks[s] ?? [];
          const min = Math.min(...sp), max = Math.max(...sp);
          return (
            <button key={s} onClick={() => useStore.getState().set({ drawerSymbol: s })} className="rounded-lg border border-line px-2.5 py-2 text-left hover:border-line-strong" data-explain={s} data-explain-kind="symbol" data-explain-label={n}>
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-faint"><span>{n}</span>{q?.mock ? <span>demo</span> : null}</div>
              <div className="num text-sm text-text">{q ? fmtPrice(q.price, s === 'NATGAS' || s === 'COPPER' ? 3 : 2) : '—'}</div>
              <div className={`num text-[11px] ${q && q.changePct >= 0 ? 'text-up' : 'text-down'}`}>{q ? fmtPct(q.changePct) : ''}</div>
              {sp.length > 2 ? <svg viewBox="0 0 100 20" className="mt-1 h-4 w-full"><polyline fill="none" stroke={q && q.changePct >= 0 ? 'var(--up)' : 'var(--down)'} strokeWidth={1.2} points={sp.map((v, i) => `${(i / (sp.length - 1)) * 100},${20 - ((v - min) / (max - min || 1)) * 18 - 1}`).join(' ')} /></svg> : null}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

function cellColor(v: number) {
  const a = Math.min(1, Math.abs(v));
  return v >= 0 ? `color-mix(in oklab, var(--up) ${Math.round(a * 70)}%, transparent)` : `color-mix(in oklab, var(--down) ${Math.round(a * 70)}%, transparent)`;
}

export function CorrelationPanel() {
  const [win, setWin] = useState<'1d' | '1w' | '1m'>('1d');
  return (
    <IntelPanel<Record<string, CorrelationMatrix | null>> k="correlation" title="Correlation matrix" accent="var(--accent)" right={<Segmented label="Window" value={win} onChange={setWin} options={[{ value: '1d', label: '1d' }, { value: '1w', label: '1w' }, { value: '1m', label: '1m' }]} />}>
      {(all) => {
        const m = all[win];
        if (!m) return <p className="py-6 text-center text-[11px] text-faint">The {win} window builds up from stored daily closes.</p>;
        const n = m.symbols.length;
        return (
          <>
            <div className="overflow-x-auto">
              <div className="grid gap-px text-[9px]" style={{ gridTemplateColumns: `3.2rem repeat(${n}, minmax(1.6rem, 1fr))` }}>
                <span />
                {m.symbols.map((s) => <span key={s} className="truncate text-center text-faint">{s}</span>)}
                {m.symbols.map((a, i) => [
                  <span key={`r${a}`} className="truncate pr-1 text-right text-faint">{a}</span>,
                  ...m.symbols.map((b, j) => {
                    const v = m.values[i]?.[j] ?? 0;
                    const brk = m.breaks.some((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
                    return <span key={`${a}${b}`} title={`${a} / ${b}: ${v.toFixed(2)}`} className={`num grid h-6 place-items-center rounded-[3px] text-text ${brk ? 'ring-1 ring-warn' : ''}`} style={{ background: i === j ? 'var(--bg-2)' : cellColor(v), transition: 'background-color 900ms ease' }}>{i === j ? '' : v.toFixed(2).replace('0.', '.').replace('-.', '−.')}</span>;
                  }),
                ])}
              </div>
            </div>
            {m.breaks.length ? <div className="mt-2 space-y-0.5 text-[11px]"><div className="font-semibold text-warn">Correlation breaks</div>{m.breaks.slice(0, 3).map((b) => <div key={b.a + b.b} className="text-dim">{b.a} / {b.b}: {b.prior.toFixed(2)} → <span className="text-text">{b.now.toFixed(2)}</span></div>)}</div> : null}
          </>
        );
      }}
    </IntelPanel>
  );
}

export function RegimeDial({ score, size = 140 }: { score: number; size?: number }) {
  const angle = (score / 100) * 90; // −90° (risk-off) … +90° (risk-on)
  const r = size / 2 - 10;
  const cx = size / 2, cy = size / 2 + 4;
  const arc = (a0: number, a1: number) => {
    const p = (a: number) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0},${y0} A${r},${r} 0 0 1 ${x1},${y1}`;
  };
  return (
    <svg width={size} height={size / 2 + 16} viewBox={`0 0 ${size} ${size / 2 + 16}`} role="img" aria-label={`Regime score ${score}`}>
      <path d={arc(-90, -30)} stroke="var(--down)" strokeWidth={8} fill="none" opacity={0.7} />
      <path d={arc(-30, 30)} stroke="var(--text-faint)" strokeWidth={8} fill="none" opacity={0.5} />
      <path d={arc(30, 90)} stroke="var(--up)" strokeWidth={8} fill="none" opacity={0.7} />
      <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: `${cx}px ${cy}px`, transition: 'transform 900ms cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
        <line x1={cx} y1={cy} x2={cx} y2={cy - r + 6} stroke="var(--text)" strokeWidth={2.5} strokeLinecap="round" />
      </g>
      <circle cx={cx} cy={cy} r={4} fill="var(--text)" />
    </svg>
  );
}

export function RegimePanel() {
  return (
    <IntelPanel<RegimeState> k="regime" title="Risk regime" accent="var(--accent)">
      {(d) => (
        <>
          <div className="flex items-center gap-3">
            <RegimeDial score={d.score} />
            <div>
              <div className={`text-lg font-semibold capitalize ${d.label === 'risk-on' ? 'text-up' : d.label === 'risk-off' ? 'text-down' : 'text-text'}`}>{d.label}</div>
              <div className="num text-2xl text-text">{d.score > 0 ? '+' : ''}{d.score}</div>
            </div>
          </div>
          <div className="mt-1 flex h-6 items-end gap-px" aria-label="Regime history">
            {d.history.slice(-64).map((h) => <span key={h.t} className="flex-1 rounded-sm" style={{ height: `${Math.max(8, Math.abs(h.score))}%`, background: h.score >= 0 ? 'var(--up)' : 'var(--down)', opacity: 0.75 }} title={`${new Date(h.t).toLocaleString()}: ${h.score}`} />)}
          </div>
          <ul className="mt-2 space-y-0.5 text-[11px]">
            {d.components.map((c) => <li key={c.name} className="flex justify-between"><span className="text-dim">{c.name}</span><span className={`num ${c.contribution >= 0 ? 'text-up' : 'text-down'}`}>{c.contribution > 0 ? '+' : ''}{c.contribution}</span></li>)}
          </ul>
        </>
      )}
    </IntelPanel>
  );
}
