import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { desc, gte, inArray, lt } from 'drizzle-orm';
import type { Article, ArticleRef, Domain, NewsCluster, WatchItem } from '../../shared/types';
import type { RawArticle } from '../adapters/types';
import { db, schema } from '../db/client';
import { config } from '../config';
import { cleanText, cleanUrl } from './sanitize';
import { jaccard, tagText, tokens } from './tagger';
import { credibility, isMuted } from './sources';
import { impactScore, watchMatches, type ScoreInput } from './score';
import type { ScoreWeights } from '../../shared/v2';

interface ClusterState {
  id: string;
  articles: (Article & { cred: number; severity: number; banks: string[] })[];
  tokens: Set<string>;
  entities: Set<string>;
  firstSeen: number;
  updatedAt: number;
  impact: number;
  breaking: boolean;
  watchHit: boolean;
  inBook?: boolean;
  input?: ScoreInput;
  tldr?: string;
  why?: string;
  aiModel?: string;
}

const CLUSTER_WINDOW_MS = 4 * 3600_000;
const KEEP_IN_MEMORY_MS = 36 * 3600_000;
const MAX_CLUSTERS = 1500;

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const normHeadline = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * normalize → dedupe → tag → cluster → score → persist → emit.
 * Emits 'cluster' (NewsCluster, breakingNow: boolean) for every created/updated cluster.
 */
export class NewsPipeline extends EventEmitter {
  private clusters = new Map<string, ClusterState>();
  private seen = new Map<string, number>(); // article id / headline hash -> ts
  private watch: WatchItem[] = [];
  /** set by the portfolio module: does a cluster touch the user's positions? */
  inBookFn: (c: { tickers: string[]; currencies: string[] }) => boolean = () => false;
  stats = { ingested: 0, deduped: 0, clustered: 0, muted: 0 };

  constructor() {
    super();
    this.setMaxListeners(20);
  }

  load(watch: WatchItem[]) {
    this.watch = watch;
    const since = Date.now() - KEEP_IN_MEMORY_MS;
    const rows = db.select().from(schema.articles).where(gte(schema.articles.receivedAt, since)).orderBy(schema.articles.receivedAt).all();
    const meta = new Map(
      db.select().from(schema.clusters).where(gte(schema.clusters.updatedAt, since)).all().map((c) => [c.id, c]),
    );
    for (const r of rows) {
      const tag = tagText(`${r.headline}. ${r.summary}`);
      const a = {
        id: r.id, headline: r.headline, summary: r.summary, source: r.source, sourceId: r.sourceId, url: r.url,
        publishedAt: r.publishedAt, receivedAt: r.receivedAt, domains: r.domains as Domain[], tickers: r.tickers,
        currencies: r.currencies, tags: r.tags, sentiment: r.sentiment, impactScore: r.impact, clusterId: r.clusterId,
        demo: r.demo, cred: credibility(r.source, r.sourceId), severity: tag.severity, banks: tag.banks,
      };
      this.seen.set(r.id, r.receivedAt);
      this.seen.set(hash(normHeadline(r.headline)), r.receivedAt);
      let c = this.clusters.get(r.clusterId);
      if (!c) {
        const m = meta.get(r.clusterId);
        c = {
          id: r.clusterId, articles: [], tokens: new Set(), entities: new Set(), firstSeen: r.receivedAt, updatedAt: r.receivedAt,
          impact: r.impact, breaking: !!m?.breaking, watchHit: false, tldr: m?.tldr ?? undefined, why: m?.why ?? undefined, aiModel: m?.aiModel ?? undefined,
        };
        this.clusters.set(c.id, c);
      }
      this.addToCluster(c, a);
    }
    for (const c of this.clusters.values()) this.rescore(c);
  }

  setWatchlist(w: WatchItem[]) {
    this.watch = w;
    for (const c of this.clusters.values()) {
      const before = c.impact;
      const hitBefore = c.watchHit;
      this.rescore(c);
      if (c.impact !== before || c.watchHit !== hitBefore) this.emit('cluster', this.toClient(c), false);
    }
  }

  /** Re-score every cluster (weights, keywords, sources or positions changed) and push changes. */
  rescoreAll() {
    for (const c of this.clusters.values()) {
      const before = c.impact;
      this.rescore(c);
      if (c.impact !== before) this.emit('cluster', this.toClient(c), false);
    }
  }

  /** How the current feed would re-rank under candidate weights (Settings → Score tuning preview). */
  previewRank(w: ScoreWeights, limit = 25) {
    const rows = [...this.clusters.values()].filter((c) => c.input).map((c) => ({ id: c.id, headline: c.articles[0].headline, source: c.articles[0].source, before: c.impact, after: impactScore(c.input!, w) }));
    const beforeRank = new Map([...rows].sort((a, b) => b.before - a.before).map((r, i) => [r.id, i + 1]));
    return rows.sort((a, b) => b.after - a.after).slice(0, limit).map((r, i) => ({ ...r, rankBefore: beforeRank.get(r.id)!, rankAfter: i + 1 }));
  }

  ingest(raw: RawArticle) {
    try {
      this.ingestUnsafe(raw);
    } catch (e) {
      console.error('[news] ingest failed', e);
    }
  }

  private ingestUnsafe(raw: RawArticle) {
    const now = raw.receivedAt ?? Date.now();
    const headline = cleanText(raw.headline, 300);
    if (headline.length < 8) return;
    const url = cleanUrl(raw.url);
    const id = hash(url !== '#' ? url : `${raw.sourceId}|${headline}`);
    const hh = hash(normHeadline(headline));
    this.stats.ingested++;
    if (isMuted(raw.source, raw.sourceId)) {
      this.stats.muted++;
      return;
    }
    if (this.seen.has(id) || this.seen.has(hh)) {
      this.stats.deduped++;
      return;
    }
    this.seen.set(id, now);
    this.seen.set(hh, now);
    const summary = cleanText(raw.summary, 500);
    const publishedAt = Number.isFinite(raw.publishedAt) && raw.publishedAt <= now + 60_000 ? Math.min(raw.publishedAt, now) : now;
    // ignore very old items coming from a first RSS poll
    if (now - publishedAt > 24 * 3600_000) return;

    const tag = tagText(`${headline}. ${summary}`, { tickers: raw.tickers, category: raw.category });
    const article: ClusterState['articles'][number] = {
      id, headline, summary, source: cleanText(raw.source, 60), sourceId: raw.sourceId, url, publishedAt, receivedAt: now,
      domains: tag.domains, tickers: tag.tickers, currencies: tag.currencies, tags: tag.tags, sentiment: tag.sentiment,
      impactScore: 0, clusterId: '', demo: raw.demo, cred: credibility(raw.source, raw.sourceId), severity: tag.severity, banks: tag.banks,
    };

    // ---- cluster
    const tk = tokens(headline);
    const ent = new Set([...tag.tickers, ...tag.currencies.filter((c) => c.length === 6), ...tag.banks]);
    let best: ClusterState | null = null;
    let bestSim = 0;
    for (const c of this.clusters.values()) {
      if (Math.abs(now - c.updatedAt) > CLUSTER_WINDOW_MS) continue;
      let sim = jaccard(tk, c.tokens);
      let sharedEntity = false;
      for (const e of ent) if (c.entities.has(e)) { sharedEntity = true; break; }
      // Two stories about different assets are never the same story, however similar the wording.
      if (ent.size && c.entities.size && !sharedEntity) continue;
      if (sharedEntity) sim += 0.18;
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    let cluster: ClusterState;
    if (best && bestSim >= 0.46) {
      cluster = best;
      this.stats.clustered++;
    } else {
      cluster = {
        id: `c_${id}`, articles: [], tokens: new Set(), entities: new Set(), firstSeen: now, updatedAt: now,
        impact: 0, breaking: false, watchHit: false,
      };
      this.clusters.set(cluster.id, cluster);
    }
    article.clusterId = cluster.id;
    this.addToCluster(cluster, article, tk, ent);
    const wasBreaking = cluster.breaking;
    this.rescore(cluster);
    article.impactScore = cluster.impact;
    const breakingNow = !wasBreaking && cluster.impact >= config.breakingThreshold && now - publishedAt < 30 * 60_000;
    if (breakingNow) cluster.breaking = true;

    this.persist(cluster, article);
    this.emit('cluster', this.toClient(cluster), breakingNow);
    this.prune();
  }

  private addToCluster(c: ClusterState, a: ClusterState['articles'][number], tk = tokens(a.headline), ent?: Set<string>) {
    c.articles.push(a);
    // lead = most credible, then earliest
    c.articles.sort((x, y) => y.cred - x.cred || x.publishedAt - y.publishedAt);
    for (const t of tk) c.tokens.add(t);
    for (const e of ent ?? [...a.tickers, ...a.currencies.filter((x) => x.length === 6), ...a.banks]) c.entities.add(e);
    c.updatedAt = Math.max(c.updatedAt, a.receivedAt);
    c.firstSeen = Math.min(c.firstSeen, a.receivedAt);
  }

  private rescore(c: ClusterState) {
    const lead = c.articles[0];
    const sources = new Set(c.articles.map((a) => a.source));
    const union = this.unions(c);
    c.watchHit = watchMatches(this.watch, { headline: c.articles.map((a) => a.headline).join(' '), summary: lead.summary, tickers: union.tickers, currencies: union.currencies });
    c.inBook = this.inBookFn(union);
    c.input = {
      credibility: Math.max(...c.articles.map((a) => credibility(a.source, a.sourceId))),
      severity: Math.max(...c.articles.map((a) => a.severity)),
      clusterSize: sources.size,
      watchHit: c.watchHit,
      centralBank: c.articles.some((a) => a.banks.length > 0),
      exposure: c.inBook,
    };
    c.impact = impactScore(c.input);
  }

  private unions(c: ClusterState) {
    const u = <T>(f: (a: Article) => T[]) => [...new Set(c.articles.flatMap(f))];
    return { domains: u((a) => a.domains), tickers: u((a) => a.tickers).slice(0, 8), currencies: u((a) => a.currencies).slice(0, 8), tags: u((a) => a.tags).slice(0, 6) };
  }

  private persist(c: ClusterState, a: Article) {
    db.insert(schema.articles).values({
      id: a.id, clusterId: a.clusterId, headline: a.headline, summary: a.summary, source: a.source, sourceId: a.sourceId, url: a.url,
      publishedAt: a.publishedAt, receivedAt: a.receivedAt, domains: a.domains, tickers: a.tickers, currencies: a.currencies, tags: a.tags,
      sentiment: a.sentiment, impact: a.impactScore, demo: !!a.demo,
    }).onConflictDoNothing().run();
    db.insert(schema.clusters)
      .values({ id: c.id, leadId: c.articles[0].id, firstSeen: c.firstSeen, updatedAt: c.updatedAt, impact: c.impact, breaking: c.breaking })
      .onConflictDoUpdate({ target: schema.clusters.id, set: { leadId: c.articles[0].id, updatedAt: c.updatedAt, impact: c.impact, breaking: c.breaking } })
      .run();
  }

  setAi(id: string, tldr: string, why: string, model: string) {
    const c = this.clusters.get(id);
    if (!c) return;
    c.tldr = tldr;
    c.why = why;
    c.aiModel = model;
    db.update(schema.clusters).set({ tldr, why, aiModel: model }).where(inArray(schema.clusters.id, [id])).run();
    this.emit('cluster', this.toClient(c), false);
  }

  toClient(c: ClusterState): NewsCluster {
    const lead = c.articles[0];
    const u = this.unions(c);
    const refs: ArticleRef[] = c.articles.map(({ id, headline, source, url, publishedAt, receivedAt }) => ({ id, headline, source, url, publishedAt, receivedAt }));
    return {
      id: c.id, headline: lead.headline, summary: lead.summary, source: lead.source, url: lead.url,
      publishedAt: Math.min(...c.articles.map((a) => a.publishedAt)), receivedAt: c.firstSeen, updatedAt: c.updatedAt,
      ...u,
      sentiment: Math.round((c.articles.reduce((s, a) => s + a.sentiment, 0) / c.articles.length) * 100) / 100,
      impact: c.impact, breaking: c.breaking, demo: lead.demo, articles: refs, tldr: c.tldr, why: c.why, aiModel: c.aiModel, watchHit: c.watchHit,
    };
  }

  get(id: string) {
    const c = this.clusters.get(id);
    return c ? this.toClient(c) : null;
  }

  recent(limit = 250, before?: number): NewsCluster[] {
    return [...this.clusters.values()]
      .filter((c) => (before ? c.firstSeen < before : true))
      .sort((a, b) => b.firstSeen - a.firstSeen)
      .slice(0, limit)
      .map((c) => this.toClient(c));
  }

  /** Older than in-memory window: served from SQLite for infinite scroll. */
  archive(before: number, limit = 100): NewsCluster[] {
    const mem = this.recent(limit, before);
    if (mem.length >= limit) return mem;
    const rows = db.select().from(schema.articles).where(lt(schema.articles.receivedAt, before)).orderBy(desc(schema.articles.receivedAt)).limit(limit * 3).all();
    const byCluster = new Map<string, typeof rows>();
    for (const r of rows) {
      if (this.clusters.has(r.clusterId)) continue;
      const arr = byCluster.get(r.clusterId) ?? [];
      arr.push(r);
      byCluster.set(r.clusterId, arr);
    }
    const extra: NewsCluster[] = [...byCluster.values()].slice(0, limit - mem.length).map((arts) => {
      const lead = arts[arts.length - 1];
      return {
        id: lead.clusterId, headline: lead.headline, summary: lead.summary, source: lead.source, url: lead.url,
        publishedAt: lead.publishedAt, receivedAt: lead.receivedAt, updatedAt: arts[0].receivedAt, domains: lead.domains as Domain[],
        tickers: lead.tickers, currencies: lead.currencies, tags: lead.tags, sentiment: lead.sentiment, impact: lead.impact, breaking: false,
        demo: lead.demo, articles: arts.map((a) => ({ id: a.id, headline: a.headline, source: a.source, url: a.url, publishedAt: a.publishedAt, receivedAt: a.receivedAt })),
      };
    });
    return [...mem, ...extra];
  }

  private lastPrune = 0;
  private prune() {
    const now = Date.now();
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    for (const [id, c] of this.clusters) if (now - c.updatedAt > KEEP_IN_MEMORY_MS) this.clusters.delete(id);
    if (this.clusters.size > MAX_CLUSTERS) {
      const sorted = [...this.clusters.values()].sort((a, b) => a.updatedAt - b.updatedAt);
      for (const c of sorted.slice(0, this.clusters.size - MAX_CLUSTERS)) this.clusters.delete(c.id);
    }
    for (const [k, ts] of this.seen) if (now - ts > 48 * 3600_000) this.seen.delete(k);
  }

  /** Remove articles older than retention from SQLite. */
  pruneDb() {
    const cutoff = Date.now() - config.retentionDays * 86400_000;
    db.delete(schema.articles).where(lt(schema.articles.receivedAt, cutoff)).run();
    db.delete(schema.clusters).where(lt(schema.clusters.updatedAt, cutoff)).run();
  }
}

export const pipeline = new NewsPipeline();
