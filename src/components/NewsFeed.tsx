'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { NewsCluster } from '@shared/types';
import { useStore } from '@/lib/store';
import { useCalm } from '@/lib/hooks';
import { matchesFilter, feedOrder } from '@/lib/filter';
import { NewsCard } from './NewsCard';
import { FilterBar } from './FilterBar';
import { NextEventCard } from './NextEvent';
import { HandoffCards } from './HandoffCards';
import { EmptyState, Skeleton, Icon } from './ui';
import { useSettings } from '@/lib/settings';

function FeedSkeleton() {
  return (
    <div className="space-y-2 p-1" aria-busy>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="rounded-xl border border-line bg-panel p-3">
          <Skeleton className="mb-2 h-3 w-40" />
          <Skeleton className="mb-1.5 h-4 w-full" />
          <Skeleton className="mb-2 h-4 w-3/4" />
          <Skeleton className="h-3 w-56" />
        </div>
      ))}
    </div>
  );
}

export function NewsFeed({ initial }: { initial?: NewsCluster[] }) {
  const live = useStore((s) => s.clusters);
  // server-rendered first screen until the WebSocket snapshot arrives
  const clusters = live.length || !initial ? live : initial;
  const hydrated = useStore((s) => s.hydrated);
  const filter = useStore((s) => s.filter);
  const search = useStore((s) => s.search);
  const highImpactOnly = useStore((s) => s.highImpactOnly);
  const breakingOnly = useStore((s) => s.breakingOnly);
  const breakingThreshold = useStore((s) => s.breakingThreshold);
  const savedIds = useStore((s) => s.savedIds);
  const readIds = useStore((s) => s.readIds);
  const selectedId = useStore((s) => s.selectedId);
  const focus = useSettings((s) => s.focus);
  const calm = useCalm();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [anchorTs, setAnchorTs] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const filtered = useMemo(
    () => clusters.filter((c) => matchesFilter(c, { filter, search, highImpactOnly, breakingOnly, breakingThreshold, savedIds })),
    [clusters, filter, search, highImpactOnly, breakingOnly, breakingThreshold, savedIds],
  );
  // While the reader is scrolled down, hold back newer items so nothing shifts under them.
  const display = useMemo(() => (anchorTs === null ? filtered : filtered.filter((c) => c.receivedAt <= anchorTs)), [filtered, anchorTs]);
  const pending = filtered.length - display.length;
  feedOrder.ids = display.map((c) => c.id);

  // "fresh" = arrived live after the initial load → gets the entrance animation once
  const seen = useRef<Map<string, number>>(new Map());
  const readyAt = useRef<number | null>(null);
  useEffect(() => {
    if (hydrated && readyAt.current === null) readyAt.current = Date.now() + 800;
  }, [hydrated]);
  const now = Date.now();
  for (const c of display) {
    if (!seen.current.has(c.id)) seen.current.set(c.id, readyAt.current !== null && now > readyAt.current ? now : 0);
  }
  if (seen.current.size > 2000) {
    const keep = new Set(clusters.map((c) => c.id));
    for (const k of seen.current.keys()) if (!keep.has(k)) seen.current.delete(k);
  }

  const virt = useVirtualizer({
    count: display.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 132,
    overscan: 6,
    gap: 8,
    initialRect: { width: 720, height: 1000 }, // lets the first screen server-render
    getItemKey: (i) => display[i]?.id ?? i,
  });

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atTop = el.scrollTop < 24;
    if (atTop && anchorTs !== null) setAnchorTs(null);
    else if (!atTop && anchorTs === null) setAnchorTs(display[0]?.receivedAt ?? Date.now());
  }, [anchorTs, display]);

  const jumpToTop = () => {
    setAnchorTs(null);
    scrollRef.current?.scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' });
  };

  // keyboard selection → keep the selected card in view
  useEffect(() => {
    if (!selectedId) return;
    const idx = display.findIndex((c) => c.id === selectedId);
    if (idx >= 0) virt.scrollToIndex(idx, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const loadOlder = async () => {
    const oldest = clusters[clusters.length - 1];
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/news?before=${oldest.receivedAt}&limit=80`);
      const older = (await res.json()) as NewsCluster[];
      if (!older.length) setExhausted(true);
      const st = useStore.getState();
      const have = new Set(st.clusters.map((c) => c.id));
      const merged = [...st.clusters, ...older.filter((c) => !have.has(c.id))].sort((a, b) => b.receivedAt - a.receivedAt);
      st.set({ clusters: merged.slice(0, 1200) });
    } catch {
      useStore.getState().pushToast({ kind: 'error', title: 'Could not load older stories' });
    } finally {
      setLoadingOlder(false);
    }
  };

  const items = virt.getVirtualItems();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilterBar counts={{ shown: display.length, total: clusters.length }} />
      {focus ? <div className="px-1 pb-2"><NextEventCard compact /></div> : null}
      <HandoffCards />
      <div className="relative min-h-0 flex-1">
        {pending > 0 && (
          <button
            onClick={jumpToTop}
            className="pill-in absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-accent/40 bg-panel-solid/95 px-3 py-1 text-xs font-semibold text-text shadow-lg backdrop-blur"
          >
            <span aria-hidden>↑</span> {pending} new {pending === 1 ? 'story' : 'stories'}
          </button>
        )}
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain px-1 pb-6" role="feed" aria-busy={!hydrated && !clusters.length} aria-label="Live news feed">
          {!hydrated && !clusters.length ? (
            <FeedSkeleton />
          ) : !display.length ? (
            <div className="p-4">
              <EmptyState title={filter === 'saved' ? 'No saved stories yet' : 'No stories match these filters'} body={filter === 'saved' ? 'Press S on a story (or the bookmark icon) to save it for later.' : 'Try clearing the search or switching tabs.'} />
            </div>
          ) : (
            <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {items.map((vi) => {
                const c = display[vi.index];
                if (!c) return null;
                const t = seen.current.get(c.id) ?? 0;
                return (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={virt.measureElement}
                    className="absolute left-0 right-0 top-0"
                    style={{ transform: `translateY(${vi.start}px)`, transition: calm ? undefined : 'transform 340ms cubic-bezier(0.2, 0.8, 0.2, 1)' }}
                  >
                    <NewsCard c={c} fresh={t > 0 && now - t < 2000} selected={selectedId === c.id} read={readIds.has(c.id)} saved={savedIds.has(c.id)} />
                  </div>
                );
              })}
            </div>
          )}
          {hydrated && display.length > 0 && filter !== 'saved' ? (
            <div className="flex justify-center py-4">
              <button onClick={loadOlder} disabled={loadingOlder || exhausted} className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1 text-xs text-dim hover:border-line-strong hover:text-text disabled:opacity-50">
                {exhausted ? 'No older stories' : loadingOlder ? 'Loading…' : <>Load older stories <Icon name="chevron" size={12} /></>}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
