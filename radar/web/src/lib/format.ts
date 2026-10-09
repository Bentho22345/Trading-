export function usd(v?: number | null, digits = 1): string {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(digits)}K`;
  return `$${v.toFixed(0)}`;
}

export function price(v?: number | null): string {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 1) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  if (v === 0) return '$0';
  // 0.0000612 -> $0.0₄612
  const s = v.toFixed(12);
  const m = s.match(/^0\.(0+)(\d{1,4})/);
  if (m && m[1].length >= 4) return `$0.0${subscript(m[1].length)}${m[2]}`;
  return `$${v.toPrecision(4)}`;
}

function subscript(n: number): string {
  return String(n).split('').map((d) => '₀₁₂₃₄₅₆₇₈₉'[+d]).join('');
}

export function pct(v?: number | null): string {
  if (v == null || !isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)}%`;
}

export function pctClass(v?: number | null): string {
  if (v == null) return 'text-mute';
  return v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-mute';
}

export function ago(ts?: number | null, now = Date.now() / 1000): string {
  if (!ts) return '—';
  const s = Math.max(0, now - ts);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function short(a?: string | null, n = 4): string {
  if (!a) return '—';
  return a.length > n * 2 + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a;
}

export function clock(ts?: number | null): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleTimeString([], { hour12: false });
}
