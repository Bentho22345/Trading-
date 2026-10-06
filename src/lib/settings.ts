'use client';
import { create } from 'zustand';
import type { TickerGroup } from '@shared/types';
import { DEFAULT_THEME, type ThemeConfig } from './theme';

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
  // ---- PULSE 2.0
  ttsRate: number;
  ttsVoice: string;
  ttsServer: boolean;
  activeWorkspace: string;
  shortcuts: Record<string, string>;
  themeConfig: ThemeConfig;
  ticker: { mode: 'auto' | 'custom'; symbols: string[]; density: 'compact' | 'comfortable'; fields: { change: boolean; pct: boolean; delay: boolean } };
  clocks: string[];
  workingHours: { start: string; end: string };
  quietHours: { enabled: boolean; start: string; end: string };
  customSessions: { id: string; label: string; tz: string; openH: number; closeH: number }[];
  squawk: { enabled: boolean; voice: string; rate: number; domains: string[]; minImpact: number; earcons: boolean };
  syncEnabled: boolean;
  updatedAt: number;
}

export const DEFAULT_LAYOUT_V1: Layout = {
  left: ['sessions', 'calendar', 'banks'],
  right: ['strength', 'heatmap', 'crypto', 'vol', 'watchlist', 'alerts'],
  hidden: [],
};

const DEFAULTS: Settings = {
  theme: 'dark', colorblind: false, calm: false, tickerSpeed: 45, tickerGroups: ['EQ', 'FX', 'CRYPTO'],
  sound: false, notifications: false, focus: false, layout: DEFAULT_LAYOUT_V1,
  ttsRate: 1, ttsVoice: '', ttsServer: false, activeWorkspace: 'desk', shortcuts: {},
  themeConfig: DEFAULT_THEME,
  ticker: { mode: 'auto', symbols: [], density: 'comfortable', fields: { change: true, pct: true, delay: true } },
  clocks: ['Europe/London', 'Asia/Tokyo'], workingHours: { start: '07:00', end: '17:00' }, quietHours: { enabled: false, start: '22:00', end: '06:30' },
  customSessions: [], squawk: { enabled: false, voice: '', rate: 1.05, domains: ['centralbanks', 'fx', 'macro'], minImpact: 75, earcons: false },
  syncEnabled: true, updatedAt: 0,
};

const KEY = 'pulse.settings.v1';

function load(): Settings {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const s = { ...DEFAULTS, ...JSON.parse(raw) } as Settings;
    s.themeConfig = { ...DEFAULT_THEME, ...s.themeConfig };
    s.ticker = { ...DEFAULTS.ticker, ...s.ticker, fields: { ...DEFAULTS.ticker.fields, ...s.ticker?.fields } };
    s.squawk = { ...DEFAULTS.squawk, ...s.squawk };
    // repair layouts from older versions: every panel must appear exactly once
    const all = new Set<PanelId>([...DEFAULT_LAYOUT_V1.left, ...DEFAULT_LAYOUT_V1.right]);
    const seen = new Set<PanelId>();
    const clean = (a: PanelId[]) => a.filter((p) => all.has(p) && !seen.has(p) && seen.add(p));
    const left = clean(s.layout?.left ?? []), right = clean(s.layout?.right ?? []);
    for (const p of all) if (!seen.has(p)) (DEFAULT_LAYOUT_V1.left.includes(p) ? left : right).push(p);
    s.layout = { left, right, hidden: (s.layout?.hidden ?? []).filter((p) => all.has(p)) };
    return s;
  } catch {
    return DEFAULTS;
  }
}

interface SettingsStore extends Settings {
  hydrated: boolean;
  hydrate: () => void;
  pullRemote: () => Promise<void>;
  set: (p: Partial<Settings>) => void;
  reset: () => void;
}

// ------------------------------------------------------------------ cross-device sync through the backend
let syncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSync() {
  if (typeof window === 'undefined') return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const st = useSettings.getState();
    if (!st.syncEnabled) return;
    const { hydrated: _h, hydrate: _hy, set: _s, reset: _r, pullRemote: _p, ...settings } = st;
    void fetch('/api/settings-sync', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings, updatedAt: st.updatedAt }) }).catch(() => {});
  }, 1500);
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...DEFAULTS,
  hydrated: false,
  hydrate: () => {
    set({ ...load(), hydrated: true });
    void get().pullRemote();
  },
  /** Adopt settings saved from another device if they are newer than ours. */
  pullRemote: async () => {
    try {
      const res = await fetch('/api/settings-sync');
      const doc = (await res.json()) as { settings?: Partial<Settings>; updatedAt?: number } | null;
      if (!doc?.settings || !get().syncEnabled) return;
      if ((doc.updatedAt ?? 0) > (get().updatedAt ?? 0)) {
        set({ ...DEFAULTS, ...doc.settings, updatedAt: doc.updatedAt });
        const { hydrated: _h, hydrate: _hy, set: _s, reset: _r, pullRemote: _p, ...rest } = get();
        window.localStorage.setItem(KEY, JSON.stringify(rest));
      }
    } catch {
      /* offline or worker down: local settings stand */
    }
  },
  set: (p) => {
    set({ ...p, updatedAt: Date.now() });
    scheduleSync();
    try {
      const { hydrated: _h, hydrate: _hy, set: _s, reset: _r, pullRemote: _p, ...rest } = get();
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
