import type { Domain } from '@shared/types';

export function fmtPrice(v: number | undefined | null, decimals = 2): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtChange(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s}`;
}

/** Change in basis points for yield instruments (price is a % yield) */
export function fmtBp(change: number): string {
  if (!Number.isFinite(change)) return '—';
  const bp = change * 100;
  return `${bp > 0 ? '+' : bp < 0 ? '−' : ''}${Math.abs(bp).toFixed(1)}bp`;
}

export function fmtPct(v: number | null | undefined, d = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`;
}

export function fmtCompact(v: number | null | undefined, prefix = ''): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const [n, s] = a >= 1e12 ? [v / 1e12, 'T'] : a >= 1e9 ? [v / 1e9, 'B'] : a >= 1e6 ? [v / 1e6, 'M'] : a >= 1e3 ? [v / 1e3, 'K'] : [v, ''];
  return `${prefix}${n.toFixed(a >= 1e3 ? 2 : 0)}${s}`;
}

export function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function countdown(ms: number, withSeconds = true): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return withSeconds ? `${h}:${pad(m)}:${pad(sec)}` : `${h}h ${pad(m)}m`;
  return withSeconds ? `${pad(m)}:${pad(sec)}` : `${m}m`;
}

export function clockTime(ts: number, withSeconds = false) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: false });
}

export function flag(country: string): string {
  const c = country.toUpperCase();
  if (c === 'EU') return '🇪🇺';
  if (!/^[A-Z]{2}$/.test(c)) return '🏳️';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

export const DOMAIN_LABEL: Record<Domain, string> = {
  fx: 'FX', crypto: 'Crypto', equities: 'Equities', options: 'Options', macro: 'Macro', centralbanks: 'Central banks', regulation: 'Regulation', rates: 'Rates', commodities: 'Commodities',
};

/** The primary domain decides the card's accent colour. */
export function primaryDomain(domains: Domain[]): Domain {
  const order: Domain[] = ['centralbanks', 'crypto', 'fx', 'options', 'equities', 'rates', 'commodities', 'regulation', 'macro'];
  return order.find((d) => domains.includes(d)) ?? 'macro';
}

export function pairLabel(symbol: string, assetClass?: string) {
  if (assetClass === 'fx' && symbol.length === 6) return `${symbol.slice(0, 3)}/${symbol.slice(3)}`;
  return symbol;
}
