'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useConnected } from '@/lib/live';
import { CommandPalette } from './CommandPalette';
import { Icon } from './Icon';
import { WalletButton } from './WalletButton';
import { motion } from './motion';

export const LINKS = [
  { href: '/', label: 'Dashboard', key: 'd', icon: 'dashboard' },
  { href: '/trending', label: 'Trending', key: 't', icon: 'trending' },
  { href: '/launching', label: 'Launching', key: 'l', icon: 'rocket' },
  { href: '/narratives', label: 'Narratives', key: 'n', icon: 'narrative' },
  { href: '/signals', label: 'Signals', key: 's', icon: 'signal' },
  { href: '/social', label: 'Social', key: 'f', icon: 'social' },
  { href: '/smart-money', label: 'Smart money', key: 'w', icon: 'wallet' },
  { href: '/scorecard', label: 'Scorecard', key: 'p', icon: 'score' },
  { href: '/wallet', label: 'My wallet', key: 'm', icon: 'wallet' },
  { href: '/risk', label: 'Risk', key: 'r', icon: 'risk' },
  { href: '/rotation', label: 'Rotation & Brief', key: 'b', icon: 'rotation' },
  { href: '/ask', label: 'Ask Radar', key: 'a', icon: 'ask' },
  { href: '/connectors', label: 'Connectors', key: 'c', icon: 'plug' },
  { href: '/settings', label: 'Settings', key: 'g', icon: 'settings' },
  { href: '/health', label: 'Health', key: 'h', icon: 'health' },
];

export function Nav() {
  const path = usePathname();
  const router = useRouter();
  const live = useConnected();
  const [palette, setPalette] = useState(false);
  const [authed, setAuthed] = useState(false);

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

  if (path === '/login') return null;
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));

  return (
    <>
      {/* desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[208px] flex-col border-r border-white/5 bg-bg/60 px-3 py-4 backdrop-blur-xl lg:flex">
        <Link href="/" className="mb-5 flex items-center gap-2 px-2">
          <span className="relative flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent2 text-bg shadow-[0_0_24px_-4px_var(--color-accent)]">
            <Icon name="bolt" size={17} />
          </span>
          <span className="leading-tight"><span className="block text-[14px] font-semibold tracking-tight">Memecoin Radar</span>
            <span className="block text-[10px] text-mute">narratives → coins, live</span></span>
        </Link>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} title={`shortcut: ${l.key}`}
              className={`relative flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13px] transition-colors ${active(l.href) ? 'text-fg' : 'text-mute hover:text-fg'}`}>
              {active(l.href) && <motion.span layoutId="nav-active" className="absolute inset-0 -z-10 rounded-xl bg-white/[0.07] ring-1 ring-white/10"
                transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
              <Icon name={l.icon} size={16} className={active(l.href) ? 'text-accent2' : ''} />
              <span className="flex-1">{l.label}</span>
              <kbd className="text-[10px] text-mute/60">{l.key}</kbd>
            </Link>
          ))}
        </nav>
        {authed && <button onClick={() => fetch('/api/logout', { method: 'POST' }).then(() => { location.href = '/login'; })}
          className="mt-2 rounded-xl px-2.5 py-2 text-left text-[12px] text-mute hover:text-fg">Log out</button>}
      </aside>

      {/* top bar */}
      <header className="sticky top-0 z-20 border-b border-white/5 bg-bg/70 backdrop-blur-xl lg:pl-[208px]">
        <div className="flex items-center gap-3 px-3 py-2.5 md:px-5">
          <Link href="/" className="flex items-center gap-2 lg:hidden">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent2 text-bg"><Icon name="bolt" size={15} /></span>
          </Link>
          <button onClick={() => setPalette(true)}
            className="group flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-left text-mute transition hover:border-accent/50 md:max-w-md">
            <Icon name="search" size={15} />
            <span className="flex-1 truncate">Search coins, CAs, narratives…</span>
            <kbd className="hidden rounded-md border border-white/10 px-1.5 text-[10px] sm:inline">⌘K</kbd>
          </button>
          <span className="ml-auto" />
          <WalletButton />
          <span className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium ${live ? 'border-up/30 bg-up/10 text-up' : 'border-down/30 bg-down/10 text-down'}`}
            title="Live socket to the Radar backend">
            <span className={`h-1.5 w-1.5 rounded-full ${live ? 'live-dot bg-up' : 'bg-down'}`} />{live ? 'Live' : 'Reconnecting'}
          </span>
        </div>
        {/* mobile nav */}
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href}
              className={`relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12px] ${active(l.href) ? 'text-fg' : 'text-mute'}`}>
              {active(l.href) && <motion.span layoutId="nav-active-m" className="absolute inset-0 -z-10 rounded-lg bg-white/[0.08]" />}
              <Icon name={l.icon} size={14} />{l.label}
            </Link>
          ))}
        </nav>
      </header>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </>
  );
}
