'use client';
import type { StructureEvent } from '@shared/v2';
import { IntelPanel } from './shell';

const KIND: Record<string, string> = { holiday: 'var(--down)', halfday: 'var(--warn)', opex: 'var(--eq)', quad: 'var(--eq)', rebalance: 'var(--accent)', roll: 'var(--cmdty)', monthend: 'var(--macro)', quarterend: 'var(--macro)', dst: 'var(--rates)' };

export function StructurePanel() {
  return (
    <IntelPanel<StructureEvent[]> k="structure" title="Market structure" accent="var(--macro)">
      {(items) => (
        <ul className="space-y-1">
          {items.slice(0, 18).map((e) => (
            <li key={e.id} className="flex items-start gap-2 text-[11px]">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: KIND[e.kind] }} />
              <span className="num w-12 shrink-0 text-faint">{new Date(`${e.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>
              <span className="text-dim">{e.label}</span>
            </li>
          ))}
        </ul>
      )}
    </IntelPanel>
  );
}
