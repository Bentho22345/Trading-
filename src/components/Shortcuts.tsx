'use client';
import { useEffect } from 'react';
import { useStore } from '@/lib/store';
import { useSettings } from '@/lib/settings';
import { feedOrder } from '@/lib/filter';
import { searchInputRef } from './FilterBar';
import { Overlay } from './Overlay';
import { Kbd } from './ui';
import { useV2 } from '@/lib/v2';

const SHORTCUTS: [string, string][] = [
  ['⌘K / Ctrl K', 'Command palette'],
  ['J / K', 'Next / previous story'],
  ['Enter', 'Open story timeline'],
  ['O', 'Open source article'],
  ['S', 'Save / unsave story'],
  ['U', 'Toggle read / unread'],
  ['M', 'Morning brief'],
  ['/', 'Search'],
  ['B', 'Toggle breaking-only'],
  ['H', 'Toggle high impact only'],
  ['1 – 6', 'All · FX · Crypto · Equities · Macro · Saved'],
  ['F', 'Focus mode'],
  ['Esc', 'Close / clear selection'],
  ['?', 'This cheat sheet'],
];

const FILTERS = ['all', 'fx', 'crypto', 'equities', 'macro', 'saved'] as const;

/** Global keyboard handling (ignored while typing in inputs). */
export function KeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        st.set({ paletteOpen: !st.paletteOpen });
        return;
      }
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (st.paletteOpen || st.drawerSymbol || st.timelineId || st.settingsOpen || st.digestSince) return;
      if (useV2.getState().briefOpen) return;

      const ids = feedOrder.ids;
      const idx = st.selectedId ? ids.indexOf(st.selectedId) : -1;
      const sel = st.selectedId ? st.clusters.find((c) => c.id === st.selectedId) : undefined;
      switch (e.key) {
        case 'j':
        case 'J': {
          const next = ids[Math.min(ids.length - 1, idx + 1)];
          if (next) st.set({ selectedId: next });
          break;
        }
        case 'k':
        case 'K': {
          const prev = ids[Math.max(0, idx - 1)];
          if (prev) st.set({ selectedId: prev });
          break;
        }
        case 'o':
        case 'O':
          if (sel) {
            st.markRead(sel.id);
            if (sel.url !== '#') window.open(sel.url, '_blank', 'noopener,noreferrer');
          }
          break;
        case 'Enter':
          if (sel) {
            st.markRead(sel.id);
            st.set({ timelineId: sel.id });
          }
          break;
        case 's':
        case 'S':
          if (sel) st.toggleSaved(sel.id);
          break;
        case 'u':
        case 'U':
          if (sel) st.markRead(sel.id, !st.readIds.has(sel.id));
          break;
        case 'm':
        case 'M':
          useV2.getState().openBrief(null);
          break;
        case '/':
          e.preventDefault();
          searchInputRef.current?.focus();
          break;
        case 'b':
        case 'B':
          st.set({ breakingOnly: !st.breakingOnly });
          break;
        case 'h':
        case 'H':
          st.set({ highImpactOnly: !st.highImpactOnly });
          break;
        case 'f':
        case 'F':
          useSettings.getState().set({ focus: !useSettings.getState().focus });
          break;
        case '?':
          st.set({ shortcutsOpen: !st.shortcutsOpen });
          break;
        case 'Escape':
          if (st.shortcutsOpen) st.set({ shortcutsOpen: false });
          else if (st.breaking) st.set({ breaking: null });
          else st.set({ selectedId: null });
          break;
        default:
          if (/^[1-6]$/.test(e.key)) st.set({ filter: FILTERS[+e.key - 1] });
          else return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}

export function ShortcutSheet() {
  const open = useStore((s) => s.shortcutsOpen);
  const set = useStore((s) => s.set);
  return (
    <Overlay open={open} onClose={() => set({ shortcutsOpen: false })} label="Keyboard shortcuts" width="max-w-md">
      <div className="glass rounded-2xl bg-panel-solid/95 p-5">
        <h2 className="mb-3 text-sm font-semibold text-text">Keyboard shortcuts</h2>
        <ul className="space-y-1.5">
          {SHORTCUTS.map(([k, d]) => (
            <li key={k} className="flex items-center justify-between text-xs">
              <span className="text-dim">{d}</span>
              <span className="flex gap-1">{k.split(' / ').map((x) => <Kbd key={x}>{x}</Kbd>)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Overlay>
  );
}
