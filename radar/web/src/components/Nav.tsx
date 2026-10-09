'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useConnected } from '@/lib/live';
import { useTheme } from '@/lib/theme';
import { CommandPalette } from './CommandPalette';
import { Icon } from './Icon';
import { AnimatePresence, motion } from './motion';

export const LINKS = [
  { href: '/', label: 'Home', key: 'd', icon: 'dashboard', primary: true },
  { href: '/snipe', label: 'Snipe', key: 'x', icon: 'target', primary: true },
  { href: '/engines', label: 'Engines', key: 'o', icon: 'bolt', primary: true },
  { href: '/traders', label: 'Top Traders', key: 'w', icon: 'trophy', primary: true },
  { href: '/pulse', label: 'Pulse', key: 'u', icon: 'pulse', primary: true },
  { href: '/trending', label: 'Trending', key: 't', icon: 'trending', primary: true },
  { href: '/launching', label: 'Launching', key: 'l', icon: 'rocket', primary: true },
  { href: '/narratives', label: 'Narratives', key: 'n', icon: 'narrative', primary: true },
  { href: '/signals', label: 'Signals', key: 's', icon: 'signal', primary: true },
  { href: '/proof', label: 'Proof', key: 'v', icon: 'check' },
  { href: '/playbook', label: 'Playbook', key: 'y', icon: 'narrative' },
  { href: '/news', label: 'News', key: 'e', icon: 'news' },
  { href: '/social', label: 'Social', key: 'f', icon: 'social' },
  { href: '/scorecard', label: 'Scorecard', key: 'p', icon: 'score' },
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
  const [more, setMore] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [theme, setTheme] = useTheme();

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
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll); };
  }, [router]);
  useEffect(() => { setMore(false); setMobile(false); }, [path]);

  if (path === '/login') return null;
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  const secondary = LINKS.filter((l) => !l.primary);

  return (
    <>
      <header className={`sticky top-0 z-40 transition-colors duration-300 ${scrolled ? 'border-b border-white/[0.06] bg-black/80 backdrop-blur-xl' : 'bg-transparent'}`}>
        <div className="mx-auto flex max-w-[1920px] items-center gap-6 px-4 py-3 md:px-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="relative flex h-7 w-7 items-center justify-center">
              <span className="absolute inset-0 rounded-full border-2 border-white/90" />
              <span className="absolute inset-[5px] rounded-full bg-up shadow-[0_0_14px_var(--color-up)]" />
            </span>
            <span className="display text-[22px] tracking-wide">Radar</span>
          </Link>
          <nav className="hidden items-center gap-0.5 xl:flex">
            {LINKS.filter((l) => l.primary).map((l) => (
              <Link key={l.href} href={l.href} className={`relative px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.14em] transition-colors ${active(l.href) ? 'text-white' : 'text-white/50 hover:text-white'}`}>
                {l.label}
                {active(l.href) && <motion.span layoutId="nav-underline" className="absolute inset-x-3 -bottom-[3px] h-[2px] rounded-full bg-white" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
              </Link>
            ))}
            <div className="relative" onMouseLeave={() => setMore(false)}>
              <button onMouseEnter={() => setMore(true)} onClick={() => setMore(!more)}
                className={`px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.14em] ${secondary.some((l) => active(l.href)) ? 'text-white' : 'text-white/50 hover:text-white'}`}>More ▾</button>
              <AnimatePresence>
                {more && (
                  <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.18 }}
                    className="glass absolute left-0 top-full z-50 mt-1 grid w-[420px] grid-cols-2 gap-1 rounded-2xl p-2">
                    {secondary.map((l) => (
                      <Link key={l.href} href={l.href} className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] transition ${active(l.href) ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'}`}>
                        <Icon name={l.icon} size={15} />{l.label}<kbd className="ml-auto text-[10px] text-white/30">{l.key}</kbd>
                      </Link>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setPalette(true)} className="flex items-center gap-2 rounded-full border border-white/15 px-3 py-1.5 text-[12px] text-white/60 transition hover:border-white/40 hover:text-white">
              <Icon name="search" size={14} /><span className="hidden sm:inline">Search</span><kbd className="hidden text-[10px] text-white/40 sm:inline">⌘K</kbd>
            </button>
            <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              title={`${theme === 'dark' ? 'Light' : 'Dark'} theme`}
              className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-white/15 text-white/70 transition hover:border-white/40 hover:text-white">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={theme} initial={{ y: 14, rotate: -90, opacity: 0 }} animate={{ y: 0, rotate: 0, opacity: 1 }} exit={{ y: -14, rotate: 90, opacity: 0 }}
                  transition={{ duration: 0.25 }}><Icon name={theme === 'dark' ? 'moon' : 'sun'} size={15} /></motion.span>
              </AnimatePresence>
            </button>
            <span className={`hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] sm:flex ${live ? 'text-up' : 'text-down'}`} title="Live socket">
              <span className={`h-1.5 w-1.5 rounded-full ${live ? 'live-dot bg-up' : 'bg-down'}`} />{live ? 'Live' : 'Offline'}
            </span>
            {authed && <button onClick={() => fetch('/api/logout', { method: 'POST' }).then(() => { location.href = '/login'; })} className="hidden text-[11px] uppercase tracking-[0.14em] text-white/40 hover:text-white md:block">Log out</button>}
            <button onClick={() => setMobile(true)} className="rounded-full p-2 text-white xl:hidden" aria-label="Menu"><Icon name="menu" size={20} /></button>
          </div>
        </div>
      </header>

      <AnimatePresence>
        {mobile && (
          <motion.div className="fixed inset-0 z-50 overflow-y-auto bg-black px-6 py-5" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="mb-8 flex items-center justify-between">
              <span className="display text-2xl">Radar</span>
              <button onClick={() => setMobile(false)} className="rounded-full p-2" aria-label="Close"><Icon name="x" size={22} /></button>
            </div>
            <motion.ul initial="h" animate="s" variants={{ s: { transition: { staggerChildren: 0.035 } } }} className="space-y-1">
              {LINKS.map((l) => (
                <motion.li key={l.href} variants={{ h: { opacity: 0, y: 14 }, s: { opacity: 1, y: 0 } }}>
                  <Link href={l.href} className={`display block py-1 text-[44px] ${active(l.href) ? 'text-white' : 'text-white/35'}`}>{l.label}</Link>
                </motion.li>
              ))}
            </motion.ul>
          </motion.div>
        )}
      </AnimatePresence>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </>
  );
}
