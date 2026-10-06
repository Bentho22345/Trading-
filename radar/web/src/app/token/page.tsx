'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { Chart } from '@/components/Chart';
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
    } else if (ch === 'safety' && data.token_address === a) {
      load();
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
        <div>
          <h1 className="text-lg font-bold">{t.symbol || short(a)} <span className="text-sm font-normal text-mute">{t.name}</span>
            {t.graduated_at && <span className="ml-2 rounded bg-accent/15 px-1 text-[11px] text-accent">GRADUATED {ago(t.graduated_at, now)} ago</span>}
            {t.boost_amount ? <span className="ml-2 rounded bg-warn/15 px-1 text-[11px] text-warn" title="Paid promotion is a risk flag">⚡ {t.boost_amount} paid boosts</span> : null}
          </h1>
          <div className="flex items-center gap-2 text-[11px] text-mute">
            <span className="num">{a}</span><Copy text={a} />
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
        <Panel title="Chart" className="h-[460px]"><Chart address={a} /></Panel>
        <Panel title="Safety report" className="h-[460px]" right={<>
          {s && <AsOf ts={s.as_of} now={now} staleAfter={600} source="RugCheck" />}
          <button onClick={() => api(`/api/token/${a}/safety`, { method: 'POST' })} className="rounded border border-line px-1 hover:text-accent">↻</button></>}>
          <SafetyPanel s={s} t={t} />
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

function WatchButton({ address, initial }: { address: string; initial: boolean }) {
  const [w, setW] = useState(initial);
  return (
    <button onClick={() => api(`/api/watchlist/${address}`, { method: w ? 'DELETE' : 'POST' }).then((r) => setW(r.watched))}
      className={`rounded border px-2 py-1 ${w ? 'border-accent text-accent' : 'border-line hover:border-accent'}`}>
      {w ? '★ Watching' : '☆ Watch'}
    </button>
  );
}
