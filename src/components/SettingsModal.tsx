'use client';
import type { ReactNode } from 'react';
import type { TickerGroup } from '@shared/types';
import { useStore } from '@/lib/store';
import { useSettings } from '@/lib/settings';
import { playChime } from '@/lib/sound';
import { Overlay } from './Overlay';
import { Icon, IconButton, Segmented } from './ui';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div>
        <div className="text-xs font-medium text-text">{label}</div>
        {hint ? <div className="text-[11px] text-faint">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-line-strong'}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const threshold = useStore((s) => s.breakingThreshold);
  const aiEnabled = useStore((s) => s.aiEnabled);
  const set = useStore((s) => s.set);
  const s = useSettings();
  const close = () => set({ settingsOpen: false });

  const toggleGroup = (g: TickerGroup) => {
    const has = s.tickerGroups.includes(g);
    const next = has ? s.tickerGroups.filter((x) => x !== g) : [...s.tickerGroups, g];
    if (next.length) s.set({ tickerGroups: (['EQ', 'FX', 'CRYPTO'] as TickerGroup[]).filter((x) => next.includes(x)) });
  };

  const requestNotifications = async () => {
    if (typeof Notification === 'undefined') return;
    const p = await Notification.requestPermission();
    s.set({ notifications: p === 'granted' });
  };

  return (
    <Overlay open={open} onClose={close} label="Settings" width="max-w-lg">
      <div className="glass max-h-[85vh] overflow-y-auto rounded-2xl bg-panel-solid/95">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold text-text">Settings</h2>
          <IconButton label="Close" onClick={close}><Icon name="x" size={14} /></IconButton>
        </header>
        <div className="divide-y divide-line px-5">
          <Row label="Theme"><Segmented label="Theme" value={s.theme} onChange={(v) => s.set({ theme: v })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} /></Row>
          <Row label="Colour-blind safe palette" hint="Up/down in blue/orange instead of green/red"><Switch label="Colour-blind palette" on={s.colorblind} onChange={(v) => s.set({ colorblind: v })} /></Row>
          <Row label="Calm mode" hint="Tones down every animation; slower ticker"><Switch label="Calm mode" on={s.calm} onChange={(v) => s.set({ calm: v })} /></Row>
          <Row label="Ticker speed" hint={`${s.tickerSpeed}px/s`}>
            <input type="range" min={10} max={120} step={5} value={s.tickerSpeed} onChange={(e) => s.set({ tickerSpeed: +e.target.value })} className="w-40 accent-[var(--accent)]" aria-label="Ticker speed" />
          </Row>
          <Row label="Ticker groups">
            <div className="flex gap-1.5">
              {(['EQ', 'FX', 'CRYPTO'] as TickerGroup[]).map((g) => (
                <button key={g} onClick={() => toggleGroup(g)} aria-pressed={s.tickerGroups.includes(g)} className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${s.tickerGroups.includes(g) ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-faint'}`}>{g}</button>
              ))}
            </div>
          </Row>
          <Row label="Sound" hint="Soft chime on breaking news and alerts">
            <div className="flex items-center gap-2">
              <button onClick={() => playChime('breaking')} className="text-[11px] text-dim hover:text-text">Preview</button>
              <Switch label="Sound" on={s.sound} onChange={(v) => s.set({ sound: v })} />
            </div>
          </Row>
          <Row label="Browser notifications" hint="For alerts while the tab is in the background">
            {s.notifications ? <Switch label="Notifications" on onChange={() => s.set({ notifications: false })} /> : <button onClick={requestNotifications} className="rounded-md border border-line px-2 py-1 text-[11px] text-dim hover:text-text">Ask permission</button>}
          </Row>
          <Row label="Focus mode" hint="Only the ticker, the feed and the next release"><Switch label="Focus mode" on={s.focus} onChange={(v) => s.set({ focus: v })} /></Row>
          <Row label="Layout" hint="Drag to reorder or hide panels">
            <button onClick={() => { close(); set({ layoutEditing: true }); }} className="rounded-md border border-line px-2 py-1 text-[11px] text-dim hover:text-text">Customize…</button>
          </Row>
          <Row label="Breaking threshold" hint="Set BREAKING_THRESHOLD on the worker"><span className="num text-xs text-text">impact ≥ {threshold}</span></Row>
          <Row label="AI summaries" hint={aiEnabled ? 'TL;DR + why it matters on high-impact clusters' : 'Set ANTHROPIC_API_KEY on the worker to enable'}><span className={`text-xs ${aiEnabled ? 'text-up' : 'text-faint'}`}>{aiEnabled ? 'On' : 'Off'}</span></Row>
          <Row label="Reset preferences"><button onClick={s.reset} className="rounded-md border border-down/40 px-2 py-1 text-[11px] text-down">Reset</button></Row>
        </div>
      </div>
    </Overlay>
  );
}
