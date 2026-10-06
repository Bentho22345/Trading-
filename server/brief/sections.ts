import type { EconEvent, NewsCluster } from '../../shared/types';
import type {
  BriefCall, BriefSection, BriefSectionConfig, BriefStory, LevelHit, RatePath, ScoreRow, ThemeItem, SocialRow, Auction,
} from '../../shared/v2';
import { zonedParts } from '../../shared/sessions';
import type { BriefContext } from './context';

const DAY = 86400_000;
const US_CASH = new Set(['equity', 'etf']);
const US_INDEX = new Set(['SPX', 'NDX', 'DJI']);

// ------------------------------------------------------------------ helpers
/** Overnight reference timestamp for a symbol: US cash close for US equities, 17:00 NY otherwise. */
export function refTs(ctx: BriefContext, symbol: string): number {
  const ac = ctx.symbols[symbol]?.assetClass;
  return ac && (US_CASH.has(ac) || US_INDEX.has(symbol)) ? ctx.usClose : ctx.fxClose;
}

export function refPrice(ctx: BriefContext, symbol: string, at = refTs(ctx, symbol)): number | null {
  const stored = ctx.storedClose(symbol, at);
  if (stored) return stored;
  const hist = ctx.priceAt(symbol, at);
  if (hist) return hist;
  const q = ctx.quote(symbol);
  const ac = ctx.symbols[symbol]?.assetClass;
  // equities' quote ref is the previous close — a valid overnight reference
  return q && ac && (US_CASH.has(ac) || ac === 'index' || ac === 'commodity' || ac === 'rate') ? q.ref : null;
}

export function scoreRow(ctx: BriefContext, symbol: string, group: string, since?: number): ScoreRow | null {
  const q = ctx.quote(symbol);
  const meta = ctx.symbols[symbol];
  if (!q || !meta) return null;
  const at = since ?? refTs(ctx, symbol);
  const from = refPrice(ctx, symbol, at) ?? q.ref;
  const hist = ctx.history(symbol, Math.max(at, ctx.now - 26 * 3600_000), 32).map((p) => p.c);
  const spark = hist.length >= 2 ? [...hist, q.price] : [from, q.price];
  return {
    symbol, name: meta.name, group, last: q.price, from, change: q.price - from, changePct: from ? ((q.price - from) / from) * 100 : 0,
    bp: meta.bp, decimals: meta.decimals, spark, source: q.source, delayedMin: q.delayedMin, mock: q.mock,
  };
}

const positionSymbols = (ctx: BriefContext) => new Set(ctx.positions.map((p) => p.symbol.toUpperCase()));

export function touchesBook(ctx: BriefContext, c: Pick<NewsCluster, 'tickers' | 'currencies'>): boolean {
  if (!ctx.positions.length) return false;
  const held = positionSymbols(ctx);
  if (c.tickers.some((t) => held.has(t))) return true;
  for (const p of held) {
    if (p.length === 6 && ctx.symbols[p]?.assetClass === 'fx' && (c.currencies.includes(p) || (c.currencies.includes(p.slice(0, 3)) && c.currencies.includes(p.slice(3))))) return true;
  }
  // correlated proxies: gold miners → GOLD, crypto equities → BTC
  if (held.has('BTC') && c.tickers.some((t) => ['COIN', 'MSTR'].includes(t))) return true;
  if ((held.has('GOLD') || held.has('XAUUSD')) && c.currencies.includes('XAU')) return true;
  return false;
}

export function relevance(ctx: BriefContext, c: NewsCluster, assetClasses: string[]): number {
  let r = 1;
  if (c.watchHit) r += 0.5;
  if (touchesBook(ctx, c)) r += 0.8;
  if (assetClasses.length && c.domains.some((d) => assetClasses.includes(d))) r += 0.3;
  return r;
}

function firstSentence(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{12,}?[.!?])(\s|$)/);
  const out = m ? m[1] : t;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

const DOMAIN_WHY: Record<string, string> = {
  centralbanks: 'Policy expectations move rates, the dollar and every risk asset.',
  fx: 'Shifts relative rate expectations and cross-currency flows.',
  crypto: 'Crypto risk appetite; watch spot, funding and ETF flows.',
  equities: 'Single-name and sector risk; watch the index heavyweights.',
  options: 'Positioning and hedging flows can amplify spot moves.',
  rates: 'Moves the discount rate for every asset; watch the 2s10s curve.',
  commodities: 'Feeds inflation expectations and commodity-currency moves.',
  regulation: 'Regulatory risk can reprice a whole sector quickly.',
  macro: 'Feeds growth and inflation expectations.',
};

export function templateWhy(c: Pick<NewsCluster, 'domains' | 'tickers' | 'currencies'>): string {
  const d = c.domains.find((x) => DOMAIN_WHY[x]) ?? 'macro';
  const assets = [...c.tickers.slice(0, 3), ...c.currencies.filter((x) => x.length === 6).slice(0, 2)];
  return assets.length ? `${DOMAIN_WHY[d]} In focus: ${assets.join(', ')}.` : DOMAIN_WHY[d];
}

const localDateOf = (ts: number, tz: string) => {
  const z = zonedParts(ts, tz);
  return `${z.y}-${String(z.m).padStart(2, '0')}-${String(z.d).padStart(2, '0')}`;
};

function surprise(e: EconEvent): number | null {
  return e.actual !== null && e.consensus !== null ? e.actual - e.consensus : null;
}

// ------------------------------------------------------------------ sections
export const SCOREBOARD_GROUPS: { group: string; symbols: string[]; crypto?: boolean }[] = [
  { group: 'Indices', symbols: ['NKY', 'HSI', 'DAX', 'UKX', 'SPX', 'NDX'] },
  { group: 'FX', symbols: ['DXY', 'EURUSD', 'USDJPY', 'GBPUSD', 'AUDUSD'] },
  { group: 'Crypto', symbols: ['BTC', 'ETH'], crypto: true },
  { group: 'Commodities', symbols: ['GOLD', 'WTI', 'BRENT'] },
  { group: 'Rates', symbols: ['US2Y', 'US10Y', 'DE10Y'] },
];

export function buildScoreboard(ctx: BriefContext, cfg: BriefSectionConfig, since?: number): Pick<BriefSection, 'data' | 'empty' | 'sources'> {
  const rows: ScoreRow[] = [];
  for (const g of SCOREBOARD_GROUPS) {
    if (g.crypto && cfg.options.includeCrypto === false) continue;
    for (const s of g.symbols) {
      const r = scoreRow(ctx, s === 'GOLD' && !ctx.quote('GOLD') ? 'XAUUSD' : s, g.group, since);
      if (r) rows.push(r);
    }
  }
  return rows.length
    ? { data: { rows, since: since ?? ctx.fxClose }, sources: [...new Set(rows.map((r) => r.source))] }
    : { data: { rows: [] }, empty: 'Waiting for market data — quotes appear as soon as the streams connect.' };
}

export function rankStories(ctx: BriefContext, since: number, assetClasses: string[], myAssetsOnly = false): BriefStory[] {
  const pool = ctx.clusters.filter((c) => c.receivedAt >= since || c.updatedAt >= since);
  const scored = pool.map((c) => {
    const rel = relevance(ctx, c, assetClasses);
    return { c, rel, score: c.impact * rel, inBook: touchesBook(ctx, c) };
  }).filter((x) => !myAssetsOnly || x.inBook || x.c.watchHit || x.c.domains.some((d) => assetClasses.includes(d)));
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ c, rel, score, inBook }) => ({
    id: c.id,
    headline: c.headline,
    tldr: c.tldr ?? firstSentence(c.summary || c.headline),
    why: c.why ?? templateWhy(c),
    impact: c.impact,
    relevance: +rel.toFixed(2),
    score: Math.round(score),
    inBook,
    domains: c.domains,
    sources: c.articles.slice(0, 4).map((a) => ({ source: a.source, url: a.url })),
    publishedAt: c.publishedAt,
  }));
}

export function buildStories(ctx: BriefContext, cfg: BriefSectionConfig, assetClasses: string[], since = Math.min(ctx.fxClose, ctx.now - 14 * 3600_000)) {
  const topN = Math.max(1, Math.min(15, cfg.options.topN ?? 5));
  const stories = rankStories(ctx, since, assetClasses, cfg.options.myAssetsOnly).slice(0, topN);
  return stories.length
    ? { data: { stories }, sources: [...new Set(stories.flatMap((s) => s.sources.map((x) => x.source)))] }
    : { data: { stories: [] }, empty: 'No stories yet in this window. Live news fills in as sources report.' };
}

export function buildCalendar(ctx: BriefContext, cfg: BriefSectionConfig, dayOffset = 0) {
  const target = localDateOf(ctx.now + dayOffset * DAY, ctx.tz);
  const minImp = cfg.options.minImportance ?? 2;
  const events = ctx.calendar
    .filter((e) => localDateOf(e.time, ctx.tz) === target && e.importance >= minImp)
    .map((e) => ({ ...e, avgSurprise: ctx.avgSurprise(e.title, e.currency), surprise: surprise(e), meeting: ctx.meetings.find((m) => e.time >= m.start && e.time < m.end)?.title ?? null }));
  const speakers = ctx.calendar.filter((e) => localDateOf(e.time, ctx.tz) === target && /speak|testif|remarks|speech|press conference/i.test(e.title));
  const auctions = ((ctx.intel('auctions')?.data as Auction[] | undefined) ?? []).filter((a) => a.date === target);
  const earn = (ctx.vol?.earnings ?? []).filter((e) => localDateOf(e.date, 'America/New_York') === localDateOf(ctx.now + dayOffset * DAY, 'America/New_York'));
  const structure = ctx.structure.filter((s) => s.date === target);
  const any = events.length + speakers.length + auctions.length + earn.length + structure.length;
  return {
    data: { date: target, events, speakers, auctions, bmo: earn.filter((e) => e.session === 'bmo'), amc: earn.filter((e) => e.session !== 'bmo'), structure },
    empty: any ? undefined : 'A quiet calendar: no high-importance releases, speakers, auctions or major earnings today.',
    sources: ['Economic calendar', ...(earn.length ? ['Earnings calendar'] : [])],
  };
}

export function buildBook(ctx: BriefContext) {
  if (!ctx.positions.length) return { data: { rows: [], news: [], levels: [] }, empty: 'No positions imported. Add them in Portfolio (CSV, manual or a read-only broker connection) to see overnight P&L.' };
  const rows = ctx.positions.map((p) => {
    const q = ctx.quote(p.symbol);
    const from = refPrice(ctx, p.symbol);
    const price = q?.price ?? null;
    const pnl = price !== null && from ? (price - from) * p.qty : null;
    return { symbol: p.symbol, qty: p.qty, price, from, pnl, pct: price !== null && from ? ((price - from) / from) * 100 : null, mock: q?.mock };
  });
  const total = rows.reduce((s, r) => s + (r.pnl ?? 0), 0);
  const news = ctx.clusters.filter((c) => c.receivedAt >= ctx.fxClose && touchesBook(ctx, c)).sort((a, b) => b.impact - a.impact).slice(0, 5)
    .map((c) => ({ id: c.id, headline: c.headline, url: c.url, source: c.source, impact: c.impact }));
  const held = positionSymbols(ctx);
  const levels = computeLevels(ctx).filter((l) => held.has(l.symbol) && l.status !== 'watch');
  return { data: { rows, total, news, levels }, sources: [...new Set(rows.map((r) => ctx.quote(r.symbol)?.source).filter(Boolean) as string[])] };
}

function roundStep(p: number): number {
  const mag = 10 ** Math.floor(Math.log10(p));
  return p / mag >= 5 ? mag : mag / 2;
}

export function computeLevels(ctx: BriefContext, symbols?: string[]): LevelHit[] {
  const set = new Set(symbols ?? [
    ...ctx.levels.map((l) => l.symbol), ...ctx.positions.map((p) => p.symbol),
    ...ctx.watchlist.filter((w) => w.kind !== 'keyword').map((w) => w.value), 'SPX', 'EURUSD', 'USDJPY', 'BTC', 'GOLD',
  ].map((s) => s.toUpperCase()));
  const out: LevelHit[] = [];
  for (const symbol of set) {
    const meta = ctx.symbols[symbol];
    const q = ctx.quote(symbol);
    if (!meta) continue;
    const price = q?.price ?? null;
    const d = meta.decimals;
    const ref = refTs(ctx, symbol);
    const since = ctx.history(symbol, ref, 400).map((p) => p.c);
    const prior = ctx.history(symbol, ref - DAY, 600).filter((p) => p.t < ref).map((p) => p.c);
    const onh = since.length ? Math.max(...since) : null, onl = since.length ? Math.min(...since) : null;
    const pdh = prior.length ? Math.max(...prior) : null, pdl = prior.length ? Math.min(...prior) : null;
    const pdc = refPrice(ctx, symbol);
    const cand: { level: number; kind: LevelHit['kind']; label: string }[] = [];
    for (const l of ctx.levels.filter((x) => x.symbol.toUpperCase() === symbol)) cand.push({ level: l.price, kind: 'user', label: l.label || 'Your level' });
    if (pdh) cand.push({ level: pdh, kind: 'pdh', label: 'Prior day high' });
    if (pdl) cand.push({ level: pdl, kind: 'pdl', label: 'Prior day low' });
    if (pdc) cand.push({ level: pdc, kind: 'pdc', label: 'Prior close' });
    if (onh && onl && since.length > 5) {
      cand.push({ level: onh, kind: 'onh', label: 'Overnight high' });
      cand.push({ level: onl, kind: 'onl', label: 'Overnight low' });
    }
    if (price) {
      const step = roundStep(price);
      const below = Math.floor(price / step) * step, above = below + step;
      cand.push({ level: +below.toFixed(d), kind: 'round', label: 'Round number' }, { level: +above.toFixed(d), kind: 'round', label: 'Round number' });
    }
    const near = meta.assetClass === 'fx' ? 0.08 : meta.assetClass === 'crypto' ? 0.5 : meta.assetClass === 'rate' ? 1 : 0.2;
    for (const c of cand) {
      const dist = price !== null ? ((price - c.level) / c.level) * 100 : null;
      // broken: the level sits between the reference price and now, or price crossed it overnight
      const crossed = pdc !== null && price !== null && c.kind !== 'pdc' && c.kind !== 'onh' && c.kind !== 'onl' && ((pdc < c.level && price >= c.level) || (pdc > c.level && price <= c.level));
      const status: LevelHit['status'] = crossed ? 'broken' : dist !== null && Math.abs(dist) <= near ? 'approached' : 'watch';
      out.push({ symbol, level: +c.level.toFixed(d), kind: c.kind, label: c.label, price, distancePct: dist === null ? null : +dist.toFixed(2), status, decimals: d });
    }
  }
  // user levels first, then by closeness
  return out.sort((a, b) => (a.kind === 'user' ? 0 : 1) - (b.kind === 'user' ? 0 : 1) || Math.abs(a.distancePct ?? 99) - Math.abs(b.distancePct ?? 99));
}

export function buildLevels(ctx: BriefContext, cfg: BriefSectionConfig) {
  const all = computeLevels(ctx);
  // keep the closest few per symbol
  const per = new Map<string, LevelHit[]>();
  for (const l of all) {
    const arr = per.get(l.symbol) ?? [];
    if (arr.length < 3 && !arr.some((x) => Math.abs(x.level - l.level) / l.level < 0.0005)) arr.push(l);
    per.set(l.symbol, arr);
  }
  const levels = [...per.values()].flat().slice(0, cfg.options.topN ?? 15);
  return levels.length ? { data: { levels, note: 'FX option expiries need a provider (not available on free tiers).' } } : { data: { levels: [] }, empty: 'Add levels on any chart or in Settings → Levels.' };
}

export function buildRatePath(ctx: BriefContext) {
  const b = ctx.intel('ratePaths');
  const paths = (b?.data as RatePath[] | undefined) ?? [];
  return paths.length
    ? { data: { paths, source: b!.source, cadence: b!.cadence, mock: b!.mock, connected: b!.connected, note: b!.note } }
    : { data: { paths: [] }, empty: 'Rate-path probabilities need a futures/OIS provider. Connect one in Settings → Integrations.' };
}

export function buildSentiment(ctx: BriefContext) {
  const fg = ctx.crypto?.fearGreed ?? null;
  const funding = ctx.crypto?.funding ?? [];
  const avgFunding = funding.length ? funding.reduce((s, f) => s + f.rate, 0) / funding.length : null;
  const social = ((ctx.intel('social')?.data as SocialRow[] | undefined) ?? []).slice(0, 5);
  const vix = ctx.quote('VIX');
  const regime = ctx.intel('regime')?.data as { score: number; label: string } | undefined;
  const any = fg || ctx.vol?.structure || ctx.vol?.putCall || avgFunding !== null || social.length;
  return {
    data: {
      fearGreed: fg, vix: vix ? { price: vix.price, changePct: vix.changePct } : null, structure: ctx.vol?.structure ?? null, term: ctx.vol?.termStructure ?? [],
      putCall: ctx.vol?.putCall ?? null, funding: avgFunding, fundingRows: funding.slice(0, 4), buzz: social, regime: regime ?? null,
    },
    empty: any ? undefined : 'Sentiment sources are still connecting.',
  };
}

export function buildWeekAhead(ctx: BriefContext, force = false) {
  const wd = zonedParts(ctx.now, ctx.tz).wd;
  const h = zonedParts(ctx.now, ctx.tz).h;
  if (!force && !(wd === 1 || (wd === 0 && h >= 15))) return null;
  const days: { date: string; events: EconEvent[]; earnings: string[]; structure: string[] }[] = [];
  for (let i = 0; days.length < 5 && i < 9; i++) {
    const date = localDateOf(ctx.now + i * DAY, ctx.tz);
    const dw = zonedParts(ctx.now + i * DAY, ctx.tz).wd;
    if (dw === 0 || dw === 6) continue;
    days.push({
      date,
      events: ctx.calendar.filter((e) => localDateOf(e.time, ctx.tz) === date && e.importance === 3).slice(0, 6),
      earnings: (ctx.vol?.earnings ?? []).filter((e) => localDateOf(e.date, 'America/New_York') === date).map((e) => e.symbol).slice(0, 6),
      structure: ctx.structure.filter((s) => s.date === date).map((s) => s.label),
    });
  }
  return { data: { days } };
}

/** How yesterday's calls and playbooks played out. */
export function buildScorecard(ctx: BriefContext) {
  const calls = (ctx.prevBrief?.calls ?? []).map((c) => {
    const q = ctx.quote(c.symbol);
    if (!q) return { ...c, now: null, movePct: null, outcome: 'pending' as const };
    const move = ((q.price - c.from) / c.from) * 100;
    const outcome = Math.abs(move) < 0.05 ? ('flat' as const) : (move > 0) === (c.direction === 'up') ? ('hit' as const) : ('miss' as const);
    return { ...c, now: q.price, movePct: +move.toFixed(2), outcome };
  });
  const outcomes = ctx.outcomes.filter((o) => o.firedAt >= ctx.now - 36 * 3600_000);
  if (!calls.length && !outcomes.length) return { data: { calls: [], outcomes: [] }, empty: 'Nothing to score yet: no calls in the previous brief and no playbooks fired.' };
  const hits = calls.filter((c) => c.outcome === 'hit').length;
  return { data: { calls, outcomes, hitRate: calls.length ? hits / calls.length : null } };
}

export function buildMovers(ctx: BriefContext, since: number, n = 5) {
  const rows = Object.keys(ctx.symbols).map((s) => scoreRow(ctx, s, ctx.symbols[s].assetClass, since)).filter((r): r is ScoreRow => !!r && r.symbol !== 'USDC' && !r.bp);
  rows.sort((a, b) => b.changePct - a.changePct);
  return rows.length ? { data: { gainers: rows.slice(0, n), losers: rows.slice(-n).reverse() } } : { data: { gainers: [], losers: [] }, empty: 'No price data yet.' };
}

export function buildSmartFeed(ctx: BriefContext, cfg: BriefSectionConfig) {
  const feed = ctx.smartFeeds.find((f) => f.id === cfg.options.smartFeedId);
  if (!feed) return { data: { stories: [] }, empty: 'Pick a smart feed for this section in the Brief Editor.' };
  const stories = ctx.clusters.filter((c) => c.receivedAt >= ctx.fxClose && ctx.matchFeed(feed, c)).sort((a, b) => b.impact - a.impact).slice(0, cfg.options.topN ?? 5)
    .map((c) => ({ id: c.id, headline: c.headline, source: c.source, url: c.url, impact: c.impact }));
  return { data: { feed: { name: feed.name, color: feed.color }, stories }, empty: stories.length ? undefined : `No matches for “${feed.name}” since the close.` };
}

export function buildThemes(ctx: BriefContext, n = 5) {
  const themes = ((ctx.intel('themes')?.data as ThemeItem[] | undefined) ?? []).slice(0, n);
  return themes.length ? { data: { themes } } : { data: { themes: [] }, empty: 'Themes form once a few days of coverage accumulate.' };
}

export function buildNextUp(ctx: BriefContext, hours = 8) {
  const events = ctx.calendar.filter((e) => e.time > ctx.now && e.time < ctx.now + hours * 3600_000 && e.importance >= 2).slice(0, 8);
  return { data: { events, hours }, empty: events.length ? undefined : `Nothing of note in the next ${hours} hours.` };
}

export function buildRisks(ctx: BriefContext) {
  const risks: string[] = [];
  const reg = ctx.intel('regime')?.data as { score: number; label: string } | undefined;
  if (reg) risks.push(`Regime reads ${reg.label} (${reg.score > 0 ? '+' : ''}${reg.score.toFixed(0)}).`);
  for (const c of ctx.clusters.filter((x) => x.breaking && x.receivedAt > ctx.now - 6 * 3600_000).slice(0, 2)) risks.push(`Developing: ${c.headline}`);
  const big = ctx.calendar.find((e) => e.time > ctx.now && e.time < ctx.now + 12 * 3600_000 && e.importance === 3);
  if (big) risks.push(`Event risk: ${big.currency} ${big.title}.`);
  if (ctx.vol?.structure === 'backwardation') risks.push('VIX curve in backwardation: hedging demand is elevated.');
  return { data: { risks }, empty: risks.length ? undefined : 'No outstanding risks flagged.' };
}

export function buildJournalPrompt(ctx: BriefContext) {
  const fired = ctx.alertsFired.filter((a) => a.ts > ctx.now - DAY).slice(0, 6);
  return { data: { prompt: 'What did you learn today?', alerts: fired } };
}

export function buildStructure(ctx: BriefContext, days = 7) {
  const items = ctx.structure.filter((s) => s.ts >= ctx.now - 3600_000 && s.ts <= ctx.now + days * DAY);
  return { data: { items }, empty: items.length ? undefined : 'No holidays, expiries or rebalances this week.' };
}

export function buildActivity(ctx: BriefContext) {
  return { data: { cells: ctx.activity } };
}

/** Directional leans implied by today's top stories (sentiment-based), scored in tomorrow's brief. */
export function deriveCalls(ctx: BriefContext, stories: BriefStory[]): BriefCall[] {
  const calls: BriefCall[] = [];
  for (const s of stories.slice(0, 5)) {
    const c = ctx.clusters.find((x) => x.id === s.id);
    if (!c || Math.abs(c.sentiment) < 0.25) continue;
    const sym = c.tickers.find((t) => ctx.symbols[t]) ?? c.currencies.find((x) => x.length === 6 && ctx.symbols[x]);
    const q = sym ? ctx.quote(sym) : undefined;
    if (!sym || !q || calls.some((x) => x.symbol === sym)) continue;
    const dir = c.sentiment > 0 ? 'up' : 'down';
    calls.push({ id: `${s.id}:${sym}`, text: `${sym} ${dir === 'up' ? 'higher' : 'lower'} on “${s.headline.slice(0, 80)}”`, symbol: sym, direction: dir, from: q.price, ts: ctx.now });
  }
  return calls;
}
