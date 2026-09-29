import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import type { AlertEvent, AlertRule, NewsCluster, Quote } from '../shared/types';
import { SYMBOL_MAP } from '../shared/symbols';
import { db, schema } from './db/client';
import type { Hub } from './hub';

/**
 * Server-side alert evaluation, so rules fire even while the tab is hidden; the browser
 * turns 'alert' events into toasts / Notifications.
 */
export class AlertEngine extends EventEmitter {
  rules: AlertRule[] = [];
  private lastPrice = new Map<string, number>();
  private firedClusters = new Set<string>();

  constructor(private hub: Hub) {
    super();
  }

  load() {
    this.rules = db.select().from(schema.alerts).all().map((r) => r.rule as AlertRule);
  }

  upsert(input: Partial<AlertRule>): AlertRule {
    const rule = this.validate(input);
    const existing = this.rules.findIndex((r) => r.id === rule.id);
    if (existing >= 0) this.rules[existing] = rule;
    else this.rules.push(rule);
    db.insert(schema.alerts).values({ id: rule.id, rule, createdAt: rule.createdAt })
      .onConflictDoUpdate({ target: schema.alerts.id, set: { rule } }).run();
    this.emit('rules', this.rules);
    return rule;
  }

  remove(id: string) {
    this.rules = this.rules.filter((r) => r.id !== id);
    db.delete(schema.alerts).where(eq(schema.alerts.id, id)).run();
    this.emit('rules', this.rules);
  }

  private validate(i: Partial<AlertRule>): AlertRule {
    const kind = i.kind === 'pct_move' || i.kind === 'keyword' ? i.kind : 'price_cross';
    const symbol = i.symbol?.toUpperCase().replace(/[^A-Z]/g, '');
    if (kind !== 'keyword' && (!symbol || !SYMBOL_MAP[symbol])) throw new Error(`unknown symbol ${i.symbol ?? ''}`);
    if (kind === 'price_cross' && !(Number(i.level) > 0)) throw new Error('level required');
    if (kind === 'pct_move' && !(Number(i.pct) > 0)) throw new Error('pct required');
    if (kind === 'keyword' && !(i.keyword && i.keyword.trim().length >= 2)) throw new Error('keyword required');
    return {
      id: i.id ?? randomUUID(),
      kind,
      symbol: kind === 'keyword' ? undefined : symbol,
      level: kind === 'price_cross' ? Number(i.level) : undefined,
      direction: kind === 'price_cross' ? (i.direction ?? 'cross') : undefined,
      pct: kind === 'pct_move' ? Number(i.pct) : undefined,
      windowMin: kind === 'pct_move' ? Math.max(1, Math.min(1440, Number(i.windowMin) || 60)) : undefined,
      keyword: kind === 'keyword' ? i.keyword!.trim().slice(0, 80) : undefined,
      enabled: i.enabled ?? true,
      once: i.once ?? false,
      createdAt: i.createdAt ?? Date.now(),
      lastFiredAt: i.lastFiredAt ?? null,
    };
  }

  onQuotes(qs: Quote[]) {
    if (!this.rules.length) return;
    const now = Date.now();
    for (const q of qs) {
      const prev = this.lastPrice.get(q.symbol);
      this.lastPrice.set(q.symbol, q.price);
      for (const r of this.rules) {
        if (!r.enabled || r.symbol !== q.symbol) continue;
        const d = SYMBOL_MAP[q.symbol]?.decimals ?? 2;
        if (r.kind === 'price_cross' && prev !== undefined && r.level) {
          const up = prev < r.level && q.price >= r.level;
          const down = prev > r.level && q.price <= r.level;
          if ((r.direction === 'above' && up) || (r.direction === 'below' && down) || (r.direction === 'cross' && (up || down))) {
            if (r.lastFiredAt && now - r.lastFiredAt < 60_000) continue; // debounce chatter around the level
            this.fire(r, `${q.symbol} crossed ${up ? 'above' : 'below'} ${r.level.toFixed(d)} (now ${q.price.toFixed(d)})`, { symbol: q.symbol });
          }
        } else if (r.kind === 'pct_move' && r.pct && r.windowMin) {
          if (r.lastFiredAt && now - r.lastFiredAt < r.windowMin * 60_000) continue;
          const then = this.hub.priceAt(q.symbol, now - r.windowMin * 60_000);
          if (!then) continue;
          const pct = ((q.price - then) / then) * 100;
          if (Math.abs(pct) >= r.pct) {
            const win = r.windowMin >= 60 ? `${+(r.windowMin / 60).toFixed(1)}h` : `${r.windowMin}m`;
            this.fire(r, `${q.symbol} ${pct > 0 ? '+' : ''}${pct.toFixed(2)}% in ${win} (${q.price.toFixed(d)})`, { symbol: q.symbol });
          }
        }
      }
    }
  }

  onCluster(c: NewsCluster) {
    for (const r of this.rules) {
      if (!r.enabled || r.kind !== 'keyword' || !r.keyword) continue;
      const key = `${r.id}:${c.id}`;
      if (this.firedClusters.has(key)) continue;
      const hay = `${c.headline} ${c.articles.map((a) => a.headline).join(' ')}`.toLowerCase();
      if (hay.includes(r.keyword.toLowerCase())) {
        this.firedClusters.add(key);
        if (this.firedClusters.size > 5000) this.firedClusters.clear();
        this.fire(r, `“${r.keyword}” — ${c.headline}`, { clusterId: c.id });
      }
    }
  }

  private fire(r: AlertRule, message: string, extra: { symbol?: string; clusterId?: string }) {
    const ev: AlertEvent = { id: randomUUID(), ruleId: r.id, message, ts: Date.now(), ...extra };
    r.lastFiredAt = ev.ts;
    if (r.once) r.enabled = false;
    db.update(schema.alerts).set({ rule: r }).where(eq(schema.alerts.id, r.id)).run();
    db.insert(schema.alertEvents).values({ id: ev.id, ruleId: r.id, message, ts: ev.ts }).run();
    this.emit('alert', ev);
    if (r.once) this.emit('rules', this.rules);
  }
}
