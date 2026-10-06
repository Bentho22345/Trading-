// Quant helpers (pure): returns, correlation, regime score, economic surprise index.
import type { RegimeState } from './v2';

export function returns(series: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) if (series[i - 1] > 0 && series[i] > 0) out.push(Math.log(series[i] / series[i - 1]));
  return out;
}

export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  return Math.max(-1, Math.min(1, cov / Math.sqrt(va * vb)));
}

/** Correlation matrix of log returns; series must be aligned (same timestamps). */
export function correlationMatrix(series: number[][]): number[][] {
  const r = series.map(returns);
  return r.map((a, i) => r.map((b, j) => (i === j ? 1 : +(pearson(a, b) ?? 0).toFixed(3))));
}

/** Pairs whose correlation moved by more than `threshold` between two windows. */
export function correlationBreaks(symbols: string[], now: number[][], prior: number[][], threshold = 0.5) {
  const out: { a: string; b: string; now: number; prior: number }[] = [];
  for (let i = 0; i < symbols.length; i++) for (let j = i + 1; j < symbols.length; j++) {
    if (Math.abs(now[i][j] - prior[i][j]) >= threshold) out.push({ a: symbols[i], b: symbols[j], now: now[i][j], prior: prior[i][j] });
  }
  return out.sort((x, y) => Math.abs(y.now - y.prior) - Math.abs(x.now - x.prior));
}

export interface RegimeInputs {
  spxPct?: number | null;
  vixLevel?: number | null;
  vixPct?: number | null;
  hygPct?: number | null; // credit proxy (IWM / small caps if no HY ETF)
  usdjpyPct?: number | null;
  goldPct?: number | null;
  btcPct?: number | null;
}

const clamp = (v: number, a = -1, b = 1) => Math.max(a, Math.min(b, v));

/**
 * Risk-on/off score −100…+100: equities up, VIX down/low, credit up, JPY weaker (USDJPY up), gold down
 * and BTC up are risk-on. Each input is scaled to a typical daily move, clamped and weighted.
 */
export function regimeScore(i: RegimeInputs): Pick<RegimeState, 'score' | 'label' | 'components'> {
  const parts: { name: string; value: number | null | undefined; scale: number; weight: number; sign: 1 | -1 }[] = [
    { name: 'Equities (SPX)', value: i.spxPct, scale: 1, weight: 0.25, sign: 1 },
    { name: 'VIX change', value: i.vixPct, scale: 8, weight: 0.15, sign: -1 },
    { name: 'VIX level', value: i.vixLevel === null || i.vixLevel === undefined ? null : i.vixLevel - 18, scale: 8, weight: 0.1, sign: -1 },
    { name: 'Credit / small caps', value: i.hygPct, scale: 1.2, weight: 0.15, sign: 1 },
    { name: 'JPY (USDJPY)', value: i.usdjpyPct, scale: 0.6, weight: 0.12, sign: 1 },
    { name: 'Gold', value: i.goldPct, scale: 1, weight: 0.1, sign: -1 },
    { name: 'Bitcoin', value: i.btcPct, scale: 3, weight: 0.13, sign: 1 },
  ];
  let total = 0, wsum = 0;
  const components: RegimeState['components'] = [];
  for (const p of parts) {
    if (p.value === null || p.value === undefined || !Number.isFinite(p.value)) continue;
    const c = clamp((p.value / p.scale) * p.sign);
    total += c * p.weight;
    wsum += p.weight;
    components.push({ name: p.name, value: +p.value.toFixed(3), contribution: +(c * p.weight * 100).toFixed(1) });
  }
  const score = wsum ? Math.round((total / wsum) * 100) : 0;
  return { score, label: score >= 20 ? 'risk-on' : score <= -20 ? 'risk-off' : 'neutral', components };
}

/**
 * Economic surprise index: exponentially decayed sum of standardized surprises
 * ((actual − consensus) / stdev of that series' surprises), sign-flipped for lower-is-better series.
 */
export function surpriseIndex(rows: { series: string; time: number; actual: number; consensus: number; lowerIsBetter?: boolean }[], halfLifeDays = 30, now = Date.now()): { value: number; series: { t: number; v: number }[] } {
  const bySeries = new Map<string, number[]>();
  for (const r of rows) bySeries.set(r.series, [...(bySeries.get(r.series) ?? []), r.actual - r.consensus]);
  const sd = new Map<string, number>();
  for (const [k, v] of bySeries) {
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    const s = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, v.length - 1));
    sd.set(k, s || Math.abs(m) || 1);
  }
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const lambda = Math.LN2 / (halfLifeDays * 86400_000);
  let value = 0, lastT = sorted[0]?.time ?? now;
  const series: { t: number; v: number }[] = [];
  for (const r of sorted) {
    value *= Math.exp(-lambda * (r.time - lastT));
    lastT = r.time;
    const z = clamp((r.actual - r.consensus) / sd.get(r.series)!, -3, 3) * (r.lowerIsBetter ? -1 : 1);
    value += z;
    series.push({ t: r.time, v: +value.toFixed(3) });
  }
  value *= Math.exp(-lambda * (now - lastT));
  return { value: +value.toFixed(3), series };
}

/** "When X beat by >T, SYM rose in the first 30m 9 of 12 times" */
export function baseRate(rows: { surprise: number | null; move: number | undefined }[], threshold: number, direction: 'beat' | 'miss') {
  const sel = rows.filter((r) => r.surprise !== null && r.move !== undefined && (direction === 'beat' ? r.surprise! > threshold : r.surprise! < -threshold));
  const up = sel.filter((r) => r.move! > 0).length;
  return { n: sel.length, up, down: sel.length - up };
}
