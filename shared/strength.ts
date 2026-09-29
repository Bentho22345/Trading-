import { MAJORS, MAJOR_PAIRS } from './symbols';

/**
 * Relative currency strength: for each major, the average % change of every
 * pair it appears in (sign-adjusted so "currency went up" is positive).
 * Input: map pair -> % change over the window.
 */
export function currencyStrength(pairChanges: Record<string, number | undefined>): { ccy: string; score: number }[] {
  const acc: Record<string, { sum: number; n: number }> = {};
  for (const c of MAJORS) acc[c] = { sum: 0, n: 0 };
  for (const pair of MAJOR_PAIRS) {
    const pct = pairChanges[pair];
    if (pct === undefined || !Number.isFinite(pct)) continue;
    const b = pair.slice(0, 3), q = pair.slice(3);
    acc[b].sum += pct; acc[b].n++;
    acc[q].sum -= pct; acc[q].n++;
  }
  return MAJORS.map((ccy) => ({ ccy, score: acc[ccy].n ? acc[ccy].sum / acc[ccy].n : 0 })).sort((a, b) => b.score - a.score);
}
