import type { CentralBank, CryptoMarket, EconEvent, NewsCluster, Quote, SymbolMeta, VolData, WatchItem, HistoryPoint } from '../../shared/types';
import type { Brief, IntelBlock, IntelKey, Level, Position, PlaybookOutcome, SmartFeed, StructureEvent } from '../../shared/v2';

/**
 * Everything a brief section builder may read. Builders are pure functions of this context,
 * so they can be unit-tested with a fake context and replayed against archived data.
 */
export interface BriefContext {
  now: number;
  tz: string;
  /** the user's overnight reference: last 17:00 NY (FX/crypto) and last US cash close (equities) */
  fxClose: number;
  usClose: number;
  symbols: Record<string, SymbolMeta>;
  quote: (symbol: string) => Quote | undefined;
  /** stored daily close (from the worker's 17:00 NY snapshot) or null */
  storedClose: (symbol: string, at: number) => number | null;
  priceAt: (symbol: string, ts: number) => number | null;
  history: (symbol: string, since: number, points: number) => HistoryPoint[];
  clusters: NewsCluster[];
  calendar: EconEvent[];
  banks: CentralBank[];
  crypto: CryptoMarket | null;
  vol: VolData | null;
  watchlist: WatchItem[];
  positions: Position[];
  levels: Level[];
  intel: (key: IntelKey) => IntelBlock | undefined;
  smartFeeds: SmartFeed[];
  matchFeed: (feed: SmartFeed, c: NewsCluster) => boolean;
  outcomes: PlaybookOutcome[];
  prevBrief: Brief | null;
  avgSurprise: (title: string, currency: string) => { avg: number; n: number } | null;
  structure: StructureEvent[];
  alertsFired: { ts: number; message: string }[];
  meetings: { title: string; start: number; end: number }[];
  /** article counts per hour for the activity heatmap (weekly review) */
  activity: { t: number; n: number }[];
}
