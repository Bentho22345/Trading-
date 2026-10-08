'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAction } from '@/components/radar';
import { Chips } from '@/components/motion';
import { Copy, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, pct, pctClass, short, usd } from '@/lib/format';
import { useNow } from '@/lib/live';

type Period = '1d' | '7d' | '30d';
type Source = 'radar' | 'birdeye';
type ExtPeriod = 'today' | 'yesterday' | '7d' | 'hot_tokens';
type Sort = 'roi' | 'pnl';
const PAGE = 100;

const sol = (v?: number | null, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);

export default function TopWalletsPage() {
  const now = useNow();
  const [source, setSource] = useState<Source>('radar');
  const [extPeriod, setExtPeriod] = useState<ExtPeriod>('today');
  const [period, setPeriod] = useState<Period>('1d');
  const [sort, setSort] = useState<Sort>('roi');
  const [bots, setBots] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [d, setD] = useState<any>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const { run, Msg } = useAction();
  const load = useCallback(() => {
    const q = source === 'radar' ? `period=${period}&sort=${sort}&include_bots=${bots}` : `source=${source}&period=${extPeriod}`;
    api(`/api/leaderboard?${q}&limit=${limit}`).then(setD).catch(() => {});
  }, [source, extPeriod, period, sort, limit, bots]);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  useEffect(() => { setDetail(null); if (open) api(`/api/leaderboard/wallet/${open}`).then(setDetail).catch(() => {}); }, [open]);
  const rows: any[] = d?.rows || [];
  const days = d?.observing_since ? (now - d.observing_since) / 86400 : 0;
  const need = period === '30d' ? 30 : period === '7d' ? 7 : 1;
  const follow = (w: string) => run(() => api('/api/wallets', { method: 'POST', body: JSON.stringify({ address: w, kind: 'smart' }) }), 'Following with smart-money alerts').then(load);

  return (
    <div className="space-y-3 pt-2">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-[18px] font-semibold tracking-tight">Top wallets</h1>
          <p className="text-[12px] text-mute">Ranked by realized return on every pump.fun trade Radar has observed. The top {d?.followed ?? '—'} are streamed live.</p>
        </div>
        <Chips id="source" value={source} onChange={(v) => { setSource(v); setLimit(PAGE); setD(null); }} options={[{ value: 'radar', label: 'Radar ledger' }, { value: 'birdeye', label: 'Birdeye' }]} />
        {source === 'birdeye' ? (
          <Chips id="extp" value={extPeriod} onChange={(v) => { setExtPeriod(v); setLimit(PAGE); }} options={[{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: '7d', label: '7d' }, { value: 'hot_tokens', label: 'Hot coins' }]} />
        ) : <>
        <Chips id="period" value={period} onChange={(v) => { setPeriod(v); setLimit(PAGE); }} options={[{ value: '1d', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]} />
        <Chips id="sort" value={sort} onChange={(v) => { setSort(v); setLimit(PAGE); }} options={[{ value: 'roi', label: 'Return %' }, { value: 'pnl', label: 'Profit (SOL)' }]} />
        <label className="flex items-center gap-1 text-[12px] text-mute"><input type="checkbox" checked={bots} onChange={(e) => setBots(e.target.checked)} /> show bots</label>
        </>}
        <button onClick={() => run(() => api('/api/leaderboard/refresh', { method: 'POST' }).then((r) => `Ranked ${r.ranked[period]} wallets`)).then(load)} className="rounded-lg border border-white/10 px-3 py-1 text-[12px]">Refresh now</button>
        <Msg />
      </div>
      {source === 'birdeye' && !d?.total && (
        <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-mute">
          No Birdeye data yet. Add your Birdeye API key on the <Link href="/connectors" className="text-accent">Connectors</Link> page. Radar then pulls Birdeye's top Solana traders (today, yesterday, 7d) and the top traders of the hottest coins every hour, and follows the best 300 live.
        </p>
      )}
      {source === 'radar' && days < need && (
        <p className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          Radar has been watching for {days < 1 ? `${Math.round(days * 24)}h` : `${days.toFixed(1)} days`}, so this {period} ranking covers only that much history until it fills in.
        </p>
      )}
      <div className="grid gap-3 xl:grid-cols-[1fr_420px]">
        {source === 'birdeye' ? (
        <Panel title={`Birdeye · ${extPeriod.replace('_', ' ')} · ${d?.total ?? 0} traders`} right={d?.as_of ? <>updated {ago(d.as_of, now)} ago</> : 'not pulled yet'}>
          <table className="w-full num text-[12px]">
            <thead className="sticky top-0 bg-panel2 text-[11px] text-mute">
              <tr>{['#', 'Wallet', extPeriod === 'hot_tokens' ? 'Coin' : 'P&L (USD)', 'Volume', 'Trades', 'Radar 30d', ''].map((h) => <th key={h} className="px-2 py-1 text-left font-normal">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.wallet} onClick={() => setOpen(r.wallet === open ? null : r.wallet)} className={`cursor-pointer border-t border-line/50 hover:bg-white/[0.03] ${open === r.wallet ? 'bg-white/[0.05]' : ''}`}>
                  <td className="px-2 text-mute">{r.rank}</td>
                  <td className="px-2">{short(r.wallet, 5)}{r.followed ? <span className="ml-1 text-up" title="Streamed live">●</span> : null}</td>
                  <td className={extPeriod === 'hot_tokens' ? '' : pctClass(r.pnl_usd)}>{extPeriod === 'hot_tokens' ? (r.token_symbol || short(r.token)) : usd(r.pnl_usd)}</td>
                  <td>{usd(r.volume_usd)}</td>
                  <td>{r.trades ?? '—'}</td>
                  <td className={pctClass(r.radar_roi_30d)}>{r.radar_roi_30d != null ? pct(r.radar_roi_30d * 100) : '—'}</td>
                  <td className="px-2 text-right">{r.tracked ? <span className="text-mute">alerts on</span> : <button onClick={(e) => { e.stopPropagation(); follow(r.wallet); }} className="text-accent">alerts</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        ) : (
        <Panel title={`${period} · ${d?.total ?? 0} ranked of ${d?.wallets_seen ?? 0} wallets seen`} right={d?.as_of ? <>updated {ago(d.as_of, now)} ago</> : 'not ranked yet'}>
          <table className="w-full num text-[12px]">
            <thead className="sticky top-0 bg-panel2 text-[11px] text-mute">
              <tr>{['#', 'Wallet', 'Return', 'Realized', 'Cost closed', 'Open P&L', 'Win rate', 'Trades', ''].map((h) => <th key={h} className="px-2 py-1 text-left font-normal">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.wallet} onClick={() => setOpen(r.wallet === open ? null : r.wallet)} className={`cursor-pointer border-t border-line/50 hover:bg-white/[0.03] ${open === r.wallet ? 'bg-white/[0.05]' : ''}`}>
                  <td className="px-2 text-mute">{r.rank ?? '—'}</td>
                  <td className="px-2">{r.label || short(r.wallet, 5)}{r.bot ? <span className="ml-1 rounded bg-warn/20 px-1 text-[10px] text-warn">BOT</span> : null}{r.followed ? <span className="ml-1 text-up" title="Streamed live">●</span> : null}{r.external?.length ? <span className="ml-1 rounded bg-accent/15 px-1 text-[10px] text-accent" title={r.external.join(', ')}>BIRDEYE</span> : null}</td>
                  <td className={pctClass(r.roi)}>{pct(r.roi != null ? r.roi * 100 : null)}</td>
                  <td className={pctClass(r.realized_sol)}>{sol(r.realized_sol)} SOL</td>
                  <td>{r.basis_sol?.toFixed(2)}</td>
                  <td className={pctClass(r.unrealized_sol)} title={r.unpriced_cost_sol ? `${r.unpriced_cost_sol.toFixed(2)} SOL in tokens with no price` : ''}>{sol(r.unrealized_sol)}</td>
                  <td>{r.win_rate != null ? `${Math.round(r.win_rate * 100)}%` : '—'}</td>
                  <td>{r.trades}</td>
                  <td className="px-2 text-right">{r.tracked ? <span className="text-mute">alerts on</span> : <button onClick={(e) => { e.stopPropagation(); follow(r.wallet); }} className="text-accent">alerts</button>}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={9} className="p-4 text-center text-mute">No wallet qualifies yet. A wallet needs enough closed trades in the window; rankings rebuild every 5 minutes.</td></tr>}
            </tbody>
          </table>
          {rows.length >= limit && limit < 1000 && <button onClick={() => setLimit(Math.min(1000, limit + PAGE * 2))} className="w-full border-t border-line/50 py-2 text-[12px] text-accent">Show more</button>}
        </Panel>
        )}
        <Panel title={open ? <>Wallet {short(open, 6)}</> : 'Wallet detail'} right={open && <><Copy text={open} label="Copy" /><a href={`https://solscan.io/account/${open}`} target="_blank" rel="noreferrer" className="hover:text-accent">Solscan ↗</a></>} className="xl:sticky xl:top-2 xl:max-h-[calc(100vh-24px)]">
          {!open && <p className="p-4 text-[12px] text-mute">Pick a wallet to see its daily P&L and positions.</p>}
          {open && detail && (
            <div className="space-y-3 p-2 text-[12px] num">
              <div className="grid grid-cols-3 gap-2">
                {(['1d', '7d', '30d'] as const).map((p) => { const x = detail.ranks[p]; return (
                  <div key={p} className="rounded-xl border border-white/5 bg-white/[0.03] p-2">
                    <div className="text-[10px] text-mute">{p} rank</div>
                    <div className="text-[15px] font-semibold">{x?.rank_roi ? `#${x.rank_roi}` : '—'}</div>
                    <div className={pctClass(x?.roi)}>{pct(x?.roi != null ? x.roi * 100 : null)}</div>
                  </div>); })}
              </div>
              <div>
                <div className="mb-1 text-[11px] text-mute">Daily realized P&L (SOL)</div>
                <DailyBars days={detail.days} />
              </div>
              <table className="w-full">
                <thead className="text-[11px] text-mute"><tr>{['Token', 'Realized', 'Open P&L', 'Last'].map((h) => <th key={h} className="py-1 text-left font-normal">{h}</th>)}</tr></thead>
                <tbody>
                  {detail.positions.map((p: any) => (
                    <tr key={p.mint} className="border-t border-line/50">
                      <td className="py-0.5"><Link href={`/token?a=${p.mint}`} className="font-semibold hover:text-accent">{p.symbol || short(p.mint)}</Link></td>
                      <td className={pctClass(p.realized_sol)}>{sol(p.realized_sol)}</td>
                      <td className={pctClass(p.unrealized_sol)}>{p.qty > 0 ? sol(p.unrealized_sol) : 'closed'}</td>
                      <td className="text-mute">{ago(p.last_ts, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
      <p className="text-[11px] text-mute">Return = realized P&L ÷ cost basis of tokens sold (average cost). Sells of tokens bought before Radar was watching are never counted as profit.
        Open P&L marks held tokens at their current price. Trades come from pump.fun (PumpPortal, live) and the hottest PumpSwap, Raydium and Meteora pools (GeckoTerminal), plus every trade by followed wallets.
        Birdeye's own leaderboards need your Birdeye key. pump.fun, Axiom, GMGN, Photon, BullX and DexScreener's Top traders tab have no public API for trader data, so they can't be pulled.</p>
    </div>
  );
}

function DailyBars({ days }: { days: any[] }) {
  if (!days.length) return <p className="text-mute">No closed trades yet.</p>;
  const max = Math.max(...days.map((x) => Math.abs(x.realized_sol)), 1e-9);
  return (
    <div className="flex h-20 items-center gap-px">
      {days.slice(-30).map((x) => (
        <div key={x.ts} className="flex h-full flex-1 flex-col justify-center" title={`${new Date(x.ts * 1000).toLocaleDateString()}: ${sol(x.realized_sol, 3)} SOL`}>
          <div className={x.realized_sol >= 0 ? 'bg-up' : 'bg-down'} style={{ height: `${(Math.abs(x.realized_sol) / max) * 50}%`, transform: x.realized_sol >= 0 ? 'translateY(-50%)' : 'translateY(50%)' }} />
        </div>
      ))}
    </div>
  );
}
