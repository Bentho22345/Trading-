import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// isolated database for the pipeline tests (must be set before the db module loads)
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'pulse-test-')), 'test.db');

const { tagText, tokens, jaccard } = await import('../server/news/tagger');
const { impactScore, watchMatches } = await import('../server/news/score');
const { cleanText, cleanUrl } = await import('../server/news/sanitize');
const { NewsPipeline } = await import('../server/news/pipeline');
const { currencyStrength } = await import('../shared/strength');
const { sessionStates, zonedToUtc, isFxWeekend } = await import('../shared/sessions');

test('tagger extracts coins, pairs, banks, domains and severity', () => {
  const t = tagText('Bitcoin tumbles 8% as SEC charges exchange; EUR/USD slides after Fed rate decision');
  assert.ok(t.tickers.includes('BTC'));
  assert.ok(t.currencies.includes('EURUSD'));
  assert.ok(t.banks.includes('FED'));
  for (const d of ['crypto', 'fx', 'centralbanks', 'regulation'] as const) assert.ok(t.domains.includes(d), d);
  assert.ok(t.severity >= 30);
  assert.ok(t.sentiment < 0);
});

test('tagger links company names to tickers and ignores ambiguous bare words', () => {
  const t = tagText('Nvidia shares jump after earnings beat; ARM of the deal');
  assert.ok(t.tickers.includes('NVDA'));
  assert.ok(!t.tickers.includes('ARM'));
  assert.ok(t.domains.includes('equities'));
});

test('similarity treats entity synonyms as equal', () => {
  const a = tokens('BoJ raises rates by 25 bps in rate decision; JPY jumps');
  const b = tokens('Bank of Japan raises rates by 25 bps, statement flags upside inflation risks');
  assert.ok(jaccard(a, b) > 0.4);
});

test('impact score is bounded and rewards corroboration and watchlist hits', () => {
  const base = { credibility: 0.9, severity: 30, clusterSize: 1, watchHit: false, centralBank: false };
  const s1 = impactScore(base);
  assert.ok(impactScore({ ...base, clusterSize: 4 }) > s1);
  assert.ok(impactScore({ ...base, watchHit: true }) > s1);
  assert.equal(impactScore({ credibility: 1, severity: 99, clusterSize: 99, watchHit: true, centralBank: true }), 100);
  assert.ok(watchMatches([{ id: '1', kind: 'pair', value: 'EURUSD' }], { headline: 'x', tickers: [], currencies: ['EUR', 'USD'] }));
  assert.ok(watchMatches([{ id: '1', kind: 'keyword', value: 'snb' }], { headline: 'SNB surprises', tickers: [], currencies: [] }));
});

test('sanitizer strips markup and unsafe urls', () => {
  assert.equal(cleanText('<p>Hello <script>alert(1)</script><b>world</b> &amp; co</p>'), 'Hello world & co');
  assert.equal(cleanUrl('javascript:alert(1)'), '#');
  assert.equal(cleanUrl('https://example.com/a'), 'https://example.com/a');
});

test('pipeline dedupes and clusters related stories, keeps different assets apart', () => {
  const p = new NewsPipeline();
  p.load([]);
  const events: { id: string; n: number }[] = [];
  p.on('cluster', (c) => events.push({ id: c.id, n: c.articles.length }));
  const now = Date.now();
  p.ingest({ sourceId: 'reuters', source: 'Reuters', headline: 'Spot Bitcoin ETFs log $883M net outflows, biggest day since January', url: 'https://a.test/1', publishedAt: now });
  p.ingest({ sourceId: 'reuters', source: 'Reuters', headline: 'Spot Bitcoin ETFs log $883M net outflows, biggest day since January', url: 'https://a.test/1', publishedAt: now });
  p.ingest({ sourceId: 'coindesk', source: 'CoinDesk', headline: 'Spot Bitcoin ETF net outflows hit $883M in a day', url: 'https://b.test/2', publishedAt: now });
  p.ingest({ sourceId: 'coindesk', source: 'CoinDesk', headline: 'Spot Ether ETFs log $120M net outflows, biggest day since March', url: 'https://b.test/3', publishedAt: now });
  assert.equal(events.length, 3, 'exact duplicate ignored');
  assert.equal(events[1].id, events[0].id, 'rewrite joins the cluster');
  assert.equal(events[1].n, 2);
  assert.notEqual(events[2].id, events[0].id, 'different asset is a different story');
});

test('currency strength ranks the rising currency first', () => {
  const r = currencyStrength({ EURUSD: 1, EURJPY: 1, EURGBP: 1 });
  assert.equal(r[0].ccy, 'EUR');
  assert.ok(r[r.length - 1].score < 0);
});

test('sessions follow local time zones and the FX weekend', () => {
  const tueLondon10 = zonedToUtc(2026, 9, 29, 10, 0, 'Europe/London');
  const s = sessionStates(tueLondon10, tueLondon10 - 3600_000, tueLondon10 + 3600_000);
  assert.equal(s.find((x) => x.def.id === 'london')!.open, true);
  assert.equal(s.find((x) => x.def.id === 'newyork')!.open, false);
  const saturday = zonedToUtc(2026, 10, 3, 12, 0, 'America/New_York');
  assert.equal(isFxWeekend(saturday), true);
  assert.equal(sessionStates(saturday, saturday, saturday).every((x) => !x.open), true);
});
