// Types shared by the worker and the browser. Keep this file dependency-free.
import type { IntelBlock, V2Msg, Exposure, HandoffCard } from './v2';

export type AssetClass = 'fx' | 'crypto' | 'equity' | 'etf' | 'vol' | 'index' | 'commodity' | 'rate';
export type TickerGroup = 'EQ' | 'FX' | 'CRYPTO' | 'MACRO';
export type Domain = 'fx' | 'crypto' | 'equities' | 'options' | 'macro' | 'centralbanks' | 'regulation' | 'rates' | 'commodities';

export interface SymbolMeta {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  decimals: number;
  group?: TickerGroup;
  /** Shown in the FX ticker/heatmap */
  major?: boolean;
  /** Yield instrument: changes are shown in basis points */
  bp?: boolean;
}

export interface Quote {
  symbol: string;
  price: number;
  /** Reference price the change is computed against (prev close for equities, 24h ago for crypto/FX). */
  ref: number;
  change: number;
  changePct: number;
  bid?: number;
  ask?: number;
  volume?: number;
  /** Exchange/provider timestamp (ms) */
  ts: number;
  /** When our worker received it (ms) */
  receivedAt: number;
  source: string;
  /** 0 = real-time. Anything else is displayed as a "Nm delayed" chip. */
  delayedMin: number;
  mock?: boolean;
}

export type StreamId =
  | 'crypto'
  | 'fx'
  | 'equities'
  | 'news'
  | 'calendar'
  | 'banks'
  | 'cryptoMarket'
  | 'vol'
  | 'options'
  | 'earnings'
  | 'macro';

export type StreamState = 'live' | 'stale' | 'down' | 'connecting';

export interface StreamStatus {
  id: StreamId;
  label: string;
  provider: string;
  mock: boolean;
  state: StreamState;
  lastUpdate: number | null;
  /** Upstream latency estimate (receivedAt - provider ts) when available */
  latencyMs: number | null;
  delayedMin: number;
  staleAfterMs: number;
  message?: string;
}

export interface ArticleRef {
  id: string;
  headline: string;
  source: string;
  url: string;
  publishedAt: number;
  receivedAt: number;
}

export interface Article extends ArticleRef {
  summary: string;
  sourceId: string;
  domains: Domain[];
  tickers: string[];
  currencies: string[];
  tags: string[];
  sentiment: number;
  impactScore: number;
  clusterId: string;
  demo?: boolean;
}

export interface NewsCluster {
  id: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: number;
  receivedAt: number;
  updatedAt: number;
  domains: Domain[];
  tickers: string[];
  currencies: string[];
  tags: string[];
  sentiment: number;
  impact: number;
  breaking: boolean;
  demo?: boolean;
  /** All articles (lead first) */
  articles: ArticleRef[];
  tldr?: string;
  why?: string;
  aiModel?: string;
  watchHit?: boolean;
}

export interface EconEvent {
  id: string;
  country: string; // ISO2
  currency: string;
  title: string;
  time: number;
  importance: 1 | 2 | 3;
  unit: string;
  consensus: number | null;
  previous: number | null;
  actual: number | null;
  /** Some releases are "better" when lower (e.g. unemployment, jobless claims) */
  lowerIsBetter?: boolean;
  source: string;
  mock?: boolean;
}

export interface CentralBank {
  id: string;
  name: string;
  short: string;
  currency: string;
  country: string;
  rate: number;
  rateLabel: string;
  nextMeeting: number | null;
  lastChange?: { date: string; bps: number };
  latest?: { title: string; url: string; ts: number; source: string };
  asOf: string;
  source: string;
}

export interface FundingRate {
  symbol: string;
  rate: number; // fraction per interval, e.g. 0.0001 = 0.01%
  nextFundingTime: number | null;
  venue: string;
}

export interface Liquidation {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  usd: number;
  ts: number;
  text: string;
}

export interface CryptoMarket {
  btcDominance: number | null;
  totalMcapUsd: number | null;
  mcapChange24h: number | null;
  fearGreed: { value: number; label: string; source: string; ts: number } | null;
  funding: FundingRate[];
  liquidations: Liquidation[];
  sources: string[];
  ts: number;
  mock?: boolean;
}

export interface TermPoint {
  label: string;
  expiry: number;
  value: number;
}

export interface EarningsItem {
  symbol: string;
  name: string;
  date: number;
  session: 'bmo' | 'amc' | 'dmh';
  epsEst: number | null;
  impliedMovePct: number | null;
}

export interface UnusualOption {
  id: string;
  symbol: string;
  type: 'call' | 'put';
  strike: number;
  expiry: string;
  premiumUsd: number;
  volOi: number;
  side: 'ask' | 'bid' | 'mid';
  ts: number;
}

export interface VolData {
  termStructure: TermPoint[];
  structure: 'contango' | 'backwardation' | 'flat' | null;
  termSource: string;
  termDelayedMin: number;
  putCall: { equity: number; index: number; total: number; ts: number; source: string } | null;
  putCallConnected: boolean;
  earnings: EarningsItem[];
  earningsSource: string;
  unusual: UnusualOption[];
  unusualConnected: boolean;
  unusualSource: string;
  ts: number;
}

export type Timeframe = '1h' | '4h' | '1d';

export interface Analytics {
  strength: Record<Timeframe, { ccy: string; score: number }[]>;
  /** -1..1: share of advancing minus declining across the tracked universe */
  breadth: number;
  ts: number;
}

export type WatchKind = 'ticker' | 'pair' | 'coin' | 'keyword';
export interface WatchItem {
  id: string;
  kind: WatchKind;
  value: string;
}

export type AlertKind = 'price_cross' | 'pct_move' | 'keyword';
export interface AlertRule {
  id: string;
  kind: AlertKind;
  symbol?: string;
  level?: number;
  direction?: 'above' | 'below' | 'cross';
  pct?: number;
  windowMin?: number;
  keyword?: string;
  enabled: boolean;
  once: boolean;
  createdAt: number;
  lastFiredAt?: number | null;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  message: string;
  ts: number;
  symbol?: string;
  clusterId?: string;
}

export interface Snapshot {
  serverTime: number;
  symbols: SymbolMeta[];
  quotes: Quote[];
  sparks: Record<string, number[]>;
  statuses: StreamStatus[];
  clusters: NewsCluster[];
  calendar: EconEvent[];
  banks: CentralBank[];
  crypto: CryptoMarket | null;
  vol: VolData | null;
  analytics: Analytics | null;
  watchlist: WatchItem[];
  alerts: AlertRule[];
  readIds: string[];
  savedIds: string[];
  aiEnabled: boolean;
  breakingThreshold: number;
  intel: IntelBlock[];
  exposure: Exposure | null;
  handoffs: HandoffCard[];
  replayAvailable: boolean;
}

export type ServerMsg =
  | { t: 'snapshot'; d: Snapshot }
  | { t: 'q'; d: Quote[] }
  | { t: 'status'; d: StreamStatus[] }
  | { t: 'cluster'; d: NewsCluster; breakingNow?: boolean }
  | { t: 'calendar'; d: EconEvent[] }
  | { t: 'banks'; d: CentralBank[] }
  | { t: 'crypto'; d: CryptoMarket }
  | { t: 'vol'; d: VolData }
  | { t: 'analytics'; d: Analytics }
  | { t: 'watchlist'; d: WatchItem[] }
  | { t: 'alerts'; d: AlertRule[] }
  | { t: 'alert'; d: AlertEvent }
  | { t: 'pong'; id: number; serverTime: number }
  | V2Msg;

export type ClientMsg = { t: 'ping'; id: number } | { t: 'vis'; hidden: boolean } | { t: 'resnap' };

export interface HistoryPoint {
  t: number; // ms, minute start
  c: number;
}

export interface ClusterDetail {
  cluster: NewsCluster;
  symbol: string | null;
  series: HistoryPoint[];
}

export interface Digest {
  since: number;
  clusters: NewsCluster[];
  movers: { symbol: string; from: number; to: number; pct: number }[];
}
