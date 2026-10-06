'use client';
import type { CotRow, Filing } from '@shared/v2';
import { useIntel } from '@/lib/v2';
import { fmtCompact } from '@/lib/format';
import { IntelPanel, CadenceChip, ConnectState, setDemo } from './shell';

type Flows = { stablecoins?: { total: number; change1d: number; change7d: number } | null; etfFlows?: { asset: string; d1: number; d7: number }[] | null; netflows?: { asset: string; d1: number }[] | null; unlocks?: { token: string; date: string; usd: number }[] | null };

export function PositioningPanel() {
  const flows = useIntel<Flows>('cryptoFlows');
  const filings = useIntel<Filing[]>('filings');
  const form4 = (filings?.data ?? []).filter((f) => f.form === '4').slice(0, 5);
  return (
    <IntelPanel<CotRow[]> k="cot" title="Positioning & flows" accent="var(--cmdty)">
      {(rows) => (
        <>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">CFTC net speculative · percentile vs 3y</div>
          <ul className="space-y-1 text-[11px]">
            {rows.map((r) => (
              <li key={r.symbol} className="grid grid-cols-[4.5rem_1fr_3.6rem_2.6rem] items-center gap-2">
                <span className="truncate text-dim" title={r.market}>{r.symbol}</span>
                <span className="relative h-2 rounded-full bg-bg-2"><span className="absolute top-0 h-2 rounded-full bg-cmdty/70" style={{ left: 0, width: `${r.pct3y}%` }} /><span className="absolute -top-0.5 h-3 w-px bg-text" style={{ left: '50%' }} /></span>
                <span className={`num text-right ${r.net >= 0 ? 'text-up' : 'text-down'}`}>{fmtCompact(r.net)}</span>
                <span className="num text-right text-faint">{r.pct3y}%</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 border-t border-line pt-2">
            <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-faint">Crypto flows {flows ? <CadenceChip b={flows} /> : null}</div>
            {flows?.data ? (
              <div className="space-y-1 text-[11px]">
                {flows.data.stablecoins ? <div className="flex justify-between"><span className="text-dim">Stablecoin supply</span><span className="num text-text">${fmtCompact(flows.data.stablecoins.total)} <span className={flows.data.stablecoins.change7d >= 0 ? 'text-up' : 'text-down'}>{flows.data.stablecoins.change7d >= 0 ? '+' : ''}{fmtCompact(flows.data.stablecoins.change7d)} 7d</span></span></div> : null}
                {flows.data.etfFlows ? flows.data.etfFlows.map((f) => <div key={f.asset} className="flex justify-between"><span className="text-dim">Spot {f.asset} ETF flows</span><span className={`num ${f.d1 >= 0 ? 'text-up' : 'text-down'}`}>{f.d1 >= 0 ? '+' : ''}${fmtCompact(f.d1)} 1d</span></div>)
                  : <button onClick={() => void setDemo('cryptoFlows', true)} className="text-faint underline">ETF flows, netflows & unlocks need a provider — preview demo data</button>}
                {flows.data.netflows?.map((f) => <div key={f.asset} className="flex justify-between"><span className="text-dim">{f.asset} exchange netflow</span><span className={`num ${f.d1 <= 0 ? 'text-up' : 'text-down'}`}>{f.d1 > 0 ? '+' : ''}{fmtCompact(f.d1)}</span></div>)}
                {flows.data.unlocks?.length ? <div className="text-dim">Unlocks: {flows.data.unlocks.map((u) => `${u.token} ${u.date.slice(5)} ($${fmtCompact(u.usd)})`).join(' · ')}</div> : null}
              </div>
            ) : flows && !flows.connected ? <ConnectState k="cryptoFlows" text={flows.note ?? 'Connect a provider'} /> : <div className="skeleton h-10" />}
          </div>
          <div className="mt-3 border-t border-line pt-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Insider filings (Form 4)</div>
            {form4.length ? form4.map((f) => <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer" className={`block truncate text-[11px] text-dim hover:text-text ${f.watch ? 'relevant pl-1.5' : ''}`}>{f.watch ? '📌 ' : ''}{f.ticker} · {f.company}</a>) : <p className="text-[11px] text-faint">No recent Form 4s for your names.</p>}
            <p className="mt-1 text-[10px] text-faint">Short interest needs a paid provider.</p>
          </div>
        </>
      )}
    </IntelPanel>
  );
}
