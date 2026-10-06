import { randomUUID } from 'node:crypto';
import type { EconEvent } from '../shared/types';
import type { Playbook, PlaybookOutcome } from '../shared/v2';
import { matchesEvent, selectScenario, gradeCheck, CHECKPOINTS, PLAYBOOK_TEMPLATES, hitRate } from '../shared/playbook';
import { SYMBOL_MAP } from '../shared/symbols';
import { sqlite } from './db/client';
import { docs } from './docs';
import { kvGet, kvSet } from './kv';
import type { Hub } from './hub';
import { scheduler } from './scheduler';
import type { Router } from './router';
import type { V2Feature } from './v2';

/**
 * When a release posts (actual appears), evaluate every matching playbook, store an outcome with the
 * base prices, then grade the expected moves at +5m / +30m / +2h. Outcomes broadcast as 'playbook'.
 */
export function playbooksFeature(hub: Hub, broadcast: (o: PlaybookOutcome) => void, onFire?: (o: PlaybookOutcome) => void): V2Feature {
  const processed = new Set<string>(kvGet<string[]>('playbooks.processed', []));
  const save = (o: PlaybookOutcome) => sqlite.prepare('INSERT INTO playbook_outcomes (id, playbook_id, event_id, scenario_id, fired_at, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(o.id, o.playbookId, o.eventId, o.scenarioId, o.firedAt, JSON.stringify(o));
  const pending = (): PlaybookOutcome[] => (sqlite.prepare("SELECT data FROM playbook_outcomes WHERE fired_at > ? ORDER BY fired_at DESC").all(Date.now() - 3 * 3600_000) as { data: string }[]).map((r) => JSON.parse(r.data) as PlaybookOutcome).filter((o) => o.status === 'pending');

  const evaluate = (events: EconEvent[]) => {
    const books = docs.list<Playbook>('playbooks').filter((p) => p.enabled && !p.template);
    if (!books.length) return;
    for (const e of events) {
      if (e.actual === null || processed.has(e.id) || Date.now() - e.time > 6 * 3600_000) continue;
      processed.add(e.id);
      for (const p of books) {
        if (!matchesEvent(p, e)) continue;
        const sc = selectScenario(p, e.actual, e.consensus);
        const base = (sym: string) => hub.priceAt(sym, e.time) ?? hub.quotes.get(sym)?.price ?? null;
        const o: PlaybookOutcome = {
          id: randomUUID(), playbookId: p.id, playbookName: p.name, eventId: e.id, eventTitle: `${e.currency} ${e.title}`, scenarioId: sc?.id ?? null, scenarioLabel: sc?.label ?? null,
          firedAt: Date.now(), actual: e.actual, consensus: e.consensus, surprise: e.consensus !== null ? +(e.actual - e.consensus).toFixed(4) : null,
          checks: (sc?.expect ?? []).filter((x) => SYMBOL_MAP[x.symbol]).map((x) => ({ symbol: x.symbol, direction: x.direction, base: base(x.symbol), moves: {}, hits: {} })),
          status: sc?.expect.length ? 'pending' : 'done',
        };
        save(o);
        broadcast(o);
        onFire?.(o);
      }
    }
    kvSet('playbooks.processed', [...processed].slice(-500));
  };

  const grade = () => {
    for (const o of pending()) {
      const ev = hub.calendar.find((e) => e.id === o.eventId);
      const t0 = ev?.time ?? o.firedAt;
      const at = (k: keyof typeof CHECKPOINTS, sym: string) => (Date.now() >= t0 + CHECKPOINTS[k] ? hub.priceAt(sym, t0 + CHECKPOINTS[k]) ?? hub.quotes.get(sym)?.price ?? null : null);
      const checks = o.checks.map((c) => gradeCheck(c, { m5: at('m5', c.symbol), m30: at('m30', c.symbol), h2: at('h2', c.symbol) }));
      const done = Date.now() >= t0 + CHECKPOINTS.h2;
      const next: PlaybookOutcome = { ...o, checks, status: done ? 'done' : 'pending' };
      if (JSON.stringify(next) !== JSON.stringify(o)) {
        save(next);
        broadcast(next);
      }
    }
  };

  return {
    start() {
      hub.on('calendar', evaluate);
      scheduler.every('playbook-grade', 'Playbook outcome grading (+5m/+30m/+2h)', 60_000, grade);
      setTimeout(() => evaluate(hub.calendar), 5000);
    },
    stop() {
      hub.off('calendar', evaluate);
    },
    routes(r: Router) {
      r.get('/api/playbooks/templates', () => PLAYBOOK_TEMPLATES);
      r.get('/api/playbooks/outcomes', ({ url }) => {
        const pb = url.searchParams.get('playbook');
        const rows = (pb ? sqlite.prepare('SELECT data FROM playbook_outcomes WHERE playbook_id = ? ORDER BY fired_at DESC LIMIT 200').all(pb) : sqlite.prepare('SELECT data FROM playbook_outcomes ORDER BY fired_at DESC LIMIT 200').all()) as { data: string }[];
        const list = rows.map((x) => JSON.parse(x.data) as PlaybookOutcome);
        return { outcomes: list, stats: { m5: hitRate(list, 'm5'), m30: hitRate(list, 'm30'), h2: hitRate(list, 'h2') } };
      });
      // test a playbook against a hypothetical print (no outcome stored)
      r.post('/api/playbooks/test', async ({ body }) => {
        const b = await body<{ playbook: Playbook; actual: number; consensus: number }>();
        const sc = selectScenario(b.playbook, Number(b.actual), Number(b.consensus));
        return { scenario: sc };
      });
    },
  };
}
