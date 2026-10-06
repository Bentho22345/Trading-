'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { MarketBar } from '@/components/MarketBar';
import { Copy, Panel, SafetyFlags, TokenIcon } from '@/components/ui';
import { api, type Token } from '@/lib/api';
import { ago, clock, pct, pctClass, price, short, usd } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

type SortKey = 'vol_m5' | 'vol_h1' | 'vol_h24' | 'liquidity_usd' | 'market_cap' | 'chg_m5' | 'chg_h1' | 'chg_h24' | 'age' | 'holders' | 'bs';

const COLS: { key: SortKey | null; label: string; cls?: string }[] = [
  { key: null, label: 'Token' }, { key: 'age', label: 'Age' }, { key: null, label: 'Price' },
  { key: 'market_cap', label: 'MCap' }, { key: 'liquidity_usd', label: 'Liq' },
  { key: 'vol_m5', label: 'Vol 5m' }, { key: 'vol_h1', label: 'Vol 1h' }, { key: 'vol_h24', label: 'Vol 24h' },
  { key: 'chg_m5', label: '5m' }, { key: 'chg_h1', label: '1h' }, { key: 'chg_h24', label: '24h' },
  { key: 'bs', label: 'B/S 5m' }, { key: 'holders', label: 'Holders' }, { key: null, label: 'Safety' },
  { key: null, label: 'Updated' },
];

function sortVal(t: Token, k: SortKey): number {
  if (k === 'age') return -(t.launched_at || t.pair_created_at || t.first_seen || 0);
  if (k === 'bs') return (t.buys_m5 || 0) / Math.max(1, t.sells_m5 || 0);
  if (k === 'market_cap') return t.market_cap ?? t.fdv ?? -1;
  return (t as any)[k] ?? -Infinity;
}

export default function Dashboard() {
  const now = useNow();
  const [tokens, setTokens] = useState<Record<string, Token>>({});
  const [launches, setLaunches] = useState<any[]>([]);
  const [grads, setGrads] = useState<Token[]>([]);
  const [trending, setTrending] = useState<Record<string, any>>({});
  const [news, setNews] = useState<any[]>([]);
  const [sort, setSort] = useState<SortKey>('vol_h1');
  const [minLiq, setMinLiq] = useState(5000);
  const [tab, setTab] = useState('geckoterminal:trending');
  const [fresh, setFresh] = useState<Record<string, number>>({});

  useEffect(() => {
    api<Token[]>('/api/tokens?limit=300').then((r) => setTokens(Object.fromEntries(r.map((t) => [t.address, t]))));
    api('/api/launches').then(setLaunches);
    api('/api/graduated').then(setGrads);
    api('/api/trending').then(setTrending);
    api('/api/news').then(setNews);
  }, []);

  useLive(({ ch, data }) => {
    if (ch === 'tokens') {
      setTokens((p) => { const n = { ...p }; for (const t of data as Token[]) n[t.address] = { ...p[t.address], ...t }; return n; });
      setFresh((p) => { const n = { ...p }; for (const t of data) n[t.address] = Date.now(); return n; });
    } else if (ch === 'launch') setLaunches((p) => [data, ...p].slice(0, 120));
    else if (ch === 'graduated') setGrads((p) => [data, ...p.filter((g) => g.address !== data.address)].slice(0, 60));
    else if (ch === 'trending') setTrending((p) => ({ ...p, [`${data.source}:${data.list}`]: data }));
    else if (ch === 'news') setNews((p) => [...data, ...p].slice(0, 150));
    else if (ch === 'safety')
      setTokens((p) => p[data.token_address] ? { ...p, [data.token_address]: { ...p[data.token_address], mint_authority: data.mint_authority, freeze_authority: data.freeze_authority, lp_locked_pct: data.lp_locked_pct, top10_pct: data.top10_pct, holders: data.holders, rugged: data.rugged, safety_as_of: data.as_of } } : p);
  });

  const rows = useMemo(() => Object.values(tokens)
    .filter((t) => t.pair_address && (t.liquidity_usd || 0) >= minLiq)
    .sort((a, b) => sortVal(b, sort) - sortVal(a, sort))
    .slice(0, 150), [tokens, sort, minLiq]);

  return (
    <div>
      <MarketBar />
      <div className="grid gap-2 xl:grid-cols-[1fr_380px]">
        <Panel title={`Hot tokens · ${rows.length}`} className="max-h-[calc(100vh-110px)] min-h-[420px]"
          right={<label className="flex items-center gap-1">min liq
            <select value={minLiq} onChange={(e) => setMinLiq(+e.target.value)} className="rounded border border-line bg-panel2 px-1">
              {[0, 1000, 5000, 20000, 50000, 100000].map((v) => <option key={v} value={v}>{usd(v, 0)}</option>)}
            </select></label>}>
          <table className="w-full min-w-[1100px] border-collapse num">
            <thead className="sticky top-0 bg-panel2 text-[11px] text-mute">
              <tr>{COLS.map((c) => (
                <th key={c.label} onClick={() => c.key && setSort(c.key)}
                  className={`px-2 py-1 text-left font-normal ${c.key ? 'cursor-pointer hover:text-fg' : ''} ${sort === c.key ? 'text-accent' : ''}`}>
                  {c.label}{sort === c.key ? ' ↓' : ''}
                </th>))}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={`${t.address}-${fresh[t.address] || 0}`} className="flash-in border-t border-line/60 hover:bg-panel2">
                  <td className="px-2 py-1">
                    <Link href={`/token?a=${t.address}`} className="flex items-center gap-1.5">
                      <TokenIcon src={t.image} symbol={t.symbol} />
                      <span className="font-semibold">{t.symbol || short(t.address)}</span>
                      <span className="max-w-[120px] truncate text-mute">{t.name}</span>
                      {t.graduated_at ? <span className="rounded bg-accent/15 px-1 text-[10px] text-accent" title="Graduated from pump.fun">GRAD</span> : null}
                      {t.boost_amount ? <span className="rounded bg-warn/15 px-1 text-[10px] text-warn" title="Paid DexScreener boost — often exit liquidity">⚡{t.boost_amount}</span> : null}
                    </Link>
                  </td>
                  <td className="px-2 text-mute">{ago(t.launched_at || t.pair_created_at || t.first_seen, now)}</td>
                  <td className="px-2">{price(t.price_usd)}</td>
                  <td className="px-2">{usd(t.market_cap ?? t.fdv)}</td>
                  <td className="px-2">{usd(t.liquidity_usd)}</td>
                  <td className="px-2">{usd(t.vol_m5)}</td>
                  <td className="px-2">{usd(t.vol_h1)}</td>
                  <td className="px-2">{usd(t.vol_h24)}</td>
                  <td className={`px-2 ${pctClass(t.chg_m5)}`}>{pct(t.chg_m5)}</td>
                  <td className={`px-2 ${pctClass(t.chg_h1)}`}>{pct(t.chg_h1)}</td>
                  <td className={`px-2 ${pctClass(t.chg_h24)}`}>{pct(t.chg_h24)}</td>
                  <td className="px-2"><span className="text-up">{t.buys_m5 ?? '—'}</span>/<span className="text-down">{t.sells_m5 ?? '—'}</span></td>
                  <td className="px-2">{t.holders?.toLocaleString() ?? '—'}</td>
                  <td className="px-2"><SafetyFlags t={t} /></td>
                  <td className={`px-2 text-[11px] ${t.as_of && now - t.as_of > 300 ? 'text-down' : 'text-mute'}`}>{ago(t.as_of, now)}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={COLS.length} className="p-6 text-center text-mute">Waiting for DexScreener data… (check Health if this persists)</td></tr>}
            </tbody>
          </table>
        </Panel>

        <div className="grid gap-2 xl:max-h-[calc(100vh-110px)] xl:grid-rows-[1.3fr_1fr]">
          <Panel title={<>New launches <span className="text-up">● live</span></>} right={<span>pump.fun via PumpPortal</span>}>
            <ul>
              {launches.map((l) => (
                <li key={l.address} className="flash-in flex items-center gap-2 border-b border-line/50 px-2 py-1 hover:bg-panel2">
                  <span className="w-14 shrink-0 text-mute num">{clock(l.first_seen)}</span>
                  <Link href={`/token?a=${l.address}`} className="min-w-0 flex-1 truncate">
                    <b>{l.symbol}</b> <span className="text-mute">{l.name}</span>
                  </Link>
                  <span className="num text-mute" title="Market cap from pump.fun bonding curve × Coinbase SOL price">
                    {l.mcap_usd ? usd(l.mcap_usd) : l.pump_mcap_sol ? `${(+l.pump_mcap_sol).toFixed(0)} SOL` : ''}
                  </span>
                  <Copy text={l.address} label="CA" />
                </li>
              ))}
              {!launches.length && <li className="p-4 text-center text-mute">Waiting for PumpPortal stream…</li>}
            </ul>
          </Panel>
          <Panel title="Graduated (pump.fun → AMM)">
            <ul>
              {grads.map((g) => (
                <li key={g.address} className="flex items-center gap-2 border-b border-line/50 px-2 py-1 hover:bg-panel2">
                  <span className="w-10 shrink-0 text-mute num">{ago(g.graduated_at, now)}</span>
                  <Link href={`/token?a=${g.address}`} className="min-w-0 flex-1 truncate"><b>{g.symbol || short(g.address)}</b> <span className="text-mute">{g.name}</span></Link>
                  <span className="num">{usd(g.market_cap ?? g.fdv)}</span>
                  <span className="num text-mute">liq {usd(g.liquidity_usd)}</span>
                  <SafetyFlags t={g} />
                </li>
              ))}
              {!grads.length && <li className="p-4 text-center text-mute">No graduations seen yet</li>}
            </ul>
          </Panel>
        </div>
      </div>

      <div className="mt-2 grid gap-2 lg:grid-cols-2 xl:grid-cols-[1.2fr_1fr_1fr]">
        <Panel title="Trending" className="h-[420px]" right={
          <select value={tab} onChange={(e) => setTab(e.target.value)} className="rounded border border-line bg-panel2 px-1">
            {Object.keys({ 'geckoterminal:trending': 1, 'geckoterminal:new': 1, 'dexscreener:boosts_top': 1, 'dexscreener:boosts_latest': 1, 'dexscreener:profiles': 1, 'coingecko:trending': 1, ...trending })
              .filter((k) => !k.startsWith('polymarket') && !k.startsWith('kalshi')).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>}>
          <TrendingList data={trending[tab]} now={now} />
        </Panel>
        <Panel title="Breaking news & social" className="h-[420px]" right={<span>RSS · Reddit · Google</span>}>
          <ul>
            {news.map((n) => (
              <li key={n.id} className="border-b border-line/50 px-2 py-1">
                <div className="flex gap-2 text-[11px] text-mute"><span>{n.source}</span><span>{ago(n.published || n.fetched, now)}</span>
                  {n.detected?.cashtags?.map((c: string) => <span key={c} className="text-accent">${c}</span>)}
                  {n.detected?.solana?.length ? <span className="text-flash">CA!</span> : null}
                </div>
                <a href={n.link} target="_blank" rel="noreferrer" className="hover:text-accent">{n.title}</a>
              </li>
            ))}
            {!news.length && <li className="p-4 text-center text-mute">Waiting for feeds…</li>}
          </ul>
        </Panel>
        <Panel title="Prediction markets (odds swings = news)" className="h-[420px]">
          <ul>
            {(trending['polymarket:top']?.rows || []).map((m: any) => (
              <li key={m.id} className="flex items-center gap-2 border-b border-line/50 px-2 py-1">
                <a href={m.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:text-accent" title={m.question}>{m.question}</a>
                <span className="num">{m.last_price != null ? `${(m.last_price * 100).toFixed(0)}¢` : '—'}</span>
                <span className={`num w-12 text-right ${pctClass(m.chg_1h)}`} title="1h odds change">{m.chg_1h != null ? `${(m.chg_1h * 100).toFixed(1)}` : '—'}</span>
              </li>
            ))}
            {(trending['kalshi:top']?.rows || []).slice(0, 15).map((m: any) => (
              <li key={m.ticker} className="flex items-center gap-2 border-b border-line/50 px-2 py-1">
                <span className="text-[10px] text-mute">KALSHI</span>
                <a href={`https://kalshi.com/markets/${m.ticker}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:text-accent" title={m.title}>{m.title}</a>
                <span className="num">{m.last_price != null ? `${m.last_price}¢` : '—'}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function TrendingList({ data, now }: { data?: any; now: number }) {
  if (!data) return <p className="p-4 text-center text-mute">No data yet</p>;
  return (
    <div>
      <p className="px-2 py-1 text-[11px] text-mute">{data.source} · updated {ago(data.as_of, now)} ago</p>
      <ul>
        {data.rows.map((r: any, i: number) => {
          const addr = r.token_address;
          return (
            <li key={i} className="flex items-center gap-2 border-b border-line/50 px-2 py-1 hover:bg-panel2 num">
              <span className="w-5 text-mute">{i + 1}</span>
              <TokenIcon src={r.image || r.icon} symbol={r.symbol} size={16} />
              {addr ? <Link href={`/token?a=${addr}`} className="min-w-0 flex-1 truncate"><b>{r.symbol || short(addr)}</b> <span className="text-mute">{r.name || r.description}</span></Link>
                : <span className="min-w-0 flex-1 truncate"><b>{r.symbol}</b> <span className="text-mute">{r.name}</span></span>}
              {r.vol_h1 != null && <span title="Vol 1h">{usd(r.vol_h1)}</span>}
              {r.liquidity_usd != null && <span className="text-mute" title="Liquidity">{usd(r.liquidity_usd)}</span>}
              {r.chg_h1 != null && <span className={`w-14 text-right ${pctClass(r.chg_h1)}`}>{pct(r.chg_h1)}</span>}
              {r.chg_24h != null && <span className={`w-14 text-right ${pctClass(r.chg_24h)}`}>{pct(r.chg_24h)}</span>}
              {r.total_amount != null && <span className="text-warn" title="Paid boost total">⚡{r.total_amount}</span>}
              {r.chain && r.chain !== 'solana' && <span className="text-[10px] text-mute">{r.chain}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
