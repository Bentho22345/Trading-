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

type Pos = { id: number; mode: string; mint: string; symbol: string; trigger: string; detail: string; opened: number; sol_in: number; sol_out: number; style?: string | null; ride?: boolean;
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
  const sum = d?.summary?.[mode === 'real' ? 'real' : mode === 'auto' ? 'auto' : 'demo'];

  return (
    <div className="pt-4">
      <Reveal className="mb-8">
        <div className="eyebrow mb-3">Autopilot · Radar trades its own signals</div>
        <h1 className="display text-[60px] md:text-[104px]">Auto<span className={mode === 'real' ? 'text-down' : 'text-accent'}>pilot.</span></h1>
        <p className="mt-4 max-w-3xl text-[16px] text-white/60">
          Pick what makes Radar buy (snipe score, your strategies, tweet races, copy-trading top wallets, proven devs, contract calls
          from top X accounts), how much, and how it gets out (take-profit ladder, stop loss, trailing stop, time stop, rug exits).
          Practise in <b className="text-white">Demo</b> with virtual SOL. <b className="text-white">Real</b> trades from a separate trading wallet that only holds what you put in it.
        </p>
      </Reveal>

      <div className="glass mb-6 flex flex-wrap items-center gap-3 rounded-[28px] p-4">
        <div className="flex rounded-full bg-white/[0.05] p-1">
          {(['off', 'demo', 'auto', 'real'] as const).map((m) => (
            <button key={m} onClick={() => (m === 'real' ? setRealOpen(true) : setMode(m))}
              className={`rounded-full px-5 py-2 text-[13px] font-bold uppercase tracking-wider transition ${mode === m ? (m === 'real' ? 'bg-down text-white' : m === 'demo' ? 'bg-up text-black' : m === 'auto' ? 'bg-flash text-white' : 'bg-white text-black') : 'text-white/55 hover:text-white'}`}>
              {m === 'off' ? 'Off' : m === 'demo' ? 'Demo' : m === 'auto' ? 'Self-driving' : 'Real money'}
            </button>
          ))}
        </div>
        <span className={`flex items-center gap-2 text-[13px] ${mode === 'off' ? 'text-white/50' : 'text-white'}`}>
          <span className={`h-2 w-2 rounded-full ${mode === 'real' ? 'animate-pulse bg-down' : mode === 'demo' ? 'animate-pulse bg-up' : mode === 'auto' ? 'animate-pulse bg-flash' : 'bg-white/30'}`} />
          {mode === 'off' ? 'Not buying (open positions are still managed)' : mode === 'auto' ? 'Driving itself on its own demo money' : d?.paused_reason ? `Waiting: ${d.paused_reason}` : 'Hunting'}
        </span>
        <div className="num ml-auto flex flex-wrap items-center gap-4 text-[13px]">
          <span>Balance <b>{mode === 'real' ? sol(d?.wallet?.sol) : mode === 'auto' ? sol(d?.auto_balance) : sol(d?.demo_balance)}</b></span>
          <span>Today <b className={(sum?.today?.pnl ?? 0) >= 0 ? 'text-up' : 'text-down'}>{sol(sum?.today?.pnl)}</b></span>
          <span>All-time <b className={(sum?.pnl_sol ?? 0) >= 0 ? 'text-up' : 'text-down'}>{sol(sum?.pnl_sol)}</b>{sum?.win_rate != null ? ` · ${sum.win_rate}% wins` : ''}</span>
          <button onClick={() => { try { const off = localStorage.getItem('radar:toasts') === 'off'; localStorage.setItem('radar:toasts', off ? 'on' : 'off'); alert(off ? 'Trade pop-ups on (reload to apply).' : 'Trade pop-ups off.'); } catch { /* private mode */ } }}
            className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-semibold text-white/60 hover:text-white" title="Show or hide the trade pop-ups">🔔 Pop-ups</button>
          <button onClick={() => confirm('Sell every open position and switch Autopilot off?') && api('/api/autopilot/panic', { method: 'POST' }).then(load)}
            className="rounded-full bg-down px-4 py-2 text-[12px] font-extrabold uppercase tracking-wider text-white">🛑 Panic sell</button>
        </div>
      </div>
      {err && <p className="mb-4 text-[12px] text-down">{err}</p>}
      {(mode === 'auto' || (d?.summary?.auto?.closed ?? 0) > 0 || (d?.open || []).some((p: Pos) => p.mode === 'auto')) && <SelfDriving now={now} on={mode === 'auto'} onMode={setMode} />}

      <div className="grid gap-6 xl:grid-cols-[1fr_440px]">
        <div className="space-y-6">
          <Positions rows={(d?.open || []).filter((p: Pos) => p.mode !== 'auto')} now={now} onChange={load} />
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
                {p.ride ? <span className="rounded-full bg-up/20 px-2 py-0.5 text-[10px] font-extrabold uppercase text-up">riding a surge</span>
                  : p.style === 'scalp' ? <span className="rounded-full bg-flash/20 px-2 py-0.5 text-[10px] font-extrabold uppercase text-flash">⚡ scalp</span> : null}
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
  const [engine, setEngine] = useState<string>(d?.config?.real_engine || 'rules');
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
        <div className="mt-4 text-[12px] text-white/60">Real money is driven by:</div>
        <div className="mt-1 flex rounded-full bg-white/[0.06] p-1">
          {[['rules', 'My rules'], ['brain', 'Self-driving brain']].map(([k, label]) => (
            <button key={k} onClick={() => api('/api/autopilot/real-engine', { method: 'POST', body: JSON.stringify({ engine: k }) }).then(() => setEngine(k))}
              className={`flex-1 rounded-full px-3 py-1.5 text-[12px] font-bold ${engine === k ? 'bg-white text-black' : 'text-white/60'}`}>{label}</button>
          ))}
        </div>
        {engine === 'brain' && <p className="mt-1 text-[11px] text-white/45">The brain picks and sizes trades itself, but never above your ◎{s.buy_sol} per buy (hard cap ◎{s.max_buy_sol_hard}), {s.max_open} open positions, ◎{s.max_daily_sol}/day or the daily loss limit.</p>}
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

type Brain = {
  threshold: number; trained: number; balance: number; summary: any; mode: string; aggression: string; levels: Record<string, any>;
  shadow: { trained: number; hit_rate: number | null; pending: number; brier: number | null; accuracy?: number | null };
  diag: { launches?: number; scored?: number; copy_watch?: number; shadow_pending?: number; mood?: number; top_pct?: number; influx?: number; smart_selling?: number };
  mood?: { value: number; word: string; streak: number; cool_s: number; drawdown_pct: number; top_pct: number };
  rug_model?: { trained: number; brier: number | null; accuracy: number | null; rugs_seen: number; top: { key: string; label: string; w: number }[] };
  learning?: { lessons_per_hour: number; replay: number; rehearsed: number; models: number; signals: number };
  patterns?: { base_win_pct: number | null; worst: Pat[]; best: Pat[] };
  exits?: { stop_pct: number; trail_mult: number; shaken: number; stop_right: number; sold_early: number; trail_right: number; watching: number;
    patience?: number; smart_follow?: number; copied_sells?: number; too_early?: number; early_right?: number; smart_right?: number; smart_wrong?: number; ladder?: string[] };
  benched?: { wallet: string; n: number; wins: number; until: number }[];
  blocked_devs?: number;
  copies: { mint: string; symbol?: string | null; wallets: number; best_rank: number; last: number; age_s: number }[];
  sizing: { n: number; wr: number; avg_win: number; avg_loss: number } | null;
  weights: { key: string; label: string; w: number; prior: number }[];
  scalper?: { on: boolean; n: number; wins: number; pnl_sol: number; bar?: number; tp?: number; stop?: number; max_s?: number; open: number; riding: number; streak: number; recent_pct: number | null };
  skips?: Record<string, number>;
  snipes?: { on: boolean; n: number; wins: number; pnl_sol: number; power: number; per_hour: number; open: number; power_open: number };
  compound?: { start: number; growth_pct: number };
  bars?: Record<string, number>; idle_s?: number | null;
  verdict?: { state: string; text: string; [k: string]: any };
  nebula?: Nebula;
  last_error?: { ts: number; error: string; where?: string } | null; engine_error?: string | null; refills?: number;
  timing?: { up: { trained: number; accuracy: number | null }; down: { trained: number; accuracy: number | null }; pending: number; dn_margin: number;
    market?: { coins: number; dn_med: number; up_med: number } | null;
    grad_frac: number; active: boolean; up_top: { label: string; w: number }[]; dn_top: { label: string; w: number }[] };
  candidates: { mint: string; symbol?: string; value: number; p_rug?: number; p_up?: number; p_dn?: number; scalp?: number; hard?: string | null; why: string; mcap_usd?: number; age_s?: number; tier?: string; copy_ranks?: string }[];
  log: { ts: number; kind: string; text: string; mint?: string }[]; equity: { ts: number; equity: number }[]; open: Pos[];
};
type Pat = { tag: string; text: string; n: number; win_pct: number; avg_pnl_pct: number };
const MOOD_TONE: Record<string, string> = { 'on fire': 'text-up', confident: 'text-up', cautious: 'text-warn', discouraged: 'text-down', shaken: 'text-down', 'cooling off': 'text-flash' };
const LOG_TONE: Record<string, string> = { buy: 'text-up', sell: 'text-warn', learn: 'text-accent', skip: 'text-white/55', error: 'text-down', mode: 'text-flash', reset: 'text-flash' };

function Equity({ pts, start }: { pts: { ts: number; equity: number }[]; start: number }) {
  if (pts.length < 2) return <div className="flex h-[120px] items-center justify-center text-[12px] text-white/35">The equity curve draws itself as it trades.</div>;
  const W = 600, H = 120;
  const ys = pts.map((p) => p.equity);
  const lo = Math.min(start, ...ys), hi = Math.max(start, ...ys), span = hi - lo || 1;
  const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts || t0 + 1;
  const xy = pts.map((p) => [((p.ts - t0) / Math.max(1, t1 - t0)) * W, H - 6 - ((p.equity - lo) / span) * (H - 12)]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const up = ys[ys.length - 1] >= start;
  const baseY = H - 6 - ((start - lo) / span) * (H - 12);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[120px] w-full" preserveAspectRatio="none">
      <line x1={0} x2={W} y1={baseY} y2={baseY} stroke="currentColor" strokeOpacity={0.15} strokeDasharray="4 4" />
      <path d={`${line} L${W},${H} L0,${H} Z`} fill={up ? 'var(--color-up)' : 'var(--color-down)'} fillOpacity={0.1} />
      <path d={line} fill="none" stroke={up ? 'var(--color-up)' : 'var(--color-down)'} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function SelfDriving({ now, on, onMode }: { now: number; on: boolean; onMode: (m: string) => void }) {
  const [b, setB] = useState<Brain | null>(null);
  const load = useCallback(() => api<Brain>('/api/autopilot/brain').then(setB).catch(() => {}), []);
  usePoll(load, 6000);
  useLive(({ ch, data }) => {
    if (ch !== 'brain') return;
    setB((x) => {
      if (!x) return x;
      const n = { ...x };
      if (data.event) n.log = [data.event, ...x.log].slice(0, 150);
      if (data.candidates) n.candidates = data.candidates;
      if (data.threshold != null) n.threshold = data.threshold;
      if (data.diag) n.diag = data.diag;
      if (data.mood) n.mood = data.mood;
      return n;
    });
    if (data.event && ['buy', 'sell', 'learn'].includes(data.event.kind)) load();
  });
  const sm = b?.summary;
  const start = 10;
  const eq = b?.equity?.length ? b.equity[b.equity.length - 1].equity : b?.balance ?? start;
  const maxW = Math.max(1, ...(b?.weights || []).map((w) => Math.max(Math.abs(w.w), Math.abs(w.prior))));
  const [allW, setAllW] = useState(false);
  const md = b?.mood;
  return (
    <section className="mb-6 overflow-hidden rounded-[28px] border border-flash/30 bg-flash/[0.04]">
      <header className="flex flex-wrap items-center gap-3 border-b border-flash/20 px-6 py-4">
        <span className={`h-2.5 w-2.5 rounded-full ${on ? 'animate-pulse bg-flash' : 'bg-white/30'}`} />
        <span className="display text-[30px]">Self-driving</span>
        <span className="text-[12px] text-white/55">Radar&apos;s own algorithm · own demo money · learns from every trade</span>
        <div className="num ml-auto flex flex-wrap items-center gap-4 text-[13px]">
          <span>Equity <b className={eq >= start ? 'text-up' : 'text-down'}>◎{eq.toFixed(3)}</b> <span className="text-white/45">({((eq / start - 1) * 100).toFixed(1)}%)</span></span>
          <span>Trades <b>{sm?.closed ?? 0}</b>{sm?.win_rate != null ? <> · <b>{sm.win_rate}%</b> wins</> : null}</span>
          <span>Learned from <b>{b?.trained ?? 0}</b></span>
          <span>Entry bar <b className="text-flash">{b?.threshold?.toFixed(0) ?? '—'}</b></span>
          <span className="flex rounded-full bg-white/[0.06] p-0.5">
            {['careful', 'aggressive', 'degen', 'hyper', 'surreal'].map((lv) => (
              <button key={lv} onClick={() => api('/api/autopilot/brain/aggression', { method: 'POST', body: JSON.stringify({ level: lv }) }).then(load)}
                title={lv === 'surreal' ? 'Sniper-compounder: snipes brand-new coins in their first seconds, banks quick profits, compounds the pot' : undefined}
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold capitalize ${b?.aggression === lv ? (lv === 'surreal' ? 'bg-gradient-to-r from-accent to-flash text-white' : 'bg-flash text-white') : 'text-white/55 hover:text-white'}`}>{lv === 'surreal' ? '✦ surreal' : lv}</button>
            ))}
          </span>
          {!on && <button onClick={() => onMode('auto')} className="rounded-full bg-flash px-3 py-1 text-[12px] font-bold text-white">Start</button>}
          <button onClick={() => confirm("Sell the brain's positions and reset what it learned (and its demo money)?") && api('/api/autopilot/brain/reset', { method: 'POST' }).then(load)}
            className="rounded-full border border-white/15 px-3 py-1 text-[12px] text-white/60 hover:text-white">Reset brain</button>
        </div>
      </header>
      <div className="num flex flex-wrap gap-x-5 gap-y-1 px-6 pt-3 text-[11.5px] text-white/55">
        <span>watching <b className="text-white">{b?.diag?.scored ?? 0}</b> of {b?.diag?.launches ?? 0} live launches</span>
        <span>top-wallet influxes <b className="text-white">{b?.diag?.influx ?? 0}</b> <span className="text-white/35">(of {b?.diag?.copy_watch ?? 0} coins they touched)</span></span>
        <span>top wallets selling <b className="text-white">{b?.diag?.smart_selling ?? 0}</b> coins</span>
        <span>copied sells <b className="text-white">{b?.exits?.copied_sells ?? 0}</b></span>
        <span>learned from <b className="text-white">{(b?.shadow?.trained ?? 0).toLocaleString()}</b> watched coins{b?.shadow?.hit_rate != null ? ` (${b.shadow.hit_rate}% hit +60% before the stop)` : ''}</span>
        {b?.shadow?.brier != null && <span>forecast error <b className="text-white">{b.shadow.brier}</b></span>}
        <span>sizing: <b className="text-white">{b?.sizing && b.sizing.n >= 10 ? `half-Kelly (${Math.round(b.sizing.wr * 100)}% wins)` : 'base % until 10 trades'}</b></span>
        {(b?.diag?.launches ?? 1) === 0 && <span className="text-warn">No live launches are reaching Radar — check PumpPortal on the Health page.</span>}
      </div>
      <div className="mx-6 mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
          <div className="eyebrow">Mood</div>
          <div className={`display text-[24px] capitalize ${MOOD_TONE[md?.word || ''] || ''}`}>{md?.word || '—'}</div>
          <div className="num text-[11px] text-white/50">{md ? <>{md.streak > 0 ? `${md.streak} wins in a row` : md.streak < 0 ? `${-md.streak} losses in a row` : 'no streak'} · buys top {md.top_pct}%{md.cool_s > 0 ? ` · back in ${Math.ceil(md.cool_s / 60)}m` : ''}{md.drawdown_pct > 5 ? ` · ${md.drawdown_pct}% off its high` : ''}</> : 'Losses discourage it, wins build confidence.'}</div>
        </div>
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
          <div className="eyebrow">Win model</div>
          <div className="display text-[24px]">{b?.shadow?.accuracy != null ? `${b.shadow.accuracy}%` : '—'} <span className="text-[12px] text-white/45">right</span></div>
          <div className="num text-[11px] text-white/50">{(b?.shadow?.trained ?? 0).toLocaleString()} coin lessons{b?.shadow?.hit_rate != null ? ` · ${b.shadow.hit_rate}% hit +60%` : ''}</div>
        </div>
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
          <div className="eyebrow">Rug detector</div>
          <div className="display text-[24px]">{b?.rug_model?.accuracy != null ? `${b.rug_model.accuracy}%` : '—'} <span className="text-[12px] text-white/45">right</span></div>
          <div className="num truncate text-[11px] text-white/50" title={(b?.rug_model?.top || []).map((t) => t.label).join(', ')}>{b?.rug_model?.rugs_seen ?? 0} rugs studied · {(b?.rug_model?.top || []).slice(0, 2).map((t) => t.label.toLowerCase()).join(', ') || 'learning'}</div>
        </div>
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
          <div className="eyebrow">Timing · next 3 min</div>
          <div className="display text-[24px]">{b?.timing?.down?.accuracy != null ? `${b.timing.down.accuracy}%` : '—'} <span className="text-[12px] text-white/45">{b?.timing?.active ? 'live' : 'warming up'}</span></div>
          <div className="num truncate text-[11px] text-white/50" title={`Up: ${(b?.timing?.up_top || []).map((t) => t.label).join(', ')} · Dump: ${(b?.timing?.dn_top || []).map((t) => t.label).join(', ')}`}>
            {(b?.timing?.down?.trained ?? 0).toLocaleString()} tape lessons · sells when dump odds beat the market by +{b?.timing?.dn_margin ?? 12} pts{b?.timing?.market ? ` (typical coin ${b.timing.market.dn_med}%)` : ''} · {b?.timing?.grad_frac ?? 50}% into graduation</div>
        </div>
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
          <div className="eyebrow">Always learning</div>
          <div className="display text-[24px]">{b?.learning?.lessons_per_hour ?? 0}<span className="text-[12px] text-white/45"> lessons/h</span></div>
          <div className="num text-[11px] text-white/50">{(b?.learning?.replay ?? 0).toLocaleString()} remembered · {(b?.learning?.rehearsed ?? 0).toLocaleString()} rehearsals · {b?.learning?.signals ?? 0} signals</div>
        </div>
      </div>
      {b?.nebula && <NebulaPanel n={b.nebula} now={now} />}
      {b?.verdict && (
        <div className={`mx-6 mt-3 flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-[13px] ${b.verdict.state === 'trading' ? 'border-up/30 bg-up/[0.07] text-up' : 'border-warn/40 bg-warn/[0.08] text-warn'}`}>
          <b className="uppercase tracking-wide">{b.verdict.state === 'trading' ? '● Trading' : '● Not trading'}</b>
          <span className="flex-1 text-white/85">{b.verdict.text}</span>
          <span className="num text-[11px] text-white/45">launches/min {b.verdict.launches_60s ?? '—'} · new coins trading {b.verdict.newborn_traded ?? '—'}/{b.verdict.newborn ?? '—'} · live tapes {b.verdict.live_tapes ?? '—'} · trade subs {b.verdict.trade_subs ?? '—'}
            {b.verdict.trade_feed && <> · trade feed: {b.verdict.trade_feed.chain_running
              ? `on-chain ${b.verdict.trade_feed.chain?.connected ? '●' : '○'} ${b.verdict.trade_feed.chain?.per_min ?? 0}/min`
              : `PumpPortal${b.verdict.trade_feed.pumpportal_key ? ' (key)' : ''} ${b.verdict.trade_feed.pumpportal_trades_90s ?? 0}/90s`}</>}</span>
          <button onClick={() => { const txt = JSON.stringify({ verdict: b.verdict, skips: b.skips, bars: b.bars, idle_s: b.idle_s, diag: b.diag, mood: b.mood,
              scalper: b.scalper, snipes: b.snipes, last_error: b.last_error, engine_error: b.engine_error, aggression: b.aggression, mode: b.mode,
              timing: b.timing && { up: b.timing.up, down: b.timing.down, market: b.timing.market }, log: (b.log || []).slice(0, 12).map((e) => e.text) }, null, 1);
            navigator.clipboard?.writeText(txt).then(() => alert('Diagnostics copied — paste them to Claude.')).catch(() => prompt('Copy this:', txt)); }}
            className="rounded-full border border-white/20 px-3 py-1 text-[11.5px] font-bold text-white/80 hover:text-white">Copy diagnostics</button>
        </div>
      )}
      {b?.snipes?.on && (
        <div className="num mx-6 mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-2xl border border-accent/40 bg-gradient-to-r from-accent/[0.12] to-flash/[0.08] px-4 py-2.5 text-[12px]">
          <span className="font-extrabold text-accent">✦ Surreal · sniper-compounder</span>
          <span><b>{b.snipes.n.toLocaleString()}</b> snipes · <b>{b.snipes.n ? Math.round((b.snipes.wins / b.snipes.n) * 100) : 0}%</b> won · <b className={b.snipes.pnl_sol >= 0 ? 'text-up' : 'text-down'}>◎{b.snipes.pnl_sol >= 0 ? '+' : ''}{b.snipes.pnl_sol.toFixed(3)}</b></span>
          <span><b>{b.snipes.per_hour}</b> fast trades / hour</span>
          <span>open <b>{b.snipes.open}</b> · 💥 power <b className="text-up">{b.snipes.power_open}</b> <span className="text-white/40">({b.snipes.power} total)</span></span>
          {b.compound && <span>pot <b className={b.compound.growth_pct >= 0 ? 'text-up' : 'text-down'}>{b.compound.growth_pct >= 0 ? '+' : ''}{b.compound.growth_pct}%</b> compounded</span>}
          <span className="text-white/50">last buy <b className={b.idle_s != null && b.idle_s > 60 ? 'text-warn' : 'text-white'}>{b.idle_s != null ? `${b.idle_s}s ago` : 'never'}</b>
            {b.bars?.snipe != null ? ` · snipe bar ${b.bars.snipe}` : ''}{b.bars?.scalp != null ? ` · scalp bar ${b.bars.scalp}` : ''}</span>
          {b.mode !== 'auto' && <span className="font-bold text-warn">Self-driving is off — press Start</span>}
        </div>
      )}
      {b?.scalper?.on && (
        <div className="num mx-6 mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-2xl border border-flash/25 bg-flash/[0.05] px-4 py-2.5 text-[12px]">
          <span className="font-extrabold text-flash">⚡ Scalper</span>
          <span><b>{b.scalper.n.toLocaleString()}</b> scalps · <b>{b.scalper.n ? Math.round((b.scalper.wins / b.scalper.n) * 100) : 0}%</b> won</span>
          <span>stacked <b className={b.scalper.pnl_sol >= 0 ? 'text-up' : 'text-down'}>◎{b.scalper.pnl_sol >= 0 ? '+' : ''}{b.scalper.pnl_sol.toFixed(3)}</b></span>
          {b.scalper.recent_pct != null && <span>last 40 avg <b className={b.scalper.recent_pct >= 0 ? 'text-up' : 'text-down'}>{b.scalper.recent_pct > 0 ? '+' : ''}{b.scalper.recent_pct}%</b></span>}
          <span>open <b>{b.scalper.open}</b> · riding <b className="text-up">{b.scalper.riding}</b></span>
          <span className="text-white/50">bar {Math.round((b.scalper.bar ?? 0) * 100)} · take +{Math.round(((b.scalper.tp ?? 1) - 1) * 100)}% · stop −{Math.round((b.scalper.stop ?? 0) * 100)}% · max {b.scalper.max_s}s</span>
        </div>
      )}
      {b?.last_error && now - b.last_error.ts < 600 && (
        <div className="mx-6 mt-2 rounded-xl border border-down/30 bg-down/10 px-3 py-2 text-[11.5px] text-down">
          ⚠️ Last brain error {ago(b.last_error.ts, now)} ago (it keeps trading): {b.last_error.error}{b.last_error.where ? ` — ${b.last_error.where}` : ''}
        </div>
      )}
      {!!b?.skips && Object.keys(b.skips).length > 0 && (
        <div className="num mx-6 mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/45">
          <span className="text-white/60">Why it passed on trades (last ~minute):</span>
          {Object.entries(b.skips).map(([k, v]) => <span key={k}>{k} <b className="text-white/70">{v}</b></span>)}
        </div>
      )}
      <div className="px-6 pt-2"><Equity pts={b?.equity || []} start={start} /></div>
      <div className="grid gap-px bg-white/[0.06] lg:grid-cols-3">
        <div className="bg-[var(--color-bg)]/60 p-5">
          <div className="eyebrow mb-3 flex items-center gap-2"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-flash" />What it&apos;s thinking</div>
          <ul className="max-h-[420px] space-y-2 overflow-y-auto pr-1 text-[12.5px]">
            <AnimatePresence initial={false}>
              {(b?.log || []).map((e) => (
                <motion.li key={`${e.ts}${e.text}`} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className="leading-snug">
                  <span className="num mr-1.5 text-[10.5px] text-white/35">{ago(e.ts, now)}</span>
                  {e.mint ? <Link href={`/token?a=${e.mint}`} className={`hover:underline ${LOG_TONE[e.kind] || ''}`}>{e.text}</Link> : <span className={LOG_TONE[e.kind] || ''}>{e.text}</span>}
                </motion.li>
              ))}
            </AnimatePresence>
            {!b?.log?.length && <li className="text-white/40">Switch to Self-driving and watch it think.</li>}
          </ul>
        </div>
        <div className="bg-[var(--color-bg)]/60 p-5">
          <div className="eyebrow mb-3">What it&apos;s looking at · value vs its bar</div>
          <ul className="space-y-2">
            {(b?.candidates || []).map((c) => (
              <li key={c.mint} className="text-[12px]" title={c.why}>
                <div className="flex items-center gap-2">
                  <Link href={`/token?a=${c.mint}`} className="w-24 truncate font-semibold hover:underline">${c.symbol || c.mint.slice(0, 5)}</Link>
                  <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div className={`h-full rounded-full ${c.hard ? 'bg-down/50' : c.value >= (b?.threshold ?? 100) ? 'bg-up' : 'bg-white/30'}`} style={{ width: `${c.value}%` }} />
                    <div className="absolute inset-y-0 w-px bg-flash" style={{ left: `${b?.threshold ?? 0}%` }} />
                  </div>
                  <b className="num w-8 text-right">{c.value.toFixed(0)}</b>
                  {c.p_rug != null && <span className={`num w-12 text-right text-[10.5px] ${c.p_rug >= 50 ? 'text-down' : c.p_rug >= 30 ? 'text-warn' : 'text-white/40'}`} title="Rug model: odds it collapses −60% within 20 min">rug {c.p_rug}%</span>}
                  {!!c.scalp && <span className={`num w-10 text-right text-[10.5px] ${c.scalp >= (b?.scalper?.bar ?? 1) ? 'text-flash' : 'text-white/35'}`} title="Scalp score: how good the next minute looks">⚡{Math.round(c.scalp * 100)}</span>}
                  {c.p_up != null && <span className="num hidden w-16 text-right text-[10.5px] text-white/45 sm:inline" title="Timing model: odds of +12% (▲) or −15% (▼) first in the next 3 minutes"><span className="text-up">▲{c.p_up}</span> <span className="text-down">▼{c.p_dn}</span></span>}
                </div>
                <div className="truncate pl-[104px] text-[10.5px] text-white/40">{c.hard ? `✗ ${c.hard}` : c.copy_ranks ? `🪞 ${c.copy_ranks} buying · ${c.why}` : c.why}</div>
              </li>
            ))}
            {!b?.candidates?.length && <li className="text-[12px] text-white/40">Waiting for live launches…</li>}
          </ul>
          <div className="eyebrow mb-2 mt-5">Top wallets buying now · copied only on an influx</div>
          <ul className="space-y-1">
            {(b?.copies || []).map((c) => (
              <li key={c.mint} className="num flex items-center gap-2 text-[11.5px]">
                <Link href={`/token?a=${c.mint}`} className="w-24 truncate font-semibold hover:underline">{c.symbol ? `$${c.symbol}` : c.mint.slice(0, 6)}</Link>
                <span className="text-white/55">{c.wallets} wallet{c.wallets > 1 ? 's' : ''} · best #{c.best_rank}</span>
                <span className="ml-auto text-white/35">{ago(c.last, now)}</span>
              </li>
            ))}
            {!b?.copies?.length && <li className="text-[11.5px] text-white/40">It copies an influx — 3+ top wallets piling into one coin within 5 min (or two top-10s within 2 min) — never a single wallet, and it copies their sells.</li>}
          </ul>
        </div>
        <div className="bg-[var(--color-bg)]/60 p-5">
          <div className="eyebrow mb-3 flex items-center">What it has learned · weight per signal
            <button onClick={() => setAllW(!allW)} className="ml-auto text-[10.5px] normal-case text-white/45 hover:text-white">{allW ? 'top 20' : `all ${b?.weights?.length ?? 0}`}</button></div>
          <ul className="space-y-1.5">
            {(b?.weights || []).slice(0, allW ? 200 : 20).map((w) => (
              <li key={w.key} className="flex items-center gap-2 text-[11.5px]" title={`started at ${w.prior}`}>
                <span className="w-36 truncate text-white/65">{w.label}</span>
                <div className="relative h-2 flex-1 rounded-full bg-white/[0.05]">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-white/20" />
                  <div className={`absolute inset-y-0 rounded-full ${w.w >= 0 ? 'bg-up' : 'bg-down'}`}
                    style={w.w >= 0 ? { left: '50%', width: `${(w.w / maxW) * 50}%` } : { right: '50%', width: `${(-w.w / maxW) * 50}%` }} />
                  <div className="absolute -inset-y-0.5 w-0.5 bg-white/60" style={{ left: `${50 + (w.prior / maxW) * 50}%` }} />
                </div>
                <b className={`num w-11 text-right ${w.w >= 0 ? 'text-up' : 'text-down'}`}>{w.w > 0 ? '+' : ''}{w.w.toFixed(2)}</b>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[10.5px] text-white/35">Bars = what it believes now; white tick = where it started. Winners&apos; signals grow, losers&apos; shrink.</p>
        </div>
      </div>
      <div className="grid gap-px border-t border-white/[0.06] bg-white/[0.06] lg:grid-cols-3">
        <div className="bg-[var(--color-bg)]/60 p-5">
          <div className="eyebrow mb-2">Patterns that keep losing · it backs off these</div>
          <PatList rows={b?.patterns?.worst || []} base={b?.patterns?.base_win_pct} empty="It needs a few trades before it can tell which patterns lose." />
        </div>
        <div className="bg-[var(--color-bg)]/60 p-5">
          <div className="eyebrow mb-2">Patterns that work · it leans in</div>
          <PatList rows={b?.patterns?.best || []} base={b?.patterns?.base_win_pct} empty="Winning patterns show up here as it learns." />
        </div>
        <div className="num bg-[var(--color-bg)]/60 p-5 text-[12px] text-white/65">
          <div className="eyebrow mb-2">Adaptive exits & blacklists</div>
          <p>Stop loss now <b className="text-white">−{b?.exits?.stop_pct ?? '—'}%</b> · trailing ×<b className="text-white">{b?.exits?.trail_mult ?? 1}</b> · patience ×<b className="text-white">{b?.exits?.patience ?? 1}</b></p>
          {!!b?.exits?.ladder?.length && <p className="mt-1 text-[11px] text-white/45">Scales out: {b.exits.ladder.join(' · ')} — the rest rides a trailing stop</p>}
          <p className="mt-1 text-[11px] text-white/45">Copies top traders&apos; sells (×{b?.exits?.smart_follow ?? 1}): right {b?.exits?.smart_right ?? 0}× · wrong {b?.exits?.smart_wrong ?? 0}× · recycled flat coins too early {b?.exits?.too_early ?? 0}× / right {b?.exits?.early_right ?? 0}×</p>
          <p className="mt-1 text-[11px] text-white/45">After every stop it keeps watching: shaken out {b?.exits?.shaken ?? 0}× (stops loosen) · stop was right {b?.exits?.stop_right ?? 0}× (stops tighten) · sold too early {b?.exits?.sold_early ?? 0}× · trailing right {b?.exits?.trail_right ?? 0}×{b?.exits?.watching ? ` · watching ${b.exits.watching} exits now` : ''}</p>
          <p className="mt-3">Blocked devs <b className="text-white">{b?.blocked_devs ?? 0}</b> <span className="text-white/45">(their coin rugged it)</span></p>
          <p className="mt-1">Benched wallets <b className="text-white">{b?.benched?.length ?? 0}</b> <span className="text-white/45">(copying them kept losing)</span></p>
          <ul className="mt-1 space-y-0.5 text-[11px] text-white/45">
            {(b?.benched || []).map((x) => <li key={x.wallet}><Link href={`/wallet?a=${x.wallet}`} className="hover:underline">{x.wallet.slice(0, 4)}…{x.wallet.slice(-4)}</Link> · {x.wins}/{x.n} won · back in {Math.max(0, Math.round((x.until - now) / 3600))}h</li>)}
          </ul>
        </div>
      </div>
      {!!b?.open?.length && <div className="border-t border-flash/20"><Positions rows={b.open} now={now} onChange={load} /></div>}
    </section>
  );
}

function PatList({ rows, base, empty }: { rows: Pat[]; base?: number | null; empty: string }) {
  if (!rows.length) return <p className="text-[11.5px] text-white/40">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.tag} className="flex items-center gap-2 text-[11.5px]">
          <span className="flex-1 truncate text-white/70">{r.text}</span>
          <span className="num text-white/40">{r.n.toFixed(0)}×</span>
          <b className={`num w-10 text-right ${base != null && r.win_pct < base ? 'text-down' : 'text-up'}`}>{r.win_pct}%</b>
          <span className={`num w-14 text-right text-[10.5px] ${r.avg_pnl_pct >= 0 ? 'text-up' : 'text-down'}`}>{r.avg_pnl_pct > 0 ? '+' : ''}{r.avg_pnl_pct}%</span>
        </li>
      ))}
      {base != null && <li className="pt-1 text-[10.5px] text-white/35">overall win rate {base}% · recent trades count most</li>}
    </ul>
  );
}

type Vote = { executor: number; skeptic: number; optimist: number; p_lose: number; p_big: number };
type Nebula = {
  cred: Record<string, number>; bar: number; regime: string; base_lose_pct: number; base_big_pct: number; exploring: number;
  skeptic: { trained: number; accuracy: number | null }; optimist: { trained: number; accuracy: number | null };
  playbooks: Record<string, { play: string; n: number; avg_pct: number }[]>; tracking: { real: number; ghosts: number };
  stats: Record<string, number>; recent_avg_pct: number | null;
  debate: { ts: number; symbol: string; mint: string; go: boolean; veto: boolean; score: number; bar: number; votes: Vote; play: string; style: string;
    size_mult: number; why: { skeptic: string; optimist: string } }[];
};
const BRAIN_META: Record<string, { icon: string; name: string; tone: string; role: string }> = {
  executor: { icon: '⚙️', name: 'Executor', tone: 'text-flash', role: 'finds the trade' },
  skeptic: { icon: '🛡', name: 'Skeptic', tone: 'text-down', role: 'models losing after fees' },
  optimist: { icon: '🚀', name: 'Optimist', tone: 'text-up', role: 'models the runners' },
};
const REGIME_TONE: Record<string, string> = { defensive: 'text-down', aggressive: 'text-up', normal: 'text-white/80' };

function NebulaPanel({ n, now }: { n: Nebula; now: number }) {
  const st = n.stats || {};
  return (
    <div className="mx-6 mt-3 overflow-hidden rounded-2xl border border-accent/30 bg-gradient-to-br from-accent/[0.08] via-transparent to-flash/[0.06]">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <span className="font-extrabold tracking-wide text-accent">✦ NEBULA · 3-brain council</span>
        <span className="text-[12px] text-white/55">every trade is argued out: size, exit playbook, buy or not</span>
        <span className={`num ml-auto text-[12px] font-bold uppercase ${REGIME_TONE[n.regime] || ''}`}>{n.regime}{n.exploring ? ` · exploring ${n.exploring}` : ''}</span>
        <span className="num text-[12px] text-white/60">bar <b className="text-white">{n.bar.toFixed(2)}</b>{n.recent_avg_pct != null ? <> · last trades <b className={n.recent_avg_pct >= 0 ? 'text-up' : 'text-down'}>{n.recent_avg_pct > 0 ? '+' : ''}{n.recent_avg_pct}%</b></> : null}</span>
      </div>
      <div className="grid gap-px bg-white/[0.05] sm:grid-cols-3">
        {Object.entries(BRAIN_META).map(([k, m]) => (
          <div key={k} className="bg-[var(--color-bg)]/70 p-3">
            <div className="flex items-center gap-2"><span className="text-[18px]">{m.icon}</span><b className={m.tone}>{m.name}</b><span className="text-[11px] text-white/40">{m.role}</span></div>
            <div className="mt-1 flex items-end gap-2">
              <span className="display text-[26px]">{n.cred[k]?.toFixed(0)}%</span><span className="mb-1 text-[11px] text-white/45">credibility</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-white/[0.06]"><div className={`h-full rounded-full ${k === 'skeptic' ? 'bg-down' : k === 'optimist' ? 'bg-up' : 'bg-flash'}`} style={{ width: `${n.cred[k] ?? 0}%` }} /></div>
            <div className="num mt-1.5 text-[11px] text-white/50">
              {k === 'skeptic' && <>{(n.skeptic.trained || 0).toLocaleString()} lessons · {n.skeptic.accuracy != null ? `${n.skeptic.accuracy}% right · ` : ''}base loss rate {n.base_lose_pct}% · vetoed {st.vetoed ?? 0} · pulled the plug {st.skeptic_exits ?? 0}×</>}
              {k === 'optimist' && <>{(n.optimist.trained || 0).toLocaleString()} lessons · {n.optimist.accuracy != null ? `${n.optimist.accuracy}% right · ` : ''}runner rate {n.base_big_pct}% · held {st.optimist_holds ?? 0} surges</>}
              {k === 'executor' && <>proposed {st.proposed ?? 0} · approved {st.approved ?? 0} · turned down {st.rejected ?? 0}</>}
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-px bg-white/[0.05] lg:grid-cols-[1.4fr_1fr]">
        <div className="bg-[var(--color-bg)]/70 p-3">
          <div className="eyebrow mb-2">The debate · latest votes</div>
          <ul className="max-h-[230px] space-y-1 overflow-y-auto pr-1 text-[11.5px]">
            {(n.debate || []).map((d, i) => (
              <li key={`${d.ts}${i}`} className="num flex flex-wrap items-center gap-x-2" title={`skeptic: ${d.why?.skeptic || '—'} · optimist: ${d.why?.optimist || '—'}`}>
                <span className="w-9 text-white/35">{ago(d.ts, now)}</span>
                <Link href={`/token?a=${d.mint}`} className="w-20 truncate font-semibold hover:underline">${d.symbol}</Link>
                <span className="text-flash">⚙️{d.votes.executor.toFixed(2)}</span>
                <span className="text-down">🛡{d.votes.skeptic.toFixed(2)}</span>
                <span className="text-up">🚀{d.votes.optimist.toFixed(2)}</span>
                <b className={d.veto ? 'text-down' : d.go ? 'text-up' : 'text-white/45'}>{d.veto ? 'VETO' : d.go ? `GO ×${d.size_mult.toFixed(2)}` : 'no'}</b>
                <span className="text-white/45">{d.style} · {d.play}</span>
              </li>
            ))}
            {!n.debate?.length && <li className="text-white/40">Waiting for the first proposal…</li>}
          </ul>
        </div>
        <div className="bg-[var(--color-bg)]/70 p-3 text-[11.5px]">
          <div className="eyebrow mb-2">Exit playbooks · replayed on every trade &amp; ghost</div>
          {Object.entries(n.playbooks || {}).map(([style, rows]) => (
            <div key={style} className="mb-2">
              <div className="mb-0.5 text-white/55 capitalize">{style}</div>
              <div className="flex flex-wrap gap-1.5">
                {rows.map((r, i) => (
                  <span key={r.play} className={`num rounded-full px-2 py-0.5 ${i === 0 ? 'bg-accent/25 text-white' : 'bg-white/[0.05] text-white/60'}`}>
                    {r.play} <b className={r.avg_pct >= 0 ? 'text-up' : 'text-down'}>{r.avg_pct > 0 ? '+' : ''}{r.avg_pct}%</b> <span className="text-white/35">{r.n.toFixed(0)}</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
          {!Object.keys(n.playbooks || {}).length && <p className="text-white/40">Fills in as trades and ghosts finish.</p>}
          <p className="num mt-2 text-white/50">ghost trades: {st.ghosts_done ?? 0} · saying no saved <b className="text-up">◎{(st.saved_sol ?? 0).toFixed(3)}</b> · missed <b className="text-warn">◎{(st.missed_sol ?? 0).toFixed(3)}</b> · tracking {n.tracking.real} real / {n.tracking.ghosts} ghosts</p>
        </div>
      </div>
    </div>
  );
}
