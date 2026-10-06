'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useConnected } from '@/lib/live';

const LINKS = [
  { href: '/', label: 'Dashboard', key: 'd' },
  { href: '/connectors', label: 'Connectors', key: 'c' },
  { href: '/health', label: 'Health', key: 'h' },
];

export function Nav() {
  const path = usePathname();
  const router = useRouter();
  const live = useConnected();
  const [q, setQ] = useState('');
  return (
    <nav className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-line bg-bg/95 px-3 py-2 backdrop-blur">
      <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
        <span className="text-accent">◉</span> MEMECOIN RADAR
      </Link>
      <div className="flex gap-1">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href}
            className={`rounded px-2 py-1 ${path === l.href ? 'bg-panel2 text-fg' : 'text-mute hover:text-fg'}`}>
            {l.label}
          </Link>
        ))}
      </div>
      <form className="ml-auto flex min-w-0 flex-1 justify-end md:flex-none"
        onSubmit={(e) => { e.preventDefault(); const a = q.trim(); if (a) router.push(`/token?a=${encodeURIComponent(a)}`); setQ(''); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Paste contract address…  ( / )" id="ca-search"
          className="w-full rounded border border-line bg-panel px-2 py-1 outline-none focus:border-accent md:w-80" />
      </form>
      <span className={`flex items-center gap-1 text-[11px] ${live ? 'text-up' : 'text-down'}`} title="Live socket to the Radar backend">
        <span className={`h-2 w-2 rounded-full ${live ? 'bg-up animate-pulse' : 'bg-down'}`} />{live ? 'LIVE' : 'OFFLINE'}
      </span>
      <Shortcuts />
    </nav>
  );
}

function Shortcuts() {
  const router = useRouter();
  if (typeof window !== 'undefined' && !(window as any).__radarKeys) {
    (window as any).__radarKeys = true;
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); document.getElementById('ca-search')?.focus(); }
      const l = LINKS.find((x) => x.key === e.key);
      if (l) router.push(l.href);
    });
  }
  return null;
}
