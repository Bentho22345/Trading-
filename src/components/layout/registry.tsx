'use client';
import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import type { NewsCluster } from '@shared/types';
import type { WidgetInstance, WidgetType } from '@shared/v2';
import { LocalFeedFilter } from '@/lib/feedFilter';
import type { FeedFilter } from '@/lib/store';
import { NewsFeed } from '../NewsFeed';
import { SessionsPanel } from '../panels/Sessions';
import { CalendarPanel } from '../panels/Calendar';
import { BanksPanel } from '../panels/Banks';
import { StrengthPanel, HeatmapPanel } from '../panels/Fx';
import { CryptoPanel } from '../panels/Crypto';
import { VolPanel } from '../panels/Vol';
import { WatchlistPanel, AlertsPanel } from '../panels/Watch';
import { NextEventCard } from '../NextEvent';

export interface WidgetProps {
  config: WidgetInstance['config'];
  instanceId: string;
  primary?: boolean;
  initialClusters?: NewsCluster[];
}

const skeleton = () => <div className="glass h-full rounded-xl p-3"><div className="skeleton mb-3 h-3 w-32" /><div className="skeleton h-32 w-full" /></div>;
const lazy = (load: () => Promise<{ default: ComponentType<WidgetProps> } | ComponentType<WidgetProps>>) =>
  dynamic(async () => {
    const m = await load();
    return 'default' in m ? m.default : m;
  }, { ssr: false, loading: skeleton });

function NewsWidget({ config, primary, initialClusters }: WidgetProps) {
  if (primary && !config.feed && !config.smartFeedId) return <NewsFeed initial={initialClusters} />;
  return (
    <LocalFeedFilter initial={{ filter: (config.feed as FeedFilter) ?? 'all', smartFeedId: (config.smartFeedId as string) ?? null }}>
      <NewsFeed initial={initialClusters} compact />
    </LocalFeedFilter>
  );
}

const plain = (C: ComponentType) => function Plain() { return <C />; };

export const WIDGET_COMPONENTS: Record<WidgetType, ComponentType<WidgetProps>> = {
  news: NewsWidget,
  sessions: plain(SessionsPanel), calendar: plain(CalendarPanel), banks: plain(BanksPanel), strength: plain(StrengthPanel), heatmap: plain(HeatmapPanel),
  crypto: plain(CryptoPanel), vol: plain(VolPanel), watchlist: plain(WatchlistPanel), alerts: plain(AlertsPanel),
  nextEvent: function NextEventWidget() { return <div className="glass h-full rounded-xl p-2"><NextEventCard compact /></div>; },
  rates: lazy(() => import('../intel/Rates').then((m) => m.RatesPanel)),
  ratePaths: lazy(() => import('../intel/RatePaths').then((m) => m.RatePathsPanel)),
  crossAsset: lazy(() => import('../intel/CrossAsset').then((m) => m.CrossAssetPanel)),
  correlation: lazy(() => import('../intel/CrossAsset').then((m) => m.CorrelationPanel)),
  regime: lazy(() => import('../intel/CrossAsset').then((m) => m.RegimePanel)),
  positioning: lazy(() => import('../intel/Positioning').then((m) => m.PositioningPanel)),
  filings: lazy(() => import('../intel/Filings').then((m) => m.FilingsPanel)),
  social: lazy(() => import('../intel/Social').then((m) => m.SocialPanel)),
  prediction: lazy(() => import('../intel/Social').then((m) => m.PredictionPanel)),
  themes: lazy(() => import('../intel/Themes').then((m) => m.ThemesPanel)),
  reactions: lazy(() => import('../intel/Reactions').then((m) => m.ReactionsPanel)),
  structure: lazy(() => import('../intel/Structure').then((m) => m.StructurePanel)),
  portfolio: lazy(() => import('../personal/Portfolio').then((m) => m.PortfolioPanel)),
  playbooks: lazy(() => import('../personal/Playbooks').then((m) => m.PlaybooksPanel)),
  journal: lazy(() => import('../personal/Journal').then((m) => m.JournalPanel)),
  chart: lazy(() => import('../personal/ChartWidget').then((m) => m.ChartWidget)),
  briefCard: lazy(() => import('../personal/BriefCard').then((m) => m.BriefCard)),
  alertHistory: lazy(() => import('../personal/AlertHistory').then((m) => m.AlertHistoryPanel)),
};
