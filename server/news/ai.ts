import Anthropic from '@anthropic-ai/sdk';
import type { NewsCluster } from '../../shared/types';
import { config, keys } from '../config';

/**
 * Optional AI layer: one TL;DR + one "why it matters" line per high-impact cluster.
 * Enabled only when ANTHROPIC_API_KEY is set. Cost controls:
 *  - only clusters with impact >= AI_MIN_IMPACT
 *  - at most one summary per cluster, plus one refresh once it gathers 3+ sources
 *  - hourly cap (AI_MAX_PER_HOUR), serial queue, tiny prompt, low effort, short output
 *  - results cached in SQLite (clusters.tldr / clusters.why) and reused across restarts
 */

const SCHEMA = {
  type: 'object',
  properties: {
    tldr: { type: 'string', description: 'One sentence, at most 22 words.' },
    why: { type: 'string', description: 'One sentence on market impact, at most 25 words, naming affected assets.' },
  },
  required: ['tldr', 'why'],
  additionalProperties: false,
} as const;

const SYSTEM =
  'You are a markets desk editor. Given clustered headlines, write a plain TL;DR and a single "why it matters for markets" line. ' +
  'Be factual, use only the provided text, no speculation beyond obvious first-order effects, no advice.';

// Models that accept `effort` and the server-side refusal fallback.
const SUPPORTS_EFFORT = /^claude-(opus-5|opus-4-[5-8]|fable|sonnet-5)/;
const SUPPORTS_FALLBACK = /^claude-(fable-5-1|opus-5|sonnet-5-5)/;

export class AiSummarizer {
  private client: Anthropic | null = keys.anthropic ? new Anthropic({ apiKey: keys.anthropic, maxRetries: 1, timeout: 30_000 }) : null;
  private queue: string[] = [];
  private done = new Map<string, number>(); // cluster id -> source count when summarized
  private stamps: number[] = [];
  private running = false;

  constructor(private get: (id: string) => NewsCluster | null, private save: (id: string, tldr: string, why: string, model: string) => void) {}

  get enabled() {
    return !!this.client;
  }

  consider(c: NewsCluster) {
    if (!this.client || c.impact < config.aiMinImpact) return;
    const n = c.articles.length;
    if (c.tldr && !this.done.has(c.id)) this.done.set(c.id, n); // cached from a previous run
    const prev = this.done.get(c.id);
    if (prev !== undefined && !(prev < 3 && n >= 3)) return;
    if (this.queue.includes(c.id)) return;
    this.done.set(c.id, n);
    this.queue.push(c.id);
    if (this.queue.length > 50) this.queue.shift();
    void this.drain();
  }

  private async drain() {
    if (this.running || !this.client) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const now = Date.now();
        this.stamps = this.stamps.filter((t) => now - t < 3600_000);
        if (this.stamps.length >= config.aiMaxPerHour) break;
        const id = this.queue.shift()!;
        const c = this.get(id);
        if (!c) continue;
        this.stamps.push(now);
        try {
          const out = await this.summarize(c);
          if (out) this.save(id, out.tldr, out.why, config.aiModel);
        } catch (e) {
          if (e instanceof Anthropic.RateLimitError) {
            console.warn('[ai] rate limited; pausing queue');
            this.queue.unshift(id);
            break;
          } else if (e instanceof Anthropic.AuthenticationError) {
            console.error('[ai] invalid ANTHROPIC_API_KEY — disabling AI layer');
            this.client = null;
            break;
          } else if (e instanceof Anthropic.APIError) {
            console.warn(`[ai] API error ${e.status}: ${e.message}`);
          } else {
            console.warn('[ai] summarize failed', e);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async summarize(c: NewsCluster): Promise<{ tldr: string; why: string } | null> {
    const lines = c.articles.slice(0, 6).map((a) => `- ${a.source}: ${a.headline}`).join('\n');
    const user = `Headlines:\n${lines}\nLead summary: ${c.summary.slice(0, 400)}\nAssets: ${[...c.tickers, ...c.currencies].join(', ') || 'n/a'}`;
    const model = config.aiModel;
    const params: Record<string, unknown> = {
      model,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
      output_config: {
        format: { type: 'json_schema', schema: SCHEMA },
        ...(SUPPORTS_EFFORT.test(model) ? { effort: 'low' } : {}),
      },
    };
    const betas: string[] = [];
    if (SUPPORTS_FALLBACK.test(model)) {
      betas.push('server-side-fallback-2026-07-01');
      params.fallbacks = 'default';
    }
    if (betas.length) params.betas = betas;
    const res = (await this.client!.beta.messages.create(params as never)) as Anthropic.Beta.BetaMessage;
    if (res.stop_reason === 'refusal') return null;
    const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text;
    if (!text) return null;
    const parsed = JSON.parse(text) as { tldr?: unknown; why?: unknown };
    if (typeof parsed.tldr !== 'string' || typeof parsed.why !== 'string') return null;
    return { tldr: parsed.tldr.slice(0, 240), why: parsed.why.slice(0, 260) };
  }
}
