import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { config, keys } from '../config';
import { sqlite } from '../db/client';
import { kvGet, kvSet } from '../kv';

/**
 * One gateway for every model call PULSE makes (TL;DRs, brief narrative, Ask Pulse, theme labels,
 * filing one-liners, smart-alert parsing). Enforces the daily token budget, caches by content hash,
 * records usage + estimated cost per feature, and opts into server-side refusal fallbacks.
 * When there is no key or the budget is spent, callers fall back to deterministic templates.
 */

// $ per 1M tokens (input, output) — Anthropic first-party list prices
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-fable-5-1': [10, 50], 'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5], 'claude-haiku-4-5-20251001': [1, 5],
};
const SUPPORTS_EFFORT = /^claude-(opus-5|opus-4-[5-8]|fable|sonnet-5)/;
const SUPPORTS_FALLBACK = /^claude-(fable-5-1|opus-5|sonnet-5-5)/;

export const SMALL_MODEL = process.env.ANTHROPIC_SMALL_MODEL?.trim() || 'claude-haiku-4-5';

export const anthropic: Anthropic | null = keys.anthropic ? new Anthropic({ apiKey: keys.anthropic, maxRetries: 1, timeout: 60_000 }) : null;
export const aiEnabled = () => !!anthropic;

const today = () => new Date().toISOString().slice(0, 10);

export function dailyBudget(): number {
  return kvGet<number>('ai.dailyTokenBudget', Number(process.env.AI_DAILY_TOKEN_BUDGET) || 300_000);
}
export function setDailyBudget(n: number) {
  kvSet('ai.dailyTokenBudget', Math.max(0, Math.min(50_000_000, Math.round(n))));
}

export interface UsageRow { day: string; kind: string; input_tokens: number; output_tokens: number; calls: number; cost_usd: number }

export function usageToday(): { used: number; budget: number; costUsd: number; rows: UsageRow[] } {
  const rows = sqlite.prepare('SELECT * FROM ai_usage WHERE day = ?').all(today()) as UsageRow[];
  return { used: rows.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0), budget: dailyBudget(), costUsd: rows.reduce((s, r) => s + r.cost_usd, 0), rows };
}

export function budgetLeft(): number {
  const u = usageToday();
  return u.budget - u.used;
}

export function recordUsage(kind: string, model: string, usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined) {
  if (!usage) return;
  const inTok = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const outTok = usage.output_tokens ?? 0;
  const [pi, po] = PRICES[model] ?? [4, 20];
  const cost = ((usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1) / 1e6 * pi + (outTok / 1e6) * po;
  sqlite.prepare(`INSERT INTO ai_usage (day, kind, input_tokens, output_tokens, calls, cost_usd) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(day, kind) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
    calls = calls + 1, cost_usd = cost_usd + excluded.cost_usd`).run(today(), kind, inTok, outTok, cost);
}

export function cacheGet<T>(key: string, maxAgeMs = 7 * 86400_000): T | null {
  const row = sqlite.prepare('SELECT value, created_at FROM ai_cache WHERE key = ?').get(key) as { value: string; created_at: number } | undefined;
  if (!row || Date.now() - row.created_at > maxAgeMs) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}
export function cacheSet(key: string, value: unknown) {
  sqlite.prepare('INSERT INTO ai_cache (key, value, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at').run(key, JSON.stringify(value), Date.now());
}
export const hashKey = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);

export class BudgetExceeded extends Error {
  constructor() {
    super('daily AI token budget reached');
  }
}

export interface JsonCall {
  kind: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  small?: boolean;
  effort?: 'low' | 'medium' | 'high';
  cacheKey?: string;
  cacheMaxAgeMs?: number;
}

/** Structured-output call; returns parsed JSON or null (no key, budget spent, refusal, bad output). */
export async function aiJson<T>(c: JsonCall): Promise<T | null> {
  if (!anthropic) return null;
  if (c.cacheKey) {
    const hit = cacheGet<T>(c.cacheKey, c.cacheMaxAgeMs);
    if (hit) return hit;
  }
  if (budgetLeft() <= (c.maxTokens ?? 1024)) throw new BudgetExceeded();
  const model = c.small ? SMALL_MODEL : config.aiModel;
  const params: Record<string, unknown> = {
    model,
    max_tokens: c.maxTokens ?? 1024,
    system: c.system,
    messages: [{ role: 'user', content: c.user }],
    output_config: { format: { type: 'json_schema', schema: c.schema }, ...(SUPPORTS_EFFORT.test(model) ? { effort: c.effort ?? 'low' } : {}) },
  };
  if (SUPPORTS_FALLBACK.test(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const res = (await anthropic.beta.messages.create(params as never)) as Anthropic.Beta.BetaMessage;
  recordUsage(c.kind, model, res.usage);
  if (res.stop_reason === 'refusal') return null;
  const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text;
  if (!text) return null;
  try {
    const out = JSON.parse(text) as T;
    if (c.cacheKey) cacheSet(c.cacheKey, out);
    return out;
  } catch {
    return null;
  }
}

export { SUPPORTS_EFFORT, SUPPORTS_FALLBACK };
