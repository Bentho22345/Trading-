import type { Hub } from '../hub';
import type { StreamId } from '../../shared/types';

/** A raw article as produced by any news adapter, before normalization. */
export interface RawArticle {
  sourceId: string;
  source: string;
  headline: string;
  summary?: string;
  url: string;
  publishedAt: number;
  demo?: boolean;
  /** Optional hints from the provider (e.g. Finnhub "related" tickers) */
  tickers?: string[];
  category?: string;
  /** Only used by demo backfill to spread items over the past hours */
  receivedAt?: number;
}

export interface Logger {
  info(msg: string, ...a: unknown[]): void;
  warn(msg: string, ...a: unknown[]): void;
  error(msg: string, ...a: unknown[]): void;
}

export interface AdapterContext {
  hub: Hub;
  log: Logger;
  /** Sink for news adapters */
  emitNews: (a: RawArticle) => void;
  /** Number of clusters currently held by the pipeline (lets demo backfill skip after restarts) */
  newsCount: () => number;
}

/**
 * Every data source — mock or real — implements this interface. Adapters write their output
 * into the hub (quotes, calendar, panels) or via emitNews, and report health via
 * hub.touch/hub.setState. They must never throw out of start()/stop().
 */
export interface Adapter {
  /** e.g. "coinbase", "mock-fx" */
  id: string;
  /** The stream this adapter feeds (used for status + staleness) */
  stream: StreamId;
  /** Human-readable provider label shown in the UI */
  provider: string;
  mock: boolean;
  delayedMin: number;
  /** After this long without data the stream is shown as stale */
  staleAfterMs: number;
  start(ctx: AdapterContext): void | Promise<void>;
  stop(): void | Promise<void>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter, capped. */
export function backoff(attempt: number, base = 1000, cap = 30_000) {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export async function fetchJson<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { 'User-Agent': 'PulseTerminal/0.1', ...(init?.headers ?? {}) } });
    if (res.status === 429) throw new RateLimitError(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${redact(url)}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export class RateLimitError extends Error {
  constructor(url: string) {
    super(`rate limited: ${new URL(url).host}`);
  }
}

/** Strip credentials from URLs before they reach logs or the browser-visible status message. */
export function redact(url: string): string {
  return url.replace(/([?&](?:token|apikey|api_key|apiKey|auth_token|key|secret)=)[^&]*/gi, '$1***');
}

/** Error text safe to show in the UI (no credentials, bounded length). */
export function errText(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e)).slice(0, 160);
}

/** setInterval that runs immediately, never overlaps, and survives errors. */
export function poller(fn: () => Promise<void>, everyMs: number, onError: (e: unknown) => void) {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let delay = everyMs;
  const run = async () => {
    if (stopped) return;
    try {
      await fn();
      delay = everyMs;
    } catch (e) {
      onError(e);
      // back off on failure (rate limits in particular)
      delay = Math.min(everyMs * 8, delay * 2);
    }
    if (!stopped) timer = setTimeout(run, delay);
  };
  run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
