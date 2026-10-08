'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useConnected } from '@/lib/live';
import { CommandPalette } from './CommandPalette';
import { Icon } from './Icon';
import { motion } from './motion';
import { DISCLAIMER } from './ui';

export const LINKS = [
  { href: '/', label: 'Dashboard', key: 'd', icon: 'dashboard', group: 'Discover' },
  { href: '/trending', label: 'Trending', key: 't', icon: 'trending', group: 'Discover' },
  { href: '/launching', label: 'Launching', key: 'l', icon: 'rocket', group: 'Discover' },
  { href: '/narratives', label: 'Narratives', key: 'n', icon: 'narrative', group: 'Discover' },
  { href: '/signals', label: 'Signals', key: 's', icon: 'signal', group: 'Intelligence' },
  { href: '/social', label: 'Social', key: 'f', icon: 'social', group: 'Intelligence' },
  { href: '/smart-money', label: 'Smart money', key: 'w', icon: 'wallet', group: 'Intelligence' },
  { href: '/scorecard', label: 'Scorecard', key: 'p', icon: 'score', group: 'Intelligence' },
  { href: '/risk', label: 'Risk', key: 'r', icon: 'risk', group: 'Intelligence' },
  { href: '/rotation', label: 'Rotation & Brief', key: 'b', icon: 'rotation', group: 'Intelligence' },
  { href: '/ask', label: 'Ask Radar', key: 'a', icon: 'ask', group: 'Intelligence' },
  { href: '/connectors', label: 'Connectors', key: 'c', icon: 'plug', group: 'System' },
  { href: '/settings', label: 'Settings', key: 'g', icon: 'settings', group: 'System' },
  { href: '/health', label: 'Health', key: 'h', icon: 'health', group: 'System' },
];
const GROUPS = [...new Set(LINKS.map((l) => l.group))];

export function Nav() {
  const path = usePathname();
  const router = useRouter();
  const live = useConnected();
  const [palette, setPalette] = useState(false);
  const [authed, setAuthed] = useState(false);
  const mobileNav = useRef<HTMLElement>(null);

  useEffect(() => {
    fetch('/api/session').then((r) => r.json()).then((s) => setAuthed(s.auth_required && s.authed)).catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); setPalette(true); return; }
      const l = LINKS.find((x) => x.key === e.key);
      if (l) router.push(l.href);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  // keep the active tab in view on the scrolling mobile nav
  useEffect(() => {
    mobileNav.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [path]);

  if (path === '/login') return null;
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  const current = LINKS.find((l) => active(l.href)) ?? (path.startsWith('/token') ? { label: 'Token', icon: 'eye' } : undefined);

  return (
    <>
      {/* desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[208px] flex-col border-r border-white/[0.06] bg-[linear-gradient(180deg,#080a12,#05060b)] px-3 py-4 lg:flex">
        <Link href="/" className="group mb-6 flex items-center gap-2.5 px-2">
          <span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent2 text-bg shadow-[0_0_28px_-6px_var(--color-accent)] transition-transform duration-300 group-hover:rotate-[-8deg] group-hover:scale-105">
            <Icon name="bolt" size={18} />
          </span>
          <span className="leading-tight"><span className="block text-[14.5px] font-semibold tracking-tight">Memecoin <span className="grad-text">Radar</span></span>
            <span className="block text-[10.5px] text-mute">narratives → coins, live</span></span>
        </Link>
        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto">
          {GROUPS.map((g) => (
            <div key={g} className="flex flex-col gap-0.5">
              <span className="eyebrow mb-1 px-2.5 text-mute/70">{g}</span>
              {LINKS.filter((l) => l.group === g).map((l) => (
                <Link key={l.href} href={l.href} title={`shortcut: ${l.key}`}
                  className={`group relative flex items-center gap-2.5 rounded-xl px-2.5 py-[7px] text-[13px] transition-colors ${active(l.href) ? 'text-fg' : 'text-mute hover:bg-white/[0.03] hover:text-fg'}`}>
                  {active(l.href) && <motion.span layoutId="nav-active" className="absolute inset-0 -z-10 rounded-xl bg-gradient-to-r from-accent/[0.16] to-white/[0.03] ring-1 ring-white/10"
                    transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                  {active(l.href) && <span className="absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-gradient-to-b from-accent to-accent2" />}
                  <Icon name={l.icon} size={16} className={active(l.href) ? 'text-accent2' : 'transition-colors group-hover:text-fg'} />
                  <span className="flex-1">{l.label}</span>
                  <kbd className="rounded border border-white/[0.06] px-1 font-mono text-[9.5px] text-mute/50 opacity-0 transition-opacity group-hover:opacity-100">{l.key}</kbd>
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-[10.5px] leading-snug text-mute">
          {DISCLAIMER}
          {authed && <button onClick={() => fetch('/api/logout', { method: 'POST' }).then(() => { location.href = '/login'; })}
            className="mt-1.5 block text-[11.5px] text-mute hover:text-fg">Log out</button>}
        </div>
      </aside>

      {/* top bar */}
      <header className="chrome sticky top-0 z-20 border-b border-white/[0.06] lg:pl-[208px]">
        <div className="flex items-center gap-3 px-3 py-2.5 md:px-5">
          <Link href="/" className="flex items-center gap-2 lg:hidden">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent2 text-bg"><Icon name="bolt" size={15} /></span>
          </Link>
          <span className="hidden items-center gap-2 text-[13px] font-semibold tracking-tight lg:flex">
            {current && <Icon name={current.icon} size={15} className="text-accent2" />}{current?.label}
          </span>
          <button onClick={() => setPalette(true)}
            className="group flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-left text-mute transition hover:border-accent/50 md:max-w-md lg:ml-4">
            <Icon name="search" size={15} />
            <span className="flex-1 truncate">Search coins, CAs, narratives…</span>
            <kbd className="hidden rounded-md border border-white/10 px-1.5 text-[10px] sm:inline">⌘K</kbd>
          </button>
          <span className={`ml-auto flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium ${live ? 'border-up/30 bg-up/10 text-up' : 'border-down/30 bg-down/10 text-down'}`}
            title="Live socket to the Radar backend">
            <span className={`h-1.5 w-1.5 rounded-full ${live ? 'live-dot bg-up' : 'bg-down'}`} />{live ? 'Live' : 'Reconnecting'}
          </span>
        </div>
        {/* mobile nav */}
        <nav ref={mobileNav} className="scroll-x flex gap-1 px-3 pb-2 lg:hidden">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} data-active={active(l.href) || undefined}
              className={`relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12px] ${active(l.href) ? 'text-fg' : 'text-mute'}`}>
              {active(l.href) && <motion.span layoutId="nav-active-m" className="absolute inset-0 -z-10 rounded-lg bg-gradient-to-r from-accent/25 to-accent2/15 ring-1 ring-white/10" />}
              <Icon name={l.icon} size={14} />{l.label}
            </Link>
          ))}
        </nav>
      </header>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </>
  );
}
