// Event playbooks: match a calendar release, pick the scenario that fired, grade the expected moves.
import type { EconEvent } from './types';
import type { OutcomeCheck, Playbook, PlaybookScenario } from './v2';

export function matchesEvent(p: Pick<Playbook, 'eventMatch' | 'currency' | 'enabled'>, e: Pick<EconEvent, 'title' | 'currency'>): boolean {
  if (!p.enabled) return false;
  if (p.currency && p.currency.toUpperCase() !== e.currency.toUpperCase()) return false;
  const words = p.eventMatch.toLowerCase().split(/\s+/).filter(Boolean);
  const title = e.title.toLowerCase();
  return words.length > 0 && words.every((w) => title.includes(w));
}

export function conditionMet(s: PlaybookScenario, actual: number | null, consensus: number | null): boolean {
  if (actual === null) return false;
  const v = s.condition.metric === 'surprise' ? (consensus === null ? null : actual - consensus) : actual;
  if (v === null) return false;
  const { op, value, value2 } = s.condition;
  const eps = 1e-9;
  switch (op) {
    case '>': return v > value + eps;
    case '<': return v < value - eps;
    case '>=': return v >= value - eps;
    case '<=': return v <= value + eps;
    case 'between': return v >= Math.min(value, value2 ?? value) - eps && v <= Math.max(value, value2 ?? value) + eps;
  }
}

/** First scenario (in the user's order) whose condition holds. */
export function selectScenario(p: Playbook, actual: number | null, consensus: number | null): PlaybookScenario | null {
  return p.scenarios.find((s) => conditionMet(s, actual, consensus)) ?? null;
}

export const CHECKPOINTS = { m5: 5 * 60_000, m30: 30 * 60_000, h2: 2 * 3600_000 } as const;

/** Grade an expectation given the base price and the price at each checkpoint (null = not yet reached). */
export function gradeCheck(c: Pick<OutcomeCheck, 'symbol' | 'direction' | 'base'>, prices: { m5?: number | null; m30?: number | null; h2?: number | null }, minMovePct = 0.02): OutcomeCheck {
  const out: OutcomeCheck = { symbol: c.symbol, direction: c.direction, base: c.base, moves: {}, hits: {} };
  if (!c.base) return out;
  for (const k of ['m5', 'm30', 'h2'] as const) {
    const p = prices[k];
    if (p === null || p === undefined) continue;
    const pct = ((p - c.base) / c.base) * 100;
    out.moves[k] = +pct.toFixed(3);
    out.hits[k] = c.direction === 'up' ? pct >= minMovePct : pct <= -minMovePct;
  }
  return out;
}

export function hitRate(outcomes: { checks: OutcomeCheck[] }[], k: 'm5' | 'm30' | 'h2' = 'm30'): { hits: number; total: number; rate: number | null } {
  let hits = 0, total = 0;
  for (const o of outcomes) for (const c of o.checks) if (c.hits[k] !== undefined) { total++; if (c.hits[k]) hits++; }
  return { hits, total, rate: total ? hits / total : null };
}

const sc = (id: string, label: string, metric: 'surprise' | 'actual', op: PlaybookScenario['condition']['op'], value: number, expect: PlaybookScenario['expect'], notes = '', value2?: number): PlaybookScenario => ({ id, label, condition: { metric, op, value, ...(value2 !== undefined ? { value2 } : {}) }, expect, notes });

export const PLAYBOOK_TEMPLATES: Omit<Playbook, 'id' | 'createdAt'>[] = [
  {
    name: 'NFP standard playbook', eventMatch: 'nonfarm payrolls', currency: 'USD', enabled: true, template: true, notes: 'Surprise in thousands. Revisions and unemployment rate can override the headline.',
    scenarios: [
      sc('beat', 'Strong beat (> +50k)', 'surprise', '>', 50, [{ symbol: 'USDJPY', direction: 'up' }, { symbol: 'GOLD', direction: 'down' }, { symbol: 'US2Y', direction: 'up' }], 'Watch USDJPY above the overnight high.'),
      sc('miss', 'Big miss (< −50k)', 'surprise', '<', -50, [{ symbol: 'USDJPY', direction: 'down' }, { symbol: 'GOLD', direction: 'up' }, { symbol: 'US2Y', direction: 'down' }]),
      sc('inline', 'In line (±50k)', 'surprise', 'between', -50, [], 'Fade the initial spike; focus on wages.', 50),
    ],
  },
  {
    name: 'US CPI playbook', eventMatch: 'cpi', currency: 'USD', enabled: true, template: true, notes: 'Surprise in percentage points (0.1 = 10bp).',
    scenarios: [
      sc('hot', 'Hot (≥ +0.1pp)', 'surprise', '>=', 0.1, [{ symbol: 'DXY', direction: 'up' }, { symbol: 'US10Y', direction: 'up' }, { symbol: 'SPX', direction: 'down' }, { symbol: 'GOLD', direction: 'down' }]),
      sc('cool', 'Cool (≤ −0.1pp)', 'surprise', '<=', -0.1, [{ symbol: 'DXY', direction: 'down' }, { symbol: 'US10Y', direction: 'down' }, { symbol: 'SPX', direction: 'up' }, { symbol: 'BTC', direction: 'up' }]),
    ],
  },
  {
    name: 'FOMC day', eventMatch: 'federal funds rate', currency: 'USD', enabled: true, template: true, notes: 'Actual is the policy rate. Pair with the dot plot and press conference tone.',
    scenarios: [
      sc('cut', 'Cut vs hold expected', 'surprise', '<', 0, [{ symbol: 'US2Y', direction: 'down' }, { symbol: 'DXY', direction: 'down' }, { symbol: 'GOLD', direction: 'up' }]),
      sc('hike', 'Hawkish surprise', 'surprise', '>', 0, [{ symbol: 'US2Y', direction: 'up' }, { symbol: 'DXY', direction: 'up' }, { symbol: 'NDX', direction: 'down' }]),
    ],
  },
  {
    name: 'ECB decision', eventMatch: 'main refinancing rate', currency: 'EUR', enabled: true, template: true, notes: '',
    scenarios: [
      sc('dovish', 'Dovish surprise', 'surprise', '<', 0, [{ symbol: 'EURUSD', direction: 'down' }, { symbol: 'DE10Y', direction: 'down' }]),
      sc('hawkish', 'Hawkish surprise', 'surprise', '>', 0, [{ symbol: 'EURUSD', direction: 'up' }, { symbol: 'DE10Y', direction: 'up' }]),
    ],
  },
];
