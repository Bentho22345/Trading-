'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { AnimatePresence, motion } from '@/components/motion';
import { useStrategies } from '@/components/snipe';
import { Reveal } from '@/components/whoop';
import { api } from '@/lib/api';
import { ago, short } from '@/lib/format';
import { useLive, useNow, usePoll } from '@/lib/live';

type Pos = { id: number; mode: string; mint: string; symbol: string; trigger: string; detail: string; opened: number; sol_in: number; sol_out: number;
  tokens: number; tokens_left: number; x: number | null; peak_x: number; value_sol: number; pnl_sol: number; tp_done: number[] };
const sol = (v?: number | null, d = 3) => (v == null ? '—' : `${v >= 0 ? '' : '−'}◎${Math.abs(v).toFixed(d)}`);
const TRIG: Record<string, string> = { snipe: 'Snipe score', strategies: 'Strategies', tweet_race: 'Tweet races (X)', copy: 'Copy top wallets', dev: 'Proven devs', x_call: 'X contract calls' };

export default function AutopilotPage() {
  const [d, setD] = useState<any>(null);
  const [realOpen, setRealOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow(2000);
  const load = useCallback(() => api('/api/autopilot').then(setD).catch((e) => setErr(e.message)), []);
  usePoll(load, 4000);
  useLive(({ ch, data }) => { if (ch === 'autopilot') setD((x: any) => (x ? { ...x, ...data } : x)); });
  const setMode = (mode: string) => api('/api/autopilot/mode', { method: 'POST', body: JSON.stringify({ mode }) }).then(load).catch((e) => setErr(e.message));
  const mode = d?.mode || 'off';
  const sum = d?.summary?.[mode === 'real' ? 'real' : 'demo'];

  return (
    <div className="pt-4">
      <Reveal className="mb-8">
        <div className="eyebrow mb-3">Autopilot · Radar trades its own signals</div>
        <h1 className="display text-[60px] md:text-[104px]">Auto<span className={mode === 'real' ? 'text-down' : 'text-up'}>pilot.</span></h1>
        <p className="mt-4 max-w-3xl text-[16px] text-white/60">
          Pick what makes Radar buy (snipe score, your strategies, tweet races, copy-trading top wallets, proven devs, contract calls
          from top X accounts), how much, and how it gets out (take-profit ladder, stop loss, trailing stop, time stop, rug exits).
          Practise in <b className="text-white">Demo</b> with virtual SOL. <b className="text-white">Real</b> trades from a separate trading wallet that only holds what you put in it.
        </p>
      </Reveal>

      <div className="glass mb-6 flex flex-wrap items-center gap-3 rounded-[28px] p-4">
        <div className="flex rounded-full bg-white/[0.05] p-1">
          {(['off', 'demo', 'real'] as const).map((m) => (
            <button key={m} onClick={() => (m === 'real' ? setRealOpen(true) : setMode(m))}
              className={`rounded-full px-5 py-2 text-[13px] font-bold uppercase tracking-wider transition ${mode === m ? (m === 'real' ? 'bg-down text-white' : m === 'demo' ? 'bg-up text-black' : 'bg-white text-black') : 'text-white/55 hover:text-white'}`}>
              {m === 'off' ? 'Off' : m === 'demo' ? 'Demo' : 'Real money'}
            </button>
          ))}
        </div>
        <span className={`flex items-center gap-2 text-[13px] ${mode === 'off' ? 'text-white/50' : 'text-white'}`}>
          <span className={`h-2 w-2 rounded-full ${mode === 'real' ? 'animate-pulse bg-down' : mode === 'demo' ? 'animate-pulse bg-up' : 'bg-white/30'}`} />
          {mode === 'off' ? 'Not buying (open positions are still managed)' : d?.paused_reason ? `Waiting: ${d.paused_reason}` : 'Hunting'}
        </span>
        <div className="num ml-auto flex flex-wrap items-center gap-4 text-[13px]">
          <span>Balance <b>{mode === 'real' ? sol(d?.wallet?.sol) : sol(d?.demo_balance)}</b></span>
          <span>Today <b className={(sum?.today?.pnl ?? 0) >= 0 ? 'text-up' : 'text-down'}>{sol(sum?.today?.pnl)}</b></span>
          <span>All-time <b className={(sum?.pnl_sol ?? 0) >= 0 ? 'text-up' : 'text-down'}>{sol(sum?.pnl_sol)}</b>{sum?.win_rate != null ? ` · ${sum.win_rate}% wins` : ''}</span>
          <button onClick={() => confirm('Sell every open position and switch Autopilot off?') && api('/api/autopilot/panic', { method: 'POST' }).then(load)}
            className="rounded-full bg-down px-4 py-2 text-[12px] font-extrabold uppercase tracking-wider text-white">🛑 Panic sell</button>
        </div>
      </div>
      {err && <p className="mb-4 text-[12px] text-down">{err}</p>}

      <div className="grid gap-6 xl:grid-cols-[1fr_440px]">
        <div className="space-y-6">
          <Positions rows={d?.open || []} now={now} onChange={load} />
          <History now={now} />
        </div>
        <aside className="space-y-4">
          <Wallet d={d} onChange={load} />
          {d && <Settings d={d} onSaved={load} />}
        </aside>
      </div>
      <AnimatePresence>{realOpen && <RealModal d={d} onClose={() => setRealOpen(false)} onDone={() => { setRealOpen(false); load(); }} />}</AnimatePresence>
      <p className="mt-10 text-[11px] text-white/35">Not financial advice. Most memecoins go to zero; fills can be worse than expected and transactions can fail.
        Radar never asks for your main wallet&apos;s seed phrase.</p>
    </div>
  );
}

function Positions({ rows, now, onChange }: { rows: Pos[]; now: number; onChange: () => void }) {
  const sell = (id: number, fraction: number) => api(`/api/autopilot/positions/${id}/sell`, { method: 'POST', body: JSON.stringify({ fraction }) }).then(onChange);
  return (
    <section className="glass overflow-hidden rounded-[28px]">
      <header className="flex items-center gap-2 border-b border-white/[0.06] px-6 py-4"><span className="display text-[28px]">Open positions</span><span className="num ml-auto text-[12px] text-white/45">{rows.length}</span></header>
      <ul>
        <AnimatePresence initial={false}>
          {rows.map((p) => (
            <motion.li key={p.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="border-t border-white/[0.05] px-6 py-4 first:border-t-0">
              <div className="flex flex-wrap items-center gap-3">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase ${p.mode === 'real' ? 'bg-down text-white' : 'bg-up/15 text-up'}`}>{p.mode}</span>
                <Link href={`/token?a=${p.mint}`} className="text-[16px] font-bold hover:underline">${p.symbol}</Link>
                <span className="text-[11.5px] text-white/45">{p.trigger} · {p.detail} · {ago(p.opened, now)} ago</span>
                <span className={`num ml-auto text-[22px] font-bold ${(p.x ?? 0) >= 1 ? 'text-up' : 'text-down'}`}>{p.x ? `${p.x.toFixed(2)}×` : '—'}</span>
              </div>
              <div className="num mt-1 flex flex-wrap items-center gap-4 text-[12px] text-white/60">
                <span>in {sol(p.sol_in)}</span><span>out {sol(p.sol_out)}</span><span>held {sol(p.value_sol)}</span>
                <span className={p.pnl_sol >= 0 ? 'text-up' : 'text-down'}>PnL {sol(p.pnl_sol)}</span><span>peak {p.peak_x.toFixed(2)}×</span>
                <span>{p.tp_done.length ? `${p.tp_done.length} take-profit${p.tp_done.length > 1 ? 's' : ''} hit` : ''}</span>
                <span className="ml-auto flex gap-1.5">
                  {[0.25, 0.5, 1].map((f) => <button key={f} onClick={() => sell(p.id, f)} className="rounded-full border border-white/15 px-2.5 py-0.5 font-semibold hover:border-white/50">Sell {f * 100}%</button>)}
                </span>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
        {!rows.length && <li className="px-6 py-10 text-center text-white/40">No open positions. Turn on Demo, or quick-buy from a Snipe card.</li>}
      </ul>
    </section>
  );
}

function History({ now }: { now: number }) {
  const [h, setH] = useState<any>(null);
  usePoll(() => api('/api/autopilot/history?limit=60').then(setH).catch(() => {}), 10000);
  return (
    <section className="glass overflow-hidden rounded-[28px]">
      <header className="border-b border-white/[0.06] px-6 py-4"><span className="display text-[28px]">Orders</span></header>
      <div className="max-h-[520px] overflow-y-auto">
        <table className="num w-full text-[12px]">
          <tbody>
            {(h?.orders || []).map((o: any) => (
              <tr key={o.id} className="border-t border-white/[0.05]">
                <td className="py-2 pl-6 text-white/45">{ago(o.ts, now)}</td>
                <td><span className={`rounded-full px-1.5 text-[9.5px] font-bold uppercase ${o.mode === 'real' ? 'bg-down/20 text-down' : 'bg-white/[0.07] text-white/60'}`}>{o.mode}</span></td>
                <td className={o.side === 'buy' ? 'text-up' : 'text-warn'}>{o.side}</td>
                <td className="font-semibold">{o.symbol ? `$${o.symbol}` : short(o.mint)}</td>
                <td>{sol(o.sol)}</td>
                <td className="max-w-[260px] truncate text-white/50" title={o.error || o.reason}>{o.status === 'failed' ? <span className="text-down">✗ {o.error}</span> : o.reason}</td>
                <td className="pr-6 text-right">{o.sig ? <a href={`https://solscan.io/tx/${o.sig}`} target="_blank" rel="noreferrer" className="text-white/50 hover:text-white">tx ↗</a> : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!h?.orders?.length && <p className="px-6 py-8 text-center text-white/40">No orders yet.</p>}
      </div>
    </section>
  );
}

function Wallet({ d, onChange }: { d: any; onChange: () => void }) {
  const w = d?.wallet || {};
  const [payout, setPayout] = useState('');
  const [amt, setAmt] = useState('');
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => { if (w.payout && !payout) setPayout(w.payout); }, [w.payout, payout]);
  const call = (path: string, body: any) => api(path, { method: 'POST', body: JSON.stringify(body) });
  return (
    <section className="glass rounded-[28px] p-5">
      <div className="mb-3 flex items-center gap-2"><Icon name="wallet" size={16} /><span className="display text-[24px]">Trading wallet</span></div>
      {!w.pubkey ? (
        <>
          <p className="text-[12.5px] text-white/60">Radar creates a <b className="text-white">separate wallet just for Autopilot</b>, like Telegram sniping bots do. Its key is
            encrypted on your server; you deposit only what you&apos;re willing to risk, and can withdraw or export it any time. Radar never asks for your main wallet&apos;s seed phrase.</p>
          <button onClick={() => call('/api/autopilot/wallet', {}).then(onChange).catch((e) => setMsg(e.message))} className="btn-primary mt-4">Create trading wallet</button>
        </>
      ) : (
        <div className="space-y-3 text-[12.5px]">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-white/45">Deposit address</div>
            <button onClick={() => navigator.clipboard?.writeText(w.pubkey)} className="mt-0.5 break-all text-left font-mono text-[12.5px] hover:text-up" title="Copy">{w.pubkey}</button>
            <div className="num mt-1">Balance <b className="text-[16px]">{w.sol != null ? `◎${w.sol.toFixed(4)}` : '—'}</b>
              <a href={`https://solscan.io/account/${w.pubkey}`} target="_blank" rel="noreferrer" className="ml-2 text-white/45 hover:text-white">Solscan ↗</a></div>
            {w.error && <p className="text-[11px] text-warn">Balance check: {w.error}</p>}
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-white/45">Your wallet (watch-only — withdrawals go here)
              {w.payout && <Link href={`/wallet?a=${w.payout}`} className="ml-2 normal-case tracking-normal text-white/60 hover:text-white">view holdings →</Link>}</div>
            <div className="mt-1 flex gap-1.5">
              <input value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="Your Phantom / Solflare address" className="min-w-0 flex-1 rounded-xl border border-white/10 bg-transparent px-3 py-1.5 font-mono text-[11.5px]" />
              <button onClick={() => call('/api/autopilot/wallet/payout', { address: payout }).then(() => { setMsg('✓ saved'); onChange(); }).catch((e) => setMsg(e.message))} className="rounded-xl border border-white/15 px-3 text-[12px]">Save</button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <input value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="SOL (empty = all)" className="num w-32 rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-[12px]" />
            <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="Radar password" className="w-36 rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-[12px]" />
            <button onClick={() => call('/api/autopilot/wallet/withdraw', { sol: amt ? Number(amt) : null, password: pw }).then((r: any) => { setMsg(`✓ sent · ${r.signature.slice(0, 10)}…`); onChange(); }).catch((e) => setMsg(e.message))}
              className="rounded-xl bg-white px-3 text-[12px] font-bold text-black">Withdraw</button>
            <button onClick={() => call('/api/autopilot/wallet/export', { password: pw }).then((r: any) => setKey(r.private_key)).catch((e) => setMsg(e.message))}
              className="rounded-xl border border-white/15 px-3 text-[12px]">Export key</button>
          </div>
          {key && <div className="rounded-xl border border-down/40 bg-down/10 p-3 text-[11px]"><b>Private key — anyone with this controls the wallet.</b>
            <div className="mt-1 break-all font-mono">{key}</div><button onClick={() => setKey(null)} className="mt-1 underline">Hide</button></div>}
        </div>
      )}
      {msg && <p className={`mt-2 text-[11.5px] ${msg.startsWith('✓') ? 'text-up' : 'text-down'}`}>{msg}</p>}
      {!d?.password_set && <p className="mt-3 text-[11px] text-warn">Set RADAR_PASSWORD on Render before using real money — it protects withdrawals, key export and real mode.</p>}
    </section>
  );
}

function Num({ label, value, onChange, step = 'any', suffix }: { label: string; value: number; onChange: (v: number) => void; step?: string; suffix?: string }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[12px]"><span className="text-white/60">{label}</span>
      <span className="flex items-center gap-1"><input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="num w-24 rounded-lg border border-white/10 bg-transparent px-2 py-1 text-right" />{suffix && <span className="w-6 text-white/40">{suffix}</span>}</span></label>
  );
}

function Settings({ d, onSaved }: { d: any; onSaved: () => void }) {
  const [c, setC] = useState<any>(d.config);
  const [ok, setOk] = useState(false);
  const { list: strategies } = useStrategies();
  const set = (path: string[], v: any) => setC((x: any) => {
    const n = structuredClone(x);
    let o = n;
    for (const k of path.slice(0, -1)) o = o[k];
    o[path[path.length - 1]] = v;
    return n;
  });
  const save = () => api('/api/autopilot/config', { method: 'POST', body: JSON.stringify(c) }).then((r) => { setC(r); setOk(true); setTimeout(() => setOk(false), 1500); onSaved(); });
  const t = c.triggers, f = c.filters, s = c.size, e = c.exits, x = c.exec;
  return (
    <section className="glass space-y-5 rounded-[28px] p-5">
      <div className="flex items-center gap-2"><Icon name="settings" size={16} /><span className="display text-[24px]">Rules</span>
        <button onClick={save} className="btn-primary ml-auto !py-1.5">{ok ? 'Saved ✓' : 'Save'}</button></div>
      <div>
        <div className="eyebrow mb-2">Buy when</div>
        {Object.keys(TRIG).map((k) => (
          <div key={k} className="mb-2 rounded-xl border border-white/[0.07] p-2.5">
            <label className="flex items-center gap-2 text-[13px] font-semibold"><input type="checkbox" checked={t[k].on} onChange={(ev) => set(['triggers', k, 'on'], ev.target.checked)} />{TRIG[k]}</label>
            {t[k].on && (
              <div className="mt-2 space-y-1.5 pl-5">
                {k === 'snipe' && <>
                  <label className="flex items-center justify-between text-[12px]"><span className="text-white/60">Appetite</span>
                    <select value={t.snipe.appetite} onChange={(ev) => set(['triggers', 'snipe', 'appetite'], ev.target.value)} className="rounded-lg border border-white/10 bg-transparent px-2 py-1">
                      {['safe', 'balanced', 'degen'].map((a) => <option key={a} value={a} className="bg-[var(--color-bg)]">{a}</option>)}</select></label>
                  <Num label="Min score" value={t.snipe.min_score} onChange={(v) => set(['triggers', 'snipe', 'min_score'], v)} />
                </>}
                {k === 'strategies' && <div className="flex flex-wrap gap-1">{strategies.map((st) => {
                  const on = t.strategies.ids.includes(st.id);
                  return <button key={st.id} onClick={() => set(['triggers', 'strategies', 'ids'], on ? t.strategies.ids.filter((i: string) => i !== st.id) : [...t.strategies.ids, st.id])}
                    className={`rounded-full px-2 py-0.5 text-[11px] ${on ? 'bg-white text-black' : 'border border-white/15 text-white/60'}`}>{st.name}</button>;
                })}</div>}
                {k === 'tweet_race' && <><Num label="Only the first N coins" value={t.tweet_race.max_rank} onChange={(v) => set(['triggers', 'tweet_race', 'max_rank'], v)} />
                  <Num label="Min tweet score" value={t.tweet_race.min_tweet_score} onChange={(v) => set(['triggers', 'tweet_race', 'min_tweet_score'], v)} /></>}
                {k === 'copy' && <><Num label="Wallets buying" value={t.copy.min_wallets} onChange={(v) => set(['triggers', 'copy', 'min_wallets'], v)} />
                  <Num label="Within" value={t.copy.window_min} onChange={(v) => set(['triggers', 'copy', 'window_min'], v)} suffix="min" />
                  <Num label="Wallet rank ≤" value={t.copy.top_rank} onChange={(v) => set(['triggers', 'copy', 'top_rank'], v)} /></>}
                {k === 'dev' && <Num label="Dev's graduated coins ≥" value={t.dev.min_graduated} onChange={(v) => set(['triggers', 'dev', 'min_graduated'], v)} />}
                {k === 'x_call' && <div className="flex gap-1">{['S', 'A', 'B'].map((tier) => {
                  const on = t.x_call.tiers.includes(tier);
                  return <button key={tier} onClick={() => set(['triggers', 'x_call', 'tiers'], on ? t.x_call.tiers.filter((i: string) => i !== tier) : [...t.x_call.tiers, tier])}
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${on ? 'bg-white text-black' : 'border border-white/15 text-white/60'}`}>tier {tier}</button>;
                })}</div>}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="space-y-1.5">
        <div className="eyebrow mb-2">Only if</div>
        <Num label="Market cap ≤" value={f.max_mcap_usd} onChange={(v) => set(['filters', 'max_mcap_usd'], v)} suffix="$" />
        <Num label="Buyers ≥" value={f.min_buyers} onChange={(v) => set(['filters', 'min_buyers'], v)} />
        <Num label="Risk ≤" value={f.max_risk} onChange={(v) => set(['filters', 'max_risk'], v)} />
        <Num label="Insiders hold ≤" value={f.max_insider_hold_pct} onChange={(v) => set(['filters', 'max_insider_hold_pct'], v)} suffix="%" />
        <Num label="Age ≤" value={f.max_age_min} onChange={(v) => set(['filters', 'max_age_min'], v)} suffix="min" />
        <label className="flex items-center gap-2 text-[12px] text-white/70"><input type="checkbox" checked={f.skip_bundled} onChange={(ev) => set(['filters', 'skip_bundled'], ev.target.checked)} />Skip bundled launches</label>
        <label className="flex items-center gap-2 text-[12px] text-white/70"><input type="checkbox" checked={f.skip_trap} onChange={(ev) => set(['filters', 'skip_trap'], ev.target.checked)} />Skip TRAP coins</label>
      </div>
      <div className="space-y-1.5">
        <div className="eyebrow mb-2">Size & limits</div>
        <Num label="SOL per buy" value={s.buy_sol} onChange={(v) => set(['size', 'buy_sol'], v)} suffix="◎" />
        <Num label="Max open positions" value={s.max_open} onChange={(v) => set(['size', 'max_open'], v)} />
        <Num label="Max SOL per day" value={s.max_daily_sol} onChange={(v) => set(['size', 'max_daily_sol'], v)} suffix="◎" />
        <Num label="Stop for the day after losing" value={s.daily_loss_limit_sol} onChange={(v) => set(['size', 'daily_loss_limit_sol'], v)} suffix="◎" />
        <Num label="Seconds between buys" value={s.cooldown_s} onChange={(v) => set(['size', 'cooldown_s'], v)} />
        <Num label="Hard cap per buy" value={s.max_buy_sol_hard} onChange={(v) => set(['size', 'max_buy_sol_hard'], v)} suffix="◎" />
      </div>
      <div className="space-y-1.5">
        <div className="eyebrow mb-2">Sell</div>
        {e.tp.map((step: any, i: number) => (
          <div key={i} className="flex items-center gap-2 text-[12px]"><span className="text-white/60">Take profit {i + 1}: at</span>
            <input type="number" step="0.1" value={step.x} onChange={(ev) => set(['exits', 'tp', String(i), 'x'], Number(ev.target.value))} className="num w-16 rounded-lg border border-white/10 bg-transparent px-2 py-1 text-right" />×
            <span className="text-white/60">sell</span>
            <input type="number" step="0.05" value={Math.round(step.sell * 100)} onChange={(ev) => set(['exits', 'tp', String(i), 'sell'], Number(ev.target.value) / 100)} className="num w-16 rounded-lg border border-white/10 bg-transparent px-2 py-1 text-right" />%
            <button onClick={() => set(['exits', 'tp'], e.tp.filter((_: any, j: number) => j !== i))} className="ml-auto text-white/35 hover:text-down">✕</button></div>
        ))}
        {e.tp.length < 6 && <button onClick={() => set(['exits', 'tp'], [...e.tp, { x: (e.tp.at(-1)?.x || 1) * 2, sell: 0.5 }])} className="text-[11.5px] text-white/55 hover:text-white">+ take-profit step</button>}
        <Num label="Stop loss" value={e.stop_loss_pct} onChange={(v) => set(['exits', 'stop_loss_pct'], v)} suffix="%" />
        <Num label="Trailing stop" value={e.trailing_pct} onChange={(v) => set(['exits', 'trailing_pct'], v)} suffix="%" />
        <Num label="…once up" value={e.trail_after_x} onChange={(v) => set(['exits', 'trail_after_x'], v)} suffix="×" />
        <Num label="Time stop (if under 1.3×)" value={e.time_stop_min} onChange={(v) => set(['exits', 'time_stop_min'], v)} suffix="min" />
        <label className="flex items-center gap-2 text-[12px] text-white/70"><input type="checkbox" checked={e.rug_exit} onChange={(ev) => set(['exits', 'rug_exit'], ev.target.checked)} />Rug exit (dev dumps / insiders / turns TRAP)</label>
      </div>
      <div className="space-y-1.5">
        <div className="eyebrow mb-2">Execution (real)</div>
        <Num label="Slippage" value={x.slippage_pct} onChange={(v) => set(['exec', 'slippage_pct'], v)} suffix="%" />
        <Num label="Priority fee" value={x.priority_fee_sol} onChange={(v) => set(['exec', 'priority_fee_sol'], v)} suffix="◎" />
      </div>
      <button onClick={() => api('/api/autopilot/demo/reset', { method: 'POST' }).then(onSaved)} className="text-[11.5px] text-white/45 hover:text-white">Reset demo balance to ◎{c.demo.start_sol}</button>
    </section>
  );
}

function RealModal({ d, onClose, onDone }: { d: any; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [phrase, setPhrase] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const s = d?.config?.size || {};
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur" onClick={onClose}>
      <motion.div initial={{ scale: 0.96 }} animate={{ scale: 1 }} className="glass w-full max-w-lg rounded-[28px] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="display text-[32px] text-down">Real money</div>
        <ul className="mt-3 space-y-1.5 text-[13px] text-white/70">
          <li>• Radar will buy and sell automatically from your trading wallet ({d?.wallet?.pubkey ? short(d.wallet.pubkey, 6) : 'not created yet'}, balance {d?.wallet?.sol != null ? `◎${d.wallet.sol.toFixed(3)}` : '—'}).</li>
          <li>• Current limits: ◎{s.buy_sol} per buy, {s.max_open} open at once, ◎{s.max_daily_sol} per day, stops after losing ◎{s.daily_loss_limit_sol} in a day.</li>
          <li>• Memecoins usually go to zero. Slippage, failed transactions and rugs happen. Only deposit what you can lose.</li>
          <li>• Panic sell (here or <b>/panic</b> in Telegram) sells everything and stops.</li>
        </ul>
        <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="Radar password" className="mt-4 w-full rounded-xl border border-white/10 bg-transparent px-3 py-2 text-[13px]" />
        <input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={`Type: ${d?.real_phrase}`} className="mt-2 w-full rounded-xl border border-white/10 bg-transparent px-3 py-2 text-[13px]" />
        {err && <p className="mt-2 text-[12px] text-down">{err}</p>}
        <div className="mt-4 flex gap-2">
          <button onClick={() => api('/api/autopilot/mode', { method: 'POST', body: JSON.stringify({ mode: 'real', password: pw, confirm: phrase }) }).then(onDone).catch((e) => setErr(e.message))}
            className="rounded-full bg-down px-5 py-2 text-[13px] font-extrabold text-white">Turn on real trading</button>
          <button onClick={onClose} className="btn-ghost">Cancel</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
