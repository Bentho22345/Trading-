'use client';
import { create } from 'zustand';
import type { IntelBlock, IntelKey, HandoffCard, BriefMeta, Exposure, PlaybookOutcome, AlertHistoryItem } from '@shared/v2';

/** Document collections synced with the worker (/api/docs + 'doc' socket messages). */
export type DocCollection =
  | 'brief_profiles' | 'workspaces' | 'layouts' | 'themes' | 'smart_feeds' | 'playbooks' | 'positions' | 'journal_entries'
  | 'annotations' | 'levels' | 'themes_narrative' | 'alert_routes' | 'source_overrides' | 'score_weights' | 'settings_docs';

type Doc = { id: string } & Record<string, unknown>;

export type BriefView = 'read' | 'archive' | 'editor' | 'diff';

interface V2State {
  intel: Partial<Record<IntelKey, IntelBlock>>;
  handoffs: HandoffCard[];
  dismissedHandoffs: Set<string>;
  latestBrief: BriefMeta | null;
  exposure: Exposure | null;
  outcomes: PlaybookOutcome[];
  alertHistory: AlertHistoryItem[];
  docs: Partial<Record<DocCollection, Doc[]>>;
  docsLoaded: boolean;

  // overlays
  briefOpen: boolean;
  briefId: string | null;
  briefView: BriefView;
  diffIds: [string, string] | null;
  settingsCenter: string | null; // section id when open
  libraryOpen: boolean;
  copilotOpen: boolean;
  journalOpen: boolean;
  playbooksOpen: boolean;
  feedBuilder: string | null; // smart feed id or 'new'
  explain: { kind: string; ref: string; label: string } | null;
  privacy: boolean;
  activeFeed: string | null; // smart feed tab id
}

interface V2Actions {
  set: (p: Partial<V2State>) => void;
  setIntel: (b: IntelBlock) => void;
  applyDoc: (c: string, op: 'put' | 'del', d: Doc) => void;
  loadDocs: () => Promise<void>;
  putDoc: <T extends object>(c: DocCollection, d: T & { id?: string }) => Promise<T & { id: string }>;
  delDoc: (c: DocCollection, id: string) => Promise<void>;
  openBrief: (id?: string | null, view?: BriefView) => void;
}

export const useV2 = create<V2State & V2Actions>((set, get) => ({
  intel: {}, handoffs: [], dismissedHandoffs: new Set(), latestBrief: null, exposure: null, outcomes: [], alertHistory: [],
  docs: {}, docsLoaded: false,
  briefOpen: false, briefId: null, briefView: 'read', diffIds: null, settingsCenter: null, libraryOpen: false, copilotOpen: false,
  journalOpen: false, playbooksOpen: false, feedBuilder: null, explain: null, privacy: false, activeFeed: null,

  set: (p) => set(p),
  setIntel: (b) => set({ intel: { ...get().intel, [b.key]: b } }),

  applyDoc: (c, op, d) => {
    if (c === '*') {
      void get().loadDocs();
      return;
    }
    const list = get().docs[c as DocCollection] ?? [];
    const next = op === 'del' ? list.filter((x) => x.id !== d.id) : list.some((x) => x.id === d.id) ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d];
    set({ docs: { ...get().docs, [c]: next } });
  },

  loadDocs: async () => {
    try {
      const res = await fetch('/api/docs');
      if (!res.ok) return;
      set({ docs: (await res.json()) as V2State['docs'], docsLoaded: true });
    } catch {
      /* offline: keep whatever we have */
    }
  },

  putDoc: async (c, d) => {
    const id = d.id ?? crypto.randomUUID();
    const doc = { ...d, id } as unknown as Doc;
    get().applyDoc(c, 'put', doc);
    const res = await fetch(`/api/docs/${c}/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    const saved = (await res.json()) as Doc;
    get().applyDoc(c, 'put', saved);
    return saved as unknown as typeof d & { id: string };
  },

  delDoc: async (c, id) => {
    get().applyDoc(c, 'del', { id });
    await fetch(`/api/docs/${c}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  openBrief: (id = null, view = 'read') => set({ briefOpen: true, briefId: id, briefView: view }),
}));

const EMPTY: never[] = [];
export function useDocs<T>(c: DocCollection): T[] {
  return (useV2((s) => s.docs[c]) ?? EMPTY) as unknown as T[];
}

export function useIntel<T>(k: IntelKey): IntelBlock<T> | undefined {
  return useV2((s) => s.intel[k]) as IntelBlock<T> | undefined;
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = (await res.json().catch(() => null)) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}
