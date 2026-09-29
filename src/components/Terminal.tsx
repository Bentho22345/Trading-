'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { MotionConfig } from 'framer-motion';
import { connect } from '@/lib/socket';
import { useStore } from '@/lib/store';
import { useSettings, type PanelId } from '@/lib/settings';
import { usePrefersReducedMotion } from '@/lib/hooks';
import { Header, Footer } from './Header';
import { TickerStrip } from './TickerStrip';
import { NewsFeed } from './NewsFeed';
import { BreakingBanner } from './BreakingBanner';
import { Rail, LayoutEditBar } from './Rails';
import { Ambient } from './Ambient';
import { Toasts } from './Toasts';
import { TickerDrawer } from './Drawer';
import { StoryTimeline } from './Timeline';
import { CommandPalette } from './CommandPalette';
import { KeyboardShortcuts, ShortcutSheet } from './Shortcuts';
import { AwayTracker, DigestModal } from './Digest';
import { SettingsModal } from './SettingsModal';
import { Segmented } from './ui';

type BP = 'sm' | 'md' | 'lg';
function useBreakpoint(): BP {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('resize', cb);
      return () => window.removeEventListener('resize', cb);
    },
    () => (window.innerWidth >= 1200 ? 'lg' : window.innerWidth >= 768 ? 'md' : 'sm'),
    () => 'lg',
  );
}

function ThemeSync() {
  const theme = useSettings((s) => s.theme);
  const cb = useSettings((s) => s.colorblind);
  const calm = useSettings((s) => s.calm);
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = theme;
    el.dataset.cb = String(cb);
    el.classList.toggle('calm', calm);
  }, [theme, cb, calm]);
  return null;
}

export function Terminal() {
  const hydrateSettings = useSettings((s) => s.hydrate);
  const layout = useSettings((s) => s.layout);
  const focus = useSettings((s) => s.focus);
  const calm = useSettings((s) => s.calm);
  const reduced = usePrefersReducedMotion();
  const editing = useStore((s) => s.layoutEditing);
  const mobileTab = useStore((s) => s.mobileTab);
  const bp = useBreakpoint();

  useEffect(() => {
    hydrateSettings();
    return connect();
  }, [hydrateSettings]);

  const feed = (
    <main className="relative flex min-h-0 flex-col" aria-label="News">
      <NewsFeed />
    </main>
  );

  let body: React.ReactNode;
  if (focus && !editing) {
    body = <div className="mx-auto flex h-full w-full max-w-3xl min-h-0 flex-col">{feed}</div>;
  } else if (bp === 'lg' || editing) {
    body = (
      <div className="grid h-full min-h-0 grid-cols-12 gap-3">
        <aside className="col-span-3 min-h-0 overflow-y-auto pb-4 pr-1" aria-label="Calendar, sessions and central banks"><Rail side="left" panels={layout.left} /></aside>
        <div className="col-span-6 flex min-h-0 flex-col">{editing ? <LayoutEditBar /> : null}{feed}</div>
        <aside className="col-span-3 min-h-0 overflow-y-auto pb-4 pr-1" aria-label="Markets"><Rail side="right" panels={layout.right} /></aside>
      </div>
    );
  } else if (bp === 'md') {
    body = (
      <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(300px,38%)] gap-3">
        {feed}
        <aside className="min-h-0 overflow-y-auto pb-4 pr-1"><Rail side="right" panels={[...layout.left, ...layout.right]} /></aside>
      </div>
    );
  } else {
    const tabs: Record<string, PanelId[]> = {
      markets: [...layout.left, ...layout.right].filter((p) => !['watchlist', 'alerts', 'sessions', 'calendar', 'banks'].includes(p)),
      calendar: ['sessions', 'calendar', 'banks'],
      watch: ['watchlist', 'alerts'],
    };
    body = (
      <div className="flex h-full min-h-0 flex-col">
        <div className="mb-2 flex justify-center">
          <Segmented label="Section" size="md" value={mobileTab} onChange={(v) => useStore.getState().set({ mobileTab: v })} options={[{ value: 'feed', label: 'Feed' }, { value: 'markets', label: 'Markets' }, { value: 'calendar', label: 'Calendar' }, { value: 'watch', label: 'Watch' }]} />
        </div>
        {mobileTab === 'feed' ? feed : <div className="min-h-0 flex-1 overflow-y-auto pb-4"><Rail side="right" panels={tabs[mobileTab]} /></div>}
      </div>
    );
  }

  return (
    <MotionConfig reducedMotion={calm || reduced ? 'always' : 'user'}>
      <ThemeSync />
      <Ambient />
      <div className="flex h-dvh flex-col">
        <Header />
        <TickerStrip />
        <div className="relative min-h-0 flex-1 p-3">
          <BreakingBanner />
          {body}
        </div>
        <Footer />
      </div>
      <Toasts />
      <TickerDrawer />
      <StoryTimeline />
      <CommandPalette />
      <ShortcutSheet />
      <SettingsModal />
      <DigestModal />
      <KeyboardShortcuts />
      <AwayTracker />
    </MotionConfig>
  );
}
