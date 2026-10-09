'use client';
import Link from 'next/link';
import { memo, useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { AnimatePresence, motion } from '@/components/motion';
import { api, apiCached, peek } from '@/lib/api';
import { ago, usd } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

export type XCoin = { mint: string; symbol?: string; name?: string; ts: number; delay_s: number; rank: number; term?: string; mcap_usd?: number | null; tier?: string | null };
export type XAi = { coinable: boolean; narrative: string; tickers: string[]; names: string[]; meme_potential: number; urgency: string; category: string; why: string };
export type Tweet = {
  id: string; handle: string; author_name?: string; avatar?: string; tier: 'S' | 'A' | 'B'; category: string; text: string; ts: number; url: string;
  media_url?: string | null; likes: number; rts: number; replies: number; quotes: number; velocity: number; heur: number; score: number;
  spawns: number; kind: 'tweet' | 'profile' | 'follow'; followers?: number | null; terms: string[]; tickers: string[]; cas: string[];
  ai?: XAi | null; coins: XCoin[]; rank_score?: number;
};

const compact = (v?: number | null) => (v == null ? '—' : Intl.NumberFormat('en', { notation: 'compact' }).format(v));
export const TIER_TONE: Record<string, string> = { S: 'bg-flash/20 text-flash ring-1 ring-flash/40', A: 'bg-accent/15 text-accent', B: 'bg-white/[0.07] text-white/60' };

/** Live tweet board: first paint from cache, then REST, then every new tweet / AI read / spawned coin over the socket. */
export function useXTweets(hours = 12, limit = 60, minScore = 0) {
  const path = `/api/x/tweets?hours=${hours}&limit=${limit}&min_score=${minScore}`;
  const [rows, setRows] = useState<Tweet[]>([]);
  const load = useCallback(() => apiCached<Tweet[]>(path).then(setRows).catch(() => {}), [path]);
  useEffect(() => {
    const c = peek<Tweet[]>(path);
    if (c) setRows(c);
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load, path]);
  useLive(({ ch, data }) => {
    if (ch !== 'x_tweet' && ch !== 'x_race') return;
    const t: Tweet = ch === 'x_race' ? data.tweet : data;
    if (!t?.id || t.score < minScore) return;
    setRows((rs) => {
      const old = rs.find((r) => r.id === t.id);
      const merged = { ...old, ...t, coins: (t.coins && t.coins.length ? t.coins : old?.coins) || [] } as Tweet;
      const next = [merged, ...rs.filter((r) => r.id !== t.id)];
      const now = Date.now() / 1000;
      return next.map((r) => ({ ...r, rank_score: r.score * Math.exp(-(now - r.ts) / (6 * 3600)) }))
        .sort((a, b) => (b.rank_score ?? 0) - (a.rank_score ?? 0)).slice(0, limit);
    });
  });
  return rows;
}

function Avatar({ t, size = 40 }: { t: Tweet; size?: number }) {
  return t.avatar
    ? <img src={t.avatar} alt="" width={size} height={size} loading="lazy" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }}
      onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
    : <span className="flex shrink-0 items-center justify-center rounded-full bg-white/10 font-bold" style={{ width: size, height: size }}>{t.handle[0]?.toUpperCase()}</span>;
}

function Score({ v, size = 46 }: { v: number; size?: number }) {
  const r = size / 2 - 4, c = 2 * Math.PI * r, color = v >= 70 ? 'var(--color-flash)' : v >= 50 ? 'var(--color-up)' : v >= 35 ? 'var(--color-warn)' : 'rgba(255,255,255,0.35)';
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} title="Coinability score (author, catchiness, novelty, velocity, Claude's read, coins spawned)">
      <svg width={size} height={size} className="-rotate-90"><circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.08)" strokeWidth={4} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={4} fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} /></svg>
      <b className="num absolute text-[13px]">{Math.round(v)}</b>
    </span>
  );
}

export const TweetCard = memo(function TweetCard({ t, now, big = false }: { t: Tweet; now: number; big?: boolean }) {
  const ai = t.ai;
  const tickers = Array.from(new Set([...(ai?.tickers || []), ...t.tickers])).slice(0, 5);
  const hot = t.score >= 70 || t.coins.length >= 3;
  return (
    <article className={`group relative flex flex-col rounded-[24px] border p-4 transition-colors ${hot ? 'border-flash/40 bg-flash/[0.04]' : 'border-white/[0.08] bg-white/[0.02] hover:border-white/20'} ${big ? 'md:p-6' : ''}`}>
      <header className="flex items-center gap-3">
        <Avatar t={t} size={big ? 48 : 38} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <b className={`truncate ${big ? 'text-[17px]' : 'text-[14px]'}`}>{t.author_name || t.handle}</b>
            <span className={`rounded-full px-1.5 py-[1px] text-[9px] font-extrabold ${TIER_TONE[t.tier] || TIER_TONE.B}`}>{t.tier}</span>
            {t.kind !== 'tweet' && <span className="rounded-full bg-warn/15 px-1.5 py-[1px] text-[9px] font-extrabold uppercase text-warn">{t.kind === 'profile' ? 'profile change' : 'new follow'}</span>}
          </div>
          <div className="truncate text-[11.5px] text-white/45">@{t.handle} · {t.category} · {ago(t.ts, now)} ago{t.followers ? ` · ${compact(t.followers)} followers` : ''}</div>
        </div>
        <Score v={t.score} size={big ? 56 : 44} />
      </header>
      <p className={`mt-3 whitespace-pre-line ${big ? 'text-[20px] leading-snug md:text-[24px]' : 'line-clamp-4 text-[14px] leading-snug'}`}>{t.text}</p>
      {t.media_url && (big || !t.coins.length) && (
        <img src={t.media_url} alt="" loading="lazy" className={`mt-3 w-full rounded-2xl object-cover ${big ? 'max-h-[300px]' : 'max-h-[160px]'}`}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      )}
      {ai && (
        <div className="mt-3 rounded-2xl bg-accent/[0.07] px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
            <span className="font-bold text-accent">✦ {ai.narrative}</span>
            <span className={`num rounded-full px-1.5 text-[10.5px] font-bold ${ai.meme_potential >= 7 ? 'bg-flash/20 text-flash' : 'bg-white/[0.07] text-white/65'}`}>meme {ai.meme_potential}/10</span>
            {ai.coinable && <span className="rounded-full bg-up/15 px-1.5 text-[10.5px] font-bold text-up">coinable</span>}
            <span className="text-[10.5px] text-white/45">window: {ai.urgency}</span>
          </div>
          {ai.why && <p className="mt-0.5 text-[11.5px] text-white/55">{ai.why}</p>}
        </div>
      )}
      {(tickers.length > 0 || (!ai && t.terms.length > 0)) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {tickers.map((x) => <span key={x} className="num rounded-full bg-white/[0.07] px-2 py-[1px] text-[11px] font-bold">${x}</span>)}
          {!ai && t.terms.slice(0, 5).map((x) => <span key={x} className="rounded-full border border-white/10 px-2 py-[1px] text-[11px] text-white/60">{x}</span>)}
        </div>
      )}
      {t.coins.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-flash">🏁 {t.coins.length} coin{t.coins.length > 1 ? 's' : ''} launched off it</div>
          <div className="flex flex-wrap gap-1.5">
            {t.coins.slice(0, big ? 8 : 4).map((c) => (
              <Link key={c.mint} href={`/token?a=${c.mint}`} className="num flex items-center gap-1 rounded-xl border border-white/10 px-2 py-1 text-[11.5px] hover:border-white/40">
                <span className="text-white/40">#{c.rank}</span><b>${c.symbol || c.mint.slice(0, 5)}</b>
                <span className="text-white/45">+{c.delay_s < 60 ? `${Math.round(c.delay_s)}s` : `${Math.round(c.delay_s / 60)}m`}</span>
                {c.mcap_usd ? <span className="text-up">{usd(c.mcap_usd)}</span> : null}
                {c.tier === 'SNIPE' && <span className="rounded bg-up px-1 text-[9px] font-extrabold text-black">SNIPE</span>}
              </Link>
            ))}
          </div>
        </div>
      )}
      <footer className="num mt-auto flex items-center gap-3 pt-3 text-[11px] text-white/45">
        <span>♥ {compact(t.likes)}</span><span>⟲ {compact(t.rts)}</span><span>💬 {compact(t.replies)}</span>
        {t.velocity > 0 && <span className={t.velocity >= 500 ? 'text-flash' : ''}>⚡ {compact(t.velocity)}/min</span>}
        <a href={t.url} target="_blank" rel="noreferrer" className="ml-auto font-semibold text-white/60 hover:text-white">Open on X ↗</a>
      </footer>
    </article>
  );
}, (a, b) => a.t === b.t && a.big === b.big && Math.floor(a.now / 10) === Math.floor(b.now / 10));

export function RaceList({ rows, now, limit = 6 }: { rows: Tweet[]; now: number; limit?: number }) {
  const races = rows.filter((t) => t.coins.length).sort((a, b) => b.coins.length - a.coins.length || b.ts - a.ts).slice(0, limit);
  return (
    <ul className="space-y-2">
      <AnimatePresence initial={false}>
        {races.map((t) => {
          const lead = [...t.coins].sort((a, b) => (b.mcap_usd || 0) - (a.mcap_usd || 0))[0];
          return (
            <motion.li key={t.id} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-white/[0.07] p-3">
              <div className="flex items-center gap-2">
                <Avatar t={t} size={24} />
                <b className="truncate text-[12.5px]">@{t.handle}</b>
                <span className="num ml-auto rounded-full bg-flash/15 px-2 text-[11px] font-bold text-flash">{t.coins.length} coins</span>
              </div>
              <p className="mt-1 line-clamp-1 text-[12px] text-white/55">“{t.text}”</p>
              {lead && <Link href={`/token?a=${lead.mint}`} className="num mt-1 block text-[11.5px] text-white/70 hover:text-white">
                leader <b>${lead.symbol}</b>{lead.mcap_usd ? ` · ${usd(lead.mcap_usd)}` : ''} · first coin +{Math.round(t.coins[0].delay_s)}s · {ago(t.ts, now)} ago</Link>}
            </motion.li>
          );
        })}
      </AnimatePresence>
      {!races.length && <li className="rounded-2xl border border-dashed border-white/10 p-4 text-center text-[12px] text-white/40">No coin races yet — when coins launch off a tracked tweet they line up here.</li>}
    </ul>
  );
}

export function CallersMini({ limit = 6 }: { limit?: number }) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api('/api/x/callers?days=7&min_calls=1').then(setRows).catch(() => {}); }, []);
  return (
    <ul className="space-y-1.5">
      {rows.slice(0, limit).map((r, i) => (
        <li key={r.handle} className="num flex items-center gap-2 text-[12px]">
          <span className="w-4 text-white/35">{i + 1}</span>
          <a href={`https://x.com/${r.handle}`} target="_blank" rel="noreferrer" className="truncate font-semibold hover:underline">@{r.handle}</a>
          <span className="ml-auto text-white/50">{r.calls} calls</span>
          <b className={r.hit_2x_pct >= 40 ? 'text-up' : 'text-white/80'}>{r.hit_2x_pct}% 2×</b>
        </li>
      ))}
      {!rows.length && <li className="text-[12px] text-white/40">Calls are graded as they happen (market cap at the tweet → peak).</li>}
    </ul>
  );
}

/** Home hero: the tweets most likely to become coins right now, the coin races they started, the callers that deliver. */
export function TweetRadarHero() {
  const rows = useXTweets(12, 40);
  const [st, setSt] = useState<any>(null);
  const now = useNow(5000);
  useEffect(() => {
    const load = () => api('/api/x/status').then(setSt).catch(() => {});
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);
  const [top, ...rest] = rows;
  return (
    <section className="relative pb-6 pt-4">
      <div className="hero-orb" aria-hidden />
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="eyebrow mb-3 flex items-center gap-2">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-flash" /> X Radar · {st?.accounts ?? '—'} accounts watched live
          </motion.div>
          <h1 className="display text-[56px] sm:text-[84px] xl:text-[112px]">
            <span className="block overflow-hidden"><motion.span className="block" initial={{ y: '105%' }} animate={{ y: 0 }} transition={{ duration: 0.8 }}>Tweets that</motion.span></span>
            <span className="block overflow-hidden"><motion.span className="block text-flash" initial={{ y: '105%' }} animate={{ y: 0 }} transition={{ duration: 0.8, delay: 0.1 }}>become coins.</motion.span></span>
          </h1>
        </div>
        <div className="num ml-auto flex flex-wrap gap-2 text-[12px]">
          <span className="rounded-full bg-white/[0.06] px-3 py-1">{compact(st?.posts)} tweets read</span>
          <span className="rounded-full bg-flash/15 px-3 py-1 text-flash">🏁 {st?.spawns ?? 0} coins spawned · {st?.races ?? 0} races</span>
          <span className="rounded-full bg-white/[0.06] px-3 py-1">X spend ${(st?.spent_usd ?? 0).toFixed(2)} / ${(st?.budget_usd ?? 0).toFixed(0)}</span>
          <Link href="/x" className="rounded-full border border-white/15 px-3 py-1 font-semibold text-white/75 hover:text-white">Open X Radar →</Link>
        </div>
      </div>
      {st && !st.connected ? (
        <div className="glass rounded-[28px] p-10 text-center">
          <p className="text-[16px] text-white/70">Connect your X bearer token and Radar starts watching {st.accounts} memecoin-moving accounts.</p>
          <Link href="/connectors" className="btn-primary mt-4 inline-flex">Connect X <Icon name="arrow" size={14} /></Link>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
          <div className="grid gap-4">
            {top ? <TweetCard t={top} now={now} big /> : <div className="glass rounded-[28px] p-10 text-center text-white/45">Watching… the first scored tweet lands here.</div>}
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              <AnimatePresence initial={false} mode="popLayout">
                {rest.slice(0, 6).map((t) => (
                  <motion.div key={t.id} layout="position" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                    <TweetCard t={t} now={now} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
          <aside className="space-y-4">
            <div className="glass rounded-[28px] p-5">
              <div className="mb-3 flex items-center gap-2"><span className="text-flash">🏁</span><span className="display text-[24px]">Coin races</span></div>
              <RaceList rows={rows} now={now} />
            </div>
            <div className="glass rounded-[28px] p-5">
              <div className="mb-3 flex items-center gap-2"><Icon name="trophy" size={15} /><span className="display text-[24px]">Callers that deliver</span></div>
              <CallersMini />
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
