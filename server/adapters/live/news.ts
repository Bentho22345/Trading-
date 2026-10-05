import Parser from 'rss-parser';
import type { Adapter } from '../types';
import { errText, fetchJson, poller, sleep } from '../types';
import { config, keys } from '../../config';

interface Feed { name: string; id: string; url: string }

/**
 * Official press-release feeds (published for syndication) plus crypto outlets that offer
 * public RSS. We store headline + short summary and always link out to the original.
 * Override with RSS_FEEDS="Name|id|url,Name|id|url".
 */
export const DEFAULT_FEEDS: Feed[] = [
  { name: 'Federal Reserve', id: 'fed', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { name: 'ECB', id: 'ecb', url: 'https://www.ecb.europa.eu/rss/press.html' },
  { name: 'Bank of England', id: 'boe', url: 'https://www.bankofengland.co.uk/rss/news' },
  { name: 'Bank of Japan', id: 'boj', url: 'https://www.boj.or.jp/en/rss/whatsnew.xml' },
  { name: 'Reserve Bank of Australia', id: 'rba', url: 'https://www.rba.gov.au/rss/rss-cb-media-releases.xml' },
  { name: 'Bank of Canada', id: 'boc', url: 'https://www.bankofcanada.ca/content_type/press-releases/feed/' },
  { name: 'SEC', id: 'sec', url: 'https://www.sec.gov/news/pressreleases.rss' },
  { name: 'BLS', id: 'bls', url: 'https://www.bls.gov/feed/bls_latest.rss' },
  { name: 'CoinDesk', id: 'coindesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph', id: 'cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'BBC Business', id: 'bbc', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { name: 'CNBC Markets', id: 'cnbc', url: 'https://www.cnbc.com/id/15839069/device/rss/rss.html' },
  { name: 'MarketWatch', id: 'marketwatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'Yahoo Finance', id: 'yahoo', url: 'https://finance.yahoo.com/news/rssindex' },
  { name: 'FXStreet', id: 'fxstreet', url: 'https://www.fxstreet.com/rss/news' },
  { name: 'Investing.com', id: 'investing', url: 'https://www.investing.com/rss/news.rss' },
  { name: 'Decrypt', id: 'decrypt', url: 'https://decrypt.co/feed' },
  { name: 'The Block', id: 'the block', url: 'https://www.theblock.co/rss.xml' },
  { name: 'Federal Reserve speeches', id: 'fed', url: 'https://www.federalreserve.gov/feeds/speeches.xml' },
  { name: 'CFTC', id: 'cftc', url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml' },
];

function feeds(): Feed[] {
  if (!config.rssFeeds) return DEFAULT_FEEDS;
  return config.rssFeeds.split(',').map((s) => {
    const [name, id, url] = s.split('|').map((x) => x.trim());
    return { name, id: id || name.toLowerCase(), url };
  }).filter((f) => f.url?.startsWith('http'));
}

export function rssAdapter(): Adapter {
  const stops: (() => void)[] = [];
  const parser = new Parser({ timeout: 10_000 });
  return {
    id: 'rss', stream: 'news', provider: 'RSS (central banks, SEC, BLS, crypto outlets)', mock: false, delayedMin: 0, staleAfterMs: 15 * 60_000,
    start(ctx) {
      // SEC asks automated clients to identify themselves with a contact address.
      const ua = process.env.SEC_USER_AGENT || 'PulseTerminal/0.1 (contact: set SEC_USER_AGENT)';
      feeds().forEach((f, i) => {
        const cache: { etag?: string; modified?: string } = {};
        const run = async () => {
          const res = await fetch(f.url, {
            headers: { 'User-Agent': ua, Accept: 'application/rss+xml, application/xml, text/xml', ...(cache.etag ? { 'If-None-Match': cache.etag } : {}), ...(cache.modified ? { 'If-Modified-Since': cache.modified } : {}) },
            signal: AbortSignal.timeout(12_000),
          });
          if (res.status === 304) return void ctx.hub.touch('news');
          if (!res.ok) throw new Error(`${f.name}: HTTP ${res.status}`);
          cache.etag = res.headers.get('etag') ?? undefined;
          cache.modified = res.headers.get('last-modified') ?? undefined;
          const feed = await parser.parseString(await res.text());
          for (const it of feed.items.slice(0, 25).reverse()) {
            if (!it.title || !it.link) continue;
            ctx.emitNews({
              sourceId: f.id, source: f.name, headline: it.title, summary: it.contentSnippet ?? it.summary ?? '', url: it.link,
              publishedAt: it.isoDate ? Date.parse(it.isoDate) : Date.now(),
            });
          }
          ctx.hub.touch('news');
        };
        // stagger feeds so we never burst
        const t = setTimeout(() => stops.push(poller(run, config.rssIntervalSec * 1000, (e) => {
        ctx.log.warn(`[rss] ${errText(e)}`);
        ctx.hub.reportError('news', errText(e));
      })), i * 1500);
        stops.push(() => clearTimeout(t));
      });
    },
    stop() {
      stops.forEach((s) => s());
    },
  };
}

/** CryptoPanic API v2. NB: the free developer tier was discontinued in 2026 — requires a paid key. */
export function cryptoPanicAdapter(): Adapter {
  let stop: (() => void) | null = null;
  return {
    id: 'cryptopanic', stream: 'news', provider: 'CryptoPanic', mock: false, delayedMin: 0, staleAfterMs: 15 * 60_000,
    start(ctx) {
      stop = poller(async () => {
        const res = await fetchJson<{ results: { title: string; published_at: string; url?: string; original_url?: string; slug?: string; id: number; source?: { title: string }; description?: string }[] }>(
          `https://cryptopanic.com/api/developer/v2/posts/?auth_token=${keys.cryptopanic}&public=true&kind=news`,
        );
        for (const p of (res.results ?? []).reverse()) {
          ctx.emitNews({
            sourceId: `cryptopanic:${p.source?.title ?? 'cp'}`.toLowerCase(), source: p.source?.title ?? 'CryptoPanic', headline: p.title,
            summary: p.description ?? '', url: p.original_url ?? p.url ?? `https://cryptopanic.com/news/${p.id}/${p.slug ?? ''}`,
            publishedAt: Date.parse(p.published_at), category: 'crypto',
          });
          await sleep(0);
        }
        ctx.hub.touch('news');
      }, 120_000, (e) => {
        ctx.log.warn(`[cryptopanic] ${errText(e)}`);
        ctx.hub.reportError('news', errText(e));
      });
    },
    stop() {
      stop?.();
    },
  };
}
