'use client';
import { useEffect, useRef } from 'react';
import { useStore, type FeedFilter } from '@/lib/store';
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

export function FilterBar({ counts }: { counts: { shown: number; total: number } }) {
  const filter = useStore((s) => s.filter);
  const search = useStore((s) => s.search);
  const high = useStore((s) => s.highImpactOnly);
  const breakingOnly = useStore((s) => s.breakingOnly);
  const set = useStore((s) => s.set);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    searchInputRef.current = ref.current;
  }, []);

  return (
    <div className="flex flex-col gap-2 px-1 pb-2">
      <div className="overflow-x-auto">
        <Segmented label="Feed filter" size="md" value={filter} onChange={(v) => set({ filter: v })} options={TABS} />
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
