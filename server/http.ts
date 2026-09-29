import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import type { ClusterDetail, Digest, WatchItem, WatchKind } from '../shared/types';
import { SYMBOL_MAP } from '../shared/symbols';
import { db, schema } from './db/client';
import { config, providers, MODE } from './config';
import type { Hub } from './hub';
import type { NewsPipeline } from './news/pipeline';
import type { AlertEngine } from './alerts';

export interface ApiDeps {
  hub: Hub;
  pipeline: NewsPipeline;
  alerts: AlertEngine;
  getWatchlist: () => WatchItem[];
  setWatchlist: (w: WatchItem[]) => void;
  onReadSaved: () => void;
  clients: () => number;
}

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

async function body<T>(req: IncomingMessage): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, 'payload too large');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}') as T;
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': config.corsOrigin.split(',')[0] });
  res.end(JSON.stringify(data));
}

/** Pick the asset most associated with a cluster for price overlays. */
export function primarySymbol(c: { tickers: string[]; currencies: string[] }): string | null {
  const pair = c.currencies.find((x) => x.length === 6 && SYMBOL_MAP[x]);
  const tick = c.tickers.find((t) => SYMBOL_MAP[t]);
  if (tick) return tick;
  if (pair) return pair;
  const ccy = c.currencies.find((x) => x.length === 3 && x !== 'USD');
  if (ccy) return SYMBOL_MAP[`${ccy}USD`] ? `${ccy}USD` : SYMBOL_MAP[`USD${ccy}`] ? `USD${ccy}` : null;
  if (c.currencies.includes('USD')) return 'EURUSD';
  return null;
}

export function createApi(d: ApiDeps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/\/+$/, '');
    const m = req.method ?? 'GET';
    try {
      if (m === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': config.corsOrigin.split(',')[0], 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
        return void res.end();
      }
      if (path === '/api/health') return send(res, 200, { ok: true, mode: MODE, clients: d.clients(), uptime: process.uptime(), streams: [...d.hub.statuses.values()] });
      if (path === '/api/config') return send(res, 200, { mode: MODE, providers, breakingThreshold: config.breakingThreshold });

      if (path === '/api/news' && m === 'GET') {
        const before = Number(url.searchParams.get('before')) || Date.now() + 1;
        const limit = Math.min(200, Number(url.searchParams.get('limit')) || 100);
        return send(res, 200, d.pipeline.archive(before, limit));
      }
      const cm = path.match(/^\/api\/cluster\/([\w-]+)$/);
      if (cm && m === 'GET') {
        const cluster = d.pipeline.get(cm[1]);
        if (!cluster) throw new HttpError(404, 'cluster not found');
        const symbol = primarySymbol(cluster);
        const from = cluster.publishedAt - 90 * 60_000;
        const detail: ClusterDetail = { cluster, symbol, series: symbol ? d.hub.historySince(symbol, from, 400) : [] };
        return send(res, 200, detail);
      }
      const hm = path.match(/^\/api\/history\/([A-Z]{2,8})$/i);
      if (hm && m === 'GET') {
        const sym = hm[1].toUpperCase();
        if (!SYMBOL_MAP[sym]) throw new HttpError(404, 'unknown symbol');
        const minutes = Math.min(1560, Number(url.searchParams.get('minutes')) || 240);
        return send(res, 200, d.hub.historySince(sym, Date.now() - minutes * 60_000, 600));
      }
      if (path === '/api/digest' && m === 'GET') {
        const since = Number(url.searchParams.get('since')) || Date.now() - 3600_000;
        const clusters = d.pipeline.recent(500).filter((c) => c.receivedAt >= since).sort((a, b) => b.impact - a.impact).slice(0, 8);
        const movers: Digest['movers'] = [];
        for (const q of d.hub.quotes.values()) {
          const from = d.hub.priceAt(q.symbol, since);
          if (!from) continue;
          movers.push({ symbol: q.symbol, from, to: q.price, pct: ((q.price - from) / from) * 100 });
        }
        movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
        return send(res, 200, { since, clusters, movers: movers.slice(0, 8) } satisfies Digest);
      }

      // ---------------------------------------------------------- watchlist
      if (path === '/api/watchlist') {
        if (m === 'GET') return send(res, 200, d.getWatchlist());
        if (m === 'POST') {
          const b = await body<{ kind?: string; value?: string }>(req);
          const kinds: WatchKind[] = ['ticker', 'pair', 'coin', 'keyword'];
          const kind = kinds.includes(b.kind as WatchKind) ? (b.kind as WatchKind) : null;
          const value = String(b.value ?? '').trim().slice(0, 60);
          if (!kind || value.length < 1) throw new HttpError(400, 'kind and value required');
          const v = kind === 'keyword' ? value : value.toUpperCase().replace(/[^A-Z]/g, '');
          if (kind !== 'keyword' && !SYMBOL_MAP[v] && !(kind === 'pair' && v.length === 6)) throw new HttpError(400, `unknown symbol ${v}`);
          const list = d.getWatchlist();
          if (list.some((w) => w.kind === kind && w.value.toLowerCase() === v.toLowerCase())) return send(res, 200, list);
          const item: WatchItem = { id: randomUUID(), kind, value: v };
          db.insert(schema.watchlist).values({ ...item, createdAt: Date.now() }).run();
          d.setWatchlist([...list, item]);
          return send(res, 200, d.getWatchlist());
        }
      }
      const wm = path.match(/^\/api\/watchlist\/([\w-]+)$/);
      if (wm && m === 'DELETE') {
        db.delete(schema.watchlist).where(eq(schema.watchlist.id, wm[1])).run();
        d.setWatchlist(d.getWatchlist().filter((w) => w.id !== wm[1]));
        return send(res, 200, d.getWatchlist());
      }

      // ---------------------------------------------------------- alerts
      if (path === '/api/alerts') {
        if (m === 'GET') return send(res, 200, d.alerts.rules);
        if (m === 'POST') {
          try {
            return send(res, 200, d.alerts.upsert(await body(req)));
          } catch (e) {
            if (e instanceof HttpError) throw e;
            throw new HttpError(400, (e as Error).message);
          }
        }
      }
      if (path === '/api/alerts/events' && m === 'GET') {
        return send(res, 200, db.select().from(schema.alertEvents).orderBy(desc(schema.alertEvents.ts)).limit(50).all());
      }
      const am = path.match(/^\/api\/alerts\/([\w-]+)$/);
      if (am && m === 'DELETE') {
        d.alerts.remove(am[1]);
        return send(res, 200, d.alerts.rules);
      }

      // ---------------------------------------------------------- read / saved
      if (path === '/api/read' && m === 'POST') {
        const b = await body<{ ids?: string[]; unread?: boolean }>(req);
        const ids = (b.ids ?? []).filter((x) => typeof x === 'string').slice(0, 500);
        if (ids.length) {
          if (b.unread) db.delete(schema.readState).where(inArray(schema.readState.clusterId, ids)).run();
          else for (const id of ids) db.insert(schema.readState).values({ clusterId: id, readAt: Date.now() }).onConflictDoNothing().run();
        }
        return send(res, 200, { ok: true });
      }
      if (path === '/api/saved') {
        if (m === 'GET') {
          const ids = db.select().from(schema.saved).orderBy(desc(schema.saved.savedAt)).all().map((r) => r.clusterId);
          return send(res, 200, ids.map((id) => d.pipeline.get(id)).filter(Boolean));
        }
        if (m === 'POST') {
          const b = await body<{ id?: string; saved?: boolean }>(req);
          if (!b.id) throw new HttpError(400, 'id required');
          if (b.saved === false) db.delete(schema.saved).where(eq(schema.saved.clusterId, b.id)).run();
          else db.insert(schema.saved).values({ clusterId: b.id, savedAt: Date.now() }).onConflictDoNothing().run();
          d.onReadSaved();
          return send(res, 200, { ok: true });
        }
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[api]', e);
      send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
    }
  };
}
