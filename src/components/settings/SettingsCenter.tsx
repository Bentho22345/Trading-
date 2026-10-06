'use client';
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import dynamic from 'next/dynamic';
import { useV2 } from '@/lib/v2';
import { Icon, Kbd } from '../ui';

const L = (load: () => Promise<ComponentType>) => dynamic(load, { ssr: false, loading: () => <div className="skeleton h-48" /> });

export const SETTINGS_SECTIONS: { id: string; label: string; keywords: string; C: ComponentType }[] = [
  { id: 'appearance', label: 'Appearance & theme', keywords: 'theme colors colours preset paper terminal contrast blur radius font density calm sound focus wcag colorblind', C: L(() => import('./Appearance').then((m) => m.AppearanceSection)) },
  { id: 'ticker', label: 'Ticker strip', keywords: 'ticker symbols speed groups density fields', C: L(() => import('./General').then((m) => m.TickerSection)) },
  { id: 'scoring', label: 'Score tuning', keywords: 'impact score weights credibility severity watchlist exposure rank', C: L(() => import('./Scoring').then((m) => m.ScoringSection)) },
  { id: 'keywords', label: 'Keywords & tags', keywords: 'keyword dictionary severity tags custom', C: L(() => import('./Scoring').then((m) => m.KeywordsSection)) },
  { id: 'sources', label: 'Sources', keywords: 'rss atom feed sources mute credibility health latency', C: L(() => import('./Scoring').then((m) => m.SourcesSection)) },
  { id: 'portfolio', label: 'Portfolio & positions', keywords: 'positions csv broker alpaca import portfolio book', C: L(() => import('./Personal').then((m) => m.PortfolioSection)) },
  { id: 'levels', label: 'Levels', keywords: 'levels price alerts chart lines', C: L(() => import('./Personal').then((m) => m.LevelsSection)) },
  { id: 'alerts', label: 'Alerts & routing', keywords: 'alerts routing destinations quiet hours digest escalation history smart alert', C: L(() => import('./Alerts').then((m) => m.AlertsSection)) },
  { id: 'audio', label: 'Audio squawk', keywords: 'audio squawk tts voice earcons mute listen', C: L(() => import('./Alerts').then((m) => m.AudioSection)) },
  { id: 'integrations', label: 'Integrations', keywords: 'email gmail outlook slack telegram discord twilio sms notion calendar webhook push send test connect', C: L(() => import('./Integrations').then((m) => m.IntegrationsSection)) },
  { id: 'ai', label: 'AI & budget', keywords: 'anthropic ai copilot budget tokens cost model', C: L(() => import('./Integrations').then((m) => m.AiSection)) },
  { id: 'shortcuts', label: 'Keyboard shortcuts', keywords: 'keyboard shortcuts keys remap hotkeys', C: L(() => import('./General').then((m) => m.ShortcutsSection)) },
  { id: 'time', label: 'Time zones & hours', keywords: 'time zone clocks working hours quiet sessions', C: L(() => import('./General').then((m) => m.TimeSection)) },
  { id: 'notifications', label: 'Notifications', keywords: 'browser notifications permission', C: L(() => import('./General').then((m) => m.NotificationsSection)) },
  { id: 'data', label: 'Backup & sync', keywords: 'export import backup restore json sync reset', C: L(() => import('./General').then((m) => m.DataSection)) },
];

/** One searchable page for everything configurable. */
export function SettingsCenter() {
  const active = useV2((s) => s.settingsCenter);
  const set = useV2((s) => s.set);
  const [q, setQ] = useState('');
  const close = () => set({ settingsCenter: null });
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), close());
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  });
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? SETTINGS_SECTIONS.filter((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(t)) : SETTINGS_SECTIONS;
  }, [q]);
  if (!active) return null;
  const current = (q ? filtered[0] : SETTINGS_SECTIONS.find((s) => s.id === active)) ?? filtered[0] ?? SETTINGS_SECTIONS[0];
  return (
    <div className="fixed inset-0 z-[68] flex bg-bg/95 backdrop-blur" role="dialog" aria-modal="true" aria-label="Settings">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line p-3">
        <div className="mb-3 flex items-center justify-between"><span className="text-sm font-semibold text-text">Settings</span><button onClick={close} className="flex items-center gap-1 text-xs text-faint hover:text-text">Close <Kbd>Esc</Kbd></button></div>
        <label className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-bg-2/60 px-2 py-1.5">
          <Icon name="search" size={13} className="text-faint" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings…" className="min-w-0 flex-1 bg-transparent text-xs text-text placeholder:text-faint focus:outline-none" />
        </label>
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {filtered.map((s) => (
            <button key={s.id} onClick={() => { setQ(''); set({ settingsCenter: s.id }); }} className={`block w-full rounded-lg px-2.5 py-1.5 text-left text-xs ${current.id === s.id ? 'bg-panel-hover text-text' : 'text-dim hover:bg-panel-hover/50'}`}>{s.label}</button>
          ))}
          {!filtered.length ? <p className="px-2 text-xs text-faint">No settings match “{q}”.</p> : null}
        </nav>
        <a href="/admin" target="_blank" rel="noreferrer" className="mt-3 rounded-lg border border-line px-2.5 py-1.5 text-xs text-dim hover:text-text">Data source health &amp; admin →</a>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-8">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-6 text-xl font-semibold text-text">{current.label}</h2>
          <current.C />
        </div>
      </main>
    </div>
  );
}
