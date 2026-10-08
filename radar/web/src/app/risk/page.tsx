'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Stat, useAction } from '@/components/radar';
import { Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, pct, pctClass, price, short, usd } from '@/lib/format';
import { useNow } from '@/lib/live';

export default function RiskPage() {
  const now = useNow();
  const [d, setD] = useState<any>(null);
  const [hold, setHold] = useState<any>(null);
  const [s, setS] = useState<Record<string, any>>({});
  const [np, setNp] = useState({ token_address: '', entry_price: '', size_usd: '', stop_price: '', notes: '' });
  const { run, Msg } = useAction();
  const load = useCallback(() => api('/api/risk').then((r) => { setD(r); setS((x) => (Object.keys(x).length ? x : r.settings)); }), []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  if (!d) return <p className="p-6 text-mute">Loading…</p>;
  const inp = 'rounded border border-line bg-panel2 px-2 py-1 outline-none focus:border-accent';
  const cooling = d.cooldown_until > now;
  return (
    <div className="space-y-2 pt-2">
      {cooling && <div className="rounded border border-down bg-down/10 p-2 text-down">🧊 Cooldown lock active until {new Date(d.cooldown_until * 1000).toLocaleTimeString()} — daily loss limit hit, BUY signals muted.
        <button onClick={() => api('/api/risk/cooldown/clear', { method: 'POST' }).then(load)} className="ml-2 underline">override</button></div>}
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-6">
        <Stat k="Bankroll" v={usd(+d.settings.bankroll_usd, 2)} /><Stat k="Open positions" v={`${d.open} / ${d.settings.max_open_positions}`} />
        <Stat k="Unrealized P&L" v={usd(d.unrealized_usd, 2)} cls={pctClass(d.unrealized_usd)} /><Stat k="Realized P&L (all)" v={usd(d.realized_usd, 2)} cls={pctClass(d.realized_usd)} />
        <Stat k="Realized 24h" v={usd(d.realized_24h, 2)} cls={pctClass(d.realized_24h)} /><Stat k="Daily loss limit" v={`-${usd(d.limit_usd, 2)}`} />
      </div>
      <div className="grid gap-2 lg:grid-cols-[1fr_360px]">
        <Panel title="Positions & trade journal">
          <form className="flex flex-wrap gap-2 border-b border-line p-2" onSubmit={(e) => { e.preventDefault(); run(() => api('/api/positions', { method: 'POST', body: JSON.stringify({ token_address: np.token_address.trim(), entry_price: +np.entry_price, size_usd: +np.size_usd, stop_price: np.stop_price ? +np.stop_price : null, notes: np.notes || null }) }), 'Position added').then(load); }}>
            <input required placeholder="Token CA" value={np.token_address} onChange={(e) => setNp({ ...np, token_address: e.target.value })} className={`${inp} min-w-0 flex-[2_1_220px]`} />
            <input required placeholder="Entry price $" value={np.entry_price} onChange={(e) => setNp({ ...np, entry_price: e.target.value })} className={`${inp} w-28`} />
            <input required placeholder="Size $" value={np.size_usd} onChange={(e) => setNp({ ...np, size_usd: e.target.value })} className={`${inp} w-20`} />
            <input placeholder="Stop $ (default -30%)" value={np.stop_price} onChange={(e) => setNp({ ...np, stop_price: e.target.value })} className={`${inp} w-36`} />
            <input placeholder="Journal note (why I took it)" value={np.notes} onChange={(e) => setNp({ ...np, notes: e.target.value })} className={`${inp} flex-1`} />
            <button className="rounded bg-accent/20 px-3 text-accent">Add</button><Msg />
          </form>
          <table className="w-full num text-[12px]">
            <thead className="bg-panel2 text-[11px] text-mute"><tr>{['Opened', 'Token', 'Entry', 'Now', 'Size', 'P&L', 'Stop', 'TP alerts', 'Notes', ''].map((h) => <th key={h} className="px-2 py-1 text-left font-normal">{h}</th>)}</tr></thead>
            <tbody>{d.positions.map((p: any) => <PosRow key={p.id} p={p} now={now} reload={load} />)}
              {!d.positions.length && <tr><td colSpan={10} className="p-4 text-center text-mute">No positions. Add the trades you place in your own wallet to get TP/stop alerts and P&L.</td></tr>}</tbody>
          </table>
        </Panel>
        <div className="space-y-2">
          <Panel title="Risk settings">
            <form className="space-y-1 p-2" onSubmit={(e) => { e.preventDefault(); run(() => api('/api/settings/risk', { method: 'POST', body: JSON.stringify(s) }), 'Saved').then(load); }}>
              {[['bankroll_usd', 'Bankroll ($)'], ['max_pct_per_trade', 'Max % per trade'], ['max_open_positions', 'Max open positions'], ['daily_loss_limit_pct', 'Daily loss limit (%)'], ['cooldown_hours', 'Cooldown (hours)'], ['timezone', 'Time zone'], ['brief_times', 'Brief times (HH:MM, comma)']].map(([k, l]) => (
                <label key={k} className="flex items-center gap-2"><span className="w-40 text-[11px] text-mute">{l}</span>
                  <input value={Array.isArray(s[k]) ? s[k].join(',') : s[k] ?? ''} onChange={(e) => setS({ ...s, [k]: k === 'brief_times' ? e.target.value.split(',').map((x) => x.trim()) : k === 'timezone' ? e.target.value : e.target.value === '' ? '' : +e.target.value || e.target.value })} className={`${inp} min-w-0 flex-1`} /></label>
              ))}
              <button className="rounded bg-accent/20 px-3 py-1 text-accent">Save</button>
            </form>
          </Panel>
          <Panel title="My wallet (read-only)" right={<button onClick={() => run(async () => setHold(await api('/api/holdings')), 'Loaded')} className="text-accent">load holdings</button>}>
            <div className="p-2 text-[12px]">
              {!hold && <p className="text-mute">Connect your wallet from the top bar (or paste a public address there), then load. Full view on <Link href="/wallet" className="text-accent">My wallet</Link>. Held tokens join the watchlist so Rug Shield monitors them.</p>}
              {hold?.holdings?.map((h: any) => (
                <div key={h.mint} className="flex gap-2 border-t border-line/50 py-1 num">
                  <Link href={`/token?a=${h.mint}`} className="flex-1 truncate font-semibold">{h.symbol || short(h.mint)}</Link>
                  <span>{h.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span><span>{usd(h.value_usd, 2)}</span>
                  {(h.mint_authority || h.freeze_authority) && <span className="text-down">⚠ authority</span>}
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function PosRow({ p, now, reload }: { p: any; now: number; reload: () => void }) {
  const [exit, setExit] = useState('');
  const fills = JSON.parse(p.fills_json || '[]');
  const ret = p.closed ? (p.exit_price / p.entry_price - 1) * 100 : p.price_usd ? (p.price_usd / p.entry_price - 1) * 100 : null;
  return (
    <tr className={`border-t border-line/50 ${p.closed ? 'opacity-60' : ''}`}>
      <td className="px-2 text-mute">{ago(p.opened, now)}</td>
      <td><Link href={`/token?a=${p.token_address}`} className="font-semibold">{p.symbol || short(p.token_address)}</Link></td>
      <td>{price(p.entry_price)}</td><td title={p.price_as_of ? `as of ${ago(p.price_as_of, now)} ago` : 'no live price'}>{p.closed ? price(p.exit_price) : price(p.price_usd)}</td>
      <td>{usd(p.size_usd, 2)}</td>
      <td className={pctClass(ret)}>{p.closed ? usd(p.realized_usd, 2) : usd(p.unrealized_usd, 2)} {ret != null ? `(${pct(ret)})` : ''}</td>
      <td className="text-down">{price(p.stop_price)}</td><td>{fills.map((f: any) => `${f.multiple}x`).join(' ') || '—'}</td>
      <td className="max-w-[200px] truncate text-mute" title={p.notes}>{p.notes}</td>
      <td className="px-2 text-right">{!p.closed ? (
        <span className="flex gap-1"><input placeholder="exit $" value={exit} onChange={(e) => setExit(e.target.value)} className="w-20 rounded border border-line bg-panel2 px-1" />
          <button onClick={() => exit && api(`/api/positions/${p.id}/close`, { method: 'POST', body: JSON.stringify({ exit_price: +exit }) }).then(reload)} className="text-accent">close</button></span>
      ) : <button onClick={() => api(`/api/positions/${p.id}`, { method: 'DELETE' }).then(reload)} className="text-mute">delete</button>}</td>
    </tr>
  );
}
