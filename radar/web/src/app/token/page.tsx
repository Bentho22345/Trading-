'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { Chart, type ChartMarker } from '@/components/Chart';
import { SignalCard, useAction } from '@/components/radar';
import { AsOf, Copy, DISCLAIMER, Panel, SafetyFlags, safetyFlags, TokenIcon } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, clock, pct, pctClass, price, short, usd } from '@/lib/format';
import { tokenLinks } from '@/lib/links';
import { setViewing, useLive, useNow } from '@/lib/live';

export default function TokenPage() {
  return <Suspense fallback={<p className="p-6 text-mute">Loading…</p>}><TokenInner /></Suspense>;
}

function TokenInner() {
  const a = (useSearchParams().get('a') || '').trim();
  const now = useNow();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    if (!a) return;
    api(`/api/token/${a}`).then((r) => { setD(r); setErr(''); }).catch((e) => setErr(String(e.message || e)));
  }, [a]);

  useEffect(() => {
    load();
    setViewing(a ? [a] : []);           // promotes this token to the top refresh tier + live trade stream
    return () => setViewing([]);
  }, [a, load]);

  useLive(({ ch, data }) => {
    if (!d) return;
    if (ch === 'tokens') {
      const t = (data as any[]).find((x) => x.address === a);
      if (t) setD((p: any) => ({ ...p, token: { ...p.token, ...t } }));
    } else if (ch === 'trade' && data.mint === a) {
      setD((p: any) => ({ ...p, trades: [data, ...p.trades].slice(0, 200) }));
    } else if ((ch === 'safety' && data.token_address === a) || (ch === 'signal' && data.token_address === a)) {
      load();
    } else if (ch === 'social' && (data.cas || []).includes(a)) {
      setD((p: any) => ({ ...p, social: [data, ...(p.social || [])] }));
    }
  });

  if (!a) return <p className="p-6 text-mute">Paste a contract address in the search box.</p>;
  if (err) return <p className="p-6 text-down">Couldn’t load {short(a)}: {err}</p>;
  if (!d) return <p className="p-6 text-mute">Loading {short(a)}…</p>;

  const t = d.token || { address: a };
  const s = d.safety;
  const buys5 = t.buys_m5 ?? 0, sells5 = t.sells_m5 ?? 0;
  const tiles: [string, string, string?][] = [
    ['Price', price(t.price_usd)], ['MCap', usd(t.market_cap ?? t.fdv)], ['Liquidity', usd(t.liquidity_usd)],
    ['Vol 5m', usd(t.vol_m5)], ['Vol 1h', usd(t.vol_h1)], ['Vol 24h', usd(t.vol_h24)],
    ['Vol/MCap 24h', t.vol_h24 && (t.market_cap || t.fdv) ? `${((t.vol_h24 / (t.market_cap || t.fdv)) * 100).toFixed(0)}%` : '—'],
    ['5m', pct(t.chg_m5), pctClass(t.chg_m5)], ['1h', pct(t.chg_h1), pctClass(t.chg_h1)], ['24h', pct(t.chg_h24), pctClass(t.chg_h24)],
    ['B/S 5m', `${buys5}/${sells5}`, buys5 > sells5 ? 'text-up' : 'text-down'], ['B/S 1h', `${t.buys_h1 ?? '—'}/${t.sells_h1 ?? '—'}`],
    ['Holders', s?.holders?.toLocaleString() ?? '—'], ['Age', ago(t.launched_at || t.pair_created_at || t.first_seen, now)],
  ];

  return (
    <div className="space-y-2">
      <header className="flex flex-wrap items-center gap-3 rounded border border-line bg-panel px-3 py-2">
        <TokenIcon src={t.image} symbol={t.symbol} size={36} />
        <div className="min-w-0">
          <h1 className="text-lg font-bold">{t.symbol || short(a)} <span className="text-sm font-normal text-mute">{t.name}</span>
            {t.graduated_at && <span className="ml-2 rounded bg-accent/15 px-1 text-[11px] text-accent">GRADUATED {ago(t.graduated_at, now)} ago</span>}
            {t.boost_amount ? <span className="ml-2 rounded bg-warn/15 px-1 text-[11px] text-warn" title="Paid promotion is a risk flag">⚡ {t.boost_amount} paid boosts</span> : null}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-mute">
            <span className="num break-all">{a}</span><Copy text={a} />
            {t.deployer && <span>dev <a className="hover:text-accent" href={`https://solscan.io/account/${t.deployer}`} target="_blank" rel="noreferrer">{short(t.deployer)}</a></span>}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-1">
          {tokenLinks(a, t.chain || 'solana', t.pair_address).map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="rounded border border-line px-2 py-1 hover:border-accent hover:text-accent">{l.label} ↗</a>
          ))}
          <WatchButton address={a} initial={d.watched} />
        </div>
      </header>

      <div className="grid grid-cols-3 gap-1 sm:grid-cols-5 lg:grid-cols-7 xl:grid-cols-14">
        {tiles.map(([k, v, c]) => (
          <div key={k} className="rounded border border-line bg-panel px-2 py-1">
            <div className="text-[10px] uppercase text-mute">{k}</div>
            <div className={`num text-sm ${c || ''}`}>{v}</div>
          </div>
        ))}
      </div>
      <p className="text-[11px]"><AsOf ts={t.as_of} now={now} staleAfter={30} source={`DexScreener ${t.dex || ''}`} /></p>

      <div className="grid gap-2 xl:grid-cols-[1fr_380px]">
        <Panel title="Chart · social timeline overlay" className="h-[460px]" right={<span><span className="text-flash">●</span> VIP <span className="text-accent">●</span> post <span className="text-warn">▲</span> signal <span className="text-up">●</span> smart $</span>}>
          <Chart address={a} markers={markers(d)} />
        </Panel>
        <Panel title="Safety report" className="h-[460px]" right={<>
          {s && <AsOf ts={s.as_of} now={now} staleAfter={600} source="RugCheck" />}
          <button onClick={() => api(`/api/token/${a}/safety`, { method: 'POST' })} className="rounded border border-line px-1 hover:text-accent">↻</button></>}>
          <SafetyPanel s={s} t={t} />
        </Panel>
      </div>

      <SignalSection d={d} a={a} now={now} reload={load} />

      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title={`Social timeline · ${(d.social || []).length} posts`} className="h-[360px]" right={d.narrative ? <Link href="/narratives" className="text-accent">{d.narrative.title} · {d.narrative.stage}</Link> : null}>
          <ul>
            {(d.social || []).map((p: any) => (
              <li key={p.id} className="border-b border-line/50 px-2 py-1 text-[12px]">
                <span className="text-[11px] text-mute">{p.source} · {p.author_id?.split(':').slice(1).join(':')} · <span className={p.author_tier === 'vip' ? 'text-flash' : ''}>{p.author_tier}</span> · {ago(p.ts, now)}</span>
                <div>{p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="hover:text-accent">{p.text}</a> : p.text}</div>
              </li>
            ))}
            {!(d.social || []).length && <li className="p-4 text-center text-mute">No posts mention this token or its ticker yet.</li>}
          </ul>
        </Panel>
        <Panel title="Smart-money & KOL activity" className="h-[360px]">
          <ul>
            {(d.smart_trades || []).map((t: any) => (
              <li key={t.id} className="flex gap-2 border-b border-line/50 px-2 py-1 text-[12px] num">
                <span className="text-mute">{clock(t.ts)}</span><span className={t.side === 'buy' ? 'text-up' : 'text-down'}>{t.side}</span>
                <span className={t.kind === 'kol' ? 'text-flash' : ''}>{t.label || short(t.wallet)}</span><span className="text-mute">score {t.score ?? '—'}</span>
                <span className="ml-auto">{t.sol != null ? `${(+t.sol).toFixed(2)} SOL` : ''}</span>
              </li>
            ))}
            {!(d.smart_trades || []).length && <li className="p-4 text-center text-mute">No tracked wallets have traded this token.</li>}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title={<>Live trades <span className="text-up">●</span> pump.fun / PumpSwap</>} className="h-[360px]">
          <table className="w-full num">
            <thead className="sticky top-0 bg-panel2 text-[11px] text-mute"><tr><th className="px-2 text-left font-normal">Time</th><th className="text-left font-normal">Side</th><th className="text-right font-normal">SOL</th><th className="text-right font-normal">USD</th><th className="text-right font-normal">MCap</th><th className="px-2 text-right font-normal">Trader</th></tr></thead>
            <tbody>
              {d.trades.map((x: any) => (
                <tr key={x.signature || x.id} className="flash-in border-t border-line/50">
                  <td className="px-2 text-mute">{clock(x.ts)}</td>
                  <td className={x.side === 'buy' ? 'text-up' : 'text-down'}>{x.side}</td>
                  <td className="text-right">{x.sol != null ? (+x.sol).toFixed(3) : '—'}</td>
                  <td className="text-right">{x.usd != null ? usd(x.usd) : d.sol_usd && x.sol != null ? usd(x.sol * d.sol_usd) : '—'}</td>
                  <td className="text-right">{x.mcap_usd != null ? usd(x.mcap_usd) : d.sol_usd && x.mcap_sol ? usd(x.mcap_sol * d.sol_usd) : '—'}</td>
                  <td className="px-2 text-right"><a href={`https://solscan.io/account/${x.trader}`} target="_blank" rel="noreferrer" className="text-mute hover:text-accent">{short(x.trader)}</a></td>
                </tr>
              ))}
              {!d.trades.length && <tr><td colSpan={6} className="p-4 text-center text-mute">Subscribed to PumpPortal trades for this token — waiting for the next trade…</td></tr>}
            </tbody>
          </table>
        </Panel>
        <Panel title="Pairs" className="h-[360px]">
          <table className="w-full num">
            <thead className="sticky top-0 bg-panel2 text-[11px] text-mute"><tr><th className="px-2 text-left font-normal">DEX</th><th className="text-right font-normal">Price</th><th className="text-right font-normal">Liq</th><th className="text-right font-normal">Vol 24h</th><th className="px-2 text-right font-normal">Updated</th></tr></thead>
            <tbody>
              {d.pairs.map((p: any) => (
                <tr key={p.pair_address} className="border-t border-line/50">
                  <td className="px-2"><a href={p.url} target="_blank" rel="noreferrer" className="hover:text-accent">{p.dex} / {p.quote_symbol}</a></td>
                  <td className="text-right">{price(p.price_usd)}</td><td className="text-right">{usd(p.liquidity_usd)}</td>
                  <td className="text-right">{usd(p.vol_h24)}</td><td className="px-2 text-right text-mute">{ago(p.as_of, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.links && (
            <div className="flex flex-wrap gap-2 border-t border-line p-2">
              {[...(d.links.websites || []), ...(d.links.socials || [])].map((l: any, i: number) => (
                <a key={i} href={l.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{l.label || l.type || 'link'} ↗</a>
              ))}
            </div>
          )}
        </Panel>
      </div>
      <p className="rounded border border-warn/40 bg-warn/5 px-3 py-2 text-warn">⚠ {DISCLAIMER} Radar never holds keys or places trades.</p>
      <p className="text-[11px] text-mute"><Link href="/">← Dashboard</Link></p>
    </div>
  );
}

function SafetyPanel({ s, t }: { s: any; t: any }) {
  if (!s) return <p className="p-4 text-mute">Fetching RugCheck report… (queued within its rate limit)</p>;
  const flags = safetyFlags({ ...t, mint_authority: s.mint_authority, freeze_authority: s.freeze_authority, lp_locked_pct: s.lp_locked_pct, top10_pct: s.top10_pct, safety_as_of: s.as_of });
  return (
    <div className="space-y-2 p-2">
      {s.rugged ? <p className="rounded bg-down/20 p-2 font-bold text-down">RugCheck marks this token as RUGGED.</p> : null}
      {s.mint_authority ? <p className="rounded bg-down/20 p-2 text-down">Mint authority is ACTIVE — the dev can print supply. Hard AVOID.</p> : null}
      {s.freeze_authority ? <p className="rounded bg-down/20 p-2 text-down">Freeze authority is ACTIVE — your tokens can be frozen. Hard AVOID.</p> : null}
      <ul className="space-y-1">
        {flags.map((f) => (
          <li key={f.label} className="flex items-center gap-2">
            <span className={`w-4 text-center ${f.bad == null ? 'text-mute' : f.bad ? 'text-down' : 'text-up'}`}>{f.bad == null ? '?' : f.bad ? '✕' : '✓'}</span>
            <span>{f.title}</span>
          </li>
        ))}
        <li className="flex gap-2"><span className="w-4 text-center text-mute">#</span>RugCheck score {s.score_normalised ?? '—'} (raw {s.score ?? '—'}; lower is safer)</li>
        <li className="flex gap-2"><span className={`w-4 text-center ${s.insiders_detected ? 'text-warn' : 'text-mute'}`}>!</span>Insider wallets detected: {s.insiders_detected ?? '—'}</li>
        {s.creator && <li className="flex gap-2"><span className="w-4" />Creator <a className="text-accent" href={`https://solscan.io/account/${s.creator}`} target="_blank" rel="noreferrer">{short(s.creator)}</a></li>}
      </ul>
      {!!s.risks?.length && (
        <div>
          <h3 className="mb-1 text-[11px] uppercase text-mute">Risks</h3>
          <ul className="space-y-1">
            {s.risks.map((r: any, i: number) => (
              <li key={i} className={`rounded border px-2 py-1 ${r.level === 'danger' ? 'border-down/40 text-down' : 'border-warn/40 text-warn'}`}>
                <b>{r.name}</b> {r.value && <span className="opacity-80">({r.value})</span>}<div className="text-[11px] text-mute">{r.description}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!s.top_holders?.length && (
        <div>
          <h3 className="mb-1 text-[11px] uppercase text-mute">Top holders (AMM vaults excluded)</h3>
          <ul className="num">
            {s.top_holders.slice(0, 10).map((h: any, i: number) => (
              <li key={i} className="flex justify-between">
                <a className="text-mute hover:text-accent" href={`https://solscan.io/account/${h.address}`} target="_blank" rel="noreferrer">{short(h.address)}{h.insider ? ' · insider' : ''}</a>
                <span className={h.pct > 5 ? 'text-warn' : ''}>{(+h.pct).toFixed(2)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <SafetyFlags t={{ ...t, safety_as_of: s.as_of }} />
    </div>
  );
}

function markers(d: any): ChartMarker[] {
  const out: ChartMarker[] = [];
  for (const p of d.social || []) out.push({ ts: p.ts, kind: p.author_tier === 'vip' ? 'vip' : 'post', label: p.author_tier === 'vip' ? `VIP ${p.author_id?.split(':')[1] || ''}` : p.source });
  for (const s of d.signals || []) out.push({ ts: s.ts, kind: 'signal', label: `${s.verdict} ${s.score}` });
  for (const t of d.smart_trades || []) out.push({ ts: t.ts, kind: 'smart', label: `${t.side} ${t.label || 'smart'}` });
  return out.slice(0, 300);
}

function SignalSection({ d, a, now, reload }: { d: any; a: string; now: number; reload: () => void }) {
  const { run, Msg } = useAction();
  const [rules, setRules] = useState<Record<string, string>>(d.rules || {});
  const [pos, setPos] = useState({ entry_price: '', size_usd: '' });
  const sigs = (d.signals || []).map((s: any) => ({
    ...s, token_address: a, symbol: d.token?.symbol, subscores: JSON.parse(s.subscores_json || '{}'), vetoes: JSON.parse(s.vetoes_json || '[]'),
    reasons: JSON.parse(s.reasons_json || '{}'), plan: JSON.parse(s.plan_json || 'null'),
  }));
  const inp = 'w-24 rounded border border-line bg-panel2 px-1 py-0.5';
  return (
    <div className="grid gap-2 xl:grid-cols-[1fr_380px]">
      <div className="space-y-2">
        {sigs[0] ? <SignalCard s={sigs[0]} now={now} /> : <p className="rounded border border-line bg-panel p-3 text-mute">No signal yet for this token.</p>}
        {sigs.length > 1 && <p className="text-[11px] text-mute">History: {sigs.slice(1).map((s: any) => `${s.verdict} ${s.score} (${ago(s.ts, now)} ago)`).join(' · ')}</p>}
      </div>
      <Panel title="Actions">
        <div className="space-y-3 p-2 text-[12px]">
          <div className="flex items-center gap-2">
            <button onClick={() => run(() => api(`/api/token/${a}/evaluate`, { method: 'POST' }), 'Re-scored').then(reload)} className="rounded bg-accent/20 px-2 py-1 text-accent">Score now</button><Msg />
          </div>
          <div>
            <h3 className="text-[10px] uppercase text-mute">Watch alert rules</h3>
            {[['price_above', 'price ≥ $'], ['price_below', 'price ≤ $'], ['chg_h1_above', '1h change ≥ %'], ['chg_h1_below', '1h change ≤ %'], ['liq_below', 'liquidity ≤ $'], ['vol_h1_above', '1h volume ≥ $']].map(([k, l]) => (
              <label key={k} className="flex items-center gap-2"><span className="w-28 text-mute">{l}</span>
                <input value={rules[k] ?? ''} onChange={(e) => setRules({ ...rules, [k]: e.target.value })} className={inp} /></label>
            ))}
            <button onClick={() => run(() => api(`/api/watchlist/${a}`, { method: 'PUT', body: JSON.stringify({ rules: Object.fromEntries(Object.entries(rules).filter(([, v]) => v !== '')) }) }), 'Rules saved')} className="mt-1 rounded border border-line px-2 py-0.5">Save rules</button>
          </div>
          <div>
            <h3 className="text-[10px] uppercase text-mute">I bought this (manual position)</h3>
            <div className="flex flex-wrap gap-1">
              <input placeholder="entry $" value={pos.entry_price} onChange={(e) => setPos({ ...pos, entry_price: e.target.value })} className={inp} />
              <input placeholder="size $" value={pos.size_usd} onChange={(e) => setPos({ ...pos, size_usd: e.target.value })} className={inp} />
              <button onClick={() => run(() => api('/api/positions', { method: 'POST', body: JSON.stringify({ token_address: a, entry_price: +pos.entry_price || d.token?.price_usd, size_usd: +pos.size_usd, signal_id: sigs[0]?.id }) }), 'Tracking position — TP/stop alerts on')} className="rounded border border-line px-2">Track</button>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function WatchButton({ address, initial }: { address: string; initial: boolean }) {
  const [w, setW] = useState(initial);
  return (
    <button onClick={() => api(`/api/watchlist/${address}`, { method: w ? 'DELETE' : 'POST' }).then((r) => setW(r.watched))}
      className={`rounded border px-2 py-1 ${w ? 'border-accent text-accent' : 'border-line hover:border-accent'}`}>
      {w ? '★ Watching' : '☆ Watch'}
    </button>
  );
}
