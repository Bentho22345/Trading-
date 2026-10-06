import type { AlertEvent, AlertRule, NewsCluster } from '../shared/types';
import type { AlertHistoryItem, AlertRoute, DestinationType, Level, PlaybookOutcome, Severity, SmartFeed, ThemeItem } from '../shared/v2';
import { SYMBOL_MAP } from '../shared/symbols';
import { matches } from '../shared/rules';
import { zonedParts } from '../shared/sessions';
import { touchesHeld } from '../shared/relevance';
import { sqlite } from './db/client';
import { docs } from './docs';
import { kvGet, kvSet } from './kv';
import type { AlertEngine } from './alerts';
import type { NewsPipeline } from './news/pipeline';
import { scheduler } from './scheduler';
import { bad, type Router } from './router';
import type { V2Feature } from './v2';
import { homeTz } from './brief/service';
import { enqueueType, sendPush } from './integrations';
import { aiJson, aiEnabled } from './ai/client';
import type { Position } from '../shared/v2';

interface AlertSettings { quietHours: { enabled: boolean; start: string; end: string } }
const DEFAULT_ROUTE: AlertRoute = { id: 'default', severity: 'normal', destinations: ['toast', 'push'], digestMin: 0 };

const minutes = (hm: string) => { const [h, m] = hm.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
export function inQuietHours(now: number, tz: string, q: AlertSettings['quietHours']): boolean {
  if (!q.enabled) return false;
  const z = zonedParts(now, tz);
  const t = z.h * 60 + z.min, a = minutes(q.start), b = minutes(q.end);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

// ------------------------------------------------------------------ plain-English alert parser
const SYM_ALIASES: Record<string, string> = { bitcoin: 'BTC', btc: 'BTC', ethereum: 'ETH', ether: 'ETH', eth: 'ETH', gold: 'GOLD', oil: 'WTI', crude: 'WTI', 'the dollar': 'DXY', dollar: 'DXY', dxy: 'DXY', yen: 'USDJPY', euro: 'EURUSD', 'the s&p': 'SPX', 's&p': 'SPX', nasdaq: 'NDX', vix: 'VIX', '10y': 'US10Y', '10-year': 'US10Y', '2y': 'US2Y', solana: 'SOL' };
function findSymbol(t: string): string | null {
  for (const [k, v] of Object.entries(SYM_ALIASES)) if (new RegExp(`\\b${k.replace(/[&]/g, '\\&')}\\b`, 'i').test(t)) return v;
  for (const w of t.toUpperCase().replace(/[^A-Z0-9/ ]/g, ' ').split(/\s+/)) { const s = w.replace('/', ''); if (SYMBOL_MAP[s]) return s; }
  return null;
}

export function parseAlertText(text: string): Partial<AlertRule> | null {
  const t = text.trim();
  const sym = findSymbol(t);
  const conditions: NonNullable<AlertRule['conditions']> = [];
  if (/funding (is |turns )?(positive|above zero)/i.test(t)) conditions.push({ metric: 'funding', op: '>', value: 0 });
  if (/funding (is |turns )?(negative|below zero)/i.test(t)) conditions.push({ metric: 'funding', op: '<', value: 0 });
  const vixC = /vix (is )?(above|over|below|under) (\d+(\.\d+)?)/i.exec(t);
  if (vixC && sym !== 'VIX') conditions.push({ metric: 'vix', op: /above|over/i.test(vixC[2]) ? '>' : '<', value: Number(vixC[3]) });
  const pct = /(drops?|falls?|down|declines?|sinks?|rises?|gains?|up|jumps?|rallies|moves?|swings?)\s+(by\s+)?(\d+(\.\d+)?)\s*%(\s*(in|within|over)\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?))?/i.exec(t);
  if (sym && pct) {
    const dir = /drop|fall|down|decline|sink/i.test(pct[1]) ? 'down' : /rise|gain|up|jump|rall/i.test(pct[1]) ? 'up' : 'either';
    const n = Number(pct[7] ?? 0), unit = (pct[8] ?? 'h').toLowerCase();
    const windowMin = pct[7] ? (unit.startsWith('m') ? n : unit.startsWith('h') ? n * 60 : n * 1440) : 1440;
    return { kind: 'pct_move', symbol: sym, pct: Number(pct[3]), windowMin, moveDir: dir, conditions, label: t };
  }
  const lvl = /(above|over|crosses|breaks|below|under|drops below|falls below|goes above)\s+\$?([\d,]+(\.\d+)?)/i.exec(t);
  if (sym && lvl) return { kind: 'price_cross', symbol: sym, level: Number(lvl[2].replace(/,/g, '')), direction: /below|under/i.test(lvl[1]) ? 'below' : /cross/i.test(lvl[1]) ? 'cross' : 'above', conditions, label: t };
  const kw = /(headline|news|story|stories|mention(s|ing)?)\s+(about|on|of|mentioning|with)?\s*["“]?([^"”]+?)["”]?$/i.exec(t);
  if (kw) return { kind: 'keyword', keyword: kw[4].trim().slice(0, 60), label: t };
  return null;
}

const RULE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['price_cross', 'pct_move', 'keyword'] }, symbol: { type: 'string' }, level: { type: 'number' },
    direction: { type: 'string', enum: ['above', 'below', 'cross'] }, pct: { type: 'number' }, windowMin: { type: 'number' }, moveDir: { type: 'string', enum: ['up', 'down', 'either'] }, keyword: { type: 'string' },
    conditions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['metric', 'op', 'value'], properties: { metric: { type: 'string', enum: ['funding', 'price', 'changePct', 'vix', 'fearGreed'] }, symbol: { type: 'string' }, op: { type: 'string', enum: ['>', '<'] }, value: { type: 'number' } } } },
  },
} as const;

export function describeRule(r: Partial<AlertRule>): string {
  const cond = (r.conditions ?? []).map((c) => `${c.metric}${c.symbol ? ` (${c.symbol})` : ''} ${c.op} ${c.value}`).join(' and ');
  const base = r.kind === 'price_cross' ? `${r.symbol} ${r.direction === 'cross' ? 'crosses' : `goes ${r.direction}`} ${r.level}`
    : r.kind === 'pct_move' ? `${r.symbol} moves ${r.moveDir === 'down' ? 'down' : r.moveDir === 'up' ? 'up' : ''} ${r.pct}% within ${r.windowMin! >= 60 ? `${+(r.windowMin! / 60).toFixed(1)}h` : `${r.windowMin}m`}`.replace(/\s+/g, ' ')
      : `a headline mentions “${r.keyword}”`;
  return `Alert when ${base}${cond ? ` while ${cond}` : ''}.`;
}

export function alerts2Feature(alerts: AlertEngine, pipeline: NewsPipeline, broadcast: (d: AlertHistoryItem & { squawk?: boolean; push?: boolean }) => void, hooks: { playbook: ((o: PlaybookOutcome) => void)[]; theme: ((t: ThemeItem) => void)[] }): V2Feature {
  const settings = () => kvGet<AlertSettings>('alert.settings', { quietHours: { enabled: false, start: '22:00', end: '06:30' } });
  const routeFor = (ruleId: string): AlertRoute => docs.get<AlertRoute>('alert_routes', ruleId) ?? (ruleId.startsWith('feed:') ? docs.get<AlertRoute>('alert_routes', 'feeds') : null) ?? docs.get<AlertRoute>('alert_routes', 'default') ?? DEFAULT_ROUTE;
  const digest = new Map<number, AlertHistoryItem[]>();

  const save = (h: AlertHistoryItem) => sqlite.prepare('INSERT INTO alert_history (id, rule_id, ts, message, severity, status, acked_at, snoozed_until, routes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, acked_at = excluded.acked_at, snoozed_until = excluded.snoozed_until, routes = excluded.routes')
    .run(h.id, h.ruleId, h.ts, h.message, h.severity, h.status, h.ackedAt ?? null, h.snoozedUntil ?? null, JSON.stringify(h.routes));

  const sendTo = (dests: DestinationType[], h: AlertHistoryItem) => {
    const msg = { kind: 'alert' as const, title: `${h.severity === 'critical' ? '🚨 ' : ''}PULSE alert`, text: h.message, severity: h.severity };
    const sent: string[] = [];
    for (const d of dests) {
      if (d === 'toast') { sent.push('toast'); continue; }
      if (d === 'push') { void sendPush({ title: 'PULSE alert', body: h.message, tag: h.ruleId, url: '/m' }); sent.push('push'); continue; }
      if (enqueueType(d, msg)) sent.push(d);
    }
    return sent;
  };

  const dispatch = (ev: AlertEvent) => {
    const route = routeFor(ev.ruleId);
    const quiet = inQuietHours(Date.now(), homeTz(), settings().quietHours);
    const h: AlertHistoryItem = { id: ev.id, ruleId: ev.ruleId, ts: ev.ts, message: ev.message, severity: route.severity, status: 'new', routes: [] };
    // quiet hours: only critical alerts break through (in-app toast always recorded)
    const dests = quiet && route.severity !== 'critical' ? route.destinations.filter((d) => d === 'toast') : route.destinations;
    if (route.digestMin > 0 && route.severity === 'low') {
      const slot = Math.floor(Date.now() / (route.digestMin * 60_000));
      digest.set(slot, [...(digest.get(slot) ?? []), h]);
      h.routes = ['digest'];
    } else h.routes = sendTo(dests, h);
    save(h);
    broadcast({ ...h, squawk: !!route.squawk && !quiet, push: h.routes.includes('push') });
    if (route.escalate && !quiet || (route.escalate && route.severity === 'critical')) {
      setTimeout(() => {
        const cur = sqlite.prepare('SELECT status FROM alert_history WHERE id = ?').get(h.id) as { status: string } | undefined;
        if (cur?.status !== 'new') return;
        const routes = [...h.routes, ...sendTo([route.escalate!.to], h)];
        const esc = { ...h, status: 'escalated' as const, routes };
        save(esc);
        broadcast(esc);
      }, Math.max(30, route.escalate!.afterSec) * 1000);
    }
  };

  const flushDigests = () => {
    const nowSlotBase = Date.now();
    for (const [slot, items] of digest) {
      const route = routeFor(items[0].ruleId);
      if ((slot + 1) * route.digestMin * 60_000 > nowSlotBase) continue;
      digest.delete(slot);
      const text = items.map((i) => `• ${i.message}`).join('\n');
      for (const d of route.destinations) if (d !== 'toast') d === 'push' ? void sendPush({ title: `PULSE digest (${items.length})`, body: text.slice(0, 200) }) : enqueueType(d, { kind: 'digest', title: `PULSE alert digest (${items.length})`, text });
    }
  };

  // smart feeds with alerts attached
  const firedFeed = new Set<string>();
  const onCluster = (c: NewsCluster) => {
    const held = new Set(docs.list<Position>('positions').map((p) => p.symbol.toUpperCase()));
    for (const f of docs.list<SmartFeed>('smart_feeds').filter((x) => x.alert)) {
      const key = `${f.id}:${c.id}`;
      if (firedFeed.has(key) || Date.now() - c.receivedAt > 10 * 60_000) continue;
      if (matches(f.query, c, { watch: !!c.watchHit, inBook: touchesHeld(c, held) })) {
        firedFeed.add(key);
        if (firedFeed.size > 5000) firedFeed.clear();
        alerts.external(`feed:${f.id}`, `${f.name}: ${c.headline}`, { clusterId: c.id });
      }
    }
  };

  // levels with "alert" on become price-cross rules (id level:<id>)
  const syncLevels = () => {
    const levels = docs.list<Level>('levels');
    const want = new Set(levels.filter((l) => l.alert && SYMBOL_MAP[l.symbol]).map((l) => `level-${l.id}`));
    for (const r of alerts.rules.filter((x) => x.id.startsWith('level-') && !want.has(x.id))) alerts.remove(r.id);
    for (const l of levels.filter((x) => x.alert && SYMBOL_MAP[x.symbol])) {
      const existing = alerts.rules.find((r) => r.id === `level-${l.id}`);
      if (!existing || existing.level !== l.price) {
        try { alerts.upsert({ id: `level-${l.id}`, kind: 'price_cross', symbol: l.symbol, level: l.price, direction: 'cross', label: `Level: ${l.label || l.price}` }); } catch { /* unknown symbol */ }
      }
    }
  };

  return {
    start() {
      alerts.on('alert', dispatch);
      pipeline.on('cluster', onCluster);
      hooks.playbook.push((o) => alerts.external('playbook', `Playbook “${o.playbookName}” fired: ${o.scenarioLabel ?? 'no scenario matched'} (${o.eventTitle})`));
      hooks.theme.push((t) => {
        if (kvGet<boolean>('alert.themes', true)) alerts.external('theme', `New top-5 theme: ${t.label}`);
      });
      docs.on('change', (c: string) => c === 'levels' && syncLevels());
      syncLevels();
      scheduler.every('alert-digest', 'Alert digest batching', 60_000, flushDigests);
    },
    routes(r: Router) {
      r.get('/api/alert-history', ({ url }) => {
        const rows = sqlite.prepare('SELECT * FROM alert_history ORDER BY ts DESC LIMIT ?').all(Math.min(500, Number(url.searchParams.get('limit')) || 200)) as Record<string, unknown>[];
        return rows.map((x) => ({ id: x.id, ruleId: x.rule_id, ts: x.ts, message: x.message, severity: x.severity, status: x.snoozed_until && Number(x.snoozed_until) > Date.now() ? 'snoozed' : x.status, ackedAt: x.acked_at, snoozedUntil: x.snoozed_until, routes: JSON.parse(String(x.routes)) }));
      });
      r.get('/api/alert-stats', () => sqlite.prepare("SELECT rule_id AS ruleId, COUNT(*) AS hits, MAX(ts) AS last, SUM(CASE WHEN status = 'acked' THEN 1 ELSE 0 END) AS acked FROM alert_history GROUP BY rule_id").all());
      r.post('/api/alert-history/:id/ack', ({ params }) => {
        sqlite.prepare("UPDATE alert_history SET status = 'acked', acked_at = ? WHERE id = ?").run(Date.now(), params[0]);
        return { ok: true };
      });
      r.post('/api/alert-history/:id/snooze', async ({ params, body }) => {
        const { minutes: m } = await body<{ minutes?: number }>();
        const until = Date.now() + Math.max(1, Math.min(1440, Number(m) || 30)) * 60_000;
        sqlite.prepare("UPDATE alert_history SET status = 'snoozed', snoozed_until = ? WHERE id = ?").run(until, params[0]);
        // snoozing an alert also mutes its rule until then
        const row = sqlite.prepare('SELECT rule_id FROM alert_history WHERE id = ?').get(params[0]) as { rule_id: string } | undefined;
        const rule = alerts.rules.find((x) => x.id === row?.rule_id);
        if (rule) { alerts.upsert({ ...rule, enabled: false }); setTimeout(() => { const cur = alerts.rules.find((x) => x.id === rule.id); if (cur) alerts.upsert({ ...cur, enabled: true }); }, until - Date.now()); }
        return { ok: true, until };
      });
      r.get('/api/alert-settings', () => ({ ...settings(), themeAlerts: kvGet('alert.themes', true) }));
      r.put('/api/alert-settings', async ({ body }) => {
        const b = await body<Partial<AlertSettings> & { themeAlerts?: boolean }>();
        if (b.quietHours) kvSet('alert.settings', { ...settings(), quietHours: { enabled: !!b.quietHours.enabled, start: String(b.quietHours.start ?? '22:00'), end: String(b.quietHours.end ?? '06:30') } });
        if (b.themeAlerts !== undefined) kvSet('alert.themes', !!b.themeAlerts);
        return settings();
      });
      r.post('/api/alerts/parse', async ({ body }) => {
        const { text } = await body<{ text?: string }>();
        if (!text?.trim()) bad('describe the alert');
        let rule = parseAlertText(text);
        let via = 'rules';
        if (!rule && aiEnabled()) {
          rule = await aiJson<Partial<AlertRule>>({ kind: 'alert-parse', small: true, system: `Convert a trader's alert request into a structured rule. Symbols must be one of: ${Object.keys(SYMBOL_MAP).join(', ')}. windowMin is minutes. Funding is a fraction (positive = longs pay).`, user: text, schema: RULE_SCHEMA, maxTokens: 400 }).catch(() => null);
          via = 'ai';
        }
        if (!rule) bad('Could not understand that. Try “BTC drops 5% in 1h while funding is positive” or “EURUSD above 1.18”.');
        return { rule: { ...rule, label: text.trim() }, description: describeRule(rule), via };
      });
      r.post('/api/alerts/test-route', async ({ body }) => {
        const { ruleId } = await body<{ ruleId?: string }>();
        alerts.external(ruleId || 'default', 'Test alert from PULSE routing');
        return { ok: true };
      });
    },
  };
}
