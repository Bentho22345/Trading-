'use client';
import { create } from 'zustand';
import type { TickerGroup } from '@shared/types';

export type PanelId = 'sessions' | 'calendar' | 'banks' | 'strength' | 'heatmap' | 'crypto' | 'vol' | 'watchlist' | 'alerts';

export const PANEL_LABELS: Record<PanelId, string> = {
  sessions: 'Market sessions', calendar: 'Economic calendar', banks: 'Central bank watch', strength: 'Currency strength',
  heatmap: 'FX heatmap', crypto: 'Crypto', vol: 'Volatility & options', watchlist: 'Watchlist', alerts: 'Alerts',
};

export interface Layout {
  left: PanelId[];
  right: PanelId[];
  hidden: PanelId[];
}

export interface Settings {
  theme: 'dark' | 'light';
  colorblind: boolean;
  calm: boolean;
  tickerSpeed: number; // px/s
  tickerGroups: TickerGroup[];
  sound: boolean;
  notifications: boolean;
  focus: boolean;
  layout: Layout;
}

export const DEFAULT_LAYOUT: Layout = {
  left: ['sessions', 'calendar', 'banks'],
  right: ['strength', 'heatmap', 'crypto', 'vol', 'watchlist', 'alerts'],
  hidden: [],
};

const DEFAULTS: Settings = {
  theme: 'dark', colorblind: false, calm: false, tickerSpeed: 45, tickerGroups: ['EQ', 'FX', 'CRYPTO'],
  sound: false, notifications: false, focus: false, layout: DEFAULT_LAYOUT,
};

const KEY = 'pulse.settings.v1';

function load(): Settings {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const s = { ...DEFAULTS, ...JSON.parse(raw) } as Settings;
    // repair layouts from older versions: every panel must appear exactly once
    const all = new Set<PanelId>([...DEFAULT_LAYOUT.left, ...DEFAULT_LAYOUT.right]);
    const seen = new Set<PanelId>();
    const clean = (a: PanelId[]) => a.filter((p) => all.has(p) && !seen.has(p) && seen.add(p));
    const left = clean(s.layout?.left ?? []), right = clean(s.layout?.right ?? []);
    for (const p of all) if (!seen.has(p)) (DEFAULT_LAYOUT.left.includes(p) ? left : right).push(p);
    s.layout = { left, right, hidden: (s.layout?.hidden ?? []).filter((p) => all.has(p)) };
    return s;
  } catch {
    return DEFAULTS;
  }
}

interface SettingsStore extends Settings {
  hydrated: boolean;
  hydrate: () => void;
  set: (p: Partial<Settings>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...DEFAULTS,
  hydrated: false,
  hydrate: () => set({ ...load(), hydrated: true }),
  set: (p) => {
    set(p);
    try {
      const { hydrated: _h, hydrate: _hy, set: _s, reset: _r, ...rest } = get();
      window.localStorage.setItem(KEY, JSON.stringify(rest));
    } catch {
      /* storage unavailable (private mode) — settings just won't persist */
    }
  },
  reset: () => {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    set({ ...DEFAULTS });
  },
}));
