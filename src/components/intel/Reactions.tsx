'use client';
import { useMemo, useState } from 'react';
import type { Playbook, ReactionSeries, SurpriseIndex } from '@shared/v2';
import { baseRate } from '@shared/quant';
import { useIntel, useDocs } from '@/lib/v2';
import { IntelPanel, setDemo } from './shell';

export function ReactionsPanel() {
  const [idx, setIdx] = useState(0);
  const [asset, setAsset] = useState<string>('');
  const [win, setWin] = useState<'m5' | 'm30' | 'd1'>('m30');
  const surprise = useIntel<SurpriseIndex[]>('surprise');
  const playbooks = useDocs<Playbook>('playbooks');
  return (
    <IntelPanel<ReactionSeries[]> k="reactions" title="Historical reaction analyzer" accent="var(--macro)" right={<button onClick={() => void setDemo('reactions', true)} className="text-[10px] text-faint hover:text-text">demo</button>}>
      {(list) => {
        const s = list[Math.min(idx, list.length - 1)];
        const assets = [...new Set(s.rows.flatMap((r) => Object.keys(r.moves)))];
        const a = asset && assets.includes(asset) ? asset : assets[0];
        const pts = s.rows.map((r) => ({ x: r.surprise, y: r.moves[a]?.[win] })).filter((p): p is { x: number; y: number } => p.x !== null && p.y !== undefined);
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        const mx = Math.max(1e-9, ...xs.map(Math.abs)), my = Math.max(1e-9, ...ys.map(Math.abs));
        const pb = playbooks.find((p) => s.series.includes(p.eventMatch.toLowerCase()) || p.eventMatch.toLowerCase().split(' ').every((w) => s.series.includes(w)));
        const thresholds = (pb?.scenarios ?? []).map((sc) => sc.condition.value).filter((v) => Math.abs(v) <= mx * 1.2);
        const thr = Math.abs(thresholds[0] ?? (mx / 3));
        const br = baseRate(s.rows.map((r) => ({ surprise: r.surprise, move: r.moves[a]?.[win] })), thr, 'beat');
        return (
          <>
            <div className="mb-2 flex flex-wrap gap-1.5">
              <select className="rounded-md border border-line bg-bg-2 px-1.5 py-0.5 text-[11px] text-text" value={idx} onChange={(e) => setIdx(Number(e.target.value))}>{list.map((x, i) => <option key={x.series + x.currency} value={i}>{x.currency} {x.series}</option>)}</select>
              <select className="rounded-md border border-line bg-bg-2 px-1.5 py-0.5 text-[11px] text-text" value={a} onChange={(e) => setAsset(e.target.value)}>{assets.map((x) => <option key={x}>{x}</option>)}</select>
              <select className="rounded-md border border-line bg-bg-2 px-1.5 py-0.5 text-[11px] text-text" value={win} onChange={(e) => setWin(e.target.value as typeof win)}><option value="m5">5m</option><option value="m30">30m</option><option value="d1">1d</option></select>
              {s.demo ? <span className="rounded border border-accent/40 px-1 text-[10px] text-accent">demo history</span> : null}
            </div>
            <svg viewBox="0 0 260 150" className="w-full" role="img" aria-label="Surprise vs reaction scatter">
              <line x1="130" y1="5" x2="130" y2="145" stroke="var(--border)" /><line x1="5" y1="75" x2="255" y2="75" stroke="var(--border)" />
              {thresholds.map((t) => <line key={t} x1={130 + (t / mx) * 120} x2={130 + (t / mx) * 120} y1="5" y2="145" stroke="var(--warn)" strokeDasharray="3 3" />)}
              {pts.map((p, i) => <circle key={i} cx={130 + (p.x / mx) * 120} cy={75 - (p.y / my) * 65} r={3.5} fill={p.y >= 0 ? 'var(--up)' : 'var(--down)'} opacity={0.8} />)}
              <text x="250" y="72" textAnchor="end" fontSize="8" fill="var(--text-faint)">surprise →</text><text x="134" y="12" fontSize="8" fill="var(--text-faint)">{a} {win}</text>
            </svg>
            <p className="mt-1 text-[11px] text-dim">{br.n ? <>When {s.series} beat by &gt;{+thr.toFixed(3)}, <span className="text-text">{a}</span> rose in the first {win === 'd1' ? 'day' : win.slice(1) + 'm'} <span className="num font-semibold text-text">{br.up} of {br.n}</span> times.</> : 'Not enough beats above the threshold yet.'}{pb ? ` Thresholds from “${pb.name}”.` : ''}</p>
            {surprise?.data?.length ? (
              <div className="mt-2 border-t border-line pt-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Economic surprise index</div>
                {surprise.data.map((r) => { const v = r.series.map((x) => x.v); const min = Math.min(...v, 0), max = Math.max(...v, 0); return (
                  <div key={r.region} className="flex items-center gap-2 text-[11px]"><span className="w-16 text-dim">{r.region}</span><svg viewBox="0 0 100 18" className="h-4 flex-1"><line x1="0" x2="100" y1={17 - ((0 - min) / (max - min || 1)) * 16} y2={17 - ((0 - min) / (max - min || 1)) * 16} stroke="var(--border)" /><polyline fill="none" stroke="var(--macro)" strokeWidth={1.2} points={v.map((x, i) => `${(i / Math.max(1, v.length - 1)) * 100},${17 - ((x - min) / (max - min || 1)) * 16}`).join(' ')} /></svg><span className={`num w-10 text-right ${r.value >= 0 ? 'text-up' : 'text-down'}`}>{r.value.toFixed(1)}</span></div>
                ); })}
              </div>
            ) : null}
          </>
        );
      }}
    </IntelPanel>
  );
}
