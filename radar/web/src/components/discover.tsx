'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ago, pct, pctClass, price, short, usd } from '@/lib/format';
import { tokenLinks } from '@/lib/links';
import { useLive, useNow } from '@/lib/live';
import { Icon } from './Icon';
import { AnimatePresence, AreaSpark, Flash, motion } from './motion';
import { Copy, SafetyFlags, TokenIcon } from './ui';

const STAGE_CLS: Record<string, string> = {
  birth: 'bg-accent2/15 text-accent2', ignition: 'bg-up/15 text-up', peak: 'bg-warn/15 text-warn', fading: 'bg-down/15 text-down',
};
const CAT_EMOJI: Record<string, string> = { politifi: '🏛', ai: '🤖', animal: '🐾', celebrity: '⭐', news: '📰', sports: '🏟', gaming: '🎮', meme: '😂', other: '✦' };

export function StageBadge({ stage }: { stage?: string | null }) {
  if (!stage) return null;
  return <span className={`rounded-full px-2 py-px text-[10px] font-semibold uppercase tracking-wider ${STAGE_CLS[stage] || 'bg-white/5 text-mute'}`}>{stage}</span>;
}

export function NarrativeTags({ items, max = 3 }: { items: any[]; max?: number }) {
  if (!items?.length) return <span className="text-[11px] text-mute">no narrative found yet</span>;
  const seen = new Set<string>();
  const uniq = items.filter((n) => { const k = (n.title || '').toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  return (
    <span className="flex flex-wrap gap-1">
      {uniq.slice(0, max).map((n, i) => (
        <span key={i} title={n.explanation || `${n.category || ''} ${n.stage || ''}`}
          className={`inline-flex max-w-[220px] items-center gap-1 truncate rounded-lg border px-1.5 py-0.5 text-[11px] ${n.fake ? 'border-down/30 text-down line-through' : 'border-accent/25 bg-accent/10 text-fg/90'}`}>
          <span>{CAT_EMOJI[n.category] || '✦'}</span><span className="truncate">{n.title}</span>
          {n.stage && <span className="text-[9px] uppercase text-mute">{n.stage}</span>}
        </span>
      ))}
      {uniq.length > max && <span className="text-[11px] text-mute">+{uniq.length - max}</span>}
    </span>
  );
}

function Meter({ v, max = 100 }: { v: number; max?: number }) {
  return (
    <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-white/5">
      <motion.span className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent to-accent2"
        initial={{ width: 0 }} animate={{ width: `${Math.max(3, Math.min(100, (v / max) * 100))}%` }} transition={{ duration: 0.6 }} />
    </span>
  );
}

/** Card used on Trending (kind=climb) and Launching (kind=launch). */
export function CoinCard({ t, kind, onStory, rank }: { t: any; kind: 'climb' | 'launch'; onStory: (a: string) => void; rank: number }) {
  const now = useNow(5000);
  const m = kind === 'climb' ? t.climb : t.explosion;
  return (
    <motion.article layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className="glass glass-hover group flex flex-col gap-2 rounded-2xl p-3">
      <div className="flex items-center gap-2.5">
        <span className="num w-5 text-[11px] text-mute">{rank}</span>
        <TokenIcon src={t.image} symbol={t.symbol} size={34} />
        <div className="min-w-0 flex-1">
          <Link href={`/token?a=${t.address}`} className="block min-w-0">
            <b className="block truncate text-[15px] tracking-tight">{t.symbol || short(t.address)}</b>
            <span className="block truncate text-[12px] text-mute">{t.name}</span>
          </Link>
          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-mute">
            <span className="whitespace-nowrap">{ago(t.launched_at || t.pair_created_at || t.first_seen, now)} old</span>
            {t.chain && t.chain !== 'solana' && <span className="rounded bg-white/5 px-1">{t.chain}</span>}
            {t.graduated_at ? <span className="text-accent2">graduated</span> : null}
            {t.boost_amount ? <span className="text-warn">⚡ paid boost</span> : null}
          </div>
        </div>
        <div className="text-right">
          <div className="num text-[14px] font-semibold"><Flash value={t.market_cap ?? t.fdv ?? m?.mcap_usd}>{usd(t.market_cap ?? t.fdv ?? m?.mcap_usd)}</Flash></div>
          <div className={`num text-[11px] ${pctClass(t.chg_h1)}`}>{t.chg_h1 != null ? `${pct(t.chg_h1)} 1h` : ''}</div>
        </div>
      </div>
      <div className="-mx-1 overflow-hidden"><AreaSpark data={t.spark} w={320} h={40} /></div>
      <div className="grid grid-cols-3 gap-1 text-[11px]">
        {kind === 'climb' ? (<>
          <Metric k="slope" v={`${pct(m.slope_pct_h)}/h`} cls="text-up" />
          <Metric k="steadiness" v={`${Math.round(m.r2 * 100)}%`} />
          <Metric k="max dip" v={`${m.drawdown_pct}%`} cls={m.drawdown_pct < -15 ? 'text-warn' : ''} />
        </>) : m.basis === 'bonding_curve' ? (<>
          <Metric k="curve 10m" v={`${m.curve_mult_10m}x`} cls="text-up" />
          <Metric k="wallets" v={m.wallets_10m} />
          <Metric k="buys" v={`${m.buy_sol_10m} SOL`} />
        </>) : (<>
          <Metric k="vol pace" v={`${m.vol_accel}x`} cls="text-up" />
          <Metric k="mcap 15m" v={pct(m.mcap_chg_15m)} cls={pctClass(m.mcap_chg_15m)} />
          <Metric k="liq 15m" v={pct(m.liq_chg_15m)} cls={pctClass(m.liq_chg_15m)} />
        </>)}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-mute">
        <span>score</span><Meter v={m.score} /><span className="num text-fg">{m.score}</span>
      </div>
      <div className="grid grid-cols-3 gap-1 text-[11px] num text-mute [&>span]:truncate">
        <span>liq <b className="text-fg">{usd(t.liquidity_usd)}</b></span><span>vol 1h <b className="text-fg">{usd(t.vol_h1)}</b></span>
        <span>B/S <b className="text-up">{t.buys_m5 ?? '—'}</b>/<b className="text-down">{t.sells_m5 ?? '—'}</b></span>
      </div>
      {kind === 'launch' && t.flow && (t.flow.sniper_supply_pct != null || t.flow.dev_initial_buy_pct != null) && (
        <div className="flex flex-wrap gap-1 text-[10px]">
          {t.flow.dev_initial_buy_pct != null && <span className={`rounded-md px-1.5 py-px ${t.flow.dev_initial_buy_pct > 10 ? 'bg-down/15 text-down' : 'bg-white/5 text-mute'}`}>dev buy {t.flow.dev_initial_buy_pct}%</span>}
          {t.flow.sniper_supply_pct != null && <span className={`rounded-md px-1.5 py-px ${t.flow.sniper_supply_pct > 15 ? 'bg-down/15 text-down' : 'bg-white/5 text-mute'}`}>snipers {t.flow.sniper_supply_pct}%</span>}
          {t.flow.unique_buyers_5m != null && <span className="rounded-md bg-white/5 px-1.5 py-px text-mute">{t.flow.unique_buyers_5m} buyers/5m</span>}
          {t.flow.dev_sold_pct != null && t.flow.dev_sold_pct > 0 && <span className="rounded-md bg-warn/15 px-1.5 py-px text-warn">dev sold {t.flow.dev_sold_pct}%</span>}
        </div>
      )}
      <div className="border-t border-white/5 pt-2">
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-mute">
          <span>Narratives</span>
          <button onClick={() => onStory(t.address)} className="flex items-center gap-1 normal-case tracking-normal text-accent2 hover:underline">
            <Icon name="eye" size={12} /> why it’s moving
          </button>
        </div>
        <NarrativeTags items={t.narratives} />
      </div>
      <div className="flex flex-wrap items-center gap-1 opacity-80 transition group-hover:opacity-100">
        <SafetyFlags t={t} />
        <span className="flex-1" />
        <Copy text={t.address} label="CA" />
        {tokenLinks(t.address, t.chain || 'solana', t.pair_address).slice(0, 2).map((l) => (
          <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="rounded-lg border border-white/10 px-1.5 py-0.5 text-[10px] text-mute hover:border-accent hover:text-fg">{l.label}</a>
        ))}
      </div>
    </motion.article>
  );
}

function Metric({ k, v, cls = '' }: { k: string; v: React.ReactNode; cls?: string }) {
  return <span className="min-w-0 rounded-lg bg-white/[0.03] px-2 py-1"><span className="block truncate text-[9px] uppercase tracking-wider text-mute">{k}</span><span className={`num block truncate font-semibold ${cls}`}>{v}</span></span>;
}

/** Right-side drawer: every narrative behind a coin, from web + socials, with evidence. */
export function StoryDrawer({ address, onClose }: { address: string | null; onClose: () => void }) {
  const [st, setSt] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(10000);
  const load = useCallback((refresh = false, x = false) => {
    if (!address) return;
    setBusy(true);
    api(`/api/token/${address}/story${refresh ? `?x=${x}` : ''}`, refresh ? { method: 'POST' } : undefined)
      .then(setSt).catch(() => setSt({ error: true })).finally(() => setBusy(false));
  }, [address]);
  useEffect(() => { setSt(null); load(); }, [load]);
  useLive(({ ch, data }) => { if (ch === 'story' && data.token_address === address) load(); });
  return (
    <AnimatePresence>
      {address && (
        <motion.div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.aside onClick={(e) => e.stopPropagation()} className="glass h-full w-full max-w-lg overflow-y-auto rounded-l-2xl p-4"
            initial={{ x: 60, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 60, opacity: 0 }} transition={{ type: 'spring', stiffness: 320, damping: 32 }}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-[16px] font-semibold tracking-tight">Why it’s moving</h2>
              <Link href={`/token?a=${address}`} className="text-[12px] text-accent2">open coin →</Link>
              <span className="flex-1" />
              <button onClick={onClose} className="rounded-lg p-1 text-mute hover:bg-white/5 hover:text-fg"><Icon name="x" /></button>
            </div>
            {!st || busy && !st?.narratives ? (
              <div className="space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-14" />)}<p className="text-[12px] text-mute">Researching Google News, Reddit, Bluesky and Radar’s own feeds…</p></div>
            ) : st.error ? <p className="text-down">Couldn’t research this coin.</p> : (
              <div className="space-y-4">
                <div className="rounded-xl bg-white/[0.03] p-3">
                  <p className="leading-relaxed">{st.why_moving}</p>
                  {st.origin && <p className="mt-2 text-[12px] text-mute">Origin: {st.origin}</p>}
                  <p className="mt-2 text-[10px] text-mute">{st.method === 'claude' ? 'Written by Claude from the evidence below' : 'Keyword clustering (connect Anthropic for AI write-ups)'} · {ago(st.ts, now)} ago</p>
                </div>
                <div className="space-y-2">
                  {(st.narratives || []).map((n: any, i: number) => (
                    <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} className="rounded-xl border border-white/5 p-3">
                      <div className="flex items-center gap-2"><span>{CAT_EMOJI[n.category] || '✦'}</span><b className="flex-1">{n.title}</b><span className="num text-[11px] text-mute">{Math.round(n.strength)}</span></div>
                      <div className="my-1.5"><Meter v={n.strength} /></div>
                      <p className="text-[12px] text-fg/80">{n.explanation}</p>
                      {!!n.sources?.length && <p className="mt-1 text-[10px] uppercase tracking-wider text-mute">{n.sources.join(' · ')}</p>}
                    </motion.div>
                  ))}
                  {!st.narratives?.length && <p className="text-mute">No clear narrative in the evidence.</p>}
                </div>
                {!!st.linked?.length && (<div><h3 className="mb-1 text-[11px] uppercase tracking-wider text-mute">Live narratives Radar linked</h3><NarrativeTags items={st.linked} max={8} /></div>)}
                {!!st.risks?.length && (<div className="rounded-xl border border-warn/20 bg-warn/5 p-3 text-[12px] text-warn">{st.risks.map((r: string, i: number) => <div key={i}>⚠ {r}</div>)}</div>)}
                <div>
                  <h3 className="mb-1 text-[11px] uppercase tracking-wider text-mute">Evidence ({st.evidence?.length || 0})</h3>
                  <ol className="space-y-1">
                    {(st.evidence || []).map((e: any, i: number) => (
                      <li key={i} className="rounded-lg bg-white/[0.02] px-2 py-1.5 text-[12px]">
                        <span className="mr-1 text-[10px] text-mute">[{i + 1}] {e.source}{e.author ? ` · ${e.author}` : ''}</span>
                        {e.url ? <a href={e.url} target="_blank" rel="noreferrer" className="hover:text-accent2">{e.text}</a> : e.text}
                      </li>
                    ))}
                  </ol>
                </div>
                <div className="flex gap-2">
                  <button disabled={busy} onClick={() => load(true)} className="rounded-xl bg-accent/20 px-3 py-1.5 text-accent disabled:opacity-50">{busy ? 'Researching…' : 'Research again'}</button>
                  <button disabled={busy} onClick={() => load(true, true)} className="rounded-xl border border-white/10 px-3 py-1.5 text-mute hover:text-fg" title="Uses X API credits">+ search X</button>
                </div>
              </div>
            )}
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Squarified treemap of coins: area = 1h volume, color = 1h change. */
export function HeatMap({ rows }: { rows: any[] }) {
  const items = rows.filter((r) => (r.vol_h1 || 0) > 0).slice(0, 40).map((r) => ({ r, v: r.vol_h1 as number }));
  const [hover, setHover] = useState<any>(null);
  if (!items.length) return <p className="p-6 text-center text-mute">No volume data yet.</p>;
  const W = 1000, H = 520;
  const rects: { x: number; y: number; w: number; h: number; r: any }[] = [];
  const layout = (list: typeof items, x: number, y: number, w: number, h: number) => {
    if (!list.length) return;
    if (list.length === 1) { rects.push({ x, y, w, h, r: list[0].r }); return; }
    const total = list.reduce((a, b) => a + b.v, 0);
    let acc = 0, i = 0;
    while (i < list.length - 1 && (acc + list[i].v) / total < 0.5) acc += list[i++].v;
    if (i === 0) acc = list[i++].v;
    const f = acc / total;
    if (w >= h) { layout(list.slice(0, i), x, y, w * f, h); layout(list.slice(i), x + w * f, y, w * (1 - f), h); }
    else { layout(list.slice(0, i), x, y, w, h * f); layout(list.slice(i), x, y + h * f, w, h * (1 - f)); }
  };
  layout(items.sort((a, b) => b.v - a.v), 0, 0, W, H);
  const color = (c?: number) => c == null ? 'var(--color-panel2)'
    : `color-mix(in oklab, ${c >= 0 ? 'var(--color-up)' : 'var(--color-down)'} ${Math.min(75, 12 + Math.abs(c) * 0.9)}%, var(--color-panel))`;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Heat map: area is 1h volume, color is 1h change">
        {rects.map(({ x, y, w, h, r }) => (
          <Link key={r.address} href={`/token?a=${r.address}`}>
            <g onMouseEnter={() => setHover(r)} onMouseLeave={() => setHover(null)} className="cursor-pointer">
              <rect x={x + 1} y={y + 1} width={Math.max(0, w - 2)} height={Math.max(0, h - 2)} rx={8} fill={color(r.chg_h1)} className="transition-opacity hover:opacity-80" />
              {w > 56 && h > 28 && (<>
                <clipPath id={`c-${r.address}`}><rect x={x + 1} y={y + 1} width={Math.max(0, w - 4)} height={Math.max(0, h - 2)} /></clipPath>
                <g clipPath={`url(#c-${r.address})`}>
                  <text x={x + 8} y={y + 20} fill="var(--color-fg)" fontSize={Math.min(18, Math.max(11, w / 9))} fontWeight={600}>{r.symbol || short(r.address)}</text>
                  {w > 120 && h > 46 && <text x={x + 8} y={y + 20 + Math.min(18, Math.max(11, w / 9))} fill="var(--color-fg)" opacity={0.75} fontSize={11}>{pct(r.chg_h1)} · {usd(r.vol_h1)}</text>}
                </g>
              </>)}
            </g>
          </Link>
        ))}
      </svg>
      {hover && (
        <div className="glass pointer-events-none absolute right-3 top-3 rounded-xl px-3 py-2 text-[12px]">
          <b>{hover.symbol}</b> <span className="text-mute">{hover.name}</span>
          <div className="num">vol 1h {usd(hover.vol_h1)} · <span className={pctClass(hover.chg_h1)}>{pct(hover.chg_h1)}</span> · mcap {usd(hover.market_cap ?? hover.fdv)}</div>
        </div>
      )}
      <p className="mt-1 text-[11px] text-mute">Area = 1h volume · colour = 1h change (green up, red down) · click a tile to open the coin.</p>
    </div>
  );
}

/** Launch Watch: arm keywords/tickers; alert the instant a matching coin launches. */
export function LaunchWatchPanel({ compact = false }: { compact?: boolean }) {
  const [rows, setRows] = useState<any[]>([]);
  const [terms, setTerms] = useState('');
  const [err, setErr] = useState('');
  const now = useNow(10000);
  const load = useCallback(() => api('/api/launch-watches').then(setRows).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useLive(({ ch }) => { if (ch === 'launch_watch_hit') load(); });
  const add = () => api('/api/launch-watches', { method: 'POST', body: JSON.stringify({ terms: terms.split(/[,\n]/).map((t) => t.trim()).filter(Boolean) }) })
    .then(() => { setTerms(''); setErr(''); load(); }).catch((e) => setErr(String(e.message)));
  return (
    <div className="space-y-2">
      <form onSubmit={(e) => { e.preventDefault(); add(); }} className="flex gap-2">
        <input value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="tickers or words, e.g. HAWK, hawk tuah"
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 outline-none focus:border-accent" />
        <button className="flex items-center gap-1 rounded-xl bg-gradient-to-r from-accent/40 to-accent2/30 px-3 text-[12px] font-medium"><Icon name="plus" size={13} />Arm</button>
      </form>
      {err && <p className="text-[11px] text-down">{err}</p>}
      <ul className="space-y-1">
        <AnimatePresence initial={false}>
          {rows.slice(0, compact ? 5 : 50).map((w) => (
            <motion.li key={w.id} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
              className="flex items-center gap-2 rounded-xl bg-white/[0.03] px-2.5 py-1.5 text-[12px]">
              <Icon name="eye" size={13} className="text-accent2" />
              <span className="min-w-0 flex-1 truncate">{w.terms.join(', ')}</span>
              {w.hits ? <Link href={`/token?a=${w.last_hit_token}`} className="rounded-md bg-flash/15 px-1.5 text-[11px] text-flash">{w.hits} hit{w.hits > 1 ? 's' : ''} · {ago(w.last_hit, now)}</Link>
                : <span className="text-[11px] text-mute">armed</span>}
              <button onClick={() => api(`/api/launch-watches/${w.id}`, { method: 'DELETE' }).then(load)} className="text-mute hover:text-down"><Icon name="x" size={13} /></button>
            </motion.li>
          ))}
        </AnimatePresence>
        {!rows.length && <li className="text-[12px] text-mute">Nothing armed. You’ll get a FLASH alert the moment a coin with a matching name or ticker launches.</li>}
      </ul>
    </div>
  );
}

/** Dashboard side panel: social + web narratives that could create (or are creating) a coin. */
export function NarrativeRadar() {
  const [d, setD] = useState<any>(null);
  const [tab, setTab] = useState<'narr' | 'web'>('narr');
  const [armed, setArmed] = useState<Record<number, boolean>>({});
  const now = useNow(5000);
  const load = useCallback(() => api('/api/discover/emerging').then(setD).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);
  useLive(({ ch }) => { if (ch === 'narrative_new' || ch === 'flash') load(); });
  const arm = (n: any) => api('/api/launch-watches', { method: 'POST', body: JSON.stringify({ terms: [...(n.tickers || []).slice(0, 4), ...(n.title || '').split(' ').filter((w: string) => w.length >= 5).slice(0, 2)], label: n.title, narrative_id: n.id }) })
    .then(() => setArmed((a) => ({ ...a, [n.id]: true })));
  return (
    <section className="glass flex min-h-0 flex-col overflow-hidden rounded-2xl">
      <header className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
        <Icon name="flame" size={15} className="text-warn" />
        <h2 className="whitespace-nowrap text-[12px] font-semibold">Narrative Radar</h2>
        <span className="num whitespace-nowrap text-[11px] text-mute">{d?.posts_per_min ?? 0}/min</span>
        <span className="flex-1" />
        <div className="flex shrink-0 whitespace-nowrap rounded-lg bg-white/[0.04] p-0.5 text-[11px]">
          {(['narr', 'web'] as const).map((k) => (
            <button key={k} onClick={() => setTab(k)} className={`relative rounded-md px-2 py-0.5 ${tab === k ? 'text-fg' : 'text-mute'}`}>
              {tab === k && <motion.span layoutId="nr-tab" className="absolute inset-0 -z-10 rounded-md bg-white/10" />}
              {k === 'narr' ? 'Coin-able' : 'Web pulse'}
            </button>
          ))}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!d ? <div className="space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-20" />)}</div> : tab === 'narr' ? (
          <ul className="space-y-2">
            <AnimatePresence initial={false}>
              {d.narratives.map((n: any) => (
                <motion.li key={n.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className={`rounded-xl border p-2.5 ${n.flash ? 'flash-pulse border-flash/50' : 'border-white/5 bg-white/[0.02]'}`}>
                  <div className="flex items-center gap-1.5">
                    <span>{CAT_EMOJI[n.category] || '✦'}</span>
                    <Link href={`/narratives?n=${n.id}`} className="min-w-0 flex-1 truncate font-semibold hover:text-accent2">{n.title}</Link>
                    <StageBadge stage={n.stage} />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-mute">coin potential</span>
                    <Meter v={n.potential} /><span className="num text-[11px]">{Math.round(n.potential)}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]">
                    {n.flags?.vip_mention && <span className="rounded-md bg-flash/15 px-1.5 text-flash">VIP</span>}
                    {n.flags?.breaking_news && <span className="rounded-md bg-warn/15 px-1.5 text-warn">breaking</span>}
                    {n.tickers.slice(0, 4).map((t: string) => <span key={t} className="rounded-md bg-white/5 px-1.5 text-accent2">${t}</span>)}
                    <span className="text-mute">{n.vel_5m ?? 0}/min · {n.sources.join(', ')}</span>
                    <span className="flex-1" />
                    <AreaSpark data={n.spark} w={64} h={18} up />
                  </div>
                  {n.top_posts?.[0] && <p className="mt-1.5 line-clamp-2 text-[11px] text-mute">“{n.top_posts[0].text}”</p>}
                  <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
                    {n.has_coin ? n.coins.map((c: any) => (
                      <Link key={c.token_address} href={`/token?a=${c.token_address}`} className={`rounded-md border px-1.5 ${c.is_likely_fake ? 'border-down/30 text-down line-through' : 'border-up/30 text-up'}`}>
                        {c.symbol || short(c.token_address)} {c.chg_h1 != null ? pct(c.chg_h1) : ''}
                      </Link>
                    )) : <span className="text-warn">no coin yet</span>}
                    <span className="flex-1" />
                    <button onClick={() => arm(n)} disabled={armed[n.id]} className="rounded-md bg-accent/15 px-2 py-0.5 text-accent disabled:opacity-60">
                      {armed[n.id] ? '✓ watching for launch' : 'Launch Watch'}
                    </button>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
            {!d.narratives.length && <li className="p-4 text-center text-mute">No live narratives yet. They appear as posts cluster across X, Telegram, Bluesky, 4chan, Reddit and the news.</li>}
          </ul>
        ) : (
          <ul className="space-y-1.5">
            {d.web.map((w: any, i: number) => (
              <motion.li key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-xl bg-white/[0.02] px-2.5 py-2">
                <div className="flex gap-2 text-[10px] uppercase tracking-wider text-mute"><span>{w.source.replace('_', ' ')}</span><span>{ago(w.ts, now)}</span>{w.category && <span>{CAT_EMOJI[w.category]} {w.category}</span>}</div>
                <a href={w.url} target="_blank" rel="noreferrer" className="text-[12px] hover:text-accent2">{w.text}</a>
                {!!w.tickers?.length && <div className="mt-1 flex gap-1">{w.tickers.map((t: string) => <span key={t} className="rounded-md bg-white/5 px-1.5 text-[10px] text-accent2">${t}</span>)}</div>}
              </motion.li>
            ))}
            {!d.web.length && <li className="p-4 text-center text-mute">No tokenizable headlines or trends in the last 6h.</li>}
          </ul>
        )}
      </div>
    </section>
  );
}

export function CoinGrid({ rows, kind, empty, narrow = false }: { rows: any[]; kind: 'climb' | 'launch'; empty: string; narrow?: boolean }) {
  const [story, setStory] = useState<string | null>(null);
  return (
    <>
      <div className={`grid gap-3 sm:grid-cols-2 ${narrow ? '2xl:grid-cols-3' : 'xl:grid-cols-3 2xl:grid-cols-4'}`}>
        <AnimatePresence mode="popLayout">
          {rows.map((t, i) => <CoinCard key={t.address} t={t} kind={kind} rank={i + 1} onStory={setStory} />)}
        </AnimatePresence>
      </div>
      {!rows.length && <div className="glass rounded-2xl p-10 text-center text-mute">{empty}</div>}
      <StoryDrawer address={story} onClose={() => setStory(null)} />
    </>
  );
}

export function useDiscover(path: string, every = 8000) {
  const [d, setD] = useState<{ as_of: number; rows: any[] } | null>(null);
  const load = useCallback(() => api(path).then(setD).catch(() => {}), [path]);
  useEffect(() => { load(); const t = setInterval(load, every); return () => clearInterval(t); }, [load, every]);
  // stream prices into the visible cards between refreshes
  useLive(({ ch, data }) => {
    if (ch !== 'tokens') return;
    setD((p) => {
      if (!p) return p;
      const upd = new Map((data as any[]).map((t) => [t.address, t]));
      if (!p.rows.some((r) => upd.has(r.address))) return p;
      return { ...p, rows: p.rows.map((r) => (upd.has(r.address) ? { ...r, ...upd.get(r.address), climb: r.climb, explosion: r.explosion, spark: r.spark, narratives: r.narratives, flow: r.flow } : r)) };
    });
  });
  return { d, reload: load };
}

export { price };
