import { createHash, randomUUID } from 'node:crypto';
import type { NewsCluster, WatchItem } from '../../shared/types';
import type { Brief, BriefMeta, BriefProfile, BriefSection, HandoffCard, Level, PlaybookOutcome, Position, ScoreRow, SmartFeed } from '../../shared/v2';
import { SYMBOLS, toMeta } from '../../shared/symbols';
import { lastFxCloseTs, lastUsCloseTs, structureEvents } from '../../shared/market';
import { matches } from '../../shared/rules';
import { zonedParts, zonedToUtc } from '../../shared/sessions';
import { sqlite } from '../db/client';
import { docs } from '../docs';
import { kvGet, kvSet } from '../kv';
import type { Hub } from '../hub';
import type { NewsPipeline } from '../news/pipeline';
import { avgSurprise } from '../econ';
import { scheduler, isTime, localDate } from '../scheduler';
import type { BriefContext } from './context';
import * as S from './sections';
import { aiTake, templateTake } from './narrative';
import { defaultProfiles, sanitizeProfile, SECTION_TITLES } from './profiles';

const DAY = 86400_000;

export function homeTz(): string {
  return kvGet<string>('user.tz', process.env.PULSE_TZ || 'America/New_York');
}

export interface BriefDeps {
  hub: Hub;
  pipeline: NewsPipeline;
  watchlist: () => WatchItem[];
  broadcast: (msg: { t: 'brief'; d: BriefMeta; open?: boolean } | { t: 'handoff'; d: HandoffCard }) => void;
  deliver: (brief: Brief, profile: BriefProfile) => void;
  meetings: () => { title: string; start: number; end: number }[];
}

export class BriefService {
  handoffs: HandoffCard[] = [];

  constructor(private d: BriefDeps) {
    this.handoffs = kvGet<HandoffCard[]>('handoffs', []).filter((h) => Date.now() - h.ts < DAY);
  }

  // ---------------------------------------------------------------- profiles
  profiles(): BriefProfile[] {
    let list = docs.list<BriefProfile>('brief_profiles');
    if (!list.length) {
      for (const p of defaultProfiles(homeTz())) docs.put('brief_profiles', p, { silent: true });
      list = docs.list<BriefProfile>('brief_profiles');
    }
    return list.sort((a, b) => a.order - b.order);
  }

  saveProfile(input: Partial<BriefProfile>) {
    const p = sanitizeProfile(input, homeTz());
    return docs.put('brief_profiles', { ...p, id: input.id || p.id || randomUUID() });
  }

  // ---------------------------------------------------------------- closes (overnight reference)
  /** Snapshot every price at the US cash close and the 17:00 NY rollover so Monday's brief can compare with Friday. */
  snapshotCloses(at: number) {
    const prices: Record<string, number> = {};
    for (const q of this.d.hub.quotes.values()) if (!q.mock || process.env.PULSE_MODE === 'mock') prices[q.symbol] = q.price;
    const key = `closes`;
    const all = kvGet<Record<string, Record<string, number>>>(key, {});
    all[String(at)] = prices;
    const keys = Object.keys(all).map(Number).sort((a, b) => b - a).slice(0, 14);
    kvSet(key, Object.fromEntries(keys.map((k) => [String(k), all[String(k)]])));
  }

  private storedClose = (() => {
    let cache: { at: number; data: Record<string, Record<string, number>> } | null = null;
    return (symbol: string, at: number) => {
      if (!cache || Date.now() - cache.at > 60_000) cache = { at: Date.now(), data: kvGet('closes', {}) };
      // tolerate a snapshot taken up to 10 minutes after the close
      for (const [k, v] of Object.entries(cache.data)) if (Math.abs(Number(k) - at) <= 10 * 60_000 && v[symbol]) return v[symbol];
      return null;
    };
  })();

  // ---------------------------------------------------------------- context
  context(now = Date.now(), tz = homeTz(), lookback = 0): BriefContext {
    const hub = this.d.hub;
    const positions = docs.list<Position>('positions');
    const smartFeeds = docs.list<SmartFeed>('smart_feeds');
    const prev = this.latest('morning', localDate(now - DAY, tz));
    const outcomes = (sqlite.prepare('SELECT data FROM playbook_outcomes WHERE fired_at > ? ORDER BY fired_at DESC LIMIT 50').all(now - 8 * DAY) as { data: string }[]).map((r) => JSON.parse(r.data) as PlaybookOutcome);
    const ref = now - lookback;
    const ctx: BriefContext = {
      now, tz,
      fxClose: lastFxCloseTs(ref), usClose: lastUsCloseTs(ref),
      symbols: Object.fromEntries(SYMBOLS.map((s) => [s.symbol, toMeta(s)])),
      quote: (s) => hub.quotes.get(s),
      storedClose: this.storedClose,
      priceAt: (s, ts) => hub.priceAt(s, ts),
      history: (s, since, n) => hub.historySince(s, since, n),
      clusters: this.d.pipeline.recent(600),
      calendar: hub.calendar, banks: hub.banks, crypto: hub.crypto, vol: hub.vol,
      watchlist: this.d.watchlist(), positions, levels: docs.list<Level>('levels'),
      intel: (k) => hub.intel.get(k),
      smartFeeds,
      matchFeed: (f, c) => matches(f.query, c, { watch: !!c.watchHit, inBook: S.touchesBook(ctx, c) }),
      outcomes, prevBrief: prev ? this.get(prev.id) : null,
      avgSurprise,
      structure: structureEvents(now - DAY, now + 8 * DAY),
      alertsFired: sqlite.prepare('SELECT ts, message FROM alert_events WHERE ts > ? ORDER BY ts DESC LIMIT 20').all(now - DAY) as { ts: number; message: string }[],
      meetings: this.d.meetings(),
      activity: (sqlite.prepare('SELECT (received_at / 3600000) * 3600000 AS t, COUNT(*) AS n FROM articles WHERE received_at > ? GROUP BY t ORDER BY t').all(now - 7 * DAY) as { t: number; n: number }[]),
    };
    return ctx;
  }

  // ---------------------------------------------------------------- generation
  async generate(profile: BriefProfile, opts: { now?: number; label?: string; ai?: boolean } = {}): Promise<Brief> {
    const now = opts.now ?? Date.now();
    const tz = profile.schedule.tz || homeTz();
    // EOD/weekly compare against the previous close, not the one that just happened
    const lookback = profile.kind === 'eod' ? 2 * 3600_000 : profile.kind === 'weekly' ? 5 * DAY : 0;
    const ctx = this.context(now, tz, lookback);
    const since = profile.kind === 'handoff' ? now - 8 * 3600_000 : undefined;
    const sections: BriefSection[] = [];
    let rows: ScoreRow[] = [];
    let stories: ReturnType<typeof S.rankStories> = [];

    for (const cfg of profile.sections.filter((s) => s.enabled)) {
      const title = cfg.options.title || (profile.kind !== 'morning' && cfg.type === 'calendar' ? "Tomorrow's calendar" : SECTION_TITLES[cfg.type]);
      let out: { data: unknown; empty?: string; sources?: string[] } | null = null;
      try {
        switch (cfg.type) {
          case 'take': out = { data: null }; break;
          case 'scoreboard': out = S.buildScoreboard(ctx, cfg, since); rows = (out.data as { rows: ScoreRow[] }).rows; break;
          case 'stories': out = S.buildStories(ctx, cfg, profile.assetClasses, profile.kind === 'weekly' ? now - 7 * DAY : profile.kind === 'eod' ? now - 12 * 3600_000 : undefined); stories = (out.data as { stories: typeof stories }).stories; break;
          case 'calendar': out = S.buildCalendar(ctx, cfg, profile.kind === 'eod' ? 1 : 0); break;
          case 'book': out = S.buildBook(ctx); break;
          case 'levels': out = S.buildLevels(ctx, cfg); break;
          case 'ratePath': out = S.buildRatePath(ctx); break;
          case 'sentiment': out = S.buildSentiment(ctx); break;
          case 'weekAhead': out = S.buildWeekAhead(ctx, profile.kind === 'weekly'); break;
          case 'scorecard': out = S.buildScorecard(ctx); break;
          case 'smartFeed': out = S.buildSmartFeed(ctx, cfg); break;
          case 'movers': out = S.buildMovers(ctx, ctx.fxClose); break;
          case 'journal': out = S.buildJournalPrompt(ctx); break;
          case 'themes': out = S.buildThemes(ctx); break;
          case 'nextUp': out = S.buildNextUp(ctx, profile.kind === 'handoff' ? 8 : 18); break;
          case 'risks': out = S.buildRisks(ctx); break;
          case 'structure': out = S.buildStructure(ctx); break;
          case 'activity': out = S.buildActivity(ctx); break;
        }
      } catch (e) {
        console.warn(`[brief] section ${cfg.type} failed:`, (e as Error).message);
        out = { data: null, empty: 'This section could not be built from the current data.' };
      }
      if (!out) continue; // e.g. week-ahead strip outside Sunday evening / Monday
      sections.push({ id: cfg.id, type: cfg.type, title, size: cfg.size, data: out.data, empty: out.empty, sources: out.sources });
    }
    // the narrative always has data to work from, even if those sections are hidden
    if (!rows.length) rows = (S.buildScoreboard(ctx, { id: 'x', type: 'scoreboard', enabled: true, size: 'full', options: {} }, since).data as { rows: ScoreRow[] }).rows;
    if (!stories.length) stories = S.rankStories(ctx, Math.min(ctx.fxClose, now - 14 * 3600_000), profile.assetClasses).slice(0, 5);
    const day = profile.kind === 'eod' ? 1 : 0;
    const events = ctx.calendar.filter((e) => localDate(e.time, tz) === localDate(now + day * DAY, tz) && e.importance >= 2);
    const regime = (ctx.intel('regime')?.data as { label: string; score: number } | undefined) ?? null;
    const input = { kind: profile.kind, tone: profile.tone, length: profile.length, tz, rows, stories, events, regime, handoff: profile.handoff };
    const tmpl = templateTake(input);
    const ai = opts.ai === false ? null : await aiTake(input);

    const brief: Brief = {
      id: randomUUID(), profileId: profile.id, profileName: profile.name, kind: profile.kind, date: localDate(now, tz), createdAt: now,
      headline: ai?.headline || tmpl.headline,
      take: ai ? { text: ai.text, ai: true, model: ai.model } : { text: tmpl.text, ai: false },
      sections, calls: profile.kind === 'morning' ? S.deriveCalls(ctx, stories) : [], hash: '', tz, label: opts.label,
    };
    brief.hash = createHash('sha1').update(JSON.stringify(sections.map((s) => s.data)) + brief.take.text).digest('hex').slice(0, 16);
    this.save(brief);
    if (profile.kind === 'handoff' && opts.label !== 'preview') this.pushHandoff(brief, profile, ctx, rows);
    return brief;
  }

  private pushHandoff(brief: Brief, profile: BriefProfile, ctx: BriefContext, rows: ScoreRow[]) {
    const moved = [...rows].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 5).map((r) => ({ symbol: r.symbol, changePct: +r.changePct.toFixed(2), bp: r.bp, change: r.change }));
    const next = ctx.calendar.filter((e) => e.time > ctx.now && e.time < ctx.now + 8 * 3600_000 && e.importance >= 2).slice(0, 4).map(({ id, title, time, currency, importance }) => ({ id, title, time, currency, importance }));
    const risks = (S.buildRisks(ctx).data as { risks: string[] }).risks.slice(0, 3);
    const card: HandoffCard = { id: brief.id, kind: 'handoff', from: profile.handoff?.from ?? 'Asia', to: profile.handoff?.to ?? 'London', ts: brief.createdAt, moved, next, risks, briefId: brief.id };
    this.handoffs = [card, ...this.handoffs.filter((h) => Date.now() - h.ts < DAY)].slice(0, 6);
    kvSet('handoffs', this.handoffs);
    this.d.broadcast({ t: 'handoff', d: card });
  }

  // ---------------------------------------------------------------- archive
  private save(b: Brief) {
    sqlite.prepare('INSERT INTO briefs (id, profile_id, kind, date, created_at, hash, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(b.id, b.profileId, b.kind, b.date, b.createdAt, b.hash, JSON.stringify(b));
  }

  get(id: string): Brief | null {
    const r = sqlite.prepare('SELECT data FROM briefs WHERE id = ?').get(id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as Brief) : null;
  }

  list(opts: { kind?: string; profileId?: string; limit?: number; before?: number } = {}): BriefMeta[] {
    const where: string[] = [], args: unknown[] = [];
    if (opts.kind) { where.push('kind = ?'); args.push(opts.kind); }
    if (opts.profileId) { where.push('profile_id = ?'); args.push(opts.profileId); }
    if (opts.before) { where.push('created_at < ?'); args.push(opts.before); }
    const rows = sqlite.prepare(`SELECT data FROM briefs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...args, Math.min(500, opts.limit ?? 60)) as { data: string }[];
    return rows.map((r) => {
      const b = JSON.parse(r.data) as Brief;
      return { id: b.id, profileId: b.profileId, kind: b.kind, date: b.date, createdAt: b.createdAt, headline: b.headline, label: b.label };
    });
  }

  latest(kind: string, date?: string, profileId?: string): BriefMeta | null {
    const args: unknown[] = [kind];
    let q = 'SELECT data FROM briefs WHERE kind = ?';
    if (date) { q += ' AND date = ?'; args.push(date); }
    if (profileId) { q += ' AND profile_id = ?'; args.push(profileId); }
    const r = sqlite.prepare(`${q} ORDER BY created_at DESC LIMIT 1`).get(...args) as { data: string } | undefined;
    if (!r) return null;
    const b = JSON.parse(r.data) as Brief;
    return { id: b.id, profileId: b.profileId, kind: b.kind, date: b.date, createdAt: b.createdAt, headline: b.headline, label: b.label };
  }

  prune(days = Number(process.env.BRIEF_RETENTION_DAYS) || 400) {
    sqlite.prepare('DELETE FROM briefs WHERE created_at < ?').run(Date.now() - days * DAY);
  }

  // ---------------------------------------------------------------- scheduling
  private async runProfile(p: BriefProfile, label?: string) {
    const b = await this.generate(p, { label });
    const meta = this.latest(b.kind, b.date, b.profileId)!;
    this.d.broadcast({ t: 'brief', d: meta, open: p.autoOpen });
    if (p.destinations.length) this.d.deliver(b, p);
    console.log(`[brief] ${p.name} generated (${b.take.ai ? 'AI' : 'template'} narrative)`);
    return b;
  }

  start() {
    scheduler.minutely('briefs', 'Brief scheduler (per profile, per time zone)', () => true, async () => {
      const now = Date.now();
      for (const p of this.profiles()) {
        if (!p.schedule.enabled) continue;
        const wd = zonedParts(now, p.schedule.tz).wd;
        if (isTime(now, p.schedule.tz, p.schedule.times[wd])) await this.runProfile(p);
      }
    }, 'checks every minute');
    // closing snapshots for overnight comparisons
    scheduler.minutely('closes', 'Close snapshots (16:00 & 17:00 New York)', (now) => isTime(now, 'America/New_York', '16:00', [1, 2, 3, 4, 5]) || isTime(now, 'America/New_York', '17:00', [1, 2, 3, 4, 5]), () => {
      const now = Date.now();
      const z = zonedParts(now, 'America/New_York');
      this.snapshotCloses(zonedToUtc(z.y, z.m, z.d, z.h, 0, 'America/New_York'));
    }, '16:00 / 17:00 NY');
    scheduler.every('briefs-prune', 'Brief archive retention', 6 * 3600_000, () => this.prune());
    // catch-up: if the worker was down at the scheduled time, build today's brief once data has arrived
    setTimeout(() => void this.catchUp(), 45_000);
  }

  private async catchUp() {
    const now = Date.now();
    for (const p of this.profiles()) {
      if (!p.schedule.enabled || p.kind !== 'morning') continue;
      const tz = p.schedule.tz;
      const z = zonedParts(now, tz);
      const t = p.schedule.times[z.wd];
      if (!t) continue;
      const [h, m] = t.split(':').map(Number);
      const due = zonedToUtc(z.y, z.m, z.d, h, m, tz);
      if (now >= due && now - due < 14 * 3600_000 && !this.latest('morning', localDate(now, tz), p.id)) {
        await this.runProfile(p, 'catch-up').catch((e) => console.warn('[brief] catch-up failed', e));
      }
    }
  }

  async regenerate(profileId: string) {
    const p = this.profiles().find((x) => x.id === profileId) ?? this.profiles()[0];
    return this.runProfile(p, 'regenerated');
  }

  /** Live preview for the Brief Editor: built from current data, not stored, template narrative only. */
  async preview(input: Partial<BriefProfile>): Promise<Brief> {
    const p = sanitizeProfile(input, homeTz());
    const b = await this.generateUnsaved(p);
    return b;
  }

  private async generateUnsaved(p: BriefProfile): Promise<Brief> {
    const realSave = this.save;
    this.save = () => {};
    try {
      return await this.generate({ ...p, id: p.id || 'preview' }, { ai: false, label: 'preview' });
    } finally {
      this.save = realSave;
    }
  }
}

export type { NewsCluster };
