'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Stat, useAction, VerdictBadge } from '@/components/radar';
import { Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, pct, pctClass, price } from '@/lib/format';
import { useNow } from '@/lib/live';

function StatsTable({ title, data }: { title: string; data: Record<string, any> }) {
  return (
    <Panel title={title}>
      <table className="w-full num text-[12px] [&_td]:pr-2">
        <thead className="bg-panel2 text-[11px] text-mute"><tr>{['', 'Trades', 'Hit rate', 'Avg', 'Median', 'Expectancy', 'Best', 'Worst', 'Max DD'].map((h) => <th key={h} className="px-2 py-1 text-left font-normal">{h}</th>)}</tr></thead>
        <tbody>{Object.entries(data || {}).map(([k, s]: [string, any]) => (
          <tr key={k} className="border-t border-line/50"><td className="px-2">{['BUY', 'WATCH', 'AVOID'].includes(k) ? <VerdictBadge v={k} /> : k}</td><td>{s.n}</td>
            <td>{s.n ? `${s.hit_rate}%` : '—'}</td><td className={pctClass(s.avg_return)}>{s.n ? pct(s.avg_return) : '—'}</td><td>{s.n ? pct(s.median_return) : '—'}</td>
            <td className={pctClass(s.expectancy)}>{s.n ? pct(s.expectancy) : '—'}</td><td>{s.n ? pct(s.best) : '—'}</td><td>{s.n ? pct(s.worst) : '—'}</td><td>{s.n ? `${s.max_drawdown_pct_pts}pts` : '—'}</td></tr>
        ))}</tbody>
      </table>
    </Panel>
  );
}

/** Cumulative paper return (sum of % per trade, in trade order), BUY only; hover shows each step. */
function Equity({ points }: { points: { ts: number; ret: number }[] }) {
  const [hi, setHi] = useState<number | null>(null);
  if (points.length < 2) return <p className="p-3 text-mute">Equity curve appears after 2+ BUY trades.</p>;
  let acc = 0;
  const cum = points.map((p) => (acc += p.ret));
  const w = 800, h = 160, min = Math.min(0, ...cum), max = Math.max(0, ...cum), span = max - min || 1;
  const x = (i: number) => (i / (cum.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / span) * (h - 10) - 5;
  return (
    <div className="relative p-2" onMouseLeave={() => setHi(null)}>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-40 w-full" preserveAspectRatio="none"
        onMouseMove={(e) => { const r = (e.currentTarget as SVGElement).getBoundingClientRect(); setHi(Math.round(((e.clientX - r.left) / r.width) * (cum.length - 1))); }}>
        <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="var(--color-line)" strokeWidth={1} />
        <polyline points={cum.map((v, i) => `${x(i)},${y(v)}`).join(' ')} fill="none" stroke="var(--color-accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {hi != null && <circle cx={x(hi)} cy={y(cum[hi])} r={4} fill="var(--color-accent)" stroke="var(--color-panel)" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
      </svg>
      {hi != null && <span className="absolute left-3 top-2 rounded bg-panel2 px-1 text-[11px] num">trade {hi + 1}: {pct(points[hi].ret)} · cumulative {pct(cum[hi])}</span>}
    </div>
  );
}

export default function ScorecardPage() {
  const now = useNow(5000);
  const [hours, setHours] = useState<string>('');
  const [sc, setSc] = useState<any>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [bt, setBt] = useState<any>(null);
  const [tune, setTune] = useState<any>(null);
  const [override, setOverride] = useState('{\n  "verdict": { "buy_min_score": 75 }\n}');
  const { run, Msg } = useAction();
  useEffect(() => {
    const load = () => { api(`/api/scorecard${hours ? `?hours=${hours}` : ''}`).then(setSc); api('/api/paper?limit=150').then(setTrades); };
    load(); const t = setInterval(load, 20000); return () => clearInterval(t);
  }, [hours]);
  if (!sc) return <p className="p-6 text-mute">Loading…</p>;
  const buy = sc.by_verdict?.BUY || { n: 0 };
  const good = buy.n >= 20 && buy.expectancy > 0;
  return (
    <div className="space-y-2 pt-2">
      <div className={`rounded border p-3 ${buy.n < 20 ? 'border-warn/50 bg-warn/5' : good ? 'border-up/50 bg-up/5' : 'border-down/50 bg-down/5'}`}>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-bold">Is it profitable on paper? <span className={buy.n < 20 ? 'text-warn' : good ? 'text-up' : 'text-down'}>{sc.verdict}</span></h1>
          <select value={hours} onChange={(e) => setHours(e.target.value)} className="ml-auto rounded border border-line bg-panel2 px-1">
            <option value="">all time</option><option value="24">24h</option><option value="72">3d</option><option value="168">7d</option>
          </select>
        </div>
        <p className="text-[11px] text-mute">Every signal is paper-traded with its own entry, TP ladder, stop and time stop, on the real price ticks Radar recorded. Includes open trades marked to market ({sc.open} open).</p>
      </div>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-7">
        <Stat k="BUY trades" v={buy.n} /><Stat k="BUY hit rate" v={buy.n ? `${buy.hit_rate}%` : '—'} />
        <Stat k="BUY avg return" v={buy.n ? pct(buy.avg_return) : '—'} cls={pctClass(buy.avg_return)} />
        <Stat k="BUY expectancy" v={buy.n ? pct(buy.expectancy) : '—'} cls={pctClass(buy.expectancy)} title="avg % per trade (wins and losses weighted)" />
        <Stat k="BUY max drawdown" v={buy.n ? `${buy.max_drawdown_pct_pts} pts` : '—'} />
        <Stat k="All signals" v={sc.overall?.n ?? 0} /><Stat k="Closed" v={sc.closed?.n ?? 0} />
      </div>
      <Panel title="BUY equity curve (cumulative % per $ staked)"><Equity points={(sc.equity || []).filter((e: any) => e.verdict === 'BUY')} /></Panel>
      <div className="grid gap-2 xl:grid-cols-3">
        <StatsTable title="By verdict" data={sc.by_verdict} /><StatsTable title="By score bucket" data={sc.by_bucket} /><StatsTable title="By narrative category" data={sc.by_category} />
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title="Backtest replay & weight tuning">
          <div className="space-y-2 p-2">
            <p className="text-[11px] text-mute">Replays every stored signal’s exact logged inputs through a modified config, then simulates on the stored price ticks.</p>
            <textarea value={override} onChange={(e) => setOverride(e.target.value)} rows={5} className="w-full rounded border border-line bg-panel2 p-2 font-mono text-[11px]" />
            <div className="flex flex-wrap gap-2">
              <button onClick={() => run(async () => setBt(await api('/api/backtest', { method: 'POST', body: JSON.stringify({ override: JSON.parse(override), hours: 168 }) })), 'Backtest done')} className="rounded bg-accent/20 px-3 py-1 text-accent">Run backtest (7d)</button>
              <button onClick={() => run(async () => setTune(await api('/api/tune', { method: 'POST', body: JSON.stringify({ hours: 168 }) })), 'Tuning done')} className="rounded border border-line px-3 py-1">Auto-tune weights</button>
              <Msg />
            </div>
            {bt && <StatsTable title={`Backtest · ${bt.simulated}/${bt.signals} signals simulated`} data={bt.by_verdict} />}
            {tune && (
              <div className="text-[12px]">
                <p className="text-mute">{tune.qualified}/{tune.tested} configs had ≥10 BUY trades. {tune.note}</p>
                {tune.best.map((b: any, i: number) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 border-t border-line/50 py-1 num">
                    <span>#{i + 1}</span><span>exp {pct(b.buy.expectancy)} · hit {b.buy.hit_rate}% · n {b.buy.n}</span>
                    <code className="text-[10px] text-mute">{JSON.stringify(b.override)}</code>
                    <button onClick={() => run(() => api('/api/settings/scoring', { method: 'POST', body: JSON.stringify(b.override) }), 'Applied to live scoring')} className="ml-auto text-accent">apply</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>
        <Panel title="Paper trades" className="max-h-[600px]">
          <table className="w-full num text-[12px]">
            <thead className="sticky top-0 bg-panel2 text-[11px] text-mute"><tr>{['Opened', 'Token', 'Verdict', 'Score', 'Entry', 'Last', 'Return', 'Exit'].map((h) => <th key={h} className="px-2 py-1 text-left font-normal">{h}</th>)}</tr></thead>
            <tbody>{trades.map((t) => (
              <tr key={t.id} className="border-t border-line/50"><td className="px-2 text-mute">{ago(t.opened, now)}</td>
                <td><Link href={`/token?a=${t.token_address}`} className="font-semibold">{t.symbol}</Link></td><td><VerdictBadge v={t.verdict} /></td><td>{t.score}</td>
                <td>{price(t.entry_price)}</td><td>{price(t.last_price)}</td><td className={pctClass(t.return_pct)}>{pct(t.return_pct)}</td><td className="text-mute">{t.exit_reason || 'open'}</td></tr>
            ))}</tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
