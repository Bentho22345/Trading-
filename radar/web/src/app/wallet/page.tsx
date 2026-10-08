'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Stat } from '@/components/radar';
import { AsOf, Copy, Panel, SafetyFlags, TokenIcon } from '@/components/ui';
import { WalletButton } from '@/components/WalletButton';
import { api } from '@/lib/api';
import { pct, pctClass, price, short, usd } from '@/lib/format';
import { useNow } from '@/lib/live';
import { useWallet } from '@/lib/wallet';

type Holding = {
  mint: string; amount: number; symbol?: string; name?: string; image?: string; price_usd?: number; chg_h24?: number;
  value_usd?: number | null; as_of?: number; liquidity_usd?: number; mint_authority?: string; freeze_authority?: string;
  rug_score?: number; rugged?: number; safety_as_of?: number; lp_locked_pct?: number; top10_pct?: number;
};
type Port = { address: string; sol: number | null; sol_usd: number | null; sol_value_usd: number | null; total_usd: number; holdings: Holding[]; as_of: number };

export default function WalletPage() {
  const now = useNow();
  const w = useWallet();
  const [d, setD] = useState<Port | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dust, setDust] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return api<Port>('/api/holdings').then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!w.address) { setD(null); return; }
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [w.address, load]);

  if (!w.address) {
    return (
      <div className="mx-auto mt-10 max-w-md text-center">
        <div className="glass rounded-3xl p-8">
          <div className="mb-2 text-[18px] font-semibold tracking-tight">Connect your wallet</div>
          <p className="mb-5 text-[13px] text-mute">See your SOL and token balances priced live, with Rug Shield warnings on anything you hold. Read-only: Radar never asks your wallet to sign.</p>
          <div className="flex justify-center"><WalletButton /></div>
        </div>
      </div>
    );
  }

  const rows = (d?.holdings || []).filter((h) => dust || (h.value_usd ?? 0) >= 1);
  const hidden = (d?.holdings.length || 0) - rows.length;
  const risky = d?.holdings.filter((h) => h.rugged || h.mint_authority || h.freeze_authority).length || 0;
  const best = d?.holdings.filter((h) => h.chg_h24 != null && (h.value_usd ?? 0) >= 1).sort((a, b) => (b.chg_h24 ?? 0) - (a.chg_h24 ?? 0))[0];

  return (
    <div className="space-y-2 pt-1">
      <div className="glass flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-mute">{w.via === 'address' ? 'Watching' : `Connected via ${w.via}`} · read-only</div>
          <div className="num flex items-center gap-2 truncate text-[13px] font-semibold">{short(w.address, 6)} <Copy text={w.address} label="Copy" />
            <a href={`https://solscan.io/account/${w.address}`} target="_blank" rel="noreferrer" className="text-[11px] font-normal text-accent hover:underline">Solscan</a></div>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-mute">Total value</div>
          <div className="num grad-text text-[26px] font-semibold leading-none">{d ? usd(d.total_usd, 2) : '…'}</div>
        </div>
        <button onClick={load} disabled={loading} className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-mute hover:text-fg disabled:opacity-50">{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>

      {err && <div className="rounded-xl border border-down/40 bg-down/10 p-2 text-[12px] text-down">{err}</div>}

      <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
        <Stat k="SOL" v={d?.sol != null ? `${d.sol.toLocaleString(undefined, { maximumFractionDigits: 4 })} · ${usd(d.sol_value_usd, 2)}` : '—'} />
        <Stat k="Tokens held" v={d ? String(d.holdings.length) : '—'} />
        <Stat k="Rug Shield flags" v={d ? String(risky) : '—'} cls={risky ? 'text-down' : 'text-up'} title="Held tokens that are rugged or still have mint/freeze authority" />
        <Stat k="Best 24h" v={best ? `${best.symbol || short(best.mint)} ${pct(best.chg_h24)}` : '—'} cls={pctClass(best?.chg_h24)} />
      </div>

      <Panel title="Holdings" right={<>
        {hidden > 0 && <button onClick={() => setDust(true)} className="text-accent">show {hidden} dust/unpriced</button>}
        {dust && <button onClick={() => setDust(false)} className="text-accent">hide dust</button>}
        {d && <AsOf ts={d.as_of} now={now} staleAfter={45} source="Solana RPC" />}
      </>}>
        <table className="w-full num text-[12px] [&_td]:whitespace-nowrap [&_td]:px-2">
          <thead className="bg-panel2 text-[11px] text-mute"><tr>{['Token', 'Amount', 'Price', '24h', 'Value', 'Share', 'Liq', 'Safety'].map((h) => <th key={h} className="px-2 py-1 text-left font-normal">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.mint} className="border-t border-line/50 hover:bg-white/[0.03]">
                <td className="px-2 py-1.5"><Link href={`/token?a=${h.mint}`} className="flex items-center gap-2"><TokenIcon src={h.image} symbol={h.symbol} />
                  <span className="font-semibold">{h.symbol || short(h.mint)}</span><span className="hidden truncate text-mute md:inline">{h.name}</span></Link></td>
                <td>{h.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                <td>{price(h.price_usd)}</td>
                <td className={pctClass(h.chg_h24)}>{pct(h.chg_h24)}</td>
                <td className="font-semibold">{usd(h.value_usd, 2)}</td>
                <td className="text-mute">{d?.total_usd && h.value_usd ? `${((h.value_usd / d.total_usd) * 100).toFixed(1)}%` : '—'}</td>
                <td className="text-mute">{usd(h.liquidity_usd)}</td>
                <td><SafetyFlags t={h} /></td>
              </tr>
            ))}
            {d && !rows.length && <tr><td colSpan={8} className="p-6 text-center text-mute">No priced SPL tokens in this wallet{hidden ? ' (only dust)' : ''}.</td></tr>}
            {!d && !err && <tr><td colSpan={8} className="p-6 text-center text-mute">Reading balances from Solana…</td></tr>}
          </tbody>
        </table>
      </Panel>
      <p className="px-1 text-[11px] text-mute">Held tokens are added to your watchlist so Rug Shield alerts you if liquidity is pulled or authorities change. Log trades on <Link href="/risk" className="text-accent">Risk</Link> for P&amp;L and stop alerts.</p>
    </div>
  );
}
