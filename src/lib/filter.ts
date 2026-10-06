import type { NewsCluster } from '@shared/types';
import { matches } from '@shared/rules';
import type { FeedFilter } from './store';

export interface FilterState {
  filter: FeedFilter;
  search: string;
  highImpactOnly: boolean;
  breakingOnly: boolean;
  breakingThreshold: number;
  savedIds: Set<string>;
  /** smart feed query (rules engine) */
  query?: string | null;
  inBook?: (c: NewsCluster) => boolean;
}

export const HIGH_IMPACT = 60;

export function matchesFilter(c: NewsCluster, f: FilterState): boolean {
  switch (f.filter) {
    case 'fx': if (!c.domains.includes('fx')) return false; break;
    case 'crypto': if (!c.domains.includes('crypto')) return false; break;
    case 'equities': if (!c.domains.includes('equities') && !c.domains.includes('options')) return false; break;
    case 'macro': if (!c.domains.some((d) => d === 'macro' || d === 'centralbanks' || d === 'rates' || d === 'commodities')) return false; break;
    case 'saved': if (!f.savedIds.has(c.id)) return false; break;
  }
  if (f.query && !matches(f.query, c, { watch: !!c.watchHit, inBook: f.inBook?.(c) ?? false })) return false;
  if (f.highImpactOnly && c.impact < HIGH_IMPACT) return false;
  if (f.breakingOnly && !(c.breaking || c.impact >= f.breakingThreshold)) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/);
    const hay = `${c.headline} ${c.summary} ${c.source} ${c.tickers.join(' ')} ${c.currencies.join(' ')} ${c.tags.join(' ')} ${c.articles.map((a) => a.source).join(' ')}`.toLowerCase();
    for (const t of terms) if (!hay.includes(t.replace(/^\$/, ''))) return false;
  }
  return true;
}

/** Ids in the order the feed displays them — used by keyboard navigation. */
export const feedOrder: { ids: string[] } = { ids: [] };
