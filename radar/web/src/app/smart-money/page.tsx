'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAction } from '@/components/radar';
import { Copy, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, clock, short } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

export default function SmartMoneyPage() {
  const now = useNow();
  const [wallets, setWallets] = useState<any[]>([]);
  const [trades, setTrades] = useState<any[]>([]);
  const [form, setForm] = useState({ address: '', kind: 'kol', label: '', handle: '' });
  const { run, Msg } = useAction();
  const load = useCallback(() => { api('/api/wallets?limit=300').then(setWallets); api('/api/wallet-trades?limit=200').then(setTrades); }, []);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  useLive(({ ch, data }) => { if (ch === 'wallet_trade') setTrades((t) => [{ ...data, symbol: data.symbol }, ...t].slice(0, 300)); });
  const inp = 'rounded border border-line bg-panel2 px-2 py-1 outline-none focus:border-accent';
  return (
    <div className="grid gap-2 pt-2 xl:grid-cols-[1fr_460px]">
      <div className="space-y-2">
        <Panel title="Add a wallet to follow (read-only)">
          <form className="flex flex-wrap gap-2 p-2" onSubmit={(e) => { e.preventDefault(); run(() => api('/api/wallets', { method: 'POST', body: JSON.stringify(form) }), 'Following').then(load); }}>
            <input required placeholder="Public Solana address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value.trim() })} className={`${inp} min-w-0 flex-[2_1_260px]`} />
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className={inp}><option value="kol">KOL</option><option value="smart">Smart money</option></select>
            <input placeholder="Label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} className={`${inp} w-32`} />
            <input placeholder="X/Telegram handle (for shill-and-dump)" value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value })} className={`${inp} w-56`} />
            <button className="rounded bg-accent/20 px-3 text-accent">Follow</button>
            <button type="button" onClick={() => run(() => api('/api/wallets/discover', { method: 'POST' }).then((r) => `Discovery done: ${r.tracked} wallets tracked`)).then(load)} className="rounded border border-line px-3">Run discovery now</button>
            <Msg />
          </form>
          <p className="px-2 pb-2 text-[11px] text-mute">Discovery runs every 10 min: wallets that bought in the first 15 minutes of tokens that later ran ≥3x, across ≥3 tokens, scored on win rate and average multiple.
            Live buys/sells stream via PumpPortal account subscriptions (plus Helius swap history when connected).</p>
        </Panel>
        <Panel title={`Wallets · ${wallets.filter((w) => w.tracked).length} followed`}>
          <table className="w-full num text-[12px]">
            <thead className="bg-panel2 text-[11px] text-mute"><tr>{['Wallet', 'Kind', 'Score', 'Wins/Losses', 'Avg multiple', 'Avg hold', 'Last trade', ''].map((h) => <th key={h} className="px-2 py-1 text-left font-normal">{h}</th>)}</tr></thead>
            <tbody>
              {wallets.map((w) => (
                <tr key={w.address} className="border-t border-line/50">
                  <td className="px-2"><a href={`https://solscan.io/account/${w.address}`} target="_blank" rel="noreferrer" className="hover:text-accent">{w.label || short(w.address, 5)}</a>{w.handle && <span className="ml-1 text-mute">@{w.handle}</span>}</td>
                  <td className={w.kind === 'kol' ? 'text-flash' : ''}>{w.kind}</td><td>{w.score ?? '—'}</td><td>{w.wins ?? 0}/{w.losses ?? 0}</td>
                  <td>{w.avg_multiple ? `${w.avg_multiple}x` : '—'}</td><td>{w.avg_hold_s ? `${Math.round(w.avg_hold_s / 60)}m` : '—'}</td>
                  <td className="text-mute">{ago(w.last_trade, now)}</td>
                  <td className="px-2 text-right">{w.tracked ? <button onClick={() => api(`/api/wallets/${w.address}`, { method: 'DELETE' }).then(load)} className="text-mute hover:text-down">unfollow</button>
                    : <button onClick={() => api('/api/wallets', { method: 'POST', body: JSON.stringify({ address: w.address, kind: w.kind }) }).then(load)} className="text-accent">follow</button>}</td>
                </tr>
              ))}
              {!wallets.length && <tr><td colSpan={8} className="p-4 text-center text-mute">No wallets yet. Add KOL wallets above, or wait for discovery to score early buyers.</td></tr>}
            </tbody>
          </table>
        </Panel>
      </div>
      <Panel title={<>Live wallet trades <span className="text-up">●</span></>} className="h-[calc(100vh-80px)]">
        <ul>
          {trades.map((t, i) => (
            <li key={t.signature || i} className="flash-in flex items-center gap-2 border-b border-line/50 px-2 py-1 text-[12px] num">
              <span className="w-16 text-mute">{clock(t.ts)}</span>
              <span className={t.side === 'buy' ? 'text-up' : 'text-down'}>{t.side}</span>
              <Link href={`/token?a=${t.mint}`} className="flex-1 truncate font-semibold">{t.symbol || short(t.mint)}</Link>
              <span>{t.sol != null ? `${(+t.sol).toFixed(2)} SOL` : ''}</span>
              <span className={`truncate ${t.kind === 'kol' ? 'text-flash' : 'text-mute'}`}>{t.label || short(t.wallet)}</span>
              <Copy text={t.mint} label="CA" />
            </li>
          ))}
          {!trades.length && <li className="p-4 text-center text-mute">No followed-wallet trades yet.</li>}
        </ul>
      </Panel>
    </div>
  );
}
