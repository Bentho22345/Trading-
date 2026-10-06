'use client';
import { useMemo } from 'react';
import type { NewsCluster } from '@shared/types';
import type { Position } from '@shared/v2';
import { useDocs } from './v2';

/** Same proxy rules as the server's brief builder: held tickers, FX pairs and simple correlated proxies. */
export function touchesBook(c: Pick<NewsCluster, 'tickers' | 'currencies'>, held: Set<string>): boolean {
  if (!held.size) return false;
  if (c.tickers.some((t) => held.has(t))) return true;
  for (const p of held) if (p.length === 6 && /^[A-Z]{6}$/.test(p) && (c.currencies.includes(p) || (c.currencies.includes(p.slice(0, 3)) && c.currencies.includes(p.slice(3))))) return true;
  if (held.has('BTC') && c.tickers.some((t) => t === 'COIN' || t === 'MSTR')) return true;
  if ((held.has('GOLD') || held.has('XAUUSD')) && c.currencies.includes('XAU')) return true;
  return false;
}

export function useHeld(): Set<string> {
  const positions = useDocs<Position>('positions');
  return useMemo(() => new Set(positions.map((p) => p.symbol.toUpperCase())), [positions]);
}
