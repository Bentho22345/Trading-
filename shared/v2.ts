// PULSE 2.0 types shared by the worker and the browser. Dependency-free.
import type { EconEvent, NewsCluster } from './types';

// ------------------------------------------------------------------ intel blocks
/** How fresh a data point can ever be. Shown as a chip next to every intel panel. */
export type Cadence = 'live' | 'delayed' | 'daily' | 'weekly' | 'estimate';

export type IntelKey =
  | 'auctions' | 'realYields' | 'ratePaths' | 'speakers' | 'cot' | 'cryptoFlows' | 'equityFlows' | 'filings' | 'statements'
  | 'prediction' | 'social' | 'themes' | 'correlation' | 'regime' | 'surprise' | 'structure' | 'reactions';

export interface IntelBlock<T = unknown> {
  key: IntelKey;
  data: T;
  source: string;
  ts: number;
  /** For daily/weekly data: the date the numbers refer to ("as of Tuesday") */
  asOf?: string;
  cadence: Cadence;
  delayedMin?: number;
  mock?: boolean;
  /** false = no provider connected: show the designed "connect a provider" state */
  connected: boolean;
  note?: string;
}

// ------------------------------------------------------------------ briefs
export type BriefKind = 'morning' | 'handoff' | 'eod' | 'weekly';
export type BriefTone = 'terse' | 'analyst' | 'eli5';
export type BriefLength = 50 | 150 | 300;
export type BriefSectionType =
  | 'take' | 'scoreboard' | 'stories' | 'calendar' | 'book' | 'levels' | 'ratePath' | 'sentiment' | 'weekAhead'
  | 'scorecard' | 'smartFeed' | 'movers' | 'journal' | 'themes' | 'nextUp' | 'risks' | 'structure' | 'activity';

export interface BriefSectionConfig {
  id: string;
  type: BriefSectionType;
  enabled: boolean;
  size: 'full' | 'half' | 'third';
  options: {
    topN?: number;
    myAssetsOnly?: boolean;
    includeCrypto?: boolean;
    smartFeedId?: string;
    minImportance?: 1 | 2 | 3;
    title?: string;
  };
}

export interface BriefSchedule {
  enabled: boolean;
  tz: string;
  /** HH:MM per weekday (0 = Sunday), null = no brief that day */
  times: (string | null)[];
}

export interface BriefProfile {
  id: string;
  name: string;
  kind: BriefKind;
  sections: BriefSectionConfig[];
  tone: BriefTone;
  length: BriefLength;
  schedule: BriefSchedule;
  /** integration ids (email, slack…) the brief is delivered to */
  destinations: string[];
  /** asset classes the user cares about in this profile (fx, crypto, equities, rates, commodities) */
  assetClasses: string[];
  autoOpen: boolean;
  order: number;
  /** session handoff profiles only */
  handoff?: { from: string; to: string };
}

export interface ScoreRow {
  symbol: string;
  name: string;
  group: string;
  last: number;
  from: number;
  change: number;
  changePct: number;
  bp?: boolean;
  decimals: number;
  spark: number[];
  source: string;
  delayedMin: number;
  mock?: boolean;
}

export interface BriefStory {
  id: string;
  headline: string;
  tldr: string;
  why: string;
  impact: number;
  relevance: number;
  score: number;
  inBook: boolean;
  domains: string[];
  sources: { source: string; url: string }[];
  publishedAt: number;
}

export interface LevelHit {
  symbol: string;
  level: number;
  kind: 'user' | 'pdh' | 'pdl' | 'pdc' | 'onh' | 'onl' | 'round' | 'expiry';
  label: string;
  price: number | null;
  distancePct: number | null;
  status: 'broken' | 'approached' | 'watch';
  decimals: number;
}

export interface RateMeeting {
  date: string;
  hike: number;
  hold: number;
  cut: number;
  /** change in the leading probability vs yesterday, percentage points */
  delta: number;
  impliedBps?: number;
}
export interface RatePath {
  bank: string;
  name: string;
  currency: string;
  rate: number;
  meetings: RateMeeting[];
}

export interface BriefSection {
  id: string;
  type: BriefSectionType;
  title: string;
  size: BriefSectionConfig['size'];
  data: unknown;
  /** Set when the section has nothing to show (rendered as a designed empty state) */
  empty?: string;
  sources?: string[];
}

export interface Brief {
  id: string;
  profileId: string;
  profileName: string;
  kind: BriefKind;
  /** YYYY-MM-DD in the profile's time zone */
  date: string;
  createdAt: number;
  headline: string;
  take: { text: string; ai: boolean; model?: string };
  sections: BriefSection[];
  /** "calls" made by the brief (used by tomorrow's scorecard) */
  calls: BriefCall[];
  hash: string;
  tz: string;
  label?: string;
}

export interface BriefCall {
  id: string;
  text: string;
  symbol: string;
  direction: 'up' | 'down';
  from: number;
  ts: number;
}

export interface BriefMeta {
  id: string;
  profileId: string;
  kind: BriefKind;
  date: string;
  createdAt: number;
  headline: string;
  label?: string;
}

// ------------------------------------------------------------------ workspaces
export type WidgetType =
  | 'news' | 'sessions' | 'calendar' | 'banks' | 'strength' | 'heatmap' | 'crypto' | 'vol' | 'watchlist' | 'alerts'
  | 'rates' | 'portfolio' | 'reactions' | 'themes' | 'ratePaths' | 'crossAsset' | 'correlation' | 'regime' | 'positioning'
  | 'filings' | 'social' | 'prediction' | 'playbooks' | 'journal' | 'nextEvent' | 'structure' | 'chart' | 'briefCard' | 'alertHistory';

export interface WidgetInstance {
  id: string;
  type: WidgetType;
  title?: string;
  config: { feed?: string; smartFeedId?: string; symbol?: string; [k: string]: unknown };
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Workspace {
  id: string;
  name: string;
  icon?: string;
  widgets: WidgetInstance[];
  /** Automatic switching: at HH:MM on these weekdays, or on days with major earnings */
  schedule?: { at?: string; days?: number[]; earningsDay?: boolean };
  order: number;
}

// ------------------------------------------------------------------ playbooks
export type CondOp = '>' | '<' | '>=' | '<=' | 'between';
export interface PlaybookScenario {
  id: string;
  label: string;
  /** surprise = actual − consensus (in the release's own unit) */
  condition: { metric: 'surprise' | 'actual'; op: CondOp; value: number; value2?: number };
  expect: { symbol: string; direction: 'up' | 'down'; level?: number; note?: string }[];
  notes: string;
}

export interface Playbook {
  id: string;
  name: string;
  /** case-insensitive keywords matched against the calendar event title, e.g. "CPI m/m" */
  eventMatch: string;
  currency?: string;
  scenarios: PlaybookScenario[];
  notes: string;
  enabled: boolean;
  template?: boolean;
  createdAt: number;
}

export interface OutcomeCheck {
  symbol: string;
  direction: 'up' | 'down';
  base: number | null;
  moves: { m5?: number; m30?: number; h2?: number };
  hits: { m5?: boolean; m30?: boolean; h2?: boolean };
}

export interface PlaybookOutcome {
  id: string;
  playbookId: string;
  playbookName: string;
  eventId: string;
  eventTitle: string;
  scenarioId: string | null;
  scenarioLabel: string | null;
  firedAt: number;
  actual: number | null;
  consensus: number | null;
  surprise: number | null;
  checks: OutcomeCheck[];
  status: 'pending' | 'done';
}

// ------------------------------------------------------------------ smart feeds
export interface SmartFeed {
  id: string;
  name: string;
  color: string;
  icon: string;
  query: string;
  alert: boolean;
  order: number;
  createdAt: number;
}

// ------------------------------------------------------------------ portfolio, journal, levels
export interface Position {
  id: string;
  symbol: string;
  qty: number;
  avgPrice: number;
  assetClass?: string;
  sector?: string;
  currency?: string;
  source: 'manual' | 'csv' | 'alpaca' | 'sheet';
  note?: string;
}

export interface Exposure {
  totalValue: number;
  pnlDay: number;
  pnlOvernight: number;
  pnlTotal: number;
  byCurrency: { key: string; value: number }[];
  byClass: { key: string; value: number }[];
  bySector: { key: string; value: number }[];
  rows: { id: string; symbol: string; qty: number; price: number | null; value: number; pnlDay: number; pnlTotal: number; priced: boolean; mock?: boolean }[];
  stress: { id: string; label: string; pnl: number; note: string }[];
  ts: number;
}

export interface NoteLink {
  kind: 'story' | 'ticker' | 'event' | 'chart' | 'brief';
  ref: string;
  label?: string;
  ts?: number;
  price?: number;
}

export interface JournalEntry {
  id: string;
  /** YYYY-MM-DD; one "daily journal" per day plus any number of notes */
  date: string;
  kind: 'daily' | 'note';
  title: string;
  body: string;
  tags: string[];
  links: NoteLink[];
  createdAt: number;
  updatedAt: number;
}

export interface Level {
  id: string;
  symbol: string;
  price: number;
  label: string;
  color?: string;
  /** create a price-cross alert for this level */
  alert: boolean;
  createdAt: number;
}

// ------------------------------------------------------------------ alerts 2.0
export type Severity = 'low' | 'normal' | 'high' | 'critical';
export type DestinationType = 'toast' | 'push' | 'email' | 'slack' | 'telegram' | 'discord' | 'sms' | 'webhook' | 'notion';

export interface AlertRoute {
  /** alert rule id, smart feed id (`feed:<id>`), playbook (`playbook`) or `default` */
  id: string;
  severity: Severity;
  destinations: DestinationType[];
  /** bundle into a digest every N minutes instead of sending immediately (low priority) */
  digestMin: number;
  escalate?: { afterSec: number; to: DestinationType };
  squawk?: boolean;
}

export interface AlertHistoryItem {
  id: string;
  ruleId: string;
  ts: number;
  message: string;
  severity: Severity;
  status: 'new' | 'acked' | 'snoozed' | 'escalated';
  ackedAt?: number | null;
  snoozedUntil?: number | null;
  routes: string[];
}

// ------------------------------------------------------------------ scoring
export interface ScoreWeights {
  base: number;
  credibility: number;
  severity: number;
  perSource: number;
  maxCorroboration: number;
  watchlist: number;
  exposure: number;
  centralBank: number;
}
export const DEFAULT_WEIGHTS: ScoreWeights = { base: 10, credibility: 25, severity: 1, perSource: 6, maxCorroboration: 18, watchlist: 12, exposure: 15, centralBank: 4 };

export interface KeywordEntry {
  term: string;
  weight: number;
  tag?: string;
}

export interface SourceOverride {
  id: string;
  name: string;
  url?: string;
  custom: boolean;
  credibility?: number;
  muted?: boolean;
  domain?: string;
  addedAt: number;
}

export interface SourceHealth {
  id: string;
  name: string;
  url?: string;
  ok: boolean;
  lastOk: number | null;
  lastError: string | null;
  latencyMs: number | null;
  itemsPerHour: number;
  custom: boolean;
  muted: boolean;
  credibility: number;
}

// ------------------------------------------------------------------ intel payloads
export interface Auction { id: string; date: string; security: string; term: string; offering: number | null; highYield: number | null; bidToCover: number | null; tail: number | null; indirect: number | null; status: 'upcoming' | 'result' }
export interface CotRow { market: string; symbol: string; net: number; change: number; pct3y: number; longs: number; shorts: number }
export interface Filing { id: string; form: string; company: string; ticker?: string; title: string; url: string; ts: number; oneLiner?: string; watch: boolean }
export interface StatementDiff { id: string; bank: string; title: string; url: string; date: string; added: string[]; removed: string[]; kept: number }
export interface PredictionMarket { id: string; venue: 'Polymarket' | 'Kalshi'; question: string; yes: number; change24h: number | null; volume24h: number | null; url: string; endDate?: string }
export interface SocialRow { symbol: string; mentions1h: number; baseline: number; ratio: number; spike: boolean; spark: number[] }
export interface ThemeItem {
  id: string;
  label: string;
  keywords: string[];
  assets: string[];
  volume: number;
  momentum: number;
  sentiment: number;
  clusters: string[];
  firstSeen: number;
  lastSeen: number;
  timeline: number[];
  quotes: { text: string; source: string; url: string; ts: number }[];
  ai?: boolean;
}
export interface CorrelationMatrix { window: '1d' | '1w' | '1m'; symbols: string[]; values: number[][]; breaks: { a: string; b: string; now: number; prior: number }[] }
export interface RegimeState { score: number; label: 'risk-on' | 'neutral' | 'risk-off'; components: { name: string; value: number; contribution: number }[]; history: { t: number; score: number }[] }
export interface SurpriseIndex { region: string; value: number; series: { t: number; v: number }[] }
export interface StructureEvent { id: string; date: string; ts: number; kind: 'holiday' | 'halfday' | 'opex' | 'quad' | 'rebalance' | 'roll' | 'monthend' | 'quarterend' | 'dst'; venue: string; label: string }
export interface ReactionRow { id: string; time: number; actual: number | null; consensus: number | null; surprise: number | null; moves: Record<string, { m5?: number; m30?: number; d1?: number }> }
export interface ReactionSeries { series: string; currency: string; rows: ReactionRow[]; demo: boolean }
export interface Speaker { name: string; bank: string; lean: number; role: string; next?: { title: string; time: number } }

// ------------------------------------------------------------------ messages
export interface HandoffCard {
  id: string;
  kind: 'handoff';
  from: string;
  to: string;
  ts: number;
  moved: { symbol: string; changePct: number; bp?: boolean; change: number }[];
  next: Pick<EconEvent, 'id' | 'title' | 'time' | 'currency' | 'importance'>[];
  risks: string[];
  briefId?: string;
}

export interface Copilot {
  role: 'user' | 'assistant';
  text: string;
  citations?: { id: string; label: string; url?: string; ts?: number; kind: string }[];
}

export type V2Msg =
  | { t: 'intel'; d: IntelBlock }
  | { t: 'doc'; c: string; op: 'put' | 'del'; d: { id: string } & Record<string, unknown> }
  | { t: 'brief'; d: BriefMeta; open?: boolean }
  | { t: 'handoff'; d: HandoffCard }
  | { t: 'playbook'; d: PlaybookOutcome }
  | { t: 'alert2'; d: AlertHistoryItem & { squawk?: boolean; push?: boolean } }
  | { t: 'exposure'; d: Exposure };

export type ClusterLike = Pick<NewsCluster, 'headline' | 'summary' | 'domains' | 'currencies' | 'tickers' | 'tags' | 'source' | 'impact' | 'sentiment' | 'breaking' | 'articles'>;
