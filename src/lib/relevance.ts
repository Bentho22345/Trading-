'use client';
import { useMemo } from 'react';
import type { NewsCluster } from '@shared/types';
import type { Position } from '@shared/v2';
import { touchesHeld } from '@shared/relevance';
import { useDocs } from './v2';

export const touchesBook = (c: Pick<NewsCluster, 'tickers' | 'currencies'>, held: Set<string>) => touchesHeld(c, held);

export function useHeld(): Set<string> {
  const positions = useDocs<Position>('positions');
  return useMemo(() => new Set(positions.map((p) => p.symbol.toUpperCase())), [positions]);
}
