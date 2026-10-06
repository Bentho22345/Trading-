'use client';
import { useEffect } from 'react';
import { useStore } from '@/lib/store';
import { useSettings } from '@/lib/settings';
import { feedOrder } from '@/lib/filter';
import { searchInputRef } from './FilterBar';
import { Overlay } from './Overlay';
import { Kbd } from './ui';
import { useV2 } from '@/lib/v2';
import { ACTIONS, bindings, keyOf, prettyKey, type Action } from '@/lib/shortcuts';
import { workspacesOf } from '@/lib/workspaces';

const FILTERS = ['all', 'fx', 'crypto', 'equities', 'macro', 'saved'] as const;

/** Global keyboard handling (ignored while typing in inputs). Bindings are remappable in Settings. */
export function KeyboardShortcuts() {
  const overrides = useSettings((s) => s.shortcuts);
  useEffect(() => {
    const map = bindings(overrides);
    const byKey = new Map<string, Action>();
    for (const [a, k] of Object.entries(map) as [Action, string][]) byKey.set(k, a);
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const v2 = useV2.getState();
      const key = keyOf(e);
      if (key === 'mod+k') {
        e.preventDefault();
        st.set({ paletteOpen: !st.paletteOpen });
        return;
      }
      if (byKey.get(key) === 'copilot') {
        e.preventDefault();
        v2.set({ copilotOpen: !v2.copilotOpen });
        return;
      }
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (st.paletteOpen || st.drawerSymbol || st.timelineId || st.settingsOpen || st.digestSince) return;
      if (v2.briefOpen || v2.settingsCenter || v2.journalOpen || v2.playbooksOpen || v2.feedBuilder) return;

      // 1–9 switch workspaces, shift+1–6 switch feed filters
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) {
        const n = Number(digit[1]);
        if (e.shiftKey) {
          if (n <= 6) st.set({ filter: FILTERS[n - 1] });
        } else {
          const list = workspacesOf((v2.docs.workspaces ?? []) as never);
          if (list[n - 1]) useSettings.getState().set({ activeWorkspace: list[n - 1].id });
        }
        e.preventDefault();
        return;
      }
      if (key === 'escape') {
        if (st.shortcutsOpen) st.set({ shortcutsOpen: false });
        else if (st.layoutEditing) st.set({ layoutEditing: false });
        else if (st.breaking) st.set({ breaking: null });
        else st.set({ selectedId: null });
        return;
      }
      const action = byKey.get(key);
      if (!action) return;
      const ids = feedOrder.ids;
      const idx = st.selectedId ? ids.indexOf(st.selectedId) : -1;
      const sel = st.selectedId ? st.clusters.find((c) => c.id === st.selectedId) : undefined;
      switch (action) {
        case 'next': { const n = ids[Math.min(ids.length - 1, idx + 1)]; if (n) st.set({ selectedId: n }); break; }
        case 'prev': { const p = ids[Math.max(0, idx - 1)]; if (p) st.set({ selectedId: p }); break; }
        case 'openSource': if (sel) { st.markRead(sel.id); if (sel.url !== '#') window.open(sel.url, '_blank', 'noopener,noreferrer'); } break;
        case 'openTimeline': if (sel) { st.markRead(sel.id); st.set({ timelineId: sel.id }); } break;
        case 'save': if (sel) st.toggleSaved(sel.id); break;
        case 'toggleRead': if (sel) st.markRead(sel.id, !st.readIds.has(sel.id)); break;
        case 'brief': v2.openBrief(null); break;
        case 'search': e.preventDefault(); searchInputRef.current?.focus(); break;
        case 'breaking': st.set({ breakingOnly: !st.breakingOnly }); break;
        case 'high': st.set({ highImpactOnly: !st.highImpactOnly }); break;
        case 'focus': useSettings.getState().set({ focus: !useSettings.getState().focus }); break;
        case 'help': st.set({ shortcutsOpen: !st.shortcutsOpen }); break;
        case 'privacy': v2.set({ privacy: !v2.privacy }); break;
        case 'explain': {
          const hovered = document.querySelector('[data-explain]:hover') as HTMLElement | null;
          if (hovered) v2.set({ explain: { kind: hovered.dataset.explainKind ?? 'item', ref: hovered.dataset.explain!, label: hovered.dataset.explainLabel ?? hovered.dataset.explain! }, copilotOpen: true });
          else if (sel) v2.set({ explain: { kind: 'story', ref: sel.id, label: sel.headline }, copilotOpen: true });
          break;
        }
        case 'journal': v2.set({ journalOpen: true }); break;
        case 'playbooks': v2.set({ playbooksOpen: true }); break;
        case 'library': v2.set({ libraryOpen: true }); break;
        case 'editLayout': st.set({ layoutEditing: !st.layoutEditing }); break;
        case 'muteSquawk': window.dispatchEvent(new CustomEvent('pulse:mute')); break;
        case 'replay': window.dispatchEvent(new CustomEvent('pulse:replay')); break;
        case 'settings': v2.set({ settingsCenter: 'appearance' }); break;
        default: return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overrides]);
  return null;
}

export function ShortcutSheet() {
  const open = useStore((s) => s.shortcutsOpen);
  const set = useStore((s) => s.set);
  const map = bindings(useSettings((s) => s.shortcuts));
  return (
    <Overlay open={open} onClose={() => set({ shortcutsOpen: false })} label="Keyboard shortcuts" width="max-w-md">
      <div className="glass rounded-2xl bg-panel-solid/95 p-5">
        <h2 className="mb-3 text-sm font-semibold text-text">Keyboard shortcuts <button onClick={() => { set({ shortcutsOpen: false }); useV2.getState().set({ settingsCenter: 'shortcuts' }); }} className="ml-2 text-[11px] font-normal text-faint underline">remap</button></h2>
        <ul className="max-h-[65vh] space-y-1.5 overflow-y-auto pr-1">
          {ACTIONS.map((a) => (
            <li key={a.id} className="flex items-center justify-between text-xs">
              <span className="text-dim">{a.label}</span>
              <Kbd>{prettyKey(map[a.id])}</Kbd>
            </li>
          ))}
          <li className="flex items-center justify-between text-xs"><span className="text-dim">Switch workspace</span><Kbd>1 – 9</Kbd></li>
          <li className="flex items-center justify-between text-xs"><span className="text-dim">All · FX · Crypto · Equities · Macro · Saved</span><Kbd>⇧1 – ⇧6</Kbd></li>
          <li className="flex items-center justify-between text-xs"><span className="text-dim">Close / clear selection</span><Kbd>Esc</Kbd></li>
        </ul>
      </div>
    </Overlay>
  );
}
