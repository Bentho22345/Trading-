'use client';
import { Command } from 'cmdk';
import { useStore, type FeedFilter } from '@/lib/store';
import { useSettings, PANEL_LABELS, type PanelId } from '@/lib/settings';
import { pairLabel } from '@/lib/format';
import { Overlay } from './Overlay';
import { Icon, Kbd } from './ui';

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const symbols = useStore((s) => s.symbols);
  const quotes = useStore((s) => s.quotes);
  const set = useStore((s) => s.set);
  const settings = useSettings();
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
          <Command.Group heading="Panels" className={group}>
            {(Object.keys(PANEL_LABELS) as PanelId[]).map((p) => (
              <Command.Item key={p} value={`panel ${PANEL_LABELS[p]}`} onSelect={run(() => {
                const hidden = settings.layout.hidden.filter((x) => x !== p);
                settings.set({ focus: false, layout: { ...settings.layout, hidden } });
                setTimeout(() => document.getElementById(`panel-${p}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
                set({ mobileTab: p === 'calendar' || p === 'sessions' || p === 'banks' ? 'calendar' : p === 'watchlist' || p === 'alerts' ? 'watch' : 'markets' });
              })} className={item}><Icon name="layout" size={13} />Go to {PANEL_LABELS[p]}</Command.Item>
            ))}
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
