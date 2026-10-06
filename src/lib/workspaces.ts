'use client';
import { create } from 'zustand';
import type { WidgetInstance, WidgetType, Workspace } from '@shared/v2';
import { compact, placeNew } from '@shared/grid';
import { useV2 } from './v2';
import { useSettings } from './settings';

export interface WidgetMeta {
  label: string;
  w: number;
  h: number;
  accent: string;
  group: 'News' | 'Markets' | 'Macro & rates' | 'Crypto' | 'Equities' | 'Personal' | 'Intelligence';
  description: string;
  configurable?: boolean;
}

/** Every panel that can live in a workspace. Multiple instances of the same type are allowed. */
export const WIDGETS: Record<WidgetType, WidgetMeta> = {
  news: { label: 'News feed', w: 6, h: 24, accent: 'var(--accent)', group: 'News', description: 'Clustered, scored live news. Pin it to an asset class or a smart feed.', configurable: true },
  sessions: { label: 'Market sessions', w: 3, h: 8, accent: 'var(--macro)', group: 'Markets', description: 'Session clock with holidays, expiries and DST markers.' },
  calendar: { label: 'Economic calendar', w: 3, h: 12, accent: 'var(--macro)', group: 'Macro & rates', description: 'Releases with consensus, previous and countdowns.' },
  banks: { label: 'Central bank watch', w: 3, h: 8, accent: 'var(--macro)', group: 'Macro & rates', description: 'Policy rates, next meetings and latest headlines.' },
  strength: { label: 'Currency strength', w: 3, h: 8, accent: 'var(--fx)', group: 'Markets', description: 'Relative strength of the eight majors.' },
  heatmap: { label: 'FX heatmap', w: 3, h: 9, accent: 'var(--fx)', group: 'Markets', description: 'Cross-rate moves across the majors.' },
  crypto: { label: 'Crypto', w: 3, h: 11, accent: 'var(--crypto)', group: 'Crypto', description: 'Majors, dominance, fear & greed, funding, liquidations.' },
  vol: { label: 'Volatility & options', w: 3, h: 11, accent: 'var(--eq)', group: 'Equities', description: 'VIX term structure, put/call, unusual activity, earnings.' },
  watchlist: { label: 'Watchlist', w: 3, h: 8, accent: 'var(--accent)', group: 'Personal', description: 'Your tickers, pairs, coins and keywords.' },
  alerts: { label: 'Alerts', w: 3, h: 8, accent: 'var(--warn)', group: 'Personal', description: 'Price, move and keyword alerts.' },
  rates: { label: 'Rates & yields', w: 4, h: 13, accent: 'var(--rates)', group: 'Macro & rates', description: 'Treasury curve, spreads, global 10Ys, real yields, auctions.' },
  portfolio: { label: 'Portfolio & exposure', w: 4, h: 13, accent: 'var(--accent)', group: 'Personal', description: 'Positions, exposure treemap, live P&L and stress tiles.' },
  reactions: { label: 'Reaction analyzer', w: 5, h: 13, accent: 'var(--macro)', group: 'Intelligence', description: 'Past releases: surprise vs reaction, base rates, surprise index.' },
  themes: { label: 'Theme radar', w: 4, h: 12, accent: 'var(--social)', group: 'Intelligence', description: 'Multi-day narratives by volume, sentiment and momentum.' },
  ratePaths: { label: 'Rate-path probabilities', w: 4, h: 11, accent: 'var(--rates)', group: 'Macro & rates', description: 'Hike/hold/cut odds for the next meetings, speaker tracker.' },
  crossAsset: { label: 'Commodities & DXY', w: 4, h: 9, accent: 'var(--cmdty)', group: 'Markets', description: 'Gold, silver, oil, natgas, copper and the dollar index.' },
  correlation: { label: 'Correlation matrix', w: 4, h: 12, accent: 'var(--accent)', group: 'Intelligence', description: 'Rolling correlations with break flags.' },
  regime: { label: 'Risk regime', w: 3, h: 9, accent: 'var(--accent)', group: 'Intelligence', description: 'Risk-on / risk-off dial with history.' },
  positioning: { label: 'Positioning & flows', w: 4, h: 12, accent: 'var(--cmdty)', group: 'Intelligence', description: 'CFTC COT, crypto flows, insider activity.' },
  filings: { label: 'Filings & statements', w: 4, h: 12, accent: 'var(--reg)', group: 'Equities', description: 'SEC EDGAR stream and central-bank statement diffs.' },
  social: { label: 'Social pulse', w: 3, h: 10, accent: 'var(--social)', group: 'Intelligence', description: 'Mention velocity and chatter spikes.' },
  prediction: { label: 'Prediction markets', w: 4, h: 10, accent: 'var(--social)', group: 'Intelligence', description: 'Polymarket & Kalshi odds for market-moving events.' },
  playbooks: { label: 'Event playbooks', w: 4, h: 12, accent: 'var(--warn)', group: 'Personal', description: 'Pre-planned reactions to scheduled releases.' },
  journal: { label: 'Journal', w: 4, h: 12, accent: 'var(--accent)', group: 'Personal', description: "Today's journal and notes." },
  nextEvent: { label: 'Next event', w: 3, h: 4, accent: 'var(--warn)', group: 'Macro & rates', description: 'Countdown to the next high-impact release.' },
  structure: { label: 'Market structure', w: 3, h: 9, accent: 'var(--macro)', group: 'Markets', description: 'Holidays, half-days, expiries, rebalances, rolls.' },
  chart: { label: 'Chart', w: 4, h: 10, accent: 'var(--accent)', group: 'Markets', description: 'Mini chart with your levels and notes.', configurable: true },
  briefCard: { label: 'Brief card', w: 4, h: 8, accent: 'var(--accent)', group: 'Personal', description: "Today's brief headline and take." },
  alertHistory: { label: 'Alert history', w: 4, h: 10, accent: 'var(--warn)', group: 'Personal', description: 'Fired alerts with acknowledge and snooze.' },
};

const w = (type: WidgetType, x: number, y: number, ww: number, h: number, config: WidgetInstance['config'] = {}, title?: string): WidgetInstance => ({ id: `${type}-${x}-${y}`, type, x, y, w: ww, h, config, ...(title ? { title } : {}) });

export function defaultWorkspaces(): Workspace[] {
  return [
    {
      id: 'desk', name: 'Desk', order: 0, widgets: [
        w('sessions', 0, 0, 3, 8), w('calendar', 0, 8, 3, 12), w('banks', 0, 20, 3, 8),
        w('news', 3, 0, 6, 28),
        w('strength', 9, 0, 3, 8), w('heatmap', 9, 8, 3, 9), w('crypto', 9, 17, 3, 11), w('vol', 9, 28, 3, 11), w('watchlist', 9, 39, 3, 8), w('alerts', 9, 47, 3, 8),
      ],
    },
    {
      id: 'fx', name: 'FX Desk', order: 1, schedule: { at: '07:00', days: [1, 2, 3, 4, 5] }, widgets: [
        w('news', 0, 0, 5, 26, { feed: 'fx' }, 'FX news'), w('strength', 5, 0, 3, 9), w('heatmap', 5, 9, 3, 9), w('ratePaths', 8, 0, 4, 11),
        w('calendar', 5, 18, 3, 12), w('rates', 8, 11, 4, 13), w('banks', 8, 24, 4, 8), w('positioning', 0, 26, 5, 10),
      ],
    },
    {
      id: 'crypto', name: 'Crypto Night', order: 2, widgets: [
        w('news', 0, 0, 5, 26, { feed: 'crypto' }, 'Crypto news'), w('crypto', 5, 0, 4, 13), w('social', 9, 0, 3, 10), w('prediction', 5, 13, 4, 10),
        w('watchlist', 9, 10, 3, 8), w('regime', 9, 18, 3, 9),
      ],
    },
    {
      id: 'earnings', name: 'Earnings Day', order: 3, schedule: { earningsDay: true }, widgets: [
        w('news', 0, 0, 5, 26, { feed: 'equities' }, 'Equities news'), w('vol', 5, 0, 4, 13), w('filings', 9, 0, 3, 13), w('portfolio', 5, 13, 4, 13), w('calendar', 9, 13, 3, 12),
      ],
    },
    { id: 'macro', name: 'Macro', order: 4, widgets: [w('rates', 0, 0, 4, 13), w('ratePaths', 4, 0, 4, 11), w('crossAsset', 8, 0, 4, 9), w('regime', 8, 9, 4, 9), w('correlation', 4, 11, 4, 12), w('reactions', 0, 13, 4, 13), w('themes', 8, 18, 4, 12)] },
    { id: 'focus', name: 'Focus', order: 5, widgets: [w('news', 2, 0, 8, 28), w('nextEvent', 10, 0, 2, 4)] },
  ];
}

export function newWidget(type: WidgetType, existing: WidgetInstance[], config: WidgetInstance['config'] = {}): WidgetInstance {
  const m = WIDGETS[type];
  const pos = placeNew(existing, m.w, m.h);
  return { id: `${type}-${Math.random().toString(36).slice(2, 8)}`, type, config, x: pos.x, y: pos.y, w: m.w, h: m.h };
}

// ------------------------------------------------------------------ store: active workspace + undo/redo
interface WsState {
  undo: Record<string, WidgetInstance[][]>;
  redo: Record<string, WidgetInstance[][]>;
}
export const useWorkspaceHistory = create<WsState>(() => ({ undo: {}, redo: {} }));

export function workspacesOf(list: Workspace[]): Workspace[] {
  return (list.length ? list : defaultWorkspaces()).slice().sort((a, b) => a.order - b.order);
}

export function useWorkspaces(): Workspace[] {
  const docs = useV2((s) => s.docs.workspaces) as unknown as Workspace[] | undefined;
  return workspacesOf(docs ?? []);
}

export function useActiveWorkspace(): Workspace {
  const list = useWorkspaces();
  const id = useSettings((s) => s.activeWorkspace);
  return list.find((x) => x.id === id) ?? list[0];
}

/** Persist a workspace; seeds the defaults the first time anything is edited. */
export async function saveWorkspace(ws: Workspace) {
  const v = useV2.getState();
  const existing = (v.docs.workspaces ?? []) as unknown as Workspace[];
  if (!existing.length) for (const d of defaultWorkspaces()) if (d.id !== ws.id) await v.putDoc('workspaces', d);
  await v.putDoc('workspaces', ws);
}

export function setWidgets(ws: Workspace, widgets: WidgetInstance[], record = true) {
  if (record) {
    const h = useWorkspaceHistory.getState();
    useWorkspaceHistory.setState({ undo: { ...h.undo, [ws.id]: [...(h.undo[ws.id] ?? []), ws.widgets].slice(-50) }, redo: { ...h.redo, [ws.id]: [] } });
  }
  void saveWorkspace({ ...ws, widgets: compact(widgets) });
}

export function undoLayout(ws: Workspace) {
  const h = useWorkspaceHistory.getState();
  const stack = h.undo[ws.id] ?? [];
  if (!stack.length) return;
  const prev = stack[stack.length - 1];
  useWorkspaceHistory.setState({ undo: { ...h.undo, [ws.id]: stack.slice(0, -1) }, redo: { ...h.redo, [ws.id]: [...(h.redo[ws.id] ?? []), ws.widgets] } });
  void saveWorkspace({ ...ws, widgets: prev });
}

export function redoLayout(ws: Workspace) {
  const h = useWorkspaceHistory.getState();
  const stack = h.redo[ws.id] ?? [];
  if (!stack.length) return;
  const next = stack[stack.length - 1];
  useWorkspaceHistory.setState({ redo: { ...h.redo, [ws.id]: stack.slice(0, -1) }, undo: { ...h.undo, [ws.id]: [...(h.undo[ws.id] ?? []), ws.widgets] } });
  void saveWorkspace({ ...ws, widgets: next });
}

export function resetLayout(ws: Workspace) {
  const def = defaultWorkspaces().find((d) => d.id === ws.id) ?? defaultWorkspaces()[0];
  setWidgets(ws, def.widgets);
}
