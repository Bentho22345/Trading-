import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { KeywordEntry, Position, ScoreWeights, SourceHealth, SourceOverride } from '../shared/v2';
import { touchesHeld } from '../shared/relevance';
import { DEFAULT_WEIGHTS } from '../shared/v2';
import { docs } from './docs';
import { bad, notFound, type Router } from './router';
import type { V2Feature } from './v2';
import type { NewsPipeline } from './news/pipeline';
import { scoring } from './news/score';
import { setKeywordDictionary, SEVERITY } from './news/tagger';
import { credibility, sourceOverrides } from './news/sources';
import { rssRegistry, fetchFeed, DEFAULT_FEEDS } from './adapters/live/news';

const W_KEYS = Object.keys(DEFAULT_WEIGHTS) as (keyof ScoreWeights)[];

function cleanWeights(input: Partial<ScoreWeights>): ScoreWeights {
  const out = { ...DEFAULT_WEIGHTS };
  for (const k of W_KEYS) {
    const v = Number(input[k]);
    if (Number.isFinite(v)) out[k] = Math.max(0, Math.min(k === 'severity' ? 3 : 60, v));
  }
  return out;
}

/** Block private/loopback/link-local targets so a feed URL can't be used to probe the host's network. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    bad('not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') bad('only http(s) feeds are supported');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => bad('host not found'));
  for (const { address } of addrs) {
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) || address === '::1' || /^f[cd]/i.test(address) || /^fe80/i.test(address)) bad('private network addresses are not allowed');
  }
  return u;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'feed';

export function tuningFeature(pipeline: NewsPipeline): V2Feature {
  const apply = (rescore = true) => {
    const w = docs.get<{ weights: ScoreWeights }>('score_weights', 'weights');
    scoring.weights = cleanWeights(w?.weights ?? {});
    setKeywordDictionary(docs.get<{ entries: KeywordEntry[] }>('score_weights', 'keywords')?.entries ?? []);
    const held = new Set(docs.list<Position>('positions').map((p) => p.symbol.toUpperCase()));
    pipeline.inBookFn = (c) => touchesHeld(c, held);
    sourceOverrides.clear();
    const custom: { name: string; id: string; url: string }[] = [];
    rssRegistry.muted.clear();
    for (const o of docs.list<SourceOverride>('source_overrides')) {
      const ov = { credibility: o.credibility, muted: o.muted };
      sourceOverrides.set(o.id.toLowerCase(), ov);
      sourceOverrides.set(o.name.toLowerCase(), ov);
      if (o.custom && o.url) custom.push({ name: o.name, id: o.id, url: o.url });
      if (o.muted) rssRegistry.muted.add(o.id);
    }
    const changedFeeds = JSON.stringify(custom) !== JSON.stringify(rssRegistry.custom);
    rssRegistry.custom = custom;
    if (changedFeeds) rssRegistry.reload();
    if (rescore) pipeline.rescoreAll();
  };

  let timer: NodeJS.Timeout | null = null;
  const onChange = (c: string) => {
    if (c !== 'score_weights' && c !== 'source_overrides' && c !== 'positions') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => apply(), 400);
  };

  const health = (): SourceHealth[] => {
    const seen = new Set<string>();
    const out: SourceHealth[] = [];
    for (const f of rssRegistry.list()) {
      if (seen.has(f.url)) continue;
      seen.add(f.url);
      const st = rssRegistry.stats.get(f.url);
      const o = docs.get<SourceOverride>('source_overrides', f.id);
      out.push({
        id: f.id, name: f.name, url: f.url, ok: !!st?.lastOk && !st.lastError, lastOk: st?.lastOk ?? null, lastError: st?.lastError ?? null,
        latencyMs: st?.latencyMs ?? null, itemsPerHour: st?.items.filter((t) => Date.now() - t < 3600_000).length ?? 0,
        custom: !DEFAULT_FEEDS.some((d) => d.url === f.url), muted: !!o?.muted, credibility: credibility(f.name, f.id),
      });
    }
    return out;
  };

  return {
    start() {
      apply(false);
      docs.on('change', onChange);
      docs.on('reset', onChange);
    },
    stop() {
      docs.off('change', onChange);
    },
    routes(r: Router) {
      r.get('/api/tuning', () => ({
        weights: scoring.weights, defaults: DEFAULT_WEIGHTS,
        builtin: SEVERITY.map(([re, weight, label]) => ({ term: label, weight, pattern: re.source })),
        keywords: docs.get<{ entries: KeywordEntry[] }>('score_weights', 'keywords')?.entries ?? [],
      }));
      r.put('/api/tuning/weights', async ({ body }) => {
        const w = cleanWeights(await body<Partial<ScoreWeights>>());
        docs.put('score_weights', { id: 'weights', weights: w });
        apply();
        return w;
      });
      r.put('/api/tuning/keywords', async ({ body }) => {
        const b = await body<{ entries?: KeywordEntry[] }>();
        const entries = (b.entries ?? []).filter((e) => e && typeof e.term === 'string' && e.term.trim()).slice(0, 300)
          .map((e) => ({ term: e.term.trim().slice(0, 60), weight: Math.max(0, Math.min(40, Number(e.weight) || 0)), ...(e.tag ? { tag: String(e.tag).slice(0, 30) } : {}) }));
        docs.put('score_weights', { id: 'keywords', entries });
        apply();
        return { entries };
      });
      r.post('/api/tuning/preview', async ({ body }) => pipeline.previewRank(cleanWeights(await body<Partial<ScoreWeights>>())));

      r.get('/api/sources', () => health());
      r.post('/api/sources/validate', async ({ body }) => {
        const { url } = await body<{ url?: string }>();
        const u = await assertPublicUrl(String(url ?? ''));
        try {
          const res = await fetchFeed(u.toString());
          if (res.notModified) return { ok: true, title: u.hostname, items: 0, sample: [] };
          return { ok: true, title: res.feed.title ?? u.hostname, items: res.feed.items.length, sample: res.feed.items.slice(0, 3).map((i) => i.title ?? '').filter(Boolean), latencyMs: res.latencyMs };
        } catch (e) {
          bad(`could not read that feed: ${(e as Error).message}`);
        }
      });
      r.post('/api/sources', async ({ body }) => {
        const b = await body<{ url?: string; name?: string; credibility?: number }>();
        const u = await assertPublicUrl(String(b.url ?? ''));
        const name = String(b.name ?? u.hostname).slice(0, 60);
        let id = `custom-${slug(name)}`;
        if (docs.get('source_overrides', id)) id = `${id}-${Date.now().toString(36).slice(-4)}`;
        const doc: SourceOverride = { id, name, url: u.toString(), custom: true, credibility: b.credibility !== undefined ? Math.max(0, Math.min(1, Number(b.credibility))) : 0.55, muted: false, addedAt: Date.now() };
        docs.put('source_overrides', doc);
        apply();
        return doc;
      });
      r.put('/api/sources/:id', async ({ params, body }) => {
        const b = await body<{ credibility?: number; muted?: boolean; name?: string }>();
        const builtin = rssRegistry.list().find((f) => f.id === params[0]);
        const existing = docs.get<SourceOverride>('source_overrides', params[0]);
        if (!builtin && !existing) notFound('unknown source');
        const doc: SourceOverride = {
          ...(existing ?? { id: params[0], name: builtin!.name, custom: false, addedAt: Date.now() }),
          ...(b.credibility !== undefined ? { credibility: Math.max(0, Math.min(1, Number(b.credibility))) } : {}),
          ...(b.muted !== undefined ? { muted: !!b.muted } : {}),
          ...(b.name ? { name: String(b.name).slice(0, 60) } : {}),
        };
        docs.put('source_overrides', doc);
        apply();
        return doc;
      });
      r.del('/api/sources/:id', ({ params }) => {
        docs.remove('source_overrides', params[0]);
        apply();
        return { ok: true };
      });
    },
  };
}
