'use client';
import { useEffect, useMemo, useState } from 'react';
import type { WidgetType, Workspace } from '@shared/v2';
import { useStore } from '@/lib/store';
import { useSettings } from '@/lib/settings';
import { useV2 } from '@/lib/v2';
import { WIDGETS, newWidget, resetLayout, redoLayout, setWidgets, undoLayout, useActiveWorkspace, useWorkspaceHistory, useWorkspaces, saveWorkspace } from '@/lib/workspaces';
import { Overlay } from '../Overlay';
import { Icon, Kbd } from '../ui';

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function SchedulePopover({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const [at, setAt] = useState(ws.schedule?.at ?? '');
  const [days, setDays] = useState<number[]>(ws.schedule?.days ?? [1, 2, 3, 4, 5]);
  const [earn, setEarn] = useState(!!ws.schedule?.earningsDay);
  const [name, setName] = useState(ws.name);
  return (
    <div className="absolute left-0 top-8 z-50 w-72 space-y-2 rounded-xl border border-line bg-panel-solid p-3 shadow-2xl">
      <label className="block text-[11px] text-faint">Name<input value={name} onChange={(e) => setName(e.target.value)} className="mt-0.5 w-full rounded-lg border border-line bg-bg-2 px-2 py-1 text-xs text-text" /></label>
      <label className="block text-[11px] text-faint">Switch automatically at (local time)<input value={at} placeholder="HH:MM" onChange={(e) => setAt(e.target.value)} className="num mt-0.5 w-full rounded-lg border border-line bg-bg-2 px-2 py-1 text-xs text-text" /></label>
      <div className="flex gap-1">{DAYS.map((d, i) => <button key={i} onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i])} className={`h-6 w-6 rounded-md border text-[10px] ${days.includes(i) ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-faint'}`}>{d}</button>)}</div>
      <label className="flex items-center gap-2 text-xs text-dim"><input type="checkbox" checked={earn} onChange={(e) => setEarn(e.target.checked)} />Switch on days with major earnings</label>
      <div className="flex justify-between pt-1">
        <button onClick={() => { if (confirm(`Delete workspace “${ws.name}”?`)) { void useV2.getState().delDoc('workspaces', ws.id); onClose(); } }} className="text-xs text-down">Delete</button>
        <span className="flex gap-2">
          <button onClick={onClose} className="rounded-md border border-line px-2 py-0.5 text-xs text-dim">Cancel</button>
          <button onClick={() => { void saveWorkspace({ ...ws, name: name || ws.name, schedule: { at: /^\d{1,2}:\d{2}$/.test(at) ? at.padStart(5, '0') : undefined, days, earningsDay: earn } }); onClose(); }} className="rounded-md border border-accent/50 bg-accent/15 px-2 py-0.5 text-xs text-text">Save</button>
        </span>
      </div>
    </div>
  );
}

export function WorkspaceBar() {
  const list = useWorkspaces();
  const active = useActiveWorkspace();
  const editing = useStore((s) => s.layoutEditing);
  const set = useStore((s) => s.set);
  const hist = useWorkspaceHistory();
  const [menu, setMenu] = useState<string | null>(null);

  const add = async () => {
    const ws: Workspace = { id: `ws-${Date.now().toString(36)}`, name: `Workspace ${list.length + 1}`, order: list.length, widgets: [newWidget('news', [])] };
    await saveWorkspace(ws);
    useSettings.getState().set({ activeWorkspace: ws.id });
    set({ layoutEditing: true });
  };

  return (
    <div className="flex h-9 items-center gap-1 border-b border-line bg-bg/60 px-3 text-xs">
      <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
        {list.map((ws, i) => (
          <div key={ws.id} className="relative">
            <button
              onClick={() => useSettings.getState().set({ activeWorkspace: ws.id })}
              onDoubleClick={() => setMenu(ws.id)}
              onContextMenu={(e) => { e.preventDefault(); setMenu(ws.id); }}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 ${ws.id === active.id ? 'bg-panel-hover text-text' : 'text-faint hover:text-dim'}`}
              title={`${ws.name}${i < 9 ? ` (${i + 1})` : ''}${ws.schedule?.at ? ` · auto at ${ws.schedule.at}` : ''}${ws.schedule?.earningsDay ? ' · auto on earnings days' : ''}`}
            >
              {i < 9 ? <span className="num text-[9px] text-faint">{i + 1}</span> : null}
              {ws.name}
              {ws.schedule?.at || ws.schedule?.earningsDay ? <span className="h-1 w-1 rounded-full bg-accent" aria-label="scheduled" /> : null}
            </button>
            {menu === ws.id ? <SchedulePopover ws={ws} onClose={() => setMenu(null)} /> : null}
          </div>
        ))}
        <button onClick={add} className="ml-1 rounded-md p-1 text-faint hover:text-text" aria-label="New workspace"><Icon name="plus" size={13} /></button>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {editing ? (
          <>
            <span className="hidden text-faint lg:inline">Drag headers to move · drag corners to resize · <Kbd>Esc</Kbd> to finish</span>
            <button onClick={() => useV2.getState().set({ libraryOpen: true })} className="flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 text-text"><Icon name="plus" size={12} />Add panel</button>
            <button onClick={() => undoLayout(active)} disabled={!hist.undo[active.id]?.length} className="rounded-md border border-line px-2 py-0.5 text-dim disabled:opacity-40" title="Undo (⌘Z)">Undo</button>
            <button onClick={() => redoLayout(active)} disabled={!hist.redo[active.id]?.length} className="rounded-md border border-line px-2 py-0.5 text-dim disabled:opacity-40" title="Redo (⇧⌘Z)">Redo</button>
            <button onClick={() => resetLayout(active)} className="rounded-md border border-line px-2 py-0.5 text-dim">Reset</button>
            <button onClick={() => set({ layoutEditing: false })} className="rounded-md border border-accent/50 bg-accent/15 px-2 py-0.5 font-medium text-text">Done</button>
          </>
        ) : (
          <>
            <button onClick={() => window.open('/wall', 'pulse-wall')} className="rounded-md px-2 py-0.5 text-faint hover:text-text" title="Wall / kiosk mode for a TV">Wall</button>
            <button onClick={() => set({ layoutEditing: true })} className="flex items-center gap-1 rounded-md px-2 py-0.5 text-faint hover:text-text"><Icon name="layout" size={12} />Edit layout</button>
          </>
        )}
      </div>
    </div>
  );
}

export function WidgetLibrary() {
  const open = useV2((s) => s.libraryOpen);
  const active = useActiveWorkspace();
  const groups = useMemo(() => {
    const m = new Map<string, WidgetType[]>();
    for (const [t, meta] of Object.entries(WIDGETS) as [WidgetType, (typeof WIDGETS)[WidgetType]][]) m.set(meta.group, [...(m.get(meta.group) ?? []), t]);
    return [...m.entries()];
  }, []);
  const close = () => useV2.getState().set({ libraryOpen: false });
  const add = (t: WidgetType) => {
    setWidgets(active, [...active.widgets, newWidget(t, active.widgets)]);
    useStore.getState().set({ layoutEditing: true });
  };
  return (
    <Overlay open={open} onClose={close} side="right" label="Widget library">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-text">Widget library</h2>
        <button onClick={close} className="text-faint hover:text-text" aria-label="Close"><Icon name="x" /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <p className="text-xs text-faint">Add any panel to “{active.name}”. You can add the same panel more than once with different settings — e.g. an FX-only and a crypto-only news feed.</p>
        {groups.map(([g, types]) => (
          <section key={g}>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{g}</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {types.map((t) => {
                const count = active.widgets.filter((w) => w.type === t).length;
                return (
                  <button key={t} onClick={() => add(t)} className="group flex items-start gap-2 rounded-xl border border-line bg-panel p-3 text-left hover:border-line-strong hover:bg-panel-hover">
                    <span className="mt-1 h-2.5 w-[3px] rounded-full" style={{ background: WIDGETS[t].accent }} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-text">{WIDGETS[t].label}{count ? <span className="rounded bg-panel-hover px-1 text-[9px] text-faint">{count} on page</span> : null}</span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-faint">{WIDGETS[t].description}</span>
                    </span>
                    <Icon name="plus" size={13} className="text-faint group-hover:text-text" />
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </Overlay>
  );
}

/** Switches workspace automatically at its scheduled time, or on days with big earnings. */
export function WorkspaceAutoSwitch() {
  const list = useWorkspaces();
  const earnings = useStore((s) => s.vol?.earnings);
  useEffect(() => {
    const check = () => {
      const now = new Date();
      const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      for (const ws of list) {
        const s = ws.schedule;
        if (!s?.at || s.at !== hm || (s.days && !s.days.includes(now.getDay()))) continue;
        const big = (earnings ?? []).some((e) => new Date(e.date).toDateString() === now.toDateString());
        if (s.earningsDay && !big) continue;
        if (useSettings.getState().activeWorkspace !== ws.id) {
          useSettings.getState().set({ activeWorkspace: ws.id });
          useStore.getState().pushToast({ kind: 'info', title: `Switched to “${ws.name}”`, body: 'Scheduled workspace' });
        }
      }
      // earnings-day workspaces without a time switch at 09:00 local
      if (hm === '09:00') {
        const ws = list.find((w) => w.schedule?.earningsDay && !w.schedule.at);
        const big = (earnings ?? []).some((e) => new Date(e.date).toDateString() === now.toDateString());
        if (ws && big) useSettings.getState().set({ activeWorkspace: ws.id });
      }
    };
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [list, earnings]);
  return null;
}
