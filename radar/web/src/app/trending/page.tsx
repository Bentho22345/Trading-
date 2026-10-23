'use client';
import { useMemo, useState } from 'react';
import { CoinGrid, HeatMap, NarrativeTags, useDiscover } from '@/components/discover';
import { Icon } from '@/components/Icon';
import { AnimatedNumber, Chips, motion } from '@/components/motion';
import { ago } from '@/lib/format';
import { useNow } from '@/lib/live';

type View = 'cards' | 'heat';
type Sort = 'score' | 'slope' | 'steady' | 'mcap';

export default function TrendingPage() {
  const now = useNow();
  const [hours, setHours] = useState<'2' | '4' | '8'>('4');
  const [minLiq, setMinLiq] = useState<'5000' | '25000' | '100000'>('5000');
  const [view, setView] = useState<View>('cards');
  const [sort, setSort] = useState<Sort>('score');
  const [cat, setCat] = useState('all');
  const { d } = useDiscover(`/api/discover/climbers?hours=${hours}&min_liq=${minLiq}&limit=80`, 10000);
  const cats = useMemo(() => Array.from(new Set((d?.rows || []).flatMap((r) => r.narratives.map((n: any) => n.category)).filter(Boolean))), [d]);
  const rows = useMemo(() => {
    let r = [...(d?.rows || [])];
    if (cat !== 'all') r = r.filter((x) => x.narratives.some((n: any) => n.category === cat));
    const key: Record<Sort, (x: any) => number> = { score: (x) => x.climb.score, slope: (x) => x.climb.slope_pct_h, steady: (x) => x.climb.r2, mcap: (x) => x.market_cap ?? x.fdv ?? 0 };
    return r.sort((a, b) => key[sort](b) - key[sort](a));
  }, [d, sort, cat]);
  const withNarr = rows.filter((r) => r.narratives.length).length;
  return (
    <div className="space-y-4">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><Icon name="trending" size={22} className="text-up" /> <span className="grad-text">Trending</span></h1>
          <p className="text-mute">Coins climbing <b className="text-fg">steadily</b> in market cap: consistent slope, higher lows, shallow dips. Not one-candle pumps.</p>
        </div>
        <div className="ml-auto flex gap-4 text-right">
          <div><div className="text-[10px] uppercase tracking-wider text-mute">climbers</div><AnimatedNumber value={rows.length} className="num text-xl font-semibold" /></div>
          <div><div className="text-[10px] uppercase tracking-wider text-mute">with narrative</div><AnimatedNumber value={withNarr} className="num text-xl font-semibold" /></div>
          <div><div className="text-[10px] uppercase tracking-wider text-mute">updated</div><span className="num text-xl font-semibold">{d ? `${ago(d.as_of, now)}` : '—'}</span></div>
        </div>
      </motion.div>

      <div className="glass flex flex-wrap items-center gap-2 rounded-2xl p-2">
        <Chips id="tv" value={view} onChange={setView} options={[{ value: 'cards', label: 'Cards' }, { value: 'heat', label: 'Heat map' }]} />
        <Chips id="th" value={hours} onChange={setHours} options={[{ value: '2', label: '2h trend' }, { value: '4', label: '4h trend' }, { value: '8', label: '8h trend' }]} />
        <Chips id="tl" value={minLiq} onChange={setMinLiq} options={[{ value: '5000', label: 'liq $5K+' }, { value: '25000', label: '$25K+' }, { value: '100000', label: '$100K+' }]} />
        <Chips id="ts" value={sort} onChange={setSort} options={[{ value: 'score', label: 'Best climb' }, { value: 'slope', label: 'Fastest' }, { value: 'steady', label: 'Steadiest' }, { value: 'mcap', label: 'Biggest' }]} />
        {!!cats.length && <Chips id="tc" value={cat} onChange={setCat} options={[{ value: 'all', label: 'All narratives' }, ...cats.map((c) => ({ value: c, label: c }))]} />}
      </div>

      {!d ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-64" />)}</div>
      ) : view === 'heat' ? (
        <div className="glass rounded-2xl p-3"><HeatMap rows={rows} /></div>
      ) : (
        <CoinGrid rows={rows} kind="climb" empty="No steady climbers right now. Radar needs ~30 minutes of its own price history per coin, or DexScreener windows that all point up." />
      )}

      {!!rows.length && (
        <div className="glass rounded-2xl p-3">
          <h2 className="mb-2 text-[12px] font-semibold">Narratives behind today’s climbers</h2>
          <NarrativeTags items={rows.flatMap((r) => r.narratives)} max={30} />
        </div>
      )}
    </div>
  );
}
