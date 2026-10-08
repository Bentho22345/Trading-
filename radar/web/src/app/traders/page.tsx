'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlashPrefs } from '@/components/FlashPrefs';
import { Icon } from '@/components/Icon';
import { AnimatePresence, AreaSpark, Chips, motion } from '@/components/motion';
import { CountUp, money, Reveal, Ring, WalletAvatar } from '@/components/whoop';
import { api } from '@/lib/api';
import { ago, short } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

type Win = '7d' | '30d' | '1y';
type Sort = 'rank' | 'pnl' | 'roi' | 'win_rate' | 'volume' | 'recent';

export default function TradersPage() {
  const now = useNow(10000);
  const [win, setWin] = useState<Win>('30d');
  const [sort, setSort] = useState<Sort>('rank');
  const [q, setQ] = useState('');
  const [followed, setFollowed] = useState(false);
  const [minTokens, setMinTokens] = useState<'0' | '5' | '10' | '25'>('0');
  const [data, setData] = useState<{ rows: any[]; total: number; pool: number; cap: number; top_n: number } | null>(null);
  const [pages, setPages] = useState(1);
  const [showImport, setShowImport] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const qs = `win=${win}&sort=${sort}&q=${encodeURIComponent(q)}&followed=${followed}&min_tokens=${minTokens}&limit=${pages * 100}`;
  const load = useCallback(() => api(`/api/traders?${qs}`).then(setData).catch(() => {}), [qs]);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);
  useEffect(() => setPages(1), [win, sort, q, followed, minTokens]);
  useLive(({ ch }) => { if (ch === 'traders_ranked') load(); });
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting && data && data.rows.length < data.total) setPages((p) => p + 1); }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [data]);
  const follow = (a: string, on: boolean) => api(`/api/traders/${a}/follow`, { method: 'POST', body: JSON.stringify({ on }) }).then(load);

  return (
    <div className="pt-4">
      <Reveal className="mb-10 grid items-end gap-8 lg:grid-cols-[1fr_auto]">
        <div>
          <div className="eyebrow mb-3">Top traders · Solana</div>
          <h1 className="display text-[64px] md:text-[110px]">The top <span className="text-up">1,000</span></h1>
          <p className="mt-4 max-w-2xl text-[16px] text-white/60">Ranked from a pool of up to 5,000 wallets on real on-chain trades: profit (realized + open), smoothed win rate,
            median ROI and consistency. Coins bought before Radar’s data starts are left out instead of guessed. Bots and MEV are filtered.</p>
        </div>
        <div className="flex gap-6">
          <Ring value={data?.pool} max={data?.cap || 5000} size={120} color="var(--color-accent)" label="Wallet pool"><CountUp value={data?.pool} className="stat text-[30px]" /></Ring>
          <Ring value={data?.total} max={data?.top_n || 1000} size={120} color="var(--color-up)" label={`Ranked · ${win}`}><CountUp value={data?.total} className="stat text-[30px]" /></Ring>
        </div>
      </Reveal>

      <div className="sticky top-[60px] z-20 -mx-1 mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-white/[0.06] bg-black/80 p-2 backdrop-blur-xl">
        <Chips id="tw" value={win} onChange={setWin} options={[{ value: '7d', label: '7D' }, { value: '30d', label: '30D' }, { value: '1y', label: '1Y' }]} />
        <Chips id="tsrt" value={sort} onChange={setSort} options={[{ value: 'rank', label: 'Rank' }, { value: 'pnl', label: 'P&L' }, { value: 'roi', label: 'ROI' },
          { value: 'win_rate', label: 'Win rate' }, { value: 'volume', label: 'Volume' }, { value: 'recent', label: 'Most recent' }]} />
        <Chips id="tmin" value={minTokens} onChange={setMinTokens} options={[{ value: '0', label: 'Any' }, { value: '5', label: '5+ coins' }, { value: '10', label: '10+' }, { value: '25', label: '25+' }]} />
        <button onClick={() => setFollowed(!followed)} className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[12px] transition ${followed ? 'border-warn/50 bg-warn/10 text-warn' : 'border-white/10 text-white/60 hover:text-white'}`}>
          <Icon name="star" size={13} /> Following
        </button>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search wallet or label"
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[13px] outline-none focus:border-white/40 md:max-w-xs" />
        <FlashPrefs />
        <button onClick={() => setShowImport(!showImport)} className="btn-ghost !py-2 !text-[11px]">Import & sources</button>
      </div>
      <AnimatePresence>{showImport && <ImportPanel onDone={load} />}</AnimatePresence>

      <div className="overflow-x-auto rounded-3xl border border-white/[0.06]">
        <table className="w-full min-w-[980px] border-collapse">
          <thead className="text-left">
            <tr className="eyebrow border-b border-white/[0.06] [&>th]:px-4 [&>th]:py-3 [&>th]:font-semibold">
              <th className="w-16">#</th><th>Trader</th><th className="text-right">P&L</th><th className="text-right">ROI</th><th>Win rate</th>
              <th className="text-right">Coins</th><th>Best trade</th><th>Trend</th><th>Active</th><th>Data</th><th />
            </tr>
          </thead>
          <tbody>
            {(data?.rows || []).map((t, i) => (
              <motion.tr key={t.address} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 20) * 0.015 }}
                className="group border-b border-white/[0.04] transition-colors hover:bg-white/[0.025] [&>td]:px-4 [&>td]:py-3">
                <td><span className={`stat text-[30px] ${t.rank <= 3 ? 'text-white' : 'text-white/35'}`}>{t.rank}</span></td>
                <td>
                  <Link href={`/wallet?a=${t.address}`} className="flex items-center gap-3">
                    <WalletAvatar address={t.address} size={34} />
                    <span className="min-w-0"><span className="block truncate font-semibold group-hover:underline">{t.label || short(t.address, 5)}</span>
                      <span className="block text-[11px] text-white/40">{short(t.address, 6)}</span></span>
                  </Link>
                </td>
                <td className="text-right"><span className={`stat text-[24px] ${t.pnl_usd >= 0 ? 'text-up' : 'text-down'}`}>{money(t.pnl_usd)}</span>
                  <div className="text-[11px] text-white/40">{money(t.realized_usd)} realized</div></td>
                <td className={`stat text-right text-[20px] ${t.roi >= 0 ? 'text-up' : 'text-down'}`}>{t.roi != null ? `${t.roi > 0 ? '+' : ''}${t.roi}%` : '—'}</td>
                <td>
                  <div className="flex items-center gap-2">
                    <Ring value={t.win_rate} size={36} stroke={4} color={t.win_rate >= 50 ? 'var(--color-up)' : 'var(--color-warn)'} />
                    <span className="stat text-[18px]">{t.win_rate != null ? `${Math.round(t.win_rate)}%` : '—'}</span>
                    <span className="text-[11px] text-white/35">{t.wins}/{t.wins + t.losses}</span>
                  </div>
                </td>
                <td className="text-right"><span className="stat text-[18px]">{t.tokens}</span><div className="text-[11px] text-white/40">{t.trades} trades</div></td>
                <td>{t.best_token ? <Link href={`/token?a=${t.best_token}`} className="text-[13px] hover:underline"><b>{t.best_symbol || short(t.best_token)}</b> <span className="text-up">{t.best_roi > 0 ? '+' : ''}{Math.round(t.best_roi)}%</span></Link> : '—'}</td>
                <td><AreaSpark data={(t.series || []).map((p: any) => p[1])} w={100} h={30} /></td>
                <td className="text-[12px] text-white/50">{ago(t.last_trade, now)} ago</td>
                <td className="text-[11px] text-white/40" title={`sources: ${(t.sources || []).join(', ')}`}>since {new Date((t.coverage_from || 0) * 1000).toLocaleDateString()}<br />{(t.sources || []).slice(0, 2).join(' · ')}</td>
                <td><button onClick={() => follow(t.address, !t.followed)} title={t.followed ? 'Unfollow' : 'Follow: alert me on every trade'}
                  className={`rounded-full p-2 transition ${t.followed ? 'text-warn' : 'text-white/25 hover:text-white'}`}><Icon name="star" size={16} /></button></td>
              </motion.tr>
            ))}
          </tbody>
        </table>
        {!data && <div className="space-y-2 p-4">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-14" />)}</div>}
        {data && !data.rows.length && <div className="p-16 text-center text-white/45">No ranked traders for this filter yet. Rankings need ≥3 coins and ≥5 trades per wallet in the window.</div>}
      </div>
      <div ref={sentinel} className="py-6 text-center text-[12px] text-white/35">{data ? `Showing ${data.rows.length.toLocaleString()} of ${data.total.toLocaleString()}` : ''}</div>
    </div>
  );
}

function ImportPanel({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [msg, setMsg] = useState('');
  const [st, setSt] = useState<any>(null);
  useEffect(() => { api('/api/traders/status').then(setSt).catch(() => {}); }, []);
  const run = (body: any) => api('/api/traders/import', { method: 'POST', body: JSON.stringify(body) })
    .then((r) => { setMsg(`Imported ${r.imported} wallet${r.imported === 1 ? '' : 's'}. They’re pinned to the pool, followed live, and backfilled with Helius if connected.`); setText(''); onDone(); })
    .catch((e) => setMsg(String(e.message)));
  return (
    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="mb-4 overflow-hidden">
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="glass rounded-3xl p-5">
          <div className="eyebrow mb-2">Paste wallets</div>
          <p className="mb-2 text-[12px] text-white/50">One per line, optional label after it. Paste lists you’ve collected from any leaderboard or your own research.</p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder={'GJR…xyz  whale #1\n4Nd…abc, kol'} className="w-full rounded-xl border border-white/10 bg-black p-2 font-mono text-[12px] outline-none focus:border-white/40" />
          <button onClick={() => run({ text })} className="btn-primary mt-2 !py-2">Import</button>
        </div>
        <div className="glass rounded-3xl p-5">
          <div className="eyebrow mb-2">Dune query (last 12 months)</div>
          <p className="mb-2 text-[12px] text-white/50">Use any public Dune query that lists top Solana memecoin traders (e.g. “top pump.fun / Raydium traders by PnL, 365d”). Add your Dune key on Connectors, run the query on dune.com once, then paste its ID.</p>
          <input value={query} onChange={(e) => setQuery(e.target.value.replace(/\D/g, ''))} placeholder="query ID, e.g. 3412345" className="w-full rounded-xl border border-white/10 bg-black px-3 py-2 outline-none focus:border-white/40" />
          <button onClick={() => run({ query_id: query })} className="btn-primary mt-2 !py-2" disabled={!query}>Import from Dune</button>
        </div>
        <div className="glass rounded-3xl p-5 text-[12px]">
          <div className="eyebrow mb-2">Where the data comes from</div>
          {st ? (<>
            {st.sources.map((s: any) => <div key={s.source} className="flex justify-between border-b border-white/[0.05] py-1"><span className="font-semibold">{s.source}</span><span className="text-white/50">{s.wallets.toLocaleString()} wallets · {s.trades.toLocaleString()} trades · since {new Date(s.oldest * 1000).toLocaleDateString()}</span></div>)}
            <div className="mt-2 text-white/50">1-year backfill: {st.backfill?.done ?? 0}/{st.backfill?.n ?? 0} wallets done · {st.helius_calls_today} Helius calls today · live-followed: {st.live_subscribed}</div>
            <div className="mt-1 text-white/50">Pinned imports: {st.backfill?.pinned ?? 0} · following: {st.backfill?.followed ?? 0}</div>
          </>) : <div className="skeleton h-24" />}
          <p className="mt-3 text-white/40">Add Helius for up to 365 days of swap history per wallet, Birdeye to seed the top traders of each hot coin. Without keys, Radar ranks from what it sees live on pump.fun and GeckoTerminal.</p>
        </div>
      </div>
      {msg && <p className="mt-2 text-[13px] text-white/70">{msg}</p>}
    </motion.div>
  );
}
