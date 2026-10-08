'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { NarrativeRadar } from '@/components/discover';
import { Icon } from '@/components/Icon';
import { LiveTape } from '@/components/LiveTape';
import { MarketBar } from '@/components/MarketBar';
import { TopTradesHero } from '@/components/TopTradesHero';
import { AnimatePresence, AreaSpark, Chips, Flash, motion } from '@/components/motion';
import { VerdictBadge } from '@/components/radar';
import { Copy, Panel, SafetyFlags, TokenIcon } from '@/components/ui';
import { api, type Token } from '@/lib/api';
import { ago, clock, pct, pctClass, price, short, usd } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

type SortKey = 'radar_score' | 'vol_m5' | 'vol_h1' | 'vol_h24' | 'liquidity_usd' | 'market_cap' | 'chg_m5' | 'chg_h1' | 'chg_h24' | 'age' | 'holders' | 'bs';
type Preset = 'all' | 'safe' | 'fresh' | 'grad' | 'buy' | 'big';
const PRESETS: Record<Preset, Record<string, any>> = {
  all: {}, safe: { safe_only: true, hide_boosted: true }, fresh: { max_age_min: 60 }, grad: { graduated_only: true },
  buy: { verdict: 'BUY' }, big: { min_mcap: 1_000_000 },
};

const COLS: { key: SortKey | null; label: string }[] = [
  { key: null, label: 'Token' }, { key: null, label: 'Trend' }, { key: 'radar_score', label: 'Radar' }, { key: 'age', label: 'Age' },
  { key: null, label: 'Price' }, { key: 'market_cap', label: 'MCap' }, { key: 'liquidity_usd', label: 'Liq' }, { key: 'vol_m5', label: 'Vol 5m' },
  { key: 'vol_h1', label: 'Vol 1h' }, { key: 'chg_m5', label: '5m' }, { key: 'chg_h1', label: '1h' }, { key: 'chg_h24', label: '24h' },
  { key: 'bs', label: 'B/S 5m' }, { key: null, label: 'Safety' },
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
  const [sparks, setSparks] = useState<Record<string, number[]>>({});
  const [launches, setLaunches] = useState<any[]>([]);
  const [grads, setGrads] = useState<Token[]>([]);
  const [trending, setTrending] = useState<Record<string, any>>({});
  const [news, setNews] = useState<any[]>([]);
  const [sort, setSort] = useState<SortKey>('vol_h1');
  const [preset, setPreset] = useState<Preset>('all');
  const [adv, setAdv] = useState(false);
  const [f, setF] = useState<Record<string, any>>(() => { try { return JSON.parse(localStorage.getItem('radar:filters') || '{}'); } catch { return {}; } });
  const [tab, setTab] = useState('geckoterminal:trending');
  const [lastTick, setLastTick] = useState(0);
  const setFilter = (k: string, v: any) => setF((p) => { const n = { ...p, [k]: v }; try { localStorage.setItem('radar:filters', JSON.stringify(n)); } catch { /* */ } return n; });
  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: '300', min_liq: String(f.min_liq ?? 5000), sort: sort === 'age' || sort === 'bs' ? 'vol_h1' : sort });
    for (const [k, v] of Object.entries({ ...f, ...PRESETS[preset] })) if (k !== 'min_liq' && v !== '' && v != null && v !== false) p.set(k, String(v));
    return p.toString();
  }, [f, sort, preset]);

  useEffect(() => {
    api('/api/launches').then(setLaunches); api('/api/graduated').then(setGrads); api('/api/trending').then(setTrending); api('/api/news').then(setNews);
  }, []);
  useEffect(() => {
    let alive = true;
    const load = () => api<Token[]>(`/api/tokens?${qs}`).then((r) => alive && setTokens(Object.fromEntries(r.map((t) => [t.address, t])))).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [qs]);

  const rows = useMemo(() => Object.values(tokens).filter((t) => t.pair_address).sort((a, b) => sortVal(b, sort) - sortVal(a, sort)).slice(0, 120), [tokens, sort]);
  const sparkKey = rows.slice(0, 60).map((r) => r.address).join(',');
  useEffect(() => {
    if (!sparkKey) return;
    const load = () => api(`/api/sparks?a=${sparkKey}`).then(setSparks).catch(() => {});
    load(); const t = setInterval(load, 30000); return () => clearInterval(t);
  }, [sparkKey]);

  useLive(({ ch, data }) => {
    if (ch === 'tokens') {
      setLastTick(Date.now());
      setTokens((p) => { const n = { ...p }; let hit = false; for (const t of data as Token[]) if (p[t.address]) { n[t.address] = { ...p[t.address], ...t }; hit = true; } return hit ? n : p; });
    } else if (ch === 'launch') setLaunches((p) => [data, ...p].slice(0, 120));
    else if (ch === 'graduated') setGrads((p) => [data, ...p.filter((g) => g.address !== data.address)].slice(0, 60));
    else if (ch === 'trending') setTrending((p) => ({ ...p, [`${data.source}:${data.list}`]: data }));
    else if (ch === 'news') setNews((p) => [...data, ...p].slice(0, 150));
    else if (ch === 'safety')
      setTokens((p) => p[data.token_address] ? { ...p, [data.token_address]: { ...p[data.token_address], mint_authority: data.mint_authority, freeze_authority: data.freeze_authority, lp_locked_pct: data.lp_locked_pct, top10_pct: data.top10_pct, holders: data.holders, rugged: data.rugged, safety_as_of: data.as_of } } : p);
    else if (ch === 'signal') setTokens((p) => p[data.token_address] ? { ...p, [data.token_address]: { ...p[data.token_address], verdict: data.verdict, radar_score: data.score } as any } : p);
  });

  const fresh = lastTick && Date.now() - lastTick < 4000;
  return (
    <div>
      <MarketBar />
      <LiveTape />
      <TopTradesHero />
      <div className="grid gap-3 2xl:grid-cols-[1fr_420px] xl:grid-cols-[1fr_380px]">
        <section className="glass flex min-h-[520px] min-w-0 flex-col overflow-hidden rounded-2xl xl:h-[calc(100vh-200px)]">
          <header className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
            <Icon name="flame" size={15} className="text-up" />
            <h2 className="text-[12px] font-semibold">Hot tokens</h2>
            <span className="num rounded-md bg-white/5 px-1.5 text-[11px] text-mute">{rows.length}</span>
            <span className={`flex items-center gap-1 text-[11px] ${fresh ? 'text-up' : 'text-mute'}`}><span className={`h-1.5 w-1.5 rounded-full ${fresh ? 'live-dot bg-up' : 'bg-mute'}`} />{fresh ? 'streaming' : 'idle'}</span>
            <span className="flex-1" />
            <Chips id="preset" value={preset} onChange={setPreset} options={[
              { value: 'all', label: 'All' }, { value: 'safe', label: '🛡 Safe' }, { value: 'fresh', label: '🌱 < 1h' },
              { value: 'grad', label: '🎓 Graduated' }, { value: 'buy', label: '🟢 BUY' }, { value: 'big', label: '🐋 $1M+' }]} />
            <button onClick={() => setAdv(!adv)} className={`rounded-xl border px-2.5 py-1 text-[12px] transition ${adv ? 'border-accent/60 bg-accent/10 text-fg' : 'border-white/10 text-mute hover:text-fg'}`}>Filters {Object.values(f).filter((v) => v !== '' && v != null && v !== false).length ? `· ${Object.values(f).filter((v) => v !== '' && v != null && v !== false).length}` : ''}</button>
          </header>
          <AnimatePresence initial={false}>
            {adv && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-b border-white/5">
                <FilterBar f={f} set={setFilter} reset={() => { setF({}); try { localStorage.removeItem('radar:filters'); } catch { /* */ } }} />
              </motion.div>
            )}
          </AnimatePresence>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[1080px] border-collapse num text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-panel/95 text-[11px] text-mute backdrop-blur">
                <tr>{COLS.map((c) => (
                  <th key={c.label} onClick={() => c.key && setSort(c.key)}
                    className={`whitespace-nowrap px-2 py-2 text-left font-medium ${c.key ? 'cursor-pointer hover:text-fg' : ''} ${sort === c.key ? 'text-accent2' : ''}`}>
                    {c.label}{sort === c.key ? ' ↓' : ''}
                  </th>))}
                </tr>
              </thead>
              <tbody>
                  {rows.map((t) => (
                    <tr key={t.address} className="flash-in group border-t border-white/[0.04] transition-colors hover:bg-white/[0.035]">
                      <td className="px-2 py-1.5">
                        <Link href={`/token?a=${t.address}`} className="flex items-center gap-2">
                          <TokenIcon src={t.image} symbol={t.symbol} size={24} />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1"><b className="font-sans text-[13px] tracking-tight">{t.symbol || short(t.address)}</b>
                              {t.graduated_at ? <span className="rounded bg-accent2/15 px-1 text-[9px] text-accent2">GRAD</span> : null}
                              {t.boost_amount ? <span className="rounded bg-warn/15 px-1 text-[9px] text-warn" title="Paid boost: often exit liquidity">⚡</span> : null}</span>
                            <span className="block max-w-[130px] truncate font-sans text-[11px] text-mute">{t.name}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-2"><AreaSpark data={sparks[t.address]} w={72} h={24} /></td>
                      <td className="px-2"><span className="flex items-center gap-1"><VerdictBadge v={(t as any).verdict} /><span>{(t as any).radar_score ?? ''}</span></span></td>
                      <td className="px-2 text-mute">{ago(t.launched_at || t.pair_created_at || t.first_seen, now)}</td>
                      <td className="px-2"><Flash value={t.price_usd}>{price(t.price_usd)}</Flash></td>
                      <td className="px-2"><Flash value={t.market_cap ?? t.fdv}>{usd(t.market_cap ?? t.fdv)}</Flash></td>
                      <td className="px-2"><Flash value={t.liquidity_usd}>{usd(t.liquidity_usd)}</Flash></td>
                      <td className="px-2"><Flash value={t.vol_m5}>{usd(t.vol_m5)}</Flash></td>
                      <td className="px-2"><Flash value={t.vol_h1}>{usd(t.vol_h1)}</Flash></td>
                      <td className={`px-2 ${pctClass(t.chg_m5)}`}>{pct(t.chg_m5)}</td>
                      <td className={`px-2 ${pctClass(t.chg_h1)}`}>{pct(t.chg_h1)}</td>
                      <td className={`px-2 ${pctClass(t.chg_h24)}`}>{pct(t.chg_h24)}</td>
                      <td className="px-2"><BuySell b={t.buys_m5} s={t.sells_m5} /></td>
                      <td className="px-2"><SafetyFlags t={t} /></td>
                    </tr>
                  ))}
                {!rows.length && <tr><td colSpan={COLS.length} className="p-10 text-center text-mute">Waiting for live market data… (check Health if this persists)</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <div className="min-h-[520px] xl:h-[calc(100vh-200px)]"><NarrativeRadar /></div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
        <Panel title={<span className="flex items-center gap-1.5"><span className="live-dot h-1.5 w-1.5 rounded-full bg-up" />New launches · pump.fun</span>} className="h-[380px]">
          <ul>
            <AnimatePresence initial={false}>
              {launches.slice(0, 60).map((l) => (
                <motion.li key={l.address} layout initial={{ opacity: 0, x: -12, backgroundColor: 'rgba(124,140,255,.15)' }} animate={{ opacity: 1, x: 0, backgroundColor: 'rgba(0,0,0,0)' }}
                  transition={{ duration: 0.5 }} className="flex items-center gap-2 border-b border-white/[0.04] px-3 py-1.5">
                  <span className="num w-14 shrink-0 text-[11px] text-mute">{clock(l.first_seen)}</span>
                  <Link href={`/token?a=${l.address}`} className="min-w-0 flex-1 truncate"><b>{l.symbol}</b> <span className="text-mute">{l.name}</span></Link>
                  <span className="num text-[11px] text-mute">{l.mcap_usd ? usd(l.mcap_usd) : l.pump_mcap_sol ? `${(+l.pump_mcap_sol).toFixed(0)} SOL` : ''}</span>
                  <Copy text={l.address} label="CA" />
                </motion.li>
              ))}
            </AnimatePresence>
            {!launches.length && <li className="p-4 text-center text-mute">Waiting for PumpPortal stream…</li>}
          </ul>
        </Panel>
        <Panel title="Graduated · pump.fun → AMM" className="h-[380px]">
          <ul>
            {grads.map((g) => (
              <li key={g.address} className="flex items-center gap-2 border-b border-white/[0.04] px-3 py-1.5">
                <span className="num w-10 shrink-0 text-[11px] text-mute">{ago(g.graduated_at, now)}</span>
                <Link href={`/token?a=${g.address}`} className="min-w-0 flex-1 truncate"><b>{g.symbol || short(g.address)}</b> <span className="text-mute">{g.name}</span></Link>
                <span className="num text-[11px]">{usd(g.market_cap ?? g.fdv)}</span><SafetyFlags t={g} />
              </li>
            ))}
            {!grads.length && <li className="p-4 text-center text-mute">No graduations seen yet</li>}
          </ul>
        </Panel>
        <Panel title="Trending lists" className="h-[380px]" right={
          <select value={tab} onChange={(e) => setTab(e.target.value)} className="rounded-lg border border-white/10 bg-panel2 px-1.5 py-0.5">
            {Object.keys({ 'geckoterminal:trending': 1, 'geckoterminal:new': 1, 'dexscreener:boosts_top': 1, 'dexscreener:takeovers': 1, 'jupiter:recent': 1, 'coingecko:trending': 1, ...trending })
              .filter((k) => !/polymarket|kalshi|ff_calendar/.test(k)).map((k) => <option key={k} value={k}>{k.replace(':', ' · ')}</option>)}
          </select>}>
          <TrendingList data={trending[tab]} now={now} />
        </Panel>
        <Panel title="Breaking news & social" className="h-[380px]">
          <ul>
            {news.map((n) => (
              <li key={n.id} className="border-b border-white/[0.04] px-3 py-1.5">
                <div className="flex gap-2 text-[10px] uppercase tracking-wider text-mute"><span>{n.source}</span><span>{ago(n.published || n.fetched, now)}</span>
                  {n.detected?.cashtags?.map((c: string) => <span key={c} className="normal-case text-accent2">${c}</span>)}
                  {n.detected?.solana?.length ? <span className="text-flash">CA</span> : null}</div>
                <a href={n.link} target="_blank" rel="noreferrer" className="hover:text-accent2">{n.title}</a>
              </li>
            ))}
            {!news.length && <li className="p-4 text-center text-mute">Waiting for feeds…</li>}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function BuySell({ b, s }: { b?: number; s?: number }) {
  const tot = (b || 0) + (s || 0);
  if (!tot) return <span className="text-mute">—</span>;
  const pb = ((b || 0) / tot) * 100;
  return (
    <span className="flex items-center gap-1.5" title={`${b} buys / ${s} sells`}>
      <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-down/50"><span className="absolute inset-y-0 left-0 bg-up" style={{ width: `${pb}%` }} /></span>
      <span className="text-[11px] text-mute">{b}/{s}</span>
    </span>
  );
}

function TrendingList({ data, now }: { data?: any; now: number }) {
  if (!data) return <p className="p-4 text-center text-mute">No data yet</p>;
  return (
    <div>
      <p className="px-3 py-1 text-[11px] text-mute">{data.source} · updated {ago(data.as_of, now)} ago</p>
      <ul>
        {data.rows.map((r: any, i: number) => {
          const addr = r.token_address;
          return (
            <li key={i} className="flex items-center gap-2 border-b border-white/[0.04] px-3 py-1.5 num">
              <span className="w-5 text-mute">{i + 1}</span>
              <TokenIcon src={r.image || r.icon} symbol={r.symbol} size={18} />
              {addr ? <Link href={`/token?a=${addr}`} className="min-w-0 flex-1 truncate font-sans"><b>{r.symbol || short(addr)}</b> <span className="text-mute">{r.name || r.description}</span></Link>
                : <span className="min-w-0 flex-1 truncate font-sans"><b>{r.symbol}</b> <span className="text-mute">{r.name}</span></span>}
              {r.vol_h1 != null && <span>{usd(r.vol_h1)}</span>}
              {r.chg_h1 != null && <span className={`w-14 text-right ${pctClass(r.chg_h1)}`}>{pct(r.chg_h1)}</span>}
              {r.chg_24h != null && <span className={`w-14 text-right ${pctClass(r.chg_24h)}`}>{pct(r.chg_24h)}</span>}
              {r.total_amount != null && <span className="text-warn">⚡{r.total_amount}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FilterBar({ f, set, reset }: { f: Record<string, any>; set: (k: string, v: any) => void; reset: () => void }) {
  const inp = 'w-28 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 outline-none transition focus:border-accent';
  const num = (k: string, ph: string, title: string) => (
    <label className="flex flex-col gap-0.5"><span className="text-[10px] uppercase tracking-wider text-mute">{title}</span>
      <input placeholder={ph} value={f[k] ?? ''} onChange={(e) => set(k, e.target.value.replace(/[^0-9.]/g, ''))} className={inp} /></label>
  );
  const chk = (k: string, label: string) => (
    <label className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1 transition ${f[k] ? 'border-accent/50 bg-accent/10' : 'border-white/10'}`}>
      <input type="checkbox" className="accent-[var(--color-accent)]" checked={!!f[k]} onChange={(e) => set(k, e.target.checked)} />{label}</label>
  );
  return (
    <div className="flex flex-wrap items-end gap-3 px-3 py-3 text-[12px]">
      <label className="flex flex-col gap-0.5"><span className="text-[10px] uppercase tracking-wider text-mute">search</span>
        <input placeholder="$ticker / name / CA" value={f.q ?? ''} onChange={(e) => set('q', e.target.value)} className={`${inp} w-44`} /></label>
      <label className="flex flex-col gap-0.5"><span className="text-[10px] uppercase tracking-wider text-mute">chain</span>
        <select value={f.chain ?? ''} onChange={(e) => set('chain', e.target.value)} className={inp}><option value="">all chains</option>{['solana', 'base', 'bsc', 'ethereum'].map((c) => <option key={c}>{c}</option>)}</select></label>
      <label className="flex flex-col gap-0.5"><span className="text-[10px] uppercase tracking-wider text-mute">verdict</span>
        <select value={f.verdict ?? ''} onChange={(e) => set('verdict', e.target.value)} className={inp}><option value="">any</option><option>BUY</option><option>WATCH</option><option>AVOID</option></select></label>
      {num('min_liq', '5000', 'min liquidity $')}{num('min_mcap', '0', 'min mcap $')}{num('max_mcap', '∞', 'max mcap $')}
      {num('min_vol_h1', '0', 'min vol 1h $')}{num('max_age_min', '∞', 'max age (min)')}{num('max_stale_s', '∞', 'fresh within (s)')}
      {chk('safe_only', 'safe only')}{chk('graduated_only', 'graduated')}{chk('hide_boosted', 'hide paid boosts')}
      <button onClick={reset} className="ml-auto rounded-lg px-2 py-1 text-mute hover:text-fg">reset</button>
    </div>
  );
}
