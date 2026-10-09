'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Chips } from '@/components/motion';
import { Copy, TokenIcon } from '@/components/ui';
import { CountUp, downloadPnlCard, money, PnlLine, Reveal, Ring, WalletAvatar } from '@/components/whoop';
import { api } from '@/lib/api';
import { ago, clock, short, usd } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

export default function WalletPage() {
  return <Suspense fallback={<p className="p-10 text-white/40">Loading…</p>}><WalletInner /></Suspense>;
}

function WalletInner() {
  const a = (useSearchParams().get('a') || '').trim();
  const now = useNow(10000);
  const [d, setD] = useState<any>(null);
  const [win, setWin] = useState<'7d' | '30d' | '1y'>('30d');
  const [hold, setHold] = useState<any>(null);
  const load = useCallback(async () => { if (a) await api(`/api/traders/${a}`).then(setD).catch(() => {}); }, [a]);
  useEffect(() => { load(); }, [load]);
  useLive(({ ch, data }) => { if (ch === 'trader_trade' && data.wallet === a) load(); });
  if (!a) return <p className="p-10 text-white/40">No wallet selected.</p>;
  if (!d) return <div className="space-y-3 pt-6">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-32" />)}</div>;
  const s = d.stats?.[win];
  const t = d.trader || {};
  const follow = () => api(`/api/traders/${a}/follow`, { method: 'POST', body: JSON.stringify({ on: !t.followed }) }).then(load);
  return (
    <div className="pt-4">
      <Reveal className="mb-10 flex flex-wrap items-center gap-6">
        <WalletAvatar address={a} size={84} />
        <div className="min-w-0">
          <div className="eyebrow mb-1">{s?.rank ? `Rank #${s.rank} · ${win}` : 'Not ranked in this window'}</div>
          <h1 className="display truncate text-[56px] md:text-[80px]">{t.label || short(a, 5)}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-white/50"><span className="font-mono">{a}</span><Copy text={a} label="Copy" />
            <a href={`https://solscan.io/account/${a}`} target="_blank" rel="noreferrer" className="hover:text-white">Solscan ↗</a>
            <a href={`https://gmgn.ai/sol/address/${a}`} target="_blank" rel="noreferrer" className="hover:text-white">GMGN ↗</a></div>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Chips id="ww" value={win} onChange={setWin} options={[{ value: '7d', label: '7D' }, { value: '30d', label: '30D' }, { value: '1y', label: '1Y' }]} />
          <button onClick={follow} className={t.followed ? 'btn-ghost !border-warn !text-warn' : 'btn-primary'}><Icon name="star" size={14} />{t.followed ? 'Following' : 'Follow'}</button>
          {s && <button onClick={() => downloadPnlCard({ title: t.label || short(a, 5), pnl: s.pnl_usd, roi: s.roi, winRate: s.win_rate, tokens: s.tokens, window: win, address: a, rank: s.rank, series: s.series })}
            className="btn-ghost"><Icon name="download" size={14} />P&L card</button>}
        </div>
      </Reveal>

      {s ? (
        <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
          <div className="glass rounded-[28px] p-6">
            <div className="eyebrow">Profit & loss · {win}</div>
            <div className={`stat mt-2 text-[88px] leading-none ${s.pnl_usd >= 0 ? 'text-up' : 'text-down'}`}><CountUp value={s.pnl_usd} format={(v) => money(v)} /></div>
            <div className="mt-2 text-[13px] text-white/50">{money(s.realized_usd)} realized · {money(s.unrealized_usd)} open · {money(s.invested_usd, false)} invested · {money(s.volume_usd, false)} volume</div>
            <div className="mt-6"><PnlLine series={s.series} h={180} /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="glass flex items-center justify-center rounded-[28px] p-6"><Ring value={s.win_rate} size={150} stroke={11} color="var(--color-up)" label="Win rate">
              <span className="stat text-[44px]">{s.win_rate != null ? `${Math.round(s.win_rate)}%` : '—'}</span><span className="text-[11px] text-white/40">{s.wins}/{s.wins + s.losses} closed</span></Ring></div>
            <div className="glass flex items-center justify-center rounded-[28px] p-6"><Ring value={Math.max(0, Math.min(200, (s.roi ?? 0) + 100))} max={200} size={150} stroke={11} color="var(--color-accent)" label="ROI">
              <span className="stat text-[40px]">{s.roi != null ? `${s.roi > 0 ? '+' : ''}${Math.round(s.roi)}%` : '—'}</span><span className="text-[11px] text-white/40">median {s.median_roi}%</span></Ring></div>
            {[['Coins', s.tokens], ['Trades', s.trades], ['Best trade', `${Math.round(s.best_roi)}%`], ['Avg hold', s.avg_hold_s ? `${Math.round(s.avg_hold_s / 60)}m` : '—']].map(([k, v]) => (
              <div key={k as string} className="glass rounded-3xl p-5"><div className="eyebrow">{k}</div><div className="stat mt-1 text-[40px]">{v}</div></div>
            ))}
          </div>
        </div>
      ) : <div className="glass rounded-3xl p-10 text-center text-white/50">Radar has no closed or priced trades for this wallet in {win} yet. Follow it to stream its trades live{' '}— add a Helius key to backfill its last year.</div>}

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <div className="glass overflow-hidden rounded-[28px]">
          <div className="flex items-center border-b border-white/[0.06] px-5 py-4"><span className="eyebrow !text-white">Positions</span><span className="ml-auto text-[11px] text-white/40">avg-cost P&L · only coins whose buys Radar saw</span></div>
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full text-[13px]">
              <thead className="eyebrow sticky top-0 bg-panel text-left [&>tr>th]:px-4 [&>tr>th]:py-2"><tr><th>Coin</th><th className="text-right">Invested</th><th className="text-right">Realized</th><th className="text-right">Open</th><th className="text-right">ROI</th><th>Last</th></tr></thead>
              <tbody>{d.positions.map((p: any) => (
                <tr key={p.mint} className="border-t border-white/[0.04] [&>td]:px-4 [&>td]:py-2.5">
                  <td><Link href={`/token?a=${p.mint}`} className="flex items-center gap-2"><TokenIcon src={p.image} symbol={p.symbol} size={22} /><b>{p.symbol || short(p.mint)}</b></Link></td>
                  <td className="text-right">{money(p.bu, false)}</td>
                  <td className={`text-right ${(p.realized_usd ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>{p.cost_basis_known ? money(p.realized_usd) : <span className="text-white/30" title="bought before Radar's coverage">n/a</span>}</td>
                  <td className="text-right">{p.unrealized_usd != null ? money(p.unrealized_usd) : '—'}</td>
                  <td className={`stat text-right text-[18px] ${(p.roi ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>{p.roi != null ? `${p.roi > 0 ? '+' : ''}${p.roi}%` : '—'}</td>
                  <td className="text-white/45">{ago(p.last, now)}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </div>
        <div className="glass overflow-hidden rounded-[28px]">
          <div className="flex items-center border-b border-white/[0.06] px-5 py-4"><span className="eyebrow !text-white">Trade history</span>
            <button onClick={() => api(`/api/wallet/${a}/holdings`).then(setHold).catch(() => setHold({ error: true }))} className="ml-auto text-[11px] uppercase tracking-[0.14em] text-white/50 hover:text-white">Load live holdings →</button></div>
          {hold && (
            <div className="border-b border-white/[0.06] p-4 text-[12px]">
              <div className="eyebrow mb-2">Holdings now (Solana RPC)</div>
              {hold.error ? <span className="text-down">Couldn’t read holdings.</span> : hold.holdings.slice(0, 12).map((h: any) => (
                <div key={h.mint} className="flex justify-between py-0.5"><Link href={`/token?a=${h.mint}`} className="font-semibold">{h.symbol || short(h.mint)}</Link><span className="text-white/60">{h.value_usd != null ? usd(h.value_usd) : `${h.amount.toLocaleString()} tokens`}</span></div>
              ))}
            </div>
          )}
          <div className="max-h-[520px] overflow-auto">
            {d.trades.map((tr: any) => (
              <div key={tr.id} className="flex items-center gap-3 border-t border-white/[0.04] px-5 py-2.5 text-[13px]">
                <span className="w-16 text-white/40">{clock(tr.ts)}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] ${tr.side === 'buy' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>{tr.side}</span>
                <Link href={`/token?a=${tr.mint}`} className="flex-1 truncate font-semibold">{tr.symbol || short(tr.mint)}</Link>
                <span className="text-white/40">{tr.source}</span>
                <span className="stat w-20 text-right text-[17px]">{money(tr.usd, false)}</span>
              </div>
            ))}
            {!d.trades.length && <p className="p-8 text-center text-white/40">No trades captured yet.</p>}
          </div>
        </div>
      </div>
      <p className="mt-6 text-[12px] text-white/35">Data sources for this wallet: {(t.sources || []).join(', ') || '—'}. History {t.backfill_done ? 'backfilled to 1 year' : t.backfill_oldest ? `backfilled to ${new Date(t.backfill_oldest * 1000).toLocaleDateString()}` : 'from live observation only'}.
        Profit numbers only use coins whose buys Radar observed; open positions are valued only where live market data exists.</p>
    </div>
  );
}
