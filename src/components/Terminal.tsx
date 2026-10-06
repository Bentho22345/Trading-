'use client';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import type { NewsCluster } from '@shared/types';
import { connect } from '@/lib/socket';
import { useStore } from '@/lib/store';
import { useSettings } from '@/lib/settings';
import { useActiveWorkspace } from '@/lib/workspaces';
import { Header, Footer } from './Header';
import { TickerStrip } from './TickerStrip';
import { NewsFeed } from './NewsFeed';
import { BreakingBanner } from './BreakingBanner';
import { Ambient } from './Ambient';
import { Toasts } from './Toasts';
import { KeyboardShortcuts } from './Shortcuts';
import { AwayTracker } from './Digest';
import { Segmented } from './ui';
import { ThemeSync } from './layout/ThemeSync';
import { useV2 } from '@/lib/v2';

// Overlays aren't needed for first paint: split them (and cmdk / chart code) out of the main bundle.
// Side rails mount on idle anyway; loading them (and the animation library they use) lazily keeps
// the first-paint bundle small.
const WorkspaceGrid = dynamic(() => import('./layout/Grid').then((m) => m.WorkspaceGrid), { ssr: false, loading: () => <div className="grid h-full grid-cols-12 gap-3"><div className="glass col-span-3 rounded-xl" /><div className="col-span-6 space-y-2"><div className="skeleton h-24" /><div className="skeleton h-24" /></div><div className="glass col-span-3 rounded-xl" /></div> });
const WidgetStack = dynamic(() => import('./layout/Stack').then((m) => m.WidgetStack), { ssr: false });
const WidgetLibrary = dynamic(() => import('./layout/WorkspaceBar').then((m) => m.WidgetLibrary), { ssr: false });
const WorkspaceBar = dynamic(() => import('./layout/WorkspaceBar').then((m) => m.WorkspaceBar), { ssr: false, loading: () => <div className="h-9 border-b border-line" /> });
const WorkspaceAutoSwitch = dynamic(() => import('./layout/WorkspaceBar').then((m) => m.WorkspaceAutoSwitch), { ssr: false });
const TickerDrawer = dynamic(() => import('./Drawer').then((m) => m.TickerDrawer), { ssr: false });
const StoryTimeline = dynamic(() => import('./Timeline').then((m) => m.StoryTimeline), { ssr: false });
const CommandPalette = dynamic(() => import('./CommandPalette').then((m) => m.CommandPalette), { ssr: false });
const ShortcutSheet = dynamic(() => import('./Shortcuts').then((m) => m.ShortcutSheet), { ssr: false });
const SettingsCenter = dynamic(() => import('./settings/SettingsCenter').then((m) => m.SettingsCenter), { ssr: false });
const CopilotPanel = dynamic(() => import('./power/Copilot').then((m) => m.CopilotPanel), { ssr: false });
const JournalOverlay = dynamic(() => import('./personal/Journal').then((m) => m.JournalOverlay), { ssr: false });
const PlaybooksManager = dynamic(() => import('./personal/Playbooks').then((m) => m.PlaybooksManager), { ssr: false });
const FeedBuilder = dynamic(() => import('./power/FeedBuilder').then((m) => m.FeedBuilder), { ssr: false });
const Replay = dynamic(() => import('./power/Replay').then((m) => m.Replay), { ssr: false });
const Squawk = dynamic(() => import('./power/Squawk').then((m) => m.Squawk), { ssr: false });
const DigestModal = dynamic(() => import('./Digest').then((m) => m.DigestModal), { ssr: false });
const MorningBrief = dynamic(() => import('./brief/MorningBrief').then((m) => m.MorningBrief), { ssr: false });
const BriefAutoOpen = dynamic(() => import('./brief/MorningBrief').then((m) => m.BriefAutoOpen), { ssr: false });

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

/** Sticky "has ever been opened" flags, so each overlay chunk loads only when first needed. */
function useOpenedOverlays() {
  const drawer = useStore((s) => !!s.drawerSymbol);
  const timeline = useStore((s) => !!s.timelineId);
  const palette = useStore((s) => s.paletteOpen);
  const shortcuts = useStore((s) => s.shortcutsOpen);
  const settings = useStore((s) => s.settingsOpen);
  const digest = useStore((s) => !!s.digestSince);
  const brief = useV2((s) => s.briefOpen);
  const seen = useRef({ drawer: false, timeline: false, palette: false, shortcuts: false, settings: false, digest: false, brief: false });
  const now = { drawer, timeline, palette, shortcuts, settings, digest, brief };
  for (const k of Object.keys(now) as (keyof typeof now)[]) if (now[k]) seen.current[k] = true;
  return seen.current;
}

export function Terminal({ initialClusters }: { initialClusters?: NewsCluster[] }) {
  const hydrateSettings = useSettings((s) => s.hydrate);
  const ws = useActiveWorkspace();
  const libraryOpen = useV2((s) => s.libraryOpen);
  const settingsCenter = useV2((s) => !!s.settingsCenter);
  const copilotOpen = useV2((s) => s.copilotOpen);
  const journalOpen = useV2((s) => s.journalOpen);
  const playbooksOpen = useV2((s) => s.playbooksOpen);
  const feedBuilder = useV2((s) => !!s.feedBuilder);
  const focus = useSettings((s) => s.focus);
  const editing = useStore((s) => s.layoutEditing);
  const overlays = useOpenedOverlays();
  const mobileTab = useStore((s) => s.mobileTab);
  const bp = useBreakpoint();

  useEffect(() => {
    hydrateSettings();
    if (new URLSearchParams(location.search).get('brief')) useV2.getState().openBrief(null);
    // legacy settings button / palette entry opens the new Settings Center
    const unsub = useStore.subscribe((st) => { if (st.settingsOpen) { useStore.getState().set({ settingsOpen: false }); useV2.getState().set({ settingsCenter: 'appearance' }); } });
    const stop = connect();
    return () => { unsub(); stop(); };
  }, [hydrateSettings]);

  const feed = (
    <main className="relative flex min-h-0 flex-col" aria-label="News">
      <NewsFeed initial={initialClusters} />
    </main>
  );

  let body: React.ReactNode;
  if (focus && !editing) {
    body = <div className="mx-auto flex h-full w-full max-w-3xl min-h-0 flex-col">{feed}</div>;
  } else if (bp === 'lg' || editing) {
    body = <WorkspaceGrid ws={ws} initialClusters={initialClusters} />;
  } else if (bp === 'md') {
    body = (
      <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(300px,38%)] gap-3">
        {feed}
        <aside className="min-h-0 overflow-y-auto pb-4 pr-1"><WidgetStack ws={ws} /></aside>
      </div>
    );
  } else {
    body = (
      <div className="flex h-full min-h-0 flex-col">
        <div className="mb-2 flex justify-center">
          <Segmented label="Section" size="md" value={mobileTab === 'feed' ? 'feed' : 'markets'} onChange={(v) => useStore.getState().set({ mobileTab: v })} options={[{ value: 'feed', label: 'Feed' }, { value: 'markets', label: 'Panels' }]} />
        </div>
        {mobileTab === 'feed' ? feed : <div className="min-h-0 flex-1 overflow-y-auto pb-4"><WidgetStack ws={ws} /></div>}
      </div>
    );
  }

  return (
    <>
      <ThemeSync />
      <Ambient />
      <div className="flex h-dvh flex-col">
        <div className={`transition-opacity ${editing ? 'pointer-events-none opacity-50' : ''}`}><Header /><TickerStrip /></div>
        {bp === 'lg' && !focus ? <WorkspaceBar /> : null}
        <div className="relative min-h-0 flex-1 p-3">
          <BreakingBanner />
          {body}
        </div>
        <Footer />
      </div>
      <Toasts />
      {/* overlays (and the animation library) load on first open, then stay mounted for exit animations */}
      {overlays.drawer && <TickerDrawer />}
      {overlays.timeline && <StoryTimeline />}
      {overlays.palette && <CommandPalette />}
      {overlays.shortcuts && <ShortcutSheet />}
      {overlays.digest && <DigestModal />}
      {overlays.brief && <MorningBrief />}
      <BriefAutoOpen />
      {settingsCenter ? <SettingsCenter /> : null}
      {copilotOpen ? <CopilotPanel /> : null}
      {journalOpen ? <JournalOverlay /> : null}
      {playbooksOpen ? <PlaybooksManager /> : null}
      {feedBuilder ? <FeedBuilder /> : null}
      <Replay />
      <Squawk />
      <KeyboardShortcuts />
      <WorkspaceAutoSwitch />
      {libraryOpen ? <WidgetLibrary /> : null}
      <AwayTracker />
    </>
  );
}
