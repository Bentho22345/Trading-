import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Snapshot, StreamId, WatchItem } from '../shared/types';
import { SYMBOLS, toMeta } from '../shared/symbols';
import { config, MODE, providers } from './config';
import { db, schema, sqlite } from './db/client';
import { hub } from './hub';
import { pipeline } from './news/pipeline';
import { AiSummarizer } from './news/ai';
import { AlertEngine } from './alerts';
import { buildAdapters } from './adapters';
import { updateBankHeadline } from './adapters/banks';
import type { AdapterContext } from './adapters/types';
import { Fanout } from './ws';
import { createApi } from './http';

const log = {
  info: (m: string, ...a: unknown[]) => console.log(m, ...a),
  warn: (m: string, ...a: unknown[]) => console.warn(m, ...a),
  error: (m: string, ...a: unknown[]) => console.error(m, ...a),
};

// ------------------------------------------------------------------ state
let watchlist: WatchItem[] = db.select().from(schema.watchlist).all().map(({ id, kind, value }) => ({ id, kind: kind as WatchItem['kind'], value }));
if (!watchlist.length && !db.select().from(schema.alerts).all().length) {
  // sensible first-run defaults so the watchlist boost is visible immediately
  const defaults: Omit<WatchItem, 'id'>[] = [{ kind: 'pair', value: 'EURUSD' }, { kind: 'coin', value: 'BTC' }, { kind: 'ticker', value: 'NVDA' }, { kind: 'keyword', value: 'SNB' }];
  watchlist = defaults.map((w) => ({ ...w, id: crypto.randomUUID() }));
  for (const w of watchlist) db.insert(schema.watchlist).values({ ...w, createdAt: Date.now() }).run();
}
// News is always real: purge any simulated articles left over from older demo runs.
sqlite.exec(`DELETE FROM clusters WHERE id IN (SELECT DISTINCT cluster_id FROM articles WHERE demo = 1); DELETE FROM articles WHERE demo = 1;`);
pipeline.load(watchlist);
const alerts = new AlertEngine(hub);
alerts.load();
const ai = new AiSummarizer((id) => pipeline.get(id), (id, t, w, m) => pipeline.setAi(id, t, w, m));

const readIds = () => db.select().from(schema.readState).all().map((r) => r.clusterId);
const savedIds = () => db.select().from(schema.saved).all().map((r) => r.clusterId);

function snapshot(): Snapshot {
  const sparks: Record<string, number[]> = {};
  for (const s of SYMBOLS) sparks[s.symbol] = hub.spark(s.symbol, 240, 48);
  // Keep the first payload small for a fast first paint; the client backfills older items over REST.
  const clusters = pipeline.recent(60);
  const recentIds = new Set(pipeline.recent(300).map((c) => c.id));
  return {
    serverTime: Date.now(),
    symbols: SYMBOLS.map(toMeta),
    quotes: [...hub.quotes.values()],
    sparks,
    statuses: [...hub.statuses.values()],
    clusters,
    calendar: hub.calendar,
    banks: hub.banks,
    crypto: hub.crypto,
    vol: hub.vol,
    analytics: hub.analytics,
    watchlist,
    alerts: alerts.rules,
    readIds: readIds().filter((id) => recentIds.has(id)),
    savedIds: savedIds(),
    aiEnabled: ai.enabled,
    breakingThreshold: config.breakingThreshold,
  };
}

// ------------------------------------------------------------------ servers
const api = createApi({
  hub, pipeline, alerts,
  getWatchlist: () => watchlist,
  setWatchlist: (w) => {
    watchlist = w;
    pipeline.setWatchlist(w);
    fanout.broadcast({ t: 'watchlist', d: w });
  },
  onReadSaved: () => {},
  clients: () => fanout.size,
});
// One server, one port: REST at /api, the live socket at /ws, and (unless PULSE_WEB=0) the Next.js
// web app for everything else. Same origin means it works behind any host, proxy or https preview.
const embedWeb = process.env.PULSE_WEB !== '0' && !process.argv.includes('--api-only');
type NextHandlers = { handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>; upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void> };
let web: NextHandlers | null = null;
const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/') || !web) return void api(req, res);
  void web.handle(req, res);
});
const fanout = new Fanout(snapshot);
server.on('upgrade', (req, socket, head) => {
  if (req.url?.split('?')[0] === '/ws') fanout.handleUpgrade(req, socket, head);
  else if (web) void web.upgrade(req, socket, head);
  else socket.destroy();
});

hub.on('quotes', (qs) => {
  fanout.quotes(qs);
  alerts.onQuotes(qs);
});
hub.on('status', (s) => fanout.broadcast({ t: 'status', d: s }));
hub.on('calendar', (d) => fanout.broadcast({ t: 'calendar', d }));
hub.on('banks', (d) => fanout.broadcast({ t: 'banks', d }));
hub.on('crypto', (d) => fanout.broadcast({ t: 'crypto', d }));
hub.on('vol', (d) => fanout.broadcast({ t: 'vol', d }));
hub.on('analytics', (d) => fanout.broadcast({ t: 'analytics', d }));
pipeline.on('cluster', (c, breakingNow: boolean) => {
  fanout.broadcast({ t: 'cluster', d: c, breakingNow });
  alerts.onCluster(c);
  ai.consider(c);
  updateBankHeadline(c);
});
alerts.on('alert', (d) => fanout.broadcast({ t: 'alert', d }));
alerts.on('rules', (d) => fanout.broadcast({ t: 'alerts', d }));

// ------------------------------------------------------------------ adapters
const adapters = buildAdapters(log);
const ctx: AdapterContext = { hub, log, emitNews: (a) => pipeline.ingest(a), newsCount: () => pipeline.recent(1000).length };

// one status row per stream (several news adapters share the "news" stream)
const LABELS: Record<StreamId, string> = {
  crypto: 'Crypto prices', fx: 'FX quotes', equities: 'Equities', news: 'News', calendar: 'Economic calendar', banks: 'Central banks',
  cryptoMarket: 'Crypto metrics', vol: 'Volatility', options: 'Options flow', earnings: 'Earnings calendar',
};
const byStream = new Map<StreamId, typeof adapters>();
for (const a of adapters) byStream.set(a.stream, [...(byStream.get(a.stream) ?? []), a]);
for (const [id, list] of byStream) {
  hub.registerStream({
    id, label: LABELS[id], provider: list.map((a) => a.provider).join(' + '), mock: list.every((a) => a.mock),
    delayedMin: Math.max(...list.map((a) => a.delayedMin)), staleAfterMs: Math.max(...list.map((a) => a.staleAfterMs)),
  });
}

async function startWeb() {
  if (!embedWeb) return;
  const { default: next } = await import('next');
  const dev = process.env.NODE_ENV !== 'production' && !process.argv.includes('--prod');
  const app = next({ dev, dir: join(dirname(fileURLToPath(import.meta.url)), '..'), hostname: 'localhost', port: config.port });
  await app.prepare();
  web = { handle: app.getRequestHandler() as NextHandlers['handle'], upgrade: app.getUpgradeHandler() as NextHandlers['upgrade'] };
}

await startWeb();
server.listen(config.port, config.host, async () => {
  log.info(`\n  PULSE  http://localhost:${config.port}  (mode: ${MODE}${embedWeb ? '' : ', API/WebSocket only'})`);
  log.info(`  providers: ${Object.entries(providers).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`).join('  ')}`);
  log.info(`  AI summaries: ${ai.enabled ? `on (${config.aiModel})` : 'off (set ANTHROPIC_API_KEY)'}\n`);
  for (const a of adapters) {
    try {
      await a.start(ctx);
    } catch (e) {
      log.error(`[${a.id}] failed to start`, e);
      hub.setState(a.stream, 'down', 'failed to start');
    }
  }
});

const pruneTimer = setInterval(() => pipeline.pruneDb(), 3600_000);

let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`\n[pulse] ${sig} — shutting down`);
  clearInterval(pruneTimer);
  for (const a of adapters) {
    try {
      await a.stop();
    } catch {
      /* ignore */
    }
  }
  hub.stop();
  fanout.close();
  server.close();
  sqlite.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log.error('[pulse] unhandled rejection', e));
process.on('uncaughtException', (e) => log.error('[pulse] uncaught exception', e));
