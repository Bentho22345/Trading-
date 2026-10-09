'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Terminal } from '@/components/home/Terminal';
import { DEFAULT_FILTERS, SnipeCard, useSnipe } from '@/components/snipe';
import { Icon } from '@/components/Icon';
import { AnimatePresence, AreaSpark, Chips, motion } from '@/components/motion';
import { TokenIcon } from '@/components/ui';
import { CountUp, money, onSpot, PnlLine, Reveal, Ring, SectionHead, WalletAvatar } from '@/components/whoop';
import { api, apiCached, peek } from '@/lib/api';
import { ago, pct, pctClass, short, usd } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

export default function Home() {
  const [s, setS] = useState<any>(null);
  const [feed, setFeed] = useState<any[]>([]);
  const load = useCallback(() => apiCached('/api/traders/summary').then((d) => { setS(d); setFeed((f) => (f.length ? f : d.recent)); }).catch(() => {}), []);
  useEffect(() => { const c = peek('/api/traders/summary'); if (c) { setS(c); setFeed(c.recent || []); } }, []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  useLive(({ ch, data }) => {
    if (ch === 'trader_trade') setFeed((f) => [{ ...data, _new: Date.now() }, ...f].slice(0, 40));
    if (ch === 'traders_ranked') load();
  });
  return (
    <div>
      <Hero s={s} feed={feed} />
      <SnipeSpotlight />
      <Buying s={s} />
      <Podium s={s} />
      <section className="mt-28">
        <SectionHead eyebrow="The terminal" title={<>Every coin. <span className="text-white/35">Every second.</span></>}
          sub="Live launches, hot tokens, the narratives forming behind them and the market regime: one screen, streaming." />
        <Terminal />
      </section>
    </div>
  );
}

function Hero({ s, feed }: { s: any; feed: any[] }) {
  const now = useNow();
  return (
    <section className="relative grid min-h-[calc(100vh-90px)] items-center gap-10 pb-10 pt-6 xl:grid-cols-[1.15fr_0.85fr]">
      <div className="hero-orb" aria-hidden />
      <div className="hero-grid" aria-hidden />
      <div>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8 }} className="eyebrow mb-6 flex items-center gap-2">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-up" /> Live · Solana memecoins
        </motion.div>
        <h1 className="display text-[64px] sm:text-[96px] xl:text-[132px]">
          {['Track the', 'top 1,000', 'traders.'].map((line, i) => (
            <span key={line} className="block overflow-hidden">
              <motion.span className={`block ${i === 1 ? 'text-up' : ''}`} initial={{ y: '105%' }} animate={{ y: 0 }}
                transition={{ duration: 0.9, delay: 0.1 + i * 0.12, ease: [0.2, 0.8, 0.2, 1] }}>{line}</motion.span>
            </span>
          ))}
        </h1>
        <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6, duration: 0.7 }}
          className="mt-6 max-w-xl text-[17px] leading-relaxed text-white/60">
          Radar watches a pool of up to 5,000 Solana wallets and ranks the best 1,000 by real, on-chain profit, win rate and consistency.
          Every buy and sell, live.
        </motion.p>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.75, duration: 0.7 }} className="mt-8 flex flex-wrap gap-3">
          <Link href="/traders" className="btn-primary">Explore the leaderboard <Icon name="arrow" size={14} /></Link>
          <a href="#terminal" className="btn-ghost">Open the terminal</a>
        </motion.div>
        <div className="mt-14 grid max-w-2xl grid-cols-2 gap-6 sm:grid-cols-4">
          <Ring value={s?.pool} max={s?.cap || 5000} size={112} color="var(--color-accent)" label="Wallets tracked">
            <CountUp value={s?.pool} className="stat text-[30px]" /><span className="text-[10px] text-white/40">of {(s?.cap || 5000).toLocaleString()}</span>
          </Ring>
          <Ring value={s?.ranked} max={s?.top_n || 1000} size={112} color="var(--color-up)" label="Ranked">
            <CountUp value={s?.ranked} className="stat text-[30px]" /><span className="text-[10px] text-white/40">top {(s?.top_n || 1000).toLocaleString()}</span>
          </Ring>
          <Ring value={s?.trades_1h} max={Math.max(100, (s?.trades_1h || 0) * 1.3)} size={112} color="var(--color-accent2)" label="Trades · 1h">
            <CountUp value={s?.trades_1h} className="stat text-[30px]" />
          </Ring>
          <Ring value={s?.volume_24h} max={Math.max(1, (s?.volume_24h || 0) * 1.25)} size={112} color="var(--color-flash)" label="Volume · 24h">
            <CountUp value={s?.volume_24h} format={(v) => money(v, false)} className="stat text-[26px]" />
          </Ring>
        </div>
      </div>

      <motion.div initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.4, duration: 0.9, ease: [0.2, 0.8, 0.2, 1] }}
        className="glass relative flex h-[620px] flex-col overflow-hidden rounded-[28px]">
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-4">
          <span className="live-dot h-2 w-2 rounded-full bg-up" />
          <span className="eyebrow !text-white">What the top 1,000 are doing</span>
          <Link href="/traders" className="ml-auto text-[11px] uppercase tracking-[0.14em] text-white/40 hover:text-white">All traders →</Link>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <ul className="space-y-1 p-3">
            <AnimatePresence initial={false}>
              {feed.slice(0, 18).map((t, i) => (
                <motion.li key={`${t.wallet}-${t.ts}-${t.mint}-${i}`} layout initial={{ opacity: 0, y: -16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  className="flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-white/[0.04]">
                  <WalletAvatar address={t.wallet} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Link href={`/wallet?a=${t.wallet}`} className="truncate font-semibold hover:underline">{t.label || short(t.wallet, 4)}</Link>
                      {t.rank && <span className="stat rounded-md bg-white/[0.06] px-1.5 text-[12px] text-white/70">#{t.rank}</span>}
                    </div>
                    <div className="text-[12px] text-white/45">{ago(t.ts, now)} ago</div>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${t.side === 'buy' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>{t.side}</span>
                  <Link href={`/token?a=${t.mint}`} className="flex w-28 items-center gap-1.5 truncate">
                    <TokenIcon src={t.image} symbol={t.symbol} size={20} /><span className="truncate font-semibold">{t.symbol || short(t.mint)}</span>
                  </Link>
                  <span className="stat w-20 text-right text-[18px]">{money(t.usd, false)}</span>
                </motion.li>
              ))}
            </AnimatePresence>
            {!feed.length && <li className="p-10 text-center text-white/40">Waiting for the first trade from a ranked wallet…<br /><span className="text-[12px]">Rankings build as Radar observes trades (every few minutes).</span></li>}
          </ul>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[var(--color-surface2)] to-transparent" />
        </div>
      </motion.div>
    </section>
  );
}

function Buying({ s }: { s: any }) {
  const [win, setWin] = useState<'1h' | '24h'>('1h');
  const rows = s?.flows?.[win] || [];
  const maxBuy = Math.max(1, ...rows.map((r: any) => r.bought || 0));
  return (
    <section className="mt-16">
      <SectionHead eyebrow="Smart money flow" title={<>What they’re <span className="text-up">buying</span></>}
        sub="Coins with the most distinct top-1,000 wallets buying, and their net dollar flow (buys minus sells)."
        right={<Chips id="flow" value={win} onChange={setWin} options={[{ value: '1h', label: 'Last hour' }, { value: '24h', label: '24 hours' }]} />} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {rows.map((r: any, i: number) => (
          <Reveal key={r.mint} delay={i * 0.04}>
            <Link href={`/token?a=${r.mint}`} onMouseMove={onSpot} className="glass glass-hover spotlight block rounded-3xl p-5">
              <div className="flex items-center gap-3">
                <TokenIcon src={r.image} symbol={r.symbol} size={40} />
                <div className="min-w-0 flex-1"><div className="display truncate text-[28px]">{r.symbol || short(r.mint)}</div><div className="truncate text-[12px] text-white/45">{r.name}</div></div>
                <div className="text-right"><div className="stat text-[34px] leading-none">{r.buyers}</div><div className="eyebrow">buyers</div></div>
              </div>
              <div className="mt-5 flex items-end justify-between">
                <div><div className="eyebrow">Net flow</div><div className={`stat text-[26px] ${r.net >= 0 ? 'text-up' : 'text-down'}`}>{money(r.net)}</div></div>
                <div className="text-right"><div className="eyebrow">1h</div><div className={`stat text-[22px] ${pctClass(r.chg_h1)}`}>{pct(r.chg_h1)}</div></div>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <motion.div className="h-full rounded-full bg-up" initial={{ width: 0 }} whileInView={{ width: `${(r.bought / maxBuy) * 100}%` }} viewport={{ once: true }} transition={{ duration: 1.1 }} />
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-white/40"><span>bought {money(r.bought, false)}</span><span>mcap {usd(r.market_cap)}</span></div>
            </Link>
          </Reveal>
        ))}
        {!rows.length && <div className="glass col-span-full rounded-3xl p-10 text-center text-white/40">No top-trader buys in this window yet.</div>}
      </div>
    </section>
  );
}

function Podium({ s }: { s: any }) {
  const top = s?.top || [];
  return (
    <section className="mt-28">
      <SectionHead eyebrow="Leaderboard · 30 days" title={<>The best <span className="text-white/35">on-chain.</span></>}
        sub="Ranked by profit (realized + open), Bayesian-smoothed win rate, median ROI and consistency. Bots and one-hit wallets are filtered out."
        right={<Link href="/traders" className="btn-ghost">Full top 1,000 <Icon name="arrow" size={14} /></Link>} />
      <div className="grid gap-4 lg:grid-cols-3">
        {top.slice(0, 3).map((t: any, i: number) => (
          <Reveal key={t.address} delay={i * 0.08}>
            <Link href={`/wallet?a=${t.address}`} onMouseMove={onSpot} className={`glass glass-hover spotlight block rounded-[28px] p-6 ${i === 0 ? 'lg:-translate-y-3' : ''}`}>
              <div className="flex items-start justify-between">
                <span className="display outline-num text-[120px] leading-[0.8]">{t.rank}</span>
                <Ring value={t.win_rate} size={92} stroke={7} color={i === 0 ? 'var(--color-up)' : 'var(--color-accent)'}>
                  <span className="stat text-[22px]">{t.win_rate != null ? `${Math.round(t.win_rate)}%` : '—'}</span><span className="text-[9px] uppercase tracking-widest text-white/40">win</span>
                </Ring>
              </div>
              <div className="mt-4 flex items-center gap-2.5"><WalletAvatar address={t.address} size={28} /><span className="truncate text-[15px] font-semibold">{t.label || short(t.address, 5)}</span></div>
              <div className={`stat mt-3 text-[56px] leading-none ${t.pnl_usd >= 0 ? 'text-up' : 'text-down'}`}>{money(t.pnl_usd)}</div>
              <div className="mt-1 text-[12px] text-white/45">ROI {t.roi != null ? `${t.roi > 0 ? '+' : ''}${t.roi}%` : '—'} · {t.tokens} coins · {t.trades} trades</div>
              <div className="mt-4"><PnlLine series={t.series} h={90} /></div>
            </Link>
          </Reveal>
        ))}
      </div>
      <div className="mt-4 overflow-hidden rounded-3xl border border-white/[0.06]">
        {top.slice(3, 10).map((t: any, i: number) => (
          <Reveal key={t.address} delay={i * 0.03} y={10}>
            <Link href={`/wallet?a=${t.address}`} className="flex items-center gap-4 border-b border-white/[0.05] px-5 py-3.5 transition hover:bg-white/[0.03]">
              <span className="stat w-10 text-[26px] text-white/40">{t.rank}</span>
              <WalletAvatar address={t.address} size={30} />
              <span className="min-w-0 flex-1 truncate font-semibold">{t.label || short(t.address, 5)}</span>
              <AreaSpark data={(t.series || []).map((p: any) => p[1])} w={110} h={28} />
              <span className="hidden w-20 text-right text-white/50 sm:block">{t.win_rate != null ? `${Math.round(t.win_rate)}% win` : ''}</span>
              <span className={`stat w-28 text-right text-[24px] ${t.pnl_usd >= 0 ? 'text-up' : 'text-down'}`}>{money(t.pnl_usd)}</span>
            </Link>
          </Reveal>
        ))}
        {!top.length && <div className="p-10 text-center text-white/40">The leaderboard fills in as Radar observes trades. Add a Helius key for 1-year history, or import wallets on Top Traders.</div>}
      </div>
    </section>
  );
}

const SPOT_FILTERS = { ...DEFAULT_FILTERS, tiers: ['SNIPE', 'WATCH'] };

function SnipeSpotlight() {
  const { list, meta, now } = useSnipe(SPOT_FILTERS);
  const [proof, setProof] = useState<any>(null);
  useEffect(() => { api('/api/snipe/proof?hours=24').then(setProof).catch(() => {}); }, []);
  const st = proof?.stats;
  return (
    <section className="mt-16">
      <SectionHead eyebrow="Sniper · live" title={<>Be first. <span className="text-white/35">Then prove it.</span></>}
        sub="Every pump.fun launch is scored from its first trade by six live detectors — top wallets buying, curve velocity, organic flow, dev track record, meta match and social spread. Calls are logged and graded." />
      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          <AnimatePresence initial={false} mode="popLayout">
            {list.slice(0, 6).map((r) => (
              <motion.div key={r.mint} layout="position" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}>
                <SnipeCard r={r} now={now} />
              </motion.div>
            ))}
          </AnimatePresence>
          {!list.length && <div className="glass col-span-full rounded-3xl p-10 text-center text-white/45">Scoring {meta?.tracking ?? 0} live launches — nothing is hot this second.</div>}
        </div>
        <div className="glass spotlight flex flex-col justify-between rounded-3xl p-6" onMouseMove={onSpot}>
          <div>
            <div className="eyebrow mb-4">Last 24 hours</div>
            <div className="space-y-4">
              <div><div className="stat text-[48px] leading-none">{st?.calls ?? '—'}</div><div className="text-[12px] text-white/50">SNIPE calls from {st?.launches_seen?.toLocaleString() ?? '—'} launches</div></div>
              <div><div className="stat text-[48px] leading-none text-up">{st?.hit_2x_pct != null ? `${Math.round(st.hit_2x_pct)}%` : '—'}</div><div className="text-[12px] text-white/50">peaked at 2× or more after the call</div></div>
              <div><div className="stat text-[48px] leading-none text-accent2">{st?.call_graduation_pct != null ? `${st.call_graduation_pct}%` : '—'}</div>
                <div className="text-[12px] text-white/50">graduated{st?.base_graduation_pct != null ? ` (vs ${st.base_graduation_pct}% of all launches)` : ''}</div></div>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href="/snipe" className="btn-primary">Open Snipe <Icon name="arrow" size={14} /></Link>
            <Link href="/proof" className="btn-ghost">Proof</Link>
          </div>
        </div>
      </div>
    </section>
  );
}
