'use client';
import type { Auction } from '@shared/v2';
import { useStore } from '@/lib/store';
import { useIntel } from '@/lib/v2';
import { fmtBp } from '@/lib/format';
import { Panel, DelayChip } from '../ui';
import { CadenceChip, ConnectState } from './shell';
import { DrawSpark } from '../brief/bits';

const CURVE = [['US2Y', '2Y', 2], ['US5Y', '5Y', 5], ['US10Y', '10Y', 10], ['US30Y', '30Y', 30]] as const;
const GLOBAL = [['US10Y', 'UST'], ['DE10Y', 'Bund'], ['GB10Y', 'Gilt'], ['JP10Y', 'JGB'], ['FR10Y', 'OAT'], ['IT10Y', 'BTP']] as const;

function CurveChart({ now, prev }: { now: (number | null)[]; prev: (number | null)[] }) {
  const all = [...now, ...prev].filter((v): v is number => v !== null);
  if (all.length < 2) return <div className="skeleton h-24" />;
  const min = Math.min(...all) - 0.05, max = Math.max(...all) + 0.05;
  const W = 300, H = 90;
  const xs = CURVE.map(([, , y]) => (Math.log(y) - Math.log(2)) / (Math.log(30) - Math.log(2)));
  const pt = (v: number, i: number) => `${(xs[i] * (W - 30) + 15).toFixed(1)},${(H - 12 - ((v - min) / (max - min)) * (H - 24)).toFixed(1)}`;
  const path = (vals: (number | null)[]) => vals.map((v, i) => (v === null ? null : pt(v, i))).filter(Boolean).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" role="img" aria-label="US Treasury curve, now vs yesterday">
      <polyline points={path(prev)} fill="none" stroke="var(--text-faint)" strokeWidth={1.2} strokeDasharray="3 3" opacity={0.7} />
      <polyline points={path(now)} fill="none" stroke="var(--rates)" strokeWidth={2} strokeLinejoin="round" className="ease-value" />
      {now.map((v, i) => (v === null ? null : <g key={i}><circle cx={pt(v, i).split(',')[0]} cy={pt(v, i).split(',')[1]} r={3} fill="var(--rates)" /><text x={pt(v, i).split(',')[0]} y={H - 1} textAnchor="middle" fontSize={9} fill="var(--text-faint)">{CURVE[i][1]}</text></g>))}
    </svg>
  );
}

export function RatesPanel() {
  const quotes = useStore((s) => s.quotes);
  const real = useIntel<{ id: string; label: string; value: number | null; prev: number | null; date: string; spark: number[] }[]>('realYields');
  const auctions = useIntel<Auction[]>('auctions');
  const q = (s: string) => quotes[s];
  const now = CURVE.map(([s]) => q(s)?.price ?? null), prev = CURVE.map(([s]) => q(s)?.ref ?? null);
  const spread = (a: string, b: string) => {
    const qa = q(a), qb = q(b);
    if (!qa || !qb) return null;
    const cur = (qb.price - qa.price) * 100, then = (qb.ref - qa.ref) * 100;
    return { cur, chg: cur - then };
  };
  const s210 = spread('US2Y', 'US10Y'), s530 = spread('US5Y', 'US30Y'), btp = spread('DE10Y', 'IT10Y');
  const delay = Math.max(0, ...CURVE.map(([s]) => q(s)?.delayedMin ?? 0));
  const label = (chg: number) => (Math.abs(chg) < 0.5 ? 'unch' : chg > 0 ? 'steepening' : 'flattening');
  return (
    <Panel title="Rates & yields" accent="var(--rates)" right={<DelayChip min={delay} />}>
      <CurveChart now={now} prev={prev} />
      <div className="mb-3 flex justify-between text-[10px] text-faint"><span>— now</span><span>┄ vs previous close</span></div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        {([['2s10s', s210], ['5s30s', s530]] as const).map(([n, s]) => (
          <div key={n} className="rounded-lg border border-line px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-faint">{n}</div>
            {s ? <><div className="num text-sm text-text">{s.cur.toFixed(1)}bp</div><div className={`num text-[10px] ${s.chg >= 0 ? 'text-up' : 'text-down'}`}>{s.chg >= 0 ? '+' : ''}{s.chg.toFixed(1)}bp · {label(s.chg)}</div></> : <div className="text-faint">—</div>}
          </div>
        ))}
      </div>
      <div className="mt-3">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Global 10Y</div>
        <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
          {GLOBAL.map(([s, n]) => { const x = q(s); return <div key={s} className="flex justify-between"><span className="text-dim">{n}</span><span className="num text-text">{x ? x.price.toFixed(2) : '—'} <span className={x && x.change >= 0 ? 'text-up' : 'text-down'}>{x ? fmtBp(x.change) : ''}</span></span></div>; })}
        </div>
        {btp ? <div className="mt-1 text-[11px] text-dim">BTP–Bund <span className="num text-text">{btp.cur.toFixed(0)}bp</span> <span className={btp.chg >= 0 ? 'text-down' : 'text-up'}>{btp.chg >= 0 ? '+' : ''}{btp.chg.toFixed(1)}</span></div> : null}
      </div>
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-faint">Real yields & breakevens {real ? <CadenceChip b={real} /> : null}</div>
        {!real ? <div className="skeleton h-10" /> : !real.connected ? <ConnectState k="realYields" text={real.note ?? 'Add a FRED key.'} /> : (
          <div className="space-y-1">{(real.data ?? []).map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2 text-xs"><span className="text-dim">{r.label}</span><DrawSpark data={r.spark} up={(r.value ?? 0) >= (r.prev ?? 0)} width={60} height={16} /><span className="num text-text">{r.value?.toFixed(2) ?? '—'}%</span></div>
          ))}</div>
        )}
      </div>
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-faint">Treasury auctions {auctions ? <CadenceChip b={auctions} /> : null}</div>
        {!auctions?.data?.length ? <p className="text-[11px] text-faint">{auctions?.note ?? 'Loading auction calendar…'}</p> : (
          <ul className="space-y-1 text-[11px]">
            {auctions.data.slice(0, 7).map((a) => (
              <li key={a.id} className={`flex items-center justify-between gap-2 ${a.status === 'result' ? 'fade-in' : ''}`}>
                <span className="text-dim"><span className="num text-faint">{a.date.slice(5)}</span> {a.term} {a.security}</span>
                {a.status === 'upcoming' ? <span className="text-faint">{a.offering ? `$${(a.offering / 1e9).toFixed(0)}B` : 'upcoming'}</span>
                  : <span className="num text-text">{a.highYield?.toFixed(3) ?? '—'}% · b/c {a.bidToCover?.toFixed(2) ?? '—'}{a.tail !== null ? <span className={a.tail > 0 ? ' text-down' : ' text-up'}> · {a.tail > 0 ? `tail ${a.tail}bp` : `stop-thru ${-a.tail}bp`}</span> : null}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
