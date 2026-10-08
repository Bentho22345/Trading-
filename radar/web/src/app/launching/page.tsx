'use client';
import { useMemo, useState } from 'react';
import { CoinGrid, LaunchWatchPanel, useDiscover } from '@/components/discover';
import { Icon } from '@/components/Icon';
import { AnimatedNumber, Chips, motion } from '@/components/motion';
import { ago } from '@/lib/format';
import { useNow } from '@/lib/live';

type Age = '1' | '6' | '24';
type Basis = 'all' | 'dex' | 'curve';

export default function LaunchingPage() {
  const now = useNow();
  const [age, setAge] = useState<Age>('24');
  const [basis, setBasis] = useState<Basis>('all');
  const [safe, setSafe] = useState<'any' | 'clean'>('any');
  const { d } = useDiscover(`/api/discover/launching?max_age_h=${age}&limit=80`, 5000);
  const rows = useMemo(() => (d?.rows || []).filter((r) =>
    (basis === 'all' || (basis === 'curve') === (r.explosion.basis === 'bonding_curve')) &&
    (safe === 'any' || (r.safety_as_of && !r.mint_authority && !r.freeze_authority && !r.rugged && (r.flow?.sniper_supply_pct ?? 0) < 15))), [d, basis, safe]);
  return (
    <div className="space-y-4">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><Icon name="rocket" size={22} className="text-flash" /> <span className="grad-text">Launching</span></h1>
          <p className="text-mute">New coins <b className="text-fg">exploding</b> right now: volume pace accelerating, market cap and liquidity jumping in the last 15 minutes, plus pump.fun bonding-curve rockets.</p>
        </div>
        <div className="ml-auto flex gap-4 text-right">
          <div><div className="text-[10px] uppercase tracking-wider text-mute">exploding</div><AnimatedNumber value={rows.length} className="num text-xl font-semibold" /></div>
          <div><div className="text-[10px] uppercase tracking-wider text-mute">updated</div><span className="num text-xl font-semibold">{d ? ago(d.as_of, now) : '—'}</span></div>
        </div>
      </motion.div>
      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          <div className="glass flex flex-wrap items-center gap-2 rounded-2xl p-2">
            <Chips id="la" value={age} onChange={setAge} options={[{ value: '1', label: '< 1h old' }, { value: '6', label: '< 6h' }, { value: '24', label: '< 24h' }]} />
            <Chips id="lb" value={basis} onChange={setBasis} options={[{ value: 'all', label: 'All' }, { value: 'dex', label: 'On DEX' }, { value: 'curve', label: 'Bonding curve' }]} />
            <Chips id="ls" value={safe} onChange={setSafe} options={[{ value: 'any', label: 'Any safety' }, { value: 'clean', label: 'Clean only' }]} />
          </div>
          {!d ? <div className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-72" />)}</div>
            : <CoinGrid narrow rows={rows} kind="launch" empty="Nothing exploding right now. This page refreshes every 5 seconds." />}
        </div>
        <aside className="space-y-3">
          <div className="glass rounded-2xl p-3">
            <h2 className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold"><Icon name="eye" size={14} className="text-accent2" /> Launch Watch</h2>
            <p className="mb-2 text-[11px] text-mute">Arm a ticker or phrase from a narrative you expect to be tokenized. Radar fires a FLASH alert (screen + phone) the instant a matching coin launches on pump.fun or appears on a DEX.</p>
            <LaunchWatchPanel />
          </div>
          <div className="glass rounded-2xl p-3 text-[11px] text-mute">
            <b className="text-fg">How “exploding” is measured</b>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              <li>Volume pace: last 5 min × 12 vs last hour (≥1.5×), or last hour × 6 vs 6h (≥2×)</li>
              <li>Market cap +15% or more in 15 min (Radar’s own ticks)</li>
              <li>Liquidity growth over the same 15 min</li>
              <li>Bonding curve: market cap ×1.5+ in 10 min with 15+ trades</li>
            </ul>
            <p className="mt-1">Explosive launches are where snipers and rugs live. Check the dev-buy and sniper chips, and the safety flags, before buying.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
