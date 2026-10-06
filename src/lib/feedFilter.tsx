'use client';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useStore, type FeedFilter } from './store';
import { useV2 } from './v2';

export interface FeedFilterState {
  filter: FeedFilter;
  search: string;
  highImpactOnly: boolean;
  breakingOnly: boolean;
  smartFeedId: string | null;
}

interface Ctx {
  state: FeedFilterState;
  set: (p: Partial<FeedFilterState>) => void;
  local: boolean;
}

const LocalCtx = createContext<Ctx | null>(null);

/** Gives a news widget instance its own filters (e.g. an FX-only and a crypto-only feed side by side). */
export function LocalFeedFilter({ initial, children }: { initial: Partial<FeedFilterState>; children: ReactNode }) {
  const [state, setState] = useState<FeedFilterState>({ filter: 'all', search: '', highImpactOnly: false, breakingOnly: false, smartFeedId: null, ...initial });
  const value = useMemo<Ctx>(() => ({ state, set: (p) => setState((s) => ({ ...s, ...p })), local: true }), [state]);
  return <LocalCtx.Provider value={value}>{children}</LocalCtx.Provider>;
}

/** The primary feed uses the global store (keyboard shortcuts act on it); instances use their own state. */
export function useFeedFilter(): Ctx {
  const local = useContext(LocalCtx);
  const filter = useStore((s) => s.filter);
  const search = useStore((s) => s.search);
  const highImpactOnly = useStore((s) => s.highImpactOnly);
  const breakingOnly = useStore((s) => s.breakingOnly);
  const smartFeedId = useV2((s) => s.activeFeed);
  const global = useMemo<Ctx>(() => ({
    state: { filter, search, highImpactOnly, breakingOnly, smartFeedId },
    set: (p) => {
      const { smartFeedId: sf, ...rest } = p;
      if (Object.keys(rest).length) useStore.getState().set(rest);
      if (sf !== undefined) useV2.getState().set({ activeFeed: sf });
    },
    local: false,
  }), [filter, search, highImpactOnly, breakingOnly, smartFeedId]);
  return local ?? global;
}
