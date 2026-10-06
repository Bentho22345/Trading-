import type { IntelBlock, IntelKey, Cadence } from '../../shared/v2';
import { MODE } from '../config';
import { kvGet, kvSet } from '../kv';
import type { Hub } from '../hub';

export interface IntelJob {
  key: IntelKey;
  label: string;
  everyMs: number;
  cadence: Cadence;
  /** live fetcher; return null when no provider is configured (→ "connect a provider" state) */
  live?: (ctx: IntelCtx) => Promise<Omit<IntelBlock, 'key' | 'ts' | 'cadence'> & { cadence?: Cadence } | null>;
  /** demo data, always clearly labelled mock */
  mock?: (ctx: IntelCtx) => Omit<IntelBlock, 'key' | 'ts' | 'cadence' | 'connected' | 'mock'> & { cadence?: Cadence };
  /** derived from PULSE's own data (no provider needed, never mock) */
  derived?: boolean;
  connectHint?: string;
}

export interface IntelCtx { hub: Hub; now: number }

export type IntelMode = 'auto' | 'live' | 'mock' | 'off';
export const intelModes = (): Record<string, IntelMode> => kvGet('intel.modes', {});
export function setIntelMode(key: string, mode: IntelMode) {
  kvSet('intel.modes', { ...intelModes(), [key]: mode });
}

export interface JobHealth { key: string; label: string; mode: string; lastOk: number | null; lastError: string | null; runs: number; errors: number; latencyMs: number[] }
export const jobHealth = new Map<string, JobHealth>();

/** Run one job according to its mode, publish an IntelBlock (always labelled with source, cadence, mock). */
export async function runJob(job: IntelJob, hub: Hub) {
  const h = jobHealth.get(job.key) ?? { key: job.key, label: job.label, mode: 'auto', lastOk: null, lastError: null, runs: 0, errors: 0, latencyMs: [] };
  jobHealth.set(job.key, h);
  const mode = intelModes()[job.key] ?? 'auto';
  h.mode = mode;
  if (mode === 'off') return;
  const ctx = { hub, now: Date.now() };
  const useMock = mode === 'mock' || (mode === 'auto' && MODE === 'mock' && !job.derived);
  const t0 = Date.now();
  h.runs++;
  try {
    if (useMock && job.mock) {
      const m = job.mock(ctx);
      hub.setIntel({ key: job.key, ts: Date.now(), cadence: m.cadence ?? job.cadence, connected: true, mock: true, ...m, source: `${m.source} (demo data)` });
    } else if (job.live) {
      const b = await job.live(ctx);
      if (!b) hub.setIntel({ key: job.key, ts: Date.now(), cadence: job.cadence, connected: false, data: null, source: job.connectHint ?? 'Not connected', note: job.connectHint });
      else hub.setIntel({ key: job.key, ts: Date.now(), ...b, cadence: b.cadence ?? job.cadence });
    }
    h.lastOk = Date.now();
    h.lastError = null;
  } catch (e) {
    h.errors++;
    h.lastError = (e as Error).message.slice(0, 160);
    if (!hub.intel.get(job.key) && job.mock) {
      // never leave a panel blank: show an explicit error-state block
      hub.setIntel({ key: job.key, ts: Date.now(), cadence: job.cadence, connected: true, data: null, source: job.label, note: `Source unreachable: ${h.lastError}` });
    }
  } finally {
    h.latencyMs = [...h.latencyMs, Date.now() - t0].slice(-50);
  }
}

export const UA = () => process.env.SEC_USER_AGENT || 'PulseTerminal/0.2 (set SEC_USER_AGENT="Name email@example.com")';

export async function getJson<T>(url: string, init: RequestInit = {}, timeout = 15_000): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA(), Accept: 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).host}`);
  return res.json() as Promise<T>;
}

export async function getText(url: string, timeout = 15_000): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA(), Accept: '*/*' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).host}`);
  return res.text();
}

// small deterministic PRNG for stable demo data
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
