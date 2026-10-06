'use client';
import { useEffect, useState } from 'react';
import type { Brief } from '@shared/v2';
import { api, useV2 } from '@/lib/v2';
import { Panel } from '../ui';
import { EmptyCard } from '../brief/bits';

export function BriefCard() {
  const latest = useV2((s) => s.latestBrief);
  const [b, setB] = useState<Brief | null | undefined>(undefined);
  useEffect(() => { void api<Brief | null>('/api/briefs/latest?kind=morning').then(setB).catch(() => setB(null)); }, [latest?.id]);
  return (
    <Panel title="Today's brief" accent="var(--accent)">
      {b === undefined ? <div className="skeleton h-24" /> : !b ? <EmptyCard text="No brief yet today." action="Generate now" onAction={() => useV2.getState().openBrief(null)} /> : (
        <button onClick={() => useV2.getState().openBrief(b.id)} className="block text-left">
          <div className="font-serif text-lg leading-snug text-text">{b.headline}</div>
          <p className="mt-1 line-clamp-5 font-serif text-[13px] leading-relaxed text-dim">{b.take.text}</p>
          <span className="mt-2 inline-block text-[11px] text-faint">Open the full brief (M) →</span>
        </button>
      )}
    </Panel>
  );
}
