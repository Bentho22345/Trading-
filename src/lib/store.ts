'use client';
import { create } from 'zustand';
import type {
  AlertEvent, AlertRule, Analytics, CentralBank, CryptoMarket, EconEvent, NewsCluster, Quote, Snapshot, StreamStatus, SymbolMeta, VolData, WatchItem,
} from '@shared/types';

export type FeedFilter = 'all' | 'fx' | 'crypto' | 'equities' | 'macro' | 'saved';

export interface Toast {
  id: string;
  kind: 'alert' | 'info' | 'error';
  title: string;
  body?: string;
  ts: number;
}

const MAX_CLUSTERS = 600;
const SPARK_POINTS = 48;
const SPARK_STEP_MS = 5 * 60_000;

interface State {
  conn: 'connecting' | 'open' | 'closed';
  rttMs: number | null;
  lastMsgAt: number | null;
  serverOffset: number;
  hydrated: boolean;

  symbols: Record<string, SymbolMeta>;
  quotes: Record<string, Quote>;
  sparks: Record<string, number[]>;
  sparkT: Record<string, number>;
  statuses: StreamStatus[];
  clusters: NewsCluster[];
  calendar: EconEvent[];
  banks: CentralBank[];
  crypto: CryptoMarket | null;
  vol: VolData | null;
  analytics: Analytics | null;
  watchlist: WatchItem[];
  alerts: AlertRule[];
  alertEvents: AlertEvent[];
  readIds: Set<string>;
  savedIds: Set<string>;
  aiEnabled: boolean;
  breakingThreshold: number;

  // UI
  filter: FeedFilter;
  search: string;
  highImpactOnly: boolean;
  breakingOnly: boolean;
  selectedId: string | null;
  drawerSymbol: string | null;
  timelineId: string | null;
  breaking: NewsCluster | null;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  settingsOpen: boolean;
  layoutEditing: boolean;
  digestSince: number | null;
  toasts: Toast[];
  mobileTab: 'feed' | 'markets' | 'calendar' | 'watch';
}

interface Actions {
  applySnapshot: (s: Snapshot) => void;
  applyQuotes: (qs: Quote[]) => void;
  upsertCluster: (c: NewsCluster, breakingNow?: boolean) => void;
  set: (p: Partial<State>) => void;
  markRead: (id: string, read?: boolean) => void;
  toggleSaved: (id: string) => void;
  pushToast: (t: Omit<Toast, 'id' | 'ts'>) => void;
  dismissToast: (id: string) => void;
}

export const useStore = create<State & Actions>((set, get) => ({
  conn: 'connecting', rttMs: null, lastMsgAt: null, serverOffset: 0, hydrated: false,
  symbols: {}, quotes: {}, sparks: {}, sparkT: {}, statuses: [], clusters: [], calendar: [], banks: [], crypto: null, vol: null,
  analytics: null, watchlist: [], alerts: [], alertEvents: [], readIds: new Set(), savedIds: new Set(), aiEnabled: false, breakingThreshold: 75,
  filter: 'all', search: '', highImpactOnly: false, breakingOnly: false, selectedId: null, drawerSymbol: null, timelineId: null,
  breaking: null, paletteOpen: false, shortcutsOpen: false, settingsOpen: false, layoutEditing: false, digestSince: null, toasts: [],
  mobileTab: 'feed',

  applySnapshot: (s) => {
    const now = Date.now();
    const quotes: Record<string, Quote> = {};
    for (const q of s.quotes) quotes[q.symbol] = q;
    const sparkT: Record<string, number> = {};
    for (const k of Object.keys(s.sparks)) sparkT[k] = now;
    // merge rather than replace clusters: a reconnect must not drop items we already show
    const existing = new Map(get().clusters.map((c) => [c.id, c]));
    for (const c of s.clusters) existing.set(c.id, c);
    set({
      hydrated: true,
      serverOffset: s.serverTime - now,
      symbols: Object.fromEntries(s.symbols.map((m) => [m.symbol, m])),
      quotes, sparks: s.sparks, sparkT, statuses: s.statuses,
      clusters: [...existing.values()].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, MAX_CLUSTERS),
      calendar: s.calendar, banks: s.banks, crypto: s.crypto, vol: s.vol, analytics: s.analytics,
      watchlist: s.watchlist, alerts: s.alerts, readIds: new Set(s.readIds), savedIds: new Set(s.savedIds),
      aiEnabled: s.aiEnabled, breakingThreshold: s.breakingThreshold,
    });
  },

  applyQuotes: (qs) => {
    const st = get();
    const quotes = { ...st.quotes };
    let sparks = st.sparks, sparkT = st.sparkT;
    const now = Date.now();
    for (const q of qs) {
      quotes[q.symbol] = q;
      const arr = sparks[q.symbol];
      if (!arr) continue;
      if (now - (sparkT[q.symbol] ?? 0) >= SPARK_STEP_MS) {
        if (sparks === st.sparks) { sparks = { ...sparks }; sparkT = { ...sparkT }; }
        sparks[q.symbol] = [...arr, q.price].slice(-SPARK_POINTS);
        sparkT[q.symbol] = now;
      }
    }
    set({ quotes, sparks, sparkT });
  },

  upsertCluster: (c, breakingNow) => {
    const list = get().clusters;
    const idx = list.findIndex((x) => x.id === c.id);
    let next: NewsCluster[];
    if (idx >= 0) {
      next = list.slice();
      next[idx] = c;
    } else {
      next = [c, ...list];
      if (next.length > MAX_CLUSTERS) next.length = MAX_CLUSTERS; // prune oldest from memory
      if (next.length > 1 && next[1].receivedAt > c.receivedAt) next.sort((a, b) => b.receivedAt - a.receivedAt);
    }
    set({ clusters: next, ...(breakingNow ? { breaking: c } : {}) });
  },

  set: (p) => set(p),

  markRead: (id, read = true) => {
    const s = new Set(get().readIds);
    if (read === s.has(id)) return;
    read ? s.add(id) : s.delete(id);
    set({ readIds: s });
    void fetch('/api/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id], unread: !read }) }).catch(() => {});
  },

  toggleSaved: (id) => {
    const s = new Set(get().savedIds);
    const saved = !s.has(id);
    saved ? s.add(id) : s.delete(id);
    set({ savedIds: s });
    void fetch('/api/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, saved }) }).catch(() => {});
  },

  pushToast: (t) => {
    const toast: Toast = { ...t, id: Math.random().toString(36).slice(2), ts: Date.now() };
    set({ toasts: [...get().toasts.slice(-4), toast] });
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Server-corrected "now" */
export const serverNow = () => Date.now() + useStore.getState().serverOffset;
