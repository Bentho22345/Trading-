export const API = process.env.NEXT_PUBLIC_RADAR_API || '';

export function wsUrl(): string {
  if (API) return API.replace(/^http/, 'ws') + '/ws';
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, {
    credentials: API ? 'include' : 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (r.status === 401 && typeof window !== 'undefined' && !path.startsWith('/api/login') && location.pathname !== '/login') {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).detail || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return r.json();
}

export type Token = {
  address: string; chain: string; name?: string; symbol?: string; image?: string; source?: string;
  launched_at?: number; first_seen: number; graduated_at?: number; boost_amount?: number; has_profile?: number;
  pump_mcap_sol?: number; pump_mcap_as_of?: number; deployer?: string;
  pair_address?: string; dex?: string; url?: string; price_usd?: number; liquidity_usd?: number; fdv?: number;
  market_cap?: number; vol_m5?: number; vol_h1?: number; vol_h6?: number; vol_h24?: number;
  buys_m5?: number; sells_m5?: number; buys_h1?: number; sells_h1?: number; buys_h24?: number; sells_h24?: number;
  chg_m5?: number; chg_h1?: number; chg_h6?: number; chg_h24?: number; pair_created_at?: number; as_of?: number;
  rug_score?: number; mint_authority?: string; freeze_authority?: string; lp_locked_pct?: number; top10_pct?: number;
  holders?: number; rugged?: number; safety_as_of?: number;
};

// ---- instant page loads: last response per URL kept in memory (and sessionStorage), shown first, then refreshed ----
const MEM = new Map<string, { at: number; data: unknown }>();
function readSession(path: string): { at: number; data: unknown } | undefined {
  try { const v = sessionStorage.getItem(`radar:api:${path}`); return v ? JSON.parse(v) : undefined; } catch { return undefined; }
}
/** Synchronous peek at the last known response for `path` (memory, then this tab's session storage). */
export function peek<T = any>(path: string): T | undefined {
  const hit = MEM.get(path) ?? (typeof window !== 'undefined' ? readSession(path) : undefined);
  if (hit) MEM.set(path, hit);
  return hit?.data as T | undefined;
}
/** `api()` that also remembers the response, so the next visit to the page paints immediately. */
export async function apiCached<T = any>(path: string): Promise<T> {
  const data = await api<T>(path);
  const entry = { at: Date.now(), data };
  MEM.set(path, entry);
  try { const s = JSON.stringify(entry); if (s.length < 400_000) sessionStorage.setItem(`radar:api:${path}`, s); } catch { /* quota / private mode */ }
  return data;
}
