import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'pulse-v2-')), 'test.db');

const { parseRule, evaluate, serialize, RuleError } = await import('../shared/rules');
const { nyseHolidays, lseHolidays, easter, lastUsCloseTs, lastFxCloseTs, structureEvents, nthWeekday } = await import('../shared/market');
const { diffBriefs } = await import('../shared/briefDiff');
const S = await import('../server/brief/sections');
const { templateTake } = await import('../server/brief/narrative');
const { sanitizeProfile, defaultProfiles } = await import('../server/brief/profiles');
const { SYMBOLS, toMeta } = await import('../shared/symbols');

// ------------------------------------------------------------------ rules engine
const cluster = (p: Record<string, unknown> = {}) => ({
  headline: 'BoJ signals hike as yen slides', summary: 'USDJPY falls', domains: ['centralbanks', 'fx'], currencies: ['JPY', 'USD', 'USDJPY'], tickers: [],
  tags: ['BOJ'], source: 'Reuters', impact: 70, sentiment: -0.2, breaking: false, articles: [{ source: 'Reuters' }, { source: 'Bloomberg' }], ...p,
}) as never;

test('rules: parses the documented example and evaluates it', () => {
  const n = parseRule('(asset_class = FX AND currency IN [JPY, CHF]) OR (tag = "Central Banks" AND impact > 60) NOT source = X');
  assert.equal(n.type, 'or');
  assert.equal(evaluate(n, cluster()), true);
  assert.equal(evaluate(n, cluster({ domains: ['equities'], currencies: [], tags: [], impact: 20 })), false);
});

test('rules: implicit AND, NOT, bare text terms, numeric and boolean ops', () => {
  assert.equal(evaluate(parseRule('hike NOT source = reuters'), cluster()), false);
  assert.equal(evaluate(parseRule('hike impact >= 70'), cluster()), true);
  assert.equal(evaluate(parseRule('sources > 1 AND breaking = false'), cluster()), true);
  assert.equal(evaluate(parseRule('book = true'), cluster(), { inBook: true }), true);
  assert.equal(evaluate(parseRule('currency != EUR'), cluster()), true);
  assert.equal(evaluate(parseRule('tag = Central Banks'), cluster()), true, 'unquoted multi-word values');
});

test('rules: serialize round-trips to an equivalent tree', () => {
  const q = '(asset_class = FX AND currency IN [JPY, CHF]) OR tag = "Central Banks"';
  const n = parseRule(q);
  assert.deepEqual(parseRule(serialize(n)), n);
});

test('rules: reports errors with positions', () => {
  assert.throws(() => parseRule('(impact > 50'), RuleError);
  assert.throws(() => parseRule(''), RuleError);
  assert.throws(() => parseRule('currency IN [JPY'), RuleError);
});

// ------------------------------------------------------------------ market structure
test('market: Easter, NYSE and LSE holidays', () => {
  assert.deepEqual(easter(2026), { m: 4, d: 5 });
  assert.deepEqual(easter(2025), { m: 4, d: 20 });
  const ny = nyseHolidays(2026).map((h) => h.date);
  for (const d of ['2026-01-19', '2026-04-03', '2026-07-03', '2026-11-26', '2026-12-25']) assert.ok(ny.includes(d), d);
  assert.ok(lseHolidays(2026).some((h) => h.date === '2026-04-06'), 'Easter Monday');
  assert.equal(nthWeekday(2026, 9, 1, 1), 7, 'Labor Day 2026');
});

test('market: last close skips weekends and holidays', () => {
  // Monday 2026-10-05 08:00 NY → Friday 16:00 NY (20:00Z)
  assert.equal(new Date(lastUsCloseTs(Date.parse('2026-10-05T12:00:00Z'))).toISOString(), '2026-10-02T20:00:00.000Z');
  // Friday after Thanksgiving is a half day (13:00 NY)
  assert.equal(new Date(lastUsCloseTs(Date.parse('2026-11-28T15:00:00Z'))).toISOString(), '2026-11-27T18:00:00.000Z');
  assert.equal(new Date(lastFxCloseTs(Date.parse('2026-10-05T12:00:00Z'))).toISOString(), '2026-10-02T21:00:00.000Z');
});

test('market: structure events include opex, quad witching and DST shifts', () => {
  const ev = structureEvents(Date.parse('2026-03-01'), Date.parse('2026-03-31'));
  assert.ok(ev.some((e) => e.kind === 'quad' && e.date === '2026-03-20'));
  assert.ok(ev.some((e) => e.kind === 'dst' && e.date === '2026-03-08'));
  assert.ok(ev.some((e) => e.kind === 'dst' && e.date === '2026-03-29'));
  assert.ok(ev.some((e) => e.kind === 'quarterend' && e.date === '2026-03-31'));
});

// ------------------------------------------------------------------ brief builders
const NOW = Date.parse('2026-10-06T11:00:00Z');
function ctx(over: Record<string, unknown> = {}) {
  const symbols = Object.fromEntries(SYMBOLS.map((s) => [s.symbol, toMeta(s)]));
  const prices: Record<string, [number, number]> = { EURUSD: [1.16, 1.17], USDJPY: [149, 148], BTC: [110000, 112000], SPX: [6600, 6650], US10Y: [4.1, 4.15], DXY: [98, 97.8], GOLD: [3800, 3790] };
  const quote = (s: string) => (prices[s] ? { symbol: s, price: prices[s][1], ref: prices[s][0], change: 0, changePct: 0, ts: NOW, receivedAt: NOW, source: 'Test', delayedMin: 0 } : undefined);
  return {
    now: NOW, tz: 'America/New_York', fxClose: lastFxCloseTs(NOW), usClose: lastUsCloseTs(NOW), symbols, quote,
    storedClose: (s: string) => prices[s]?.[0] ?? null, priceAt: () => null,
    history: (s: string, since: number) => (prices[s] ? [{ t: since, c: prices[s][0] }, { t: since + 60_000, c: (prices[s][0] + prices[s][1]) / 2 }] : []),
    clusters: [
      { id: 'a', headline: 'Nvidia beats', summary: 'Record revenue. Shares rally.', source: 'CNBC', url: 'u', publishedAt: NOW - 3600_000, receivedAt: NOW - 3600_000, updatedAt: NOW, domains: ['equities'], tickers: ['NVDA'], currencies: [], tags: [], sentiment: 0.6, impact: 60, breaking: false, articles: [{ id: 'x', headline: 'h', source: 'CNBC', url: 'u', publishedAt: 0, receivedAt: 0 }] },
      { id: 'b', headline: 'ECB split on cuts', summary: 'Euro firms.', source: 'FT', url: 'u', publishedAt: NOW - 7200_000, receivedAt: NOW - 7200_000, updatedAt: NOW, domains: ['centralbanks', 'fx'], tickers: [], currencies: ['EUR', 'EURUSD'], tags: [], sentiment: 0.3, impact: 70, breaking: false, articles: [{ id: 'y', headline: 'h', source: 'FT', url: 'u', publishedAt: 0, receivedAt: 0 }] },
    ],
    calendar: [{ id: 'cpi', country: 'US', currency: 'USD', title: 'CPI m/m', time: NOW + 3600_000, importance: 3, unit: '%', consensus: 0.3, previous: 0.2, actual: null, source: 't' }],
    banks: [], crypto: null, vol: null, watchlist: [], positions: [], levels: [], intel: () => undefined, smartFeeds: [], matchFeed: () => false,
    outcomes: [], prevBrief: null, avgSurprise: () => ({ avg: 0.05, n: 6 }), structure: [], alertsFired: [], meetings: [], activity: [], ...over,
  } as never;
}
const cfg = (type: string, options = {}) => ({ id: type, type, enabled: true, size: 'full', options }) as never;

test('brief: scoreboard uses the stored close as the overnight reference', () => {
  const out = S.buildScoreboard(ctx(), cfg('scoreboard'));
  const rows = (out.data as { rows: { symbol: string; from: number; changePct: number; bp?: boolean; change: number }[] }).rows;
  const eur = rows.find((r) => r.symbol === 'EURUSD')!;
  assert.equal(eur.from, 1.16);
  assert.ok(Math.abs(eur.changePct - 0.862) < 0.01);
  const tenY = rows.find((r) => r.symbol === 'US10Y')!;
  assert.equal(tenY.bp, true);
  assert.ok(Math.abs(tenY.change - 0.05) < 1e-9);
});

test('brief: stories are ranked by impact × personal relevance and get template why-lines', () => {
  const c = ctx({ positions: [{ id: 'p', symbol: 'NVDA', qty: 10, avgPrice: 100, source: 'manual' }] });
  const { data } = S.buildStories(c, cfg('stories', { topN: 2 }), ['fx']);
  const stories = (data as { stories: { id: string; inBook: boolean; why: string; tldr: string }[] }).stories;
  assert.equal(stories[0].id, 'a', 'NVDA is in the book: 60 × 1.8 beats 70 × 1.3');
  assert.equal(stories[0].inBook, true);
  assert.equal(stories[0].tldr, 'Record revenue.');
  assert.ok(stories[1].why.includes('EURUSD'));
});

test('brief: calendar section carries average surprise and meeting conflicts', () => {
  const c = ctx({ meetings: [{ title: 'Team sync', start: NOW + 1800_000, end: NOW + 5400_000 }] });
  const out = S.buildCalendar(c, cfg('calendar'));
  const ev = (out.data as { events: { avgSurprise: { avg: number }; meeting: string }[] }).events[0];
  assert.equal(ev.avgSurprise.avg, 0.05);
  assert.equal(ev.meeting, 'Team sync');
});

test('brief: levels flag broken user levels', () => {
  const c = ctx({ levels: [{ id: 'l', symbol: 'EURUSD', price: 1.165, label: 'Breakout', alert: false, createdAt: 0 }] });
  const hit = S.computeLevels(c, ['EURUSD']).find((l) => l.kind === 'user')!;
  assert.equal(hit.status, 'broken');
});

test('brief: scorecard grades yesterday’s calls', () => {
  const prev = { calls: [{ id: '1', text: 'EURUSD higher', symbol: 'EURUSD', direction: 'up', from: 1.16, ts: 0 }, { id: '2', text: 'BTC lower', symbol: 'BTC', direction: 'down', from: 110000, ts: 0 }] };
  const out = S.buildScorecard(ctx({ prevBrief: prev }));
  const d = out.data as { calls: { outcome: string }[]; hitRate: number };
  assert.deepEqual(d.calls.map((x) => x.outcome), ['hit', 'miss']);
  assert.equal(d.hitRate, 0.5);
});

test('brief: template narrative respects tone and length', () => {
  const rows = (S.buildScoreboard(ctx(), cfg('scoreboard')).data as { rows: never[] }).rows;
  const stories = S.rankStories(ctx(), 0, []);
  const base = { kind: 'morning' as const, tz: 'America/New_York', rows, stories, events: [] };
  const short = templateTake({ ...base, tone: 'terse', length: 50 });
  const long = templateTake({ ...base, tone: 'analyst', length: 300 });
  assert.ok(short.text.split(/\s+/).length <= 60);
  assert.ok(long.text.length > short.text.length);
  assert.ok(short.headline.length > 5);
  assert.match(templateTake({ ...base, tone: 'eli5', length: 150 }).text, /advice/);
});

test('brief: profile sanitizer repairs bad input and default profiles are valid', () => {
  const p = sanitizeProfile({ name: 'x'.repeat(200), kind: 'nope' as never, length: 999 as never, schedule: { enabled: true, tz: 'Mars/Base', times: ['25:99', '07:00'] } as never }, 'UTC');
  assert.equal(p.kind, 'morning');
  assert.equal(p.length, 150);
  assert.equal(p.name.length, 60);
  assert.equal(p.schedule.tz, 'UTC');
  assert.equal(p.schedule.times[1], '07:00');
  for (const d of defaultProfiles('UTC')) assert.deepEqual(sanitizeProfile(d, 'UTC').sections.map((s) => s.type), d.sections.map((s) => s.type));
});

test('brief diff: detects new/dropped stories and changed take', () => {
  const mk = (take: string, heads: string[]) => ({ take: { text: take }, sections: [{ type: 'stories', data: { stories: heads.map((h, i) => ({ id: String(i), headline: h })) } }] }) as never;
  const d = diffBriefs(mk('Yen slid. Oil rose.', ['A story', 'B story']), mk('Yen slid. Gold fell.', ['B story', 'C story']));
  assert.deepEqual(d.takeAdded, ['Gold fell.']);
  assert.deepEqual(d.takeRemoved, ['Oil rose.']);
  assert.deepEqual(d.storiesNew.map((s) => s.headline), ['C story']);
  assert.deepEqual(d.storiesDropped.map((s) => s.headline), ['A story']);
  assert.equal(d.storiesKept[0].rankFrom, 2);
});

// ------------------------------------------------------------------ playbooks, quant, grid, parsers, destinations
const PB = await import('../shared/playbook');
const Q = await import('../shared/quant');
const G = await import('../shared/grid');
const { parseAlertText, describeRule, inQuietHours } = await import('../server/alerts2');
const { parseCsv } = await import('../server/portfolio');
const { parseIcs } = await import('../server/integrations');
const { encrypt, decrypt } = await import('../server/integrations/crypto');
const R = await import('../server/brief/render');

test('playbook: event matching, scenario selection and grading', () => {
  const nfp = { ...PB.PLAYBOOK_TEMPLATES[0], id: 'p', createdAt: 0 };
  assert.ok(PB.matchesEvent(nfp, { title: 'Nonfarm Payrolls', currency: 'USD' }));
  assert.ok(!PB.matchesEvent(nfp, { title: 'Nonfarm Payrolls', currency: 'EUR' }));
  assert.equal(PB.selectScenario(nfp, 250, 150)?.id, 'beat');
  assert.equal(PB.selectScenario(nfp, 60, 150)?.id, 'miss');
  assert.equal(PB.selectScenario(nfp, 160, 150)?.id, 'inline');
  const g = PB.gradeCheck({ symbol: 'USDJPY', direction: 'up', base: 150 }, { m5: 150.2, m30: 149.9, h2: null });
  assert.equal(g.hits.m5, true);
  assert.equal(g.hits.m30, false);
  assert.equal(g.hits.h2, undefined);
  assert.deepEqual(PB.hitRate([{ checks: [g] }], 'm5'), { hits: 1, total: 1, rate: 1 });
});

test('quant: correlation, breaks, regime and surprise index', () => {
  const a = [100, 101, 102, 101, 103, 104, 103, 105];
  const b = a.map((x) => x * 2);
  const c = a.map((x) => 300 - x);
  const m = Q.correlationMatrix([a, b, c]);
  assert.ok(m[0][1] > 0.99);
  assert.ok(m[0][2] < -0.99);
  assert.equal(Q.correlationBreaks(['A', 'B'], [[1, -0.2], [-0.2, 1]], [[1, 0.6], [0.6, 1]], 0.5).length, 1);
  const on = Q.regimeScore({ spxPct: 1.2, vixPct: -8, vixLevel: 13, hygPct: 1, usdjpyPct: 0.5, goldPct: -0.8, btcPct: 4 });
  const off = Q.regimeScore({ spxPct: -2, vixPct: 20, vixLevel: 32, hygPct: -2, usdjpyPct: -1, goldPct: 2, btcPct: -6 });
  assert.equal(on.label, 'risk-on');
  assert.equal(off.label, 'risk-off');
  assert.ok(on.score <= 100 && off.score >= -100);
  const t0 = Date.parse('2026-09-01');
  const s = Q.surpriseIndex([{ series: 'cpi', time: t0, actual: 0.4, consensus: 0.3 }, { series: 'cpi', time: t0 + 86400_000, actual: 0.5, consensus: 0.3 }, { series: 'jobless', time: t0 + 2 * 86400_000, actual: 250, consensus: 220, lowerIsBetter: true }], 30, t0 + 3 * 86400_000);
  assert.ok(s.series.length === 3);
  assert.ok(s.series[1].v > s.series[0].v, 'positive surprises push the index up');
  assert.deepEqual(Q.baseRate([{ surprise: 100, move: 0.2 }, { surprise: 80, move: -0.1 }, { surprise: 10, move: 0.5 }], 50, 'beat'), { n: 2, up: 1, down: 1 });
});

test('grid: move pushes collisions down, compaction, placement', () => {
  const items = [{ id: 'a', x: 0, y: 0, w: 4, h: 4 }, { id: 'b', x: 0, y: 4, w: 4, h: 4 }, { id: 'c', x: 4, y: 0, w: 4, h: 4 }];
  const moved = G.moveItem(items, 'c', 0, 0);
  const c = moved.find((i) => i.id === 'c')!;
  assert.deepEqual([c.x, c.y], [0, 0]);
  for (const i of moved) for (const j of moved) assert.ok(!G.collides(i, j), `${i.id} overlaps ${j.id}`);
  const r = G.resizeItem(items, 'a', 8, 6);
  assert.equal(r.find((i) => i.id === 'a')!.w, 8);
  assert.deepEqual(G.placeNew(items, 4, 4), { x: 8, y: 0 });
  assert.equal(G.clampItem({ id: 'x', x: 11, y: -3, w: 4, h: 1 }).x, 8);
});

test('smart alerts: plain-English parsing and description', () => {
  const r = parseAlertText('tell me if BTC drops 5% in 1h while funding is positive')!;
  assert.deepEqual([r.kind, r.symbol, r.pct, r.windowMin, r.moveDir], ['pct_move', 'BTC', 5, 60, 'down']);
  assert.deepEqual(r.conditions, [{ metric: 'funding', op: '>', value: 0 }]);
  const lvl = parseAlertText('EURUSD above 1.18')!;
  assert.deepEqual([lvl.kind, lvl.symbol, lvl.level, lvl.direction], ['price_cross', 'EURUSD', 1.18, 'above']);
  assert.equal(parseAlertText('headlines mentioning intervention')?.keyword, 'intervention');
  assert.match(describeRule(r), /BTC moves down 5% within 1h while funding > 0/);
  assert.equal(inQuietHours(Date.parse('2026-10-06T03:00:00Z'), 'UTC', { enabled: true, start: '22:00', end: '06:30' }), true);
  assert.equal(inQuietHours(Date.parse('2026-10-06T12:00:00Z'), 'UTC', { enabled: true, start: '22:00', end: '06:30' }), false);
});

test('portfolio CSV, ICS parsing and credential encryption', () => {
  const rows = parseCsv('Symbol,Quantity,Avg Price,Sector\nnvda,50,120.5,Semis\nEURUSD,-100000,1.15,\n,,\n');
  assert.deepEqual(rows.map((r) => [r.symbol, r.qty, r.avgPrice]), [['NVDA', 50, 120.5], ['EURUSD', -100000, 1.15]]);
  const start = new Date(Date.now() + 3600_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ev = parseIcs(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:${start}\nDTEND:${start}\nSUMMARY:Team sync\nEND:VEVENT\nEND:VCALENDAR`);
  assert.equal(ev[0].title, 'Team sync');
  const enc = encrypt({ token: 'secret-value' });
  assert.ok(!enc.includes('secret-value'));
  assert.deepEqual(decrypt(enc), { token: 'secret-value' });
  assert.equal(decrypt('v1:bad:data:here'), null);
});

test('destinations: payload formatting for email, Slack, Telegram, Markdown', () => {
  const brief = {
    id: 'b', profileId: 'morning', profileName: 'Morning Brief', kind: 'morning', date: '2026-10-06', createdAt: 0, headline: 'Yen slides <script>', tz: 'UTC', hash: '', calls: [],
    take: { text: 'Overnight, the yen slid & gold rose.', ai: false },
    sections: [{ id: 's', type: 'stories', title: 'Top stories', size: 'full', data: { stories: [{ id: '1', headline: 'BoJ hints', tldr: 'Hike coming.', why: 'Rates matter.', impact: 70, relevance: 1, score: 70, inBook: true, domains: [], sources: [{ source: 'Reuters', url: 'https://x.test/a' }], publishedAt: 0 }] } }],
  } as never;
  const html = R.toHtmlEmail(brief, 'https://pulse.test');
  assert.ok(html.includes('&lt;script&gt;') && !html.includes('<script>'), 'HTML is escaped');
  assert.ok(html.includes('not investment advice'));
  assert.match(R.toSlack(brief), /<https:\/\/x\.test\/a\|Reuters>/);
  assert.match(R.toTelegram(brief), /<b>Yen slides &lt;script&gt;<\/b>/);
  assert.match(R.toMarkdown(brief), /\*\*BoJ hints\*\* 📌/);
});
