'use client';
import { Command } from 'cmdk';
import { useStore, type FeedFilter } from '@/lib/store';
import { useSettings } from '@/lib/settings';
import { WIDGETS, useWorkspaces } from '@/lib/workspaces';
import { useDocs } from '@/lib/v2';
import type { SmartFeed } from '@shared/v2';
import { SETTINGS_SECTIONS } from './settings/SettingsCenter';
import { pairLabel } from '@/lib/format';
import { Overlay } from './Overlay';
import { Icon, Kbd } from './ui';
import { useV2 } from '@/lib/v2';

const EMPTY = {} as Record<string, import('@shared/types').Quote>;

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const symbols = useStore((s) => s.symbols);
  // only follow live quotes while the palette is open
  const quotes = useStore((s) => (s.paletteOpen ? s.quotes : EMPTY));
  const set = useStore((s) => s.set);
  const settings = useSettings();
  const workspaces = useWorkspaces();
  const feeds = useDocs<SmartFeed>('smart_feeds');
  const close = () => set({ paletteOpen: false });
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  const filters: [FeedFilter, string][] = [['all', 'All news'], ['fx', 'FX'], ['crypto', 'Crypto'], ['equities', 'Equities & Options'], ['macro', 'Macro & central banks'], ['saved', 'Saved stories']];
  const item = 'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-dim aria-selected:bg-panel-hover aria-selected:text-text';
  const group = 'px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-faint [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1';

  return (
    <Overlay open={open} onClose={close} side="top" label="Command palette" width="max-w-xl">
      <Command label="Command palette" className="glass overflow-hidden rounded-2xl bg-panel-solid/95" loop>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Icon name="search" className="text-faint" />
          <Command.Input autoFocus placeholder="Jump to a ticker, filter, panel or setting…" className="h-11 flex-1 bg-transparent text-sm text-text placeholder:text-faint focus:outline-none focus-visible:outline-none" />
          <Kbd>esc</Kbd>
        </div>
        <Command.List className="max-h-[55vh] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-sm text-faint">No results.</Command.Empty>
          <Command.Group heading="Symbols" className={group}>
            {Object.values(symbols).map((m) => {
              const q = quotes[m.symbol];
              return (
                <Command.Item key={m.symbol} value={`${m.symbol} ${pairLabel(m.symbol, m.assetClass)} ${m.name}`} onSelect={run(() => set({ drawerSymbol: m.symbol }))} className={item}>
                  <span className="w-20 font-semibold text-text">{pairLabel(m.symbol, m.assetClass)}</span>
                  <span className="flex-1 truncate text-xs">{m.name}</span>
                  {q ? <span className={`num text-xs ${q.changePct >= 0 ? 'text-up' : 'text-down'}`}>{q.changePct >= 0 ? '+' : ''}{q.changePct.toFixed(2)}%</span> : null}
                </Command.Item>
              );
            })}
          </Command.Group>
          <Command.Group heading="Feed filters" className={group}>
            {filters.map(([f, label]) => (
              <Command.Item key={f} value={`filter ${label}`} onSelect={run(() => set({ filter: f }))} className={item}><Icon name="search" size={13} />Show {label}</Command.Item>
            ))}
            <Command.Item value="toggle high impact only" onSelect={run(() => set({ highImpactOnly: !useStore.getState().highImpactOnly }))} className={item}><Icon name="sparkle" size={13} />Toggle high impact only</Command.Item>
            <Command.Item value="toggle breaking only" onSelect={run(() => set({ breakingOnly: !useStore.getState().breakingOnly }))} className={item}><Icon name="sparkle" size={13} />Toggle breaking only <span className="ml-auto"><Kbd>B</Kbd></span></Command.Item>
          </Command.Group>
          <Command.Group heading="Workspaces" className={group}>
            {workspaces.map((w, i) => <Command.Item key={w.id} value={`workspace ${w.name}`} onSelect={run(() => settings.set({ activeWorkspace: w.id, focus: false }))} className={item}><Icon name="layout" size={13} />Switch to {w.name}{i < 9 ? <span className="ml-auto"><Kbd>{i + 1}</Kbd></span> : null}</Command.Item>)}
            <Command.Item value="edit layout workspace" onSelect={run(() => set({ layoutEditing: true }))} className={item}><Icon name="layout" size={13} />Edit layout</Command.Item>
            <Command.Item value="widget library add panel" onSelect={run(() => useV2.getState().set({ libraryOpen: true }))} className={item}><Icon name="plus" size={13} />Add a panel (widget library)</Command.Item>
            <Command.Item value="wall kiosk mode tv" onSelect={run(() => window.open('/wall', 'pulse-wall'))} className={item}><Icon name="external" size={13} />Open wall / kiosk mode</Command.Item>
          </Command.Group>
          <Command.Group heading="Panels" className={group}>
            {(Object.keys(WIDGETS) as (keyof typeof WIDGETS)[]).map((t) => <Command.Item key={t} value={`panel ${WIDGETS[t].label}`} onSelect={run(() => { const el = document.getElementById(`panel-${t}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); else useV2.getState().set({ libraryOpen: true }); })} className={item}><span className="h-2 w-[3px] rounded-full" style={{ background: WIDGETS[t].accent }} />Go to {WIDGETS[t].label}</Command.Item>)}
          </Command.Group>
          <Command.Group heading="Smart feeds" className={group}>
            {feeds.map((f) => <Command.Item key={f.id} value={`feed ${f.name}`} onSelect={run(() => useV2.getState().set({ activeFeed: f.id }))} className={item}><span className="h-2 w-2 rounded-full" style={{ background: f.color }} />Show feed: {f.name}</Command.Item>)}
            <Command.Item value="new smart feed builder query" onSelect={run(() => useV2.getState().set({ feedBuilder: 'new' }))} className={item}><Icon name="plus" size={13} />New smart feed…</Command.Item>
          </Command.Group>
          <Command.Group heading="Power tools" className={group}>
            <Command.Item value="ask pulse copilot ai chat" onSelect={run(() => useV2.getState().set({ copilotOpen: true }))} className={item}><Icon name="sparkle" size={13} />Ask Pulse <span className="ml-auto"><Kbd>⌘J</Kbd></span></Command.Item>
            <Command.Item value="journal notes" onSelect={run(() => useV2.getState().set({ journalOpen: true }))} className={item}><Icon name="bookmark" size={13} />Journal <span className="ml-auto"><Kbd>N</Kbd></span></Command.Item>
            <Command.Item value="playbooks event" onSelect={run(() => useV2.getState().set({ playbooksOpen: true }))} className={item}><Icon name="timeline" size={13} />Event playbooks <span className="ml-auto"><Kbd>Y</Kbd></span></Command.Item>
            <Command.Item value="market replay past day" onSelect={run(() => window.dispatchEvent(new CustomEvent('pulse:replay')))} className={item}><Icon name="timeline" size={13} />Market replay <span className="ml-auto"><Kbd>R</Kbd></span></Command.Item>
            <Command.Item value="privacy blur pnl" onSelect={run(() => useV2.getState().set({ privacy: !useV2.getState().privacy }))} className={item}><Icon name="eyeOff" size={13} />Toggle privacy blur <span className="ml-auto"><Kbd>P</Kbd></span></Command.Item>
            <Command.Item value="admin data source health" onSelect={run(() => window.open('/admin', '_blank'))} className={item}><Icon name="external" size={13} />Data source health &amp; admin</Command.Item>
            {SETTINGS_SECTIONS.map((x) => <Command.Item key={x.id} value={`settings ${x.label} ${x.keywords}`} onSelect={run(() => useV2.getState().set({ settingsCenter: x.id }))} className={item}><Icon name="settings" size={13} />Settings: {x.label}</Command.Item>)}
          </Command.Group>
          <Command.Group heading="Briefings" className={group}>
            <Command.Item value="morning brief open today" onSelect={run(() => useV2.getState().openBrief(null))} className={item}><Icon name="sparkle" size={13} />Open the Morning Brief <span className="ml-auto"><Kbd>M</Kbd></span></Command.Item>
            <Command.Item value="brief archive history" onSelect={run(() => useV2.getState().openBrief(null, 'archive'))} className={item}><Icon name="timeline" size={13} />Brief archive</Command.Item>
            <Command.Item value="brief editor customize brief sections" onSelect={run(() => useV2.getState().openBrief(null, 'editor'))} className={item}><Icon name="layout" size={13} />Edit brief sections &amp; schedule</Command.Item>
            <Command.Item value="regenerate brief now" onSelect={run(() => { void fetch('/api/briefs/regenerate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"profileId":"morning"}' }).then((r) => r.json()).then((b: { id: string }) => useV2.getState().openBrief(b.id)); })} className={item}><Icon name="sparkle" size={13} />Regenerate the morning brief now</Command.Item>
            <Command.Item value="end of day wrap eod" onSelect={run(() => { void fetch('/api/briefs/regenerate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"profileId":"eod"}' }).then((r) => r.json()).then((b: { id: string }) => useV2.getState().openBrief(b.id)); })} className={item}><Icon name="sparkle" size={13} />Build the end-of-day wrap now</Command.Item>
          </Command.Group>
          <Command.Group heading="Settings & actions" className={group}>
            <Command.Item value="toggle theme light dark" onSelect={run(() => settings.set({ theme: settings.theme === 'dark' ? 'light' : 'dark' }))} className={item}><Icon name={settings.theme === 'dark' ? 'sun' : 'moon'} size={13} />Switch to {settings.theme === 'dark' ? 'light' : 'dark'} theme</Command.Item>
            <Command.Item value="calm mode" onSelect={run(() => settings.set({ calm: !settings.calm }))} className={item}><Icon name="sparkle" size={13} />{settings.calm ? 'Disable' : 'Enable'} calm mode</Command.Item>
            <Command.Item value="focus mode" onSelect={run(() => settings.set({ focus: !settings.focus }))} className={item}><Icon name="focus" size={13} />{settings.focus ? 'Exit' : 'Enter'} focus mode <span className="ml-auto"><Kbd>F</Kbd></span></Command.Item>
            <Command.Item value="colorblind palette" onSelect={run(() => settings.set({ colorblind: !settings.colorblind }))} className={item}><Icon name="eye" size={13} />{settings.colorblind ? 'Standard' : 'Colour-blind safe'} up/down colours</Command.Item>
            <Command.Item value="customize layout" onSelect={run(() => set({ layoutEditing: true }))} className={item}><Icon name="layout" size={13} />Customize layout</Command.Item>
            <Command.Item value="while you were away digest" onSelect={run(() => set({ digestSince: Date.now() - 3600_000 }))} className={item}><Icon name="timeline" size={13} />Show digest for the last hour</Command.Item>
            <Command.Item value="settings preferences" onSelect={run(() => set({ settingsOpen: true }))} className={item}><Icon name="settings" size={13} />Open settings</Command.Item>
            <Command.Item value="keyboard shortcuts help" onSelect={run(() => set({ shortcutsOpen: true }))} className={item}><Icon name="keyboard" size={13} />Keyboard shortcuts <span className="ml-auto"><Kbd>?</Kbd></span></Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </Overlay>
  );
}
