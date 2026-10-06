import type { WatchItem } from '../../shared/types';
import { DEFAULT_WEIGHTS, type ScoreWeights } from '../../shared/v2';

/** Live weights (Settings → Score tuning). */
export const scoring: { weights: ScoreWeights } = { weights: { ...DEFAULT_WEIGHTS } };

export interface ScoreInput {
  credibility: number; // 0..1 (best source in the cluster)
  severity: number; // 0..35 (max keyword severity in the cluster)
  clusterSize: number;
  watchHit: boolean;
  centralBank: boolean;
  /** touches a position in the user's book */
  exposure?: boolean;
}

/**
 * Impact score 0–100:
 *   10 base
 * + up to 25 for source credibility
 * + up to 35 for keyword severity ("rate decision", "halt", "hack", "SEC charges"…)
 * + up to 18 for corroboration (6 per extra source)
 * + 12 when the story touches the user's watchlist
 * + 4 for central-bank stories (they move every asset class)
 */
export function impactScore(i: ScoreInput, w: ScoreWeights = scoring.weights): number {
  const s = w.base + i.credibility * w.credibility + i.severity * w.severity + Math.min(w.maxCorroboration, Math.max(0, i.clusterSize - 1) * w.perSource)
    + (i.watchHit ? w.watchlist : 0) + (i.centralBank ? w.centralBank : 0) + (i.exposure ? w.exposure : 0);
  return Math.max(0, Math.min(100, Math.round(s)));
}

export function watchMatches(
  w: WatchItem[],
  c: { headline: string; summary?: string; tickers: string[]; currencies: string[] },
): boolean {
  if (!w.length) return false;
  const text = `${c.headline} ${c.summary ?? ''}`.toLowerCase();
  for (const item of w) {
    const v = item.value.toUpperCase();
    switch (item.kind) {
      case 'ticker':
      case 'coin':
        if (c.tickers.includes(v)) return true;
        break;
      case 'pair':
        if (c.currencies.includes(v) || (v.length === 6 && c.currencies.includes(v.slice(0, 3)) && c.currencies.includes(v.slice(3)))) return true;
        break;
      case 'keyword':
        if (item.value && text.includes(item.value.toLowerCase())) return true;
        break;
    }
  }
  return false;
}
