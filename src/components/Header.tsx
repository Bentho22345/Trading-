'use client';
import { useStore } from '@/lib/store';
import { useSettings } from '@/lib/settings';
import { useNow } from '@/lib/hooks';
import { ConnectionStatus } from './ConnectionStatus';
import { useV2 } from '@/lib/v2';
import { Icon, IconButton, Kbd } from './ui';

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
        <defs>
          <linearGradient id="lg" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="var(--fx)" />
            <stop offset="1" stopColor="var(--eq)" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="22" height="22" rx="6" fill="none" stroke="url(#lg)" strokeWidth="1.5" />
        <path d="M4 13h3.5l2-5 3 9 2.5-6 1.5 2H20" fill="none" stroke="url(#lg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-sm font-bold tracking-[0.28em] text-text">PULSE</span>
    </div>
  );
}

function Breadth() {
  const b = useStore((s) => s.analytics?.breadth);
  if (b === undefined) return null;
  const pct = Math.round(((b + 1) / 2) * 100);
  return (
    <div className="hidden items-center gap-2 text-[10px] text-faint xl:flex" title="Market breadth: share of advancing vs declining symbols (equities + crypto)">
      <span className="uppercase tracking-wider">Breadth</span>
      <div className="relative h-1.5 w-20 overflow-hidden rounded-full bg-down/60">
        <div className="absolute inset-y-0 left-0 rounded-full bg-up transition-[width] duration-1000" style={{ width: `${pct}%` }} />
      </div>
      <span className={`num ${b >= 0 ? 'text-up' : 'text-down'}`}>{b >= 0 ? '+' : ''}{(b * 100).toFixed(0)}</span>
    </div>
  );
}

function PnlLine() {
  const e = useV2((s) => s.exposure);
  const privacy = useV2((s) => s.privacy);
  if (!e || !e.rows.length) return null;
  return (
    <button onClick={() => useV2.getState().set({ privacy: !privacy })} title="Live P&L — press P for privacy blur" className={`num hidden items-center gap-1.5 rounded-lg border border-line px-2 py-0.5 text-[11px] lg:flex ${privacy ? 'blur-[5px]' : ''}`}>
      <span className="text-faint">P&amp;L</span>
      <span className={e.pnlDay >= 0 ? 'text-up' : 'text-down'}>{e.pnlDay >= 0 ? '+' : '−'}${Math.abs(e.pnlDay).toLocaleString()}</span>
    </button>
  );
}

function Clocks() {
  const clocks = useSettings((s) => s.clocks);
  const now = useNow(1000);
  if (!now) return null;
  return (
    <span className="num hidden gap-3 text-[11px] text-faint 2xl:flex" suppressHydrationWarning>
      {clocks.slice(0, 3).map((tz) => <span key={tz} title={tz}>{tz.split('/').pop()?.replace('_', ' ').slice(0, 6)} {new Date(now).toLocaleTimeString([], { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })}</span>)}
    </span>
  );
}

export function Header() {
  const set = useStore((s) => s.set);
  const theme = useSettings((s) => s.theme);
  const focus = useSettings((s) => s.focus);
  const setS = useSettings((s) => s.set);
  const now = useNow(1000);
  return (
    <header className="relative z-40 flex h-12 items-center gap-3 border-b border-line bg-bg/80 px-3">
      <Logo />
      <span className="num hidden text-[11px] text-faint md:inline" suppressHydrationWarning>
        {now ? `${new Date(now).toLocaleTimeString([], { hour12: false })} · ${new Date(now).toISOString().slice(11, 16)} UTC` : ''}
      </span>
      <Clocks />
      <button onClick={() => set({ paletteOpen: true })} className="ml-auto hidden min-w-[260px] items-center gap-2 rounded-lg border border-line bg-bg-2/60 px-2.5 py-1 text-xs text-faint hover:border-line-strong sm:flex">
        <Icon name="search" size={13} />
        <span className="flex-1 text-left">Jump to ticker, filter, setting…</span>
        <Kbd>⌘K</Kbd>
      </button>
      <div className="ml-auto flex items-center gap-1.5 sm:ml-0">
        <PnlLine />
        <Breadth />
        <ConnectionStatus />
        <IconButton label="Search / commands" className="sm:hidden" onClick={() => set({ paletteOpen: true })}><Icon name="command" size={14} /></IconButton>
        <IconButton label={focus ? 'Exit focus mode (F)' : 'Focus mode (F)'} active={focus} onClick={() => setS({ focus: !focus })}><Icon name="focus" size={14} /></IconButton>
        <IconButton label="Morning brief (M)" onClick={() => useV2.getState().openBrief(null)}><span className="font-serif text-[13px] leading-none">B</span></IconButton>
        <IconButton label="Ask Pulse (⌘J)" onClick={() => useV2.getState().set({ copilotOpen: !useV2.getState().copilotOpen })}><Icon name="sparkle" size={14} /></IconButton>
        <IconButton label="Market replay (R)" className="hidden md:inline-flex" onClick={() => window.dispatchEvent(new CustomEvent('pulse:replay'))}><Icon name="timeline" size={14} /></IconButton>
        <IconButton label="Journal (N)" className="hidden md:inline-flex" onClick={() => useV2.getState().set({ journalOpen: true })}><Icon name="bookmark" size={14} /></IconButton>
        <IconButton label={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => setS({ theme: theme === 'dark' ? 'light' : 'dark' })}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} /></IconButton>
        <IconButton label="Keyboard shortcuts (?)" className="hidden md:inline-flex" onClick={() => set({ shortcutsOpen: true })}><Icon name="keyboard" size={14} /></IconButton>
        <IconButton label="Settings (,)" onClick={() => useV2.getState().set({ settingsCenter: 'appearance' })}><Icon name="settings" size={14} /></IconButton>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="flex h-7 items-center justify-between gap-3 border-t border-line bg-bg/80 px-3 text-[10px] text-faint">
      <span className="truncate">Informational only — not investment advice. Data may be delayed; every item shows its source and freshness. Headlines link to the original publisher.</span>
      <span className="hidden shrink-0 md:inline">Press <Kbd>?</Kbd> for shortcuts</span>
    </footer>
  );
}
