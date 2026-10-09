'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { NarrativeTags } from '@/components/discover';
import { AnimatePresence, motion } from '@/components/motion';
import { Copy, SafetyFlags, TokenIcon } from '@/components/ui';
import { onSpot, Reveal } from '@/components/whoop';
import { api, apiCached, peek } from '@/lib/api';
import { ago, pct, pctClass, short, usd } from '@/lib/format';
import { tokenLinks } from '@/lib/links';
import { useLive, useNow } from '@/lib/live';

const COLS = [
  { key: 'new', title: 'New', sub: 'Just launched on the bonding curve', color: 'var(--color-accent2)' },
  { key: 'final_stretch', title: 'Final stretch', sub: '60%+ of the way to graduation', color: 'var(--color-warn)' },
  { key: 'migrated', title: 'Migrated', sub: 'Graduated to an AMM pool', color: 'var(--color-up)' },
] as const;

export default function PulsePage() {
  const [d, setD] = useState<any>(null);
  const [paused, setPaused] = useState(false);
  const load = useCallback(() => apiCached('/api/pulse').then(setD).catch(() => {}), []);
  useEffect(() => { const c = peek('/api/pulse'); if (c) setD(c); }, []);
  useEffect(() => { if (paused) return; load(); const t = setInterval(load, 2500); return () => clearInterval(t); }, [load, paused]);
  useLive(({ ch }) => { if (!paused && (ch === 'launch' || ch === 'graduated')) load(); });
  return (
    <div className="pt-4">
      <Reveal className="mb-8 flex flex-wrap items-end gap-4">
        <div>
          <div className="eyebrow mb-2">pump.fun lifecycle · live</div>
          <h1 className="display text-[64px] md:text-[96px]">Pulse</h1>
          <p className="mt-2 max-w-2xl text-white/60">Every launch from birth to graduation in three live columns, with bonding-curve progress, buyers, dev buy and safety at a glance. Hover a column to pause it.</p>
        </div>
        <span className={`ml-auto rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] ${paused ? 'bg-warn/15 text-warn' : 'bg-up/15 text-up'}`}>{paused ? 'Paused' : 'Streaming'}</span>
      </Reveal>
      <div className="grid gap-4 lg:grid-cols-3">
        {COLS.map((c) => (
          <section key={c.key} className="glass flex h-[calc(100vh-260px)] min-h-[520px] flex-col overflow-hidden rounded-[28px]"
            onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
            <header className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-4">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.color, boxShadow: `0 0 10px ${c.color}` }} />
              <span className="display text-[26px]">{c.title}</span>
              <span className="stat ml-1 text-[20px] text-white/35">{d?.[c.key]?.length ?? ''}</span>
              <span className="ml-auto text-[11px] text-white/40">{c.sub}</span>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <AnimatePresence initial={false}>
                {(d?.[c.key] || []).map((t: any) => <PulseCard key={t.address} t={t} color={c.color} />)}
              </AnimatePresence>
              {d && !d[c.key]?.length && <p className="p-10 text-center text-white/35">Nothing here yet.</p>}
              {!d && [0, 1, 2, 3].map((i) => <div key={i} className="skeleton m-1 h-28" />)}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function PulseCard({ t, color }: { t: any; color: string }) {
  const now = useNow(5000);
  const prog = t.graduated_at ? 100 : t.curve_progress ?? 0;
  return (
    <motion.div layout initial={{ opacity: 0, y: -12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }} onMouseMove={onSpot}
      className="spotlight mb-2 rounded-2xl border border-white/[0.05] bg-white/[0.02] p-3 transition hover:border-white/20">
      <div className="flex items-center gap-3">
        <TokenIcon src={t.image} symbol={t.symbol} size={40} />
        <div className="min-w-0 flex-1">
          <Link href={`/token?a=${t.address}`} className="flex items-baseline gap-1.5"><b className="truncate text-[15px]">{t.symbol || short(t.address)}</b><span className="truncate text-[12px] text-white/40">{t.name}</span></Link>
          <div className="flex items-center gap-2 text-[11px] text-white/45">
            <span>{ago(t.launched_at || t.first_seen, now)}</span>
            {t.buyers_5m != null && <span>{t.buyers_5m} buyers/5m</span>}
            {t.trades_5m != null && <span>{t.trades_5m} tx/5m</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="stat text-[22px] leading-none">{usd(t.mcap_usd)}</div>
          {t.chg_h1 != null && <div className={`text-[11px] ${pctClass(t.chg_h1)}`}>{pct(t.chg_h1)} 1h</div>}
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
          <motion.div className="absolute inset-y-0 left-0 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }}
            initial={false} animate={{ width: `${prog}%` }} transition={{ duration: 0.8 }} />
        </div>
        <span className="stat w-12 text-right text-[14px]" title="bonding-curve progress (approx.)">{Math.round(prog)}%</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
        {t.dev_initial_buy_pct != null && <span className={`rounded-md px-1.5 py-0.5 ${t.dev_initial_buy_pct > 10 ? 'bg-down/15 text-down' : 'bg-white/5 text-white/50'}`}>dev {t.dev_initial_buy_pct}%</span>}
        {t.holders != null && <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-white/50">{t.holders} holders</span>}
        {t.liquidity_usd != null && <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-white/50">liq {usd(t.liquidity_usd)}</span>}
        <SafetyFlags t={t} />
        <span className="flex-1" />
        <Copy text={t.address} label="CA" />
        {tokenLinks(t.address).slice(2, 3).map((l) => <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="rounded-lg border border-white/10 px-1.5 py-0.5 text-white/50 hover:text-white">{l.label}</a>)}
      </div>
      {!!t.narratives?.length && <div className="mt-2"><NarrativeTags items={t.narratives} max={2} /></div>}
    </motion.div>
  );
}
