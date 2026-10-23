'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { ago, pct, pctClass, price, usd } from '@/lib/format';
import { useLive } from '@/lib/live';
import { AnimatePresence, Chips, motion } from './motion';
import { Panel, TokenIcon } from './ui';

export type MetaRow = {
  id: string; name: string; family: string; family_name: string; emoji: string; heat: number; status: string; rank: number;
  coins: number; mcap?: number; vol_h1: number; vol_share_h1: number; chg_h1: number | null; chg_h24: number | null;
  launches_1h: number; m_1h: number; news_1h: number; social_accel: number; vol_accel: number; spark: number[];
  leaders: { address: string; symbol?: string; name?: string; image?: string; chg_h1?: number; vol_h1?: number; market_cap?: number }[];
  narratives: { id: number; title: string; stage: string; strength: number }[];
};

export const META_STATUS: Record<string, { label: string; cls: string }> = {
  hot: { label: 'HOT', cls: 'bg-down/20 text-down ring-down/40' },
  heating: { label: 'HEATING', cls: 'bg-warn/20 text-warn ring-warn/40' },
  active: { label: 'ACTIVE', cls: 'bg-accent/15 text-accent ring-accent/30' },
  cooling: { label: 'COOLING', cls: 'bg-accent2/10 text-accent2 ring-accent2/30' },
  quiet: { label: 'QUIET', cls: 'bg-white/5 text-mute ring-white/10' },
};

/** Tile background: heat 0..100 mapped onto a cool→hot ramp. */
function heatBg(h: number): string {
  const a = Math.min(1, h / 80);
  const color = h >= 55 ? 'var(--color-down)' : h >= 30 ? 'var(--color-warn)' : 'var(--color-accent)';
  return `linear-gradient(160deg, color-mix(in oklab, ${color} ${Math.round(8 + a * 30)}%, transparent), transparent 75%)`;
}

export function MiniBars({ data, w = 108, h = 22 }: { data: number[]; w?: number; h?: number }) {
  if (!data?.length) return null;
  const max = Math.max(1, ...data);
  const bw = w / data.length;
  return (
    <svg width={w} height={h} role="img" aria-label={`mentions per 10 minutes over 6 hours, peak ${max}`}>
      {data.map((d, i) => {
        const bh = d ? Math.max(1.5, (d / max) * (h - 2)) : 0;
        return <rect key={i} x={i * bw + 0.5} y={h - bh} width={Math.max(1, bw - 1)} height={bh} rx={1}
          fill={i >= data.length - 6 ? 'var(--color-accent2)' : 'var(--color-accent)'} opacity={i >= data.length - 6 ? 0.95 : 0.55} />;
      })}
    </svg>
  );
}

export function useMetas() {
  const [rows, setRows] = useState<MetaRow[]>([]);
  const [asOf, setAsOf] = useState(0);
  const load = useCallback(() => api<{ as_of: number; metas: MetaRow[] }>('/api/metas').then((d) => { setRows(d.metas); setAsOf(d.as_of); }).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  useLive(({ ch, data }) => { if (ch === 'metas' && data?.metas) { setRows(data.metas); setAsOf(data.as_of); } });
  return { rows, asOf };
}

/** Heat map of every memecoin meta, live over the socket. */
export function MetaHeatmap({ now, onSelect, selected }: { now: number; onSelect: (id: string) => void; selected?: string | null }) {
  const { rows, asOf } = useMetas();
  const [fam, setFam] = useState('all');
  const [view, setView] = useState<'heat' | 'mentions' | 'volume' | 'launches'>('heat');
  const [showAll, setShowAll] = useState(false);
  const families = useMemo(() => Array.from(new Map(rows.map((r) => [r.family, r.family_name])).entries()), [rows]);
  const shown = useMemo(() => {
    const key: Record<string, (r: MetaRow) => number> = { heat: (r) => r.heat, mentions: (r) => r.m_1h, volume: (r) => r.vol_h1, launches: (r) => r.launches_1h };
    return rows.filter((r) => fam === 'all' || r.family === fam).sort((a, b) => key[view](b) - key[view](a));
  }, [rows, fam, view]);
  const hot = rows.filter((r) => r.status === 'hot' || r.status === 'heating');
  const quiet = shown.filter((r) => r.status === 'quiet');
  const collapse = !showAll && quiet.length > 0 && quiet.length < shown.length;
  const tiles = collapse ? shown.filter((r) => r.status !== 'quiet') : shown;
  return (
    <Panel title={<span className="flex items-center gap-2">Meta heat map <span className="font-normal text-mute">{rows.length} memecoin metas · ranked live</span></span>}
      right={<span title="Recomputed every 20 seconds from mentions, launches, DEX volume and price">{asOf ? `updated ${ago(asOf, now)} ago` : 'loading…'}</span>}>
      <div className="space-y-2 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <Chips id="meta-view" value={view} onChange={setView}
            options={[{ value: 'heat', label: 'Heat' }, { value: 'mentions', label: 'Mentions' }, { value: 'volume', label: 'Volume' }, { value: 'launches', label: 'Launches' }]} />
          <select value={fam} onChange={(e) => setFam(e.target.value)} className="rounded-lg border border-white/10 bg-panel2 px-2 py-1 text-[12px]">
            <option value="all">All families</option>
            {families.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          {!!hot.length && <span className="text-[11px] text-mute">Heating now: {hot.slice(0, 5).map((r) => <button key={r.id} onClick={() => onSelect(r.id)} className="mr-1.5 text-warn hover:underline">{r.emoji} {r.name}</button>)}</span>}
        </div>
        <motion.div layout className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          <AnimatePresence initial={false}>
            {tiles.map((r) => {
              const st = META_STATUS[r.status] || META_STATUS.quiet;
              return (
                <motion.button layout key={r.id} onClick={() => onSelect(r.id)} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 36 }}
                  style={{ background: heatBg(r.heat) }}
                  className={`glass-hover min-h-[104px] min-w-0 rounded-xl border p-2 text-left ${selected === r.id ? 'border-accent2/70' : 'border-white/[0.07]'} ${r.status === 'hot' ? 'flash-pulse' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[15px] leading-none">{r.emoji}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{r.name}</span>
                    <span className={`rounded-md px-1 text-[9px] font-bold ring-1 ${st.cls}`}>{st.label}</span>
                  </div>
                  <div className="mt-1 flex items-end justify-between gap-1">
                    <div className="num text-[22px] font-semibold leading-none">{Math.round(r.heat)}</div>
                    <MiniBars data={r.spark} w={92} h={20} />
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-1 text-[10px] text-mute num">
                    <span title="mentions in the last hour (posts + headlines)">💬 {r.m_1h}{r.social_accel >= 1.5 ? <span className="text-warn"> ↑{r.social_accel}x</span> : ''}</span>
                    <span title="1h DEX volume of matching coins">{usd(r.vol_h1, 0)}</span>
                    <span title="volume-weighted 1h change" className={pctClass(r.chg_h1)}>{pct(r.chg_h1)}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-mute">
                    {r.launches_1h ? <span className="text-accent2">🚀 {r.launches_1h} new/1h · </span> : null}
                    {r.leaders.length ? r.leaders.map((c) => `$${c.symbol}`).join(' ') : `${r.coins} coins`}
                  </div>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </motion.div>
        {collapse && (
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-mute">
            <span>Quiet right now:</span>
            {quiet.map((r) => <button key={r.id} onClick={() => onSelect(r.id)} className="rounded-md bg-white/[0.04] px-1.5 py-0.5 hover:text-fg">{r.emoji} {r.name}</button>)}
          </div>
        )}
        {quiet.length > 0 && quiet.length < shown.length && (
          <button onClick={() => setShowAll((v) => !v)} className="text-[11px] text-accent hover:underline">{showAll ? 'Hide quiet metas' : `Show all ${shown.length} as tiles`}</button>
        )}
        {!rows.length && <p className="p-4 text-mute">Building the meta board… it fills in as coins, posts and headlines arrive.</p>}
      </div>
    </Panel>
  );
}

/** Drill-down: leaders, live narratives, posts and headlines for one meta. */
export function MetaDetail({ id, now, onClose }: { id: string; now: number; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    setD(null);
    const load = () => api(`/api/meta/${id}`).then(setD).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [id]);
  if (!d) return <Panel title="Meta"><p className="p-4 text-mute">Loading…</p></Panel>;
  const s = d.stats || {};
  const st = META_STATUS[s.status] || META_STATUS.quiet;
  return (
    <Panel title={<span className="flex items-center gap-2"><span className="text-base">{d.meta.emoji}</span>{d.meta.name}
      <span className={`rounded-md px-1 text-[9px] font-bold ring-1 ${st.cls}`}>{st.label}</span></span>}
      right={<button onClick={onClose} className="hover:text-fg">close ✕</button>} className="xl:sticky xl:top-14 xl:max-h-[calc(100vh-70px)]">
      <div className="space-y-3 p-2 text-[12px]">
        <div className="grid grid-cols-4 gap-2 num">
          {[['Heat', Math.round(s.heat ?? 0)], ['Mentions 1h', `${s.m_1h ?? 0} (${s.social_accel ?? 1}x)`], ['Launches 1h', s.launches_1h ?? 0],
            ['Vol 1h', usd(s.vol_h1)], ['Vol pace', `${s.vol_accel ?? 0}x`], ['Chg 1h', pct(s.chg_h1)], ['Chg 24h', pct(s.chg_h24)], ['Coins', s.coins ?? 0]]
            .map(([k, v]) => <div key={k as string} className="rounded-lg bg-white/[0.04] p-1.5"><div className="text-[9px] uppercase text-mute">{k}</div><div className="font-semibold">{v}</div></div>)}
        </div>
        <div><h3 className="mb-1 text-[10px] uppercase text-mute">Mentions per 10 min, last 6h</h3><MiniBars data={s.spark || []} w={460} h={44} /></div>
        <div>
          <h3 className="mb-1 text-[10px] uppercase text-mute">Coins in this meta (by 1h volume)</h3>
          <table className="w-full num text-[11px]"><tbody>
            {d.coins.map((t: any) => (
              <tr key={t.address} className="border-t border-white/5">
                <td className="py-1"><Link href={`/token?a=${t.address}`} className="flex items-center gap-1.5 font-semibold hover:text-accent"><TokenIcon src={t.image} symbol={t.symbol} size={16} />{t.symbol}</Link></td>
                <td>{price(t.price_usd)}</td><td>mc {usd(t.market_cap ?? t.fdv)}</td><td>v1h {usd(t.vol_h1)}</td><td className={pctClass(t.chg_h1)}>{pct(t.chg_h1)}</td>
              </tr>
            ))}
          </tbody></table>
          {!d.coins.length && <p className="text-mute">No live coin matches this meta right now — a launch here would be early.</p>}
        </div>
        {!!s.narratives?.length && (
          <div>
            <h3 className="mb-1 text-[10px] uppercase text-mute">Live narratives</h3>
            {s.narratives.map((n: any) => <Link key={n.id} href={`/narratives?n=${n.id}`} className="block truncate hover:text-accent"><span className="text-mute">{n.stage}</span> {n.title} <span className="text-mute">· {n.strength}</span></Link>)}
          </div>
        )}
        <div>
          <h3 className="mb-1 text-[10px] uppercase text-mute">Headlines</h3>
          {d.news_items.slice(0, 12).map((n: any) => (
            <a key={n.id} href={n.link} target="_blank" rel="noreferrer" className="block border-t border-white/5 py-1 hover:text-accent">
              <span className="text-mute">{n.publisher || n.source} · {ago(n.published || n.fetched, now)} </span>{n.title}
            </a>
          ))}
          {!d.news_items.length && <p className="text-mute">No headlines in the last 48h.</p>}
        </div>
        <div>
          <h3 className="mb-1 text-[10px] uppercase text-mute">Posts</h3>
          {d.posts.slice(0, 20).map((p: any) => (
            <div key={p.id} className="border-t border-white/5 py-1">
              <span className="text-mute">{p.source} · {String(p.author_id || '').split(':').slice(1).join(':')} · {ago(p.ts, now)}</span>
              <div>{p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="hover:text-accent">{p.text}</a> : p.text}</div>
            </div>
          ))}
          {!d.posts.length && <p className="text-mute">No posts in the last 6h.</p>}
        </div>
        <p className="text-[10px] text-mute">Matched on: {[...d.meta.keywords, ...d.meta.phrases].join(', ')}{d.meta.tickers.length ? ` · tickers ${d.meta.tickers.map((t: string) => `$${t}`).join(' ')}` : ''}. Edit config/metas.yaml to tune.</p>
      </div>
    </Panel>
  );
}
