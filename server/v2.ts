import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerMsg, WatchItem } from '../shared/types';
import type { Brief, BriefProfile } from '../shared/v2';
import type { Hub } from './hub';
import type { NewsPipeline } from './news/pipeline';
import type { AlertEngine } from './alerts';
import { Router, Raw, bad, notFound } from './router';
import { docs, isCollection, PUBLIC_COLLECTIONS, type Collection } from './docs';
import { kvGet, kvSet } from './kv';
import { scheduler } from './scheduler';
import { recordReleases } from './econ';
import { BriefService, homeTz } from './brief/service';
import { validTz } from './brief/profiles';
import { toHtmlEmail, toMarkdown, toText } from './brief/render';

export interface V2Deps {
  hub: Hub;
  pipeline: NewsPipeline;
  alerts: AlertEngine;
  watchlist: () => WatchItem[];
  broadcast: (m: ServerMsg) => void;
}

export interface V2Feature {
  /** extra routes */
  routes?: (r: Router) => void;
  start?: () => void;
  stop?: () => void;
}

/**
 * PULSE 2.0 composition root: owns the router, brief service and feature modules, and keeps
 * server/index.ts small. Features register their routes and jobs through `use()`.
 */
export function createV2(d: V2Deps) {
  const router = new Router();
  const features: V2Feature[] = [];
  let deliver: (b: Brief, p: BriefProfile) => void = (b, p) => console.log(`[brief] ${p.name}: delivery requested to ${p.destinations.join(', ')}`);
  let meetings: () => { title: string; start: number; end: number }[] = () => [];

  const briefs = new BriefService({
    hub: d.hub, pipeline: d.pipeline, watchlist: d.watchlist,
    broadcast: (m) => d.broadcast(m),
    deliver: (b, p) => deliver(b, p),
    meetings: () => meetings(),
  });

  // keep other tabs/devices in sync with document edits
  docs.on('change', (c: Collection, op: 'put' | 'del', doc: { id: string }) => {
    if (c === 'integrations') return;
    d.broadcast({ t: 'doc', c, op, d: doc as { id: string } & Record<string, unknown> });
  });
  d.hub.on('calendar', (events) => recordReleases(events));

  // ---------------------------------------------------------------- documents
  router.get('/api/docs', () => Object.fromEntries(PUBLIC_COLLECTIONS.map((c) => [c, docs.list(c)])));
  router.get('/api/docs/:c', ({ params }) => {
    if (!isCollection(params[0]) || params[0] === 'integrations') notFound();
    return docs.list(params[0] as Collection);
  });
  router.put('/api/docs/:c/:id', async ({ params, body }) => {
    const c = params[0];
    if (!isCollection(c) || c === 'integrations') notFound();
    if (c === 'brief_profiles') return briefs.saveProfile({ ...(await body<BriefProfile>()), id: params[1] });
    const b = await body();
    if (typeof b !== 'object' || Array.isArray(b)) bad('document must be an object');
    try {
      return docs.put(c, { ...b, id: params[1] });
    } catch (e) {
      bad((e as Error).message);
    }
  });
  router.del('/api/docs/:c/:id', ({ params }) => {
    if (!isCollection(params[0]) || params[0] === 'integrations') notFound();
    docs.remove(params[0] as Collection, params[1]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- user prefs that the server needs (scheduling)
  router.get('/api/user', () => ({ tz: homeTz() }));
  router.put('/api/user', async ({ body }) => {
    const b = await body<{ tz?: string }>();
    if (b.tz !== undefined) {
      if (!validTz(b.tz)) bad('unknown time zone');
      kvSet('user.tz', b.tz);
    }
    return { tz: homeTz() };
  });

  // ---------------------------------------------------------------- settings sync (client settings JSON, one doc per device group)
  router.get('/api/settings-sync', () => docs.get('settings_docs', 'user') ?? null);
  router.put('/api/settings-sync', async ({ body }) => {
    const b = await body<{ settings?: unknown; updatedAt?: number }>();
    if (!b.settings || typeof b.settings !== 'object') bad('settings required');
    return docs.put('settings_docs', { id: 'user', settings: b.settings, updatedAt: Number(b.updatedAt) || Date.now() });
  });

  // ---------------------------------------------------------------- briefs
  router.get('/api/briefs', ({ url }) => briefs.list({ kind: url.searchParams.get('kind') ?? undefined, profileId: url.searchParams.get('profile') ?? undefined, limit: Number(url.searchParams.get('limit')) || 60, before: Number(url.searchParams.get('before')) || undefined }));
  router.get('/api/briefs/latest', ({ url }) => {
    const meta = briefs.latest(url.searchParams.get('kind') ?? 'morning', url.searchParams.get('date') ?? undefined, url.searchParams.get('profile') ?? undefined);
    return meta ? briefs.get(meta.id) : null;
  });
  router.get('/api/briefs/:id', ({ params }) => briefs.get(params[0]) ?? notFound('brief not found'));
  router.get('/api/briefs/:id/export/:fmt', ({ params }) => {
    const b = briefs.get(params[0]) ?? notFound('brief not found');
    const name = `pulse-${b.kind}-${b.date}`;
    switch (params[1]) {
      case 'md': return new Raw(toMarkdown(b), 'text/markdown; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}.md"` });
      case 'txt': return new Raw(toText(b), 'text/plain; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}.txt"` });
      case 'html': return new Raw(toHtmlEmail(b), 'text/html; charset=utf-8');
      case 'json': return new Raw(JSON.stringify(b, null, 2), 'application/json', { 'Content-Disposition': `attachment; filename="${name}.json"` });
      default: bad('format must be md, txt, html or json');
    }
  });
  router.post('/api/briefs/regenerate', async ({ body }) => {
    const b = await body<{ profileId?: string }>();
    return briefs.regenerate(b.profileId ?? 'morning');
  });
  router.post('/api/briefs/preview', async ({ body }) => briefs.preview(await body<BriefProfile>()));
  router.get('/api/brief-profiles', () => briefs.profiles());

  // ---------------------------------------------------------------- export / import everything
  router.get('/api/export', () => ({
    version: 2, exportedAt: Date.now(), tz: homeTz(),
    docs: Object.fromEntries(PUBLIC_COLLECTIONS.map((c) => [c, docs.list(c)])),
    watchlist: d.watchlist(), alerts: d.alerts.rules,
  }));
  router.post('/api/import', async ({ body }) => {
    const b = await body<{ version?: number; tz?: string; docs?: Record<string, { id: string }[]> }>();
    if (b.version !== 2 || !b.docs) bad('not a PULSE 2 export');
    if (b.tz && validTz(b.tz)) kvSet('user.tz', b.tz);
    for (const [c, list] of Object.entries(b.docs)) {
      if (!isCollection(c) || c === 'integrations' || !Array.isArray(list)) continue;
      docs.replaceAll(c, list.filter((x) => x && typeof x.id === 'string'));
    }
    d.broadcast({ t: 'doc', c: '*', op: 'put', d: { id: '*' } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- jobs
  router.get('/api/scheduler', () => scheduler.stats());
  router.post('/api/scheduler/:id/run', async ({ params }) => {
    await scheduler.runNow(params[0]);
    return scheduler.stats().find((s) => s.id === params[0]) ?? notFound();
  });

  return {
    router, briefs,
    use(f: V2Feature) {
      features.push(f);
      f.routes?.(router);
    },
    setDeliver(fn: typeof deliver) { deliver = fn; },
    setMeetings(fn: typeof meetings) { meetings = fn; },
    start() {
      briefs.start();
      for (const f of features) f.start?.();
      scheduler.start();
    },
    stop() {
      scheduler.stop();
      for (const f of features) f.stop?.();
    },
    handle: (req: IncomingMessage, res: ServerResponse) => router.handle(req, res),
    snapshotExtra() {
      return { intel: [...d.hub.intel.values()], exposure: null, handoffs: briefs.handoffs, replayAvailable: true };
    },
    kvGet, kvSet,
  };
}

export type V2 = ReturnType<typeof createV2>;
