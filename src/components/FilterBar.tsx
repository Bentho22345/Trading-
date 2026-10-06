'use client';
import { useEffect, useRef } from 'react';
import { useMemo } from 'react';
import type { FeedFilter } from '@/lib/store';
import { useStore } from '@/lib/store';
import type { SmartFeed } from '@shared/v2';
import { matches } from '@shared/rules';
import { useFeedFilter } from '@/lib/feedFilter';
import { useDocs, useV2 } from '@/lib/v2';
import { Segmented, Icon, Kbd } from './ui';

const TABS: { value: FeedFilter; label: string; accent?: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'fx', label: 'FX', accent: 'var(--fx)' },
  { value: 'crypto', label: 'Crypto', accent: 'var(--crypto)' },
  { value: 'equities', label: 'Equities & Options', accent: 'var(--eq)' },
  { value: 'macro', label: 'Macro', accent: 'var(--macro)' },
  { value: 'saved', label: 'Saved' },
];

export const searchInputRef: { current: HTMLInputElement | null } = { current: null };

/** Matches per hour over the last 12h, for the tiny sparkline in each smart-feed tab. */
function useFeedRates(feeds: SmartFeed[]) {
  const clusters = useStore((s) => s.clusters);
  return useMemo(() => {
    const now = Date.now();
    const out: Record<string, number[]> = {};
    for (const f of feeds) {
      const bins = new Array(12).fill(0);
      for (const c of clusters) {
        const age = Math.floor((now - c.receivedAt) / 3600_000);
        if (age >= 0 && age < 12 && matches(f.query, c, { watch: !!c.watchHit })) bins[11 - age]++;
      }
      out[f.id] = bins;
    }
    return out;
  }, [feeds, clusters]);
}

function MiniBars({ data, color }: { data: number[]; color: string }) {
  const max = Math.max(1, ...data);
  return (
    <span className="inline-flex h-3 items-end gap-px" aria-hidden>
      {data.map((v, i) => <span key={i} className="w-[2px] rounded-sm" style={{ height: `${Math.max(8, (v / max) * 100)}%`, background: color, opacity: v ? 0.9 : 0.25 }} />)}
    </span>
  );
}

export function FilterBar({ counts, compact = false }: { counts: { shown: number; total: number }; compact?: boolean }) {
  const { state, set, local } = useFeedFilter();
  const { filter, search, highImpactOnly: high, breakingOnly, smartFeedId } = state;
  const feeds = useDocs<SmartFeed>('smart_feeds');
  const sorted = useMemo(() => [...feeds].sort((a, b) => a.order - b.order), [feeds]);
  const rates = useFeedRates(sorted);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!local) searchInputRef.current = ref.current;
  }, [local]);

  return (
    <div className="flex flex-col gap-2 px-1 pb-2">
      <div className="flex items-center gap-2 overflow-x-auto">
        <Segmented label="Feed filter" size={compact ? 'sm' : 'md'} value={smartFeedId ? ('' as FeedFilter) : filter} onChange={(v) => set({ filter: v, smartFeedId: null })} options={TABS} />
        {sorted.map((f) => (
          <button key={f.id} onClick={() => set({ smartFeedId: smartFeedId === f.id ? null : f.id })} onDoubleClick={() => useV2.getState().set({ feedBuilder: f.id })} title={`${f.query}\nDouble-click to edit`}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium ${smartFeedId === f.id ? 'border-line-strong bg-panel-hover text-text' : 'border-line text-faint hover:text-dim'}`}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: f.color }} />{f.icon ? <span aria-hidden>{f.icon}</span> : null}{f.name}
            <MiniBars data={rates[f.id] ?? []} color={f.color} />
          </button>
        ))}
        <button onClick={() => useV2.getState().set({ feedBuilder: 'new' })} className="flex shrink-0 items-center gap-1 rounded-lg border border-dashed border-line px-2 py-1 text-[11px] text-faint hover:text-text" title="New smart feed"><Icon name="plus" size={11} />Feed</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="glass flex min-w-[220px] flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 focus-within:border-accent/50">
          <Icon name="search" size={14} className="text-faint" />
          <input
            ref={ref}
            value={search}
            onChange={(e) => set({ search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                set({ search: '' });
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Search headlines, $tickers, pairs, sources…"
            className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-faint focus:outline-none focus-visible:outline-none"
            aria-label="Search news"
          />
          {search ? (
            <button onClick={() => set({ search: '' })} className="text-faint hover:text-text" aria-label="Clear search"><Icon name="x" size={12} /></button>
          ) : (
            <Kbd>/</Kbd>
          )}
        </label>
        <Toggle on={high} onClick={() => set({ highImpactOnly: !high })} label="High impact" title="Only show impact ≥ 60" />
        <Toggle on={breakingOnly} onClick={() => set({ breakingOnly: !breakingOnly })} label="Breaking" title="Breaking only (B)" />
        <span className="num hidden text-[10px] text-faint xl:inline">{counts.shown}/{counts.total}</span>
      </div>
    </div>
  );
}

function Toggle({ on, onClick, label, title }: { on: boolean; onClick: () => void; label: string; title: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors ${on ? 'border-warn/50 bg-warn/10 text-warn' : 'border-line text-dim hover:border-line-strong hover:text-text'}`}
    >
      <span className={`relative h-3 w-5 rounded-full transition-colors ${on ? 'bg-warn/70' : 'bg-line-strong'}`}>
        <span className={`absolute top-0.5 h-2 w-2 rounded-full bg-white transition-transform ${on ? 'translate-x-2.5' : 'translate-x-0.5'}`} />
      </span>
      {label}
    </button>
  );
}
