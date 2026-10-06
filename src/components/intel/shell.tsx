'use client';
import type { ReactNode } from 'react';
import type { IntelBlock, IntelKey } from '@shared/v2';
import { useIntel, useV2, api } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { useNow } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import { Panel, Chip, Icon } from '../ui';

const CADENCE: Record<string, { label: string; cls: string }> = {
  live: { label: 'live', cls: 'border-up/40 text-up' }, delayed: { label: 'delayed', cls: 'border-warn/40 text-warn' },
  daily: { label: 'daily', cls: 'border-rates/40 text-rates' }, weekly: { label: 'weekly', cls: 'border-cmdty/40 text-cmdty' }, estimate: { label: 'estimate', cls: 'border-warn/40 text-warn' },
};

export function CadenceChip({ b }: { b: Pick<IntelBlock, 'cadence' | 'mock' | 'asOf' | 'delayedMin'> }) {
  const c = CADENCE[b.cadence] ?? CADENCE.live;
  return (
    <span className="flex items-center gap-1">
      {b.mock ? <Chip className="border-accent/40 text-accent" title="Demo data — not real market data">demo</Chip> : null}
      <Chip className={c.cls} title={b.asOf ? `As of ${b.asOf}` : undefined}>{c.label}{b.asOf && b.cadence !== 'live' ? ` · ${b.asOf.slice(5)}` : ''}</Chip>
    </span>
  );
}

export async function setDemo(key: IntelKey, on: boolean) {
  try {
    await api(`/api/intel/${key}/mode`, { method: 'PUT', json: { mode: on ? 'mock' : 'auto' } });
  } catch (e) {
    useStore.getState().pushToast({ kind: 'error', title: 'Could not switch data source', body: (e as Error).message });
  }
}

/** Designed "connect a provider" state: icon, one sentence, Connect + Use demo data. */
export function ConnectState({ k, text }: { k: IntelKey; text: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-dashed border-line bg-bg-2/30 px-3 py-4">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-panel-hover text-faint"><Icon name="sparkle" size={14} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-dim">{text}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button onClick={() => useV2.getState().set({ settingsCenter: 'integrations' })} className="rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-text hover:bg-accent/20">Connect</button>
          <button onClick={() => void setDemo(k, true)} className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-dim hover:text-text">Use demo data</button>
        </div>
      </div>
    </div>
  );
}

/** Panel chrome for every intel block: title, cadence chip, source + age footer, loading / connect / error states. */
export function IntelPanel<T>({ k, title, accent, children, right, empty, wide }: { k: IntelKey; title: string; accent: string; children: (data: T, b: IntelBlock<T>) => ReactNode; right?: ReactNode; empty?: string; wide?: boolean }) {
  const b = useIntel<T>(k);
  const now = useNow(5000);
  return (
    <Panel title={title} accent={accent} right={<>{right}{b ? <CadenceChip b={b} /> : null}</>} bodyClass={wide ? 'p-2' : ''}>
      {!b ? (
        <div className="space-y-2" aria-busy><div className="skeleton h-4 w-2/3" /><div className="skeleton h-24 w-full" /></div>
      ) : !b.connected ? (
        <ConnectState k={k} text={b.note ?? 'Connect a provider to enable this panel.'} />
      ) : b.data === null || (Array.isArray(b.data) && !b.data.length) ? (
        <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11px] text-faint">{b.note ?? empty ?? 'Nothing to show yet.'}</div>
      ) : (
        <>
          {children(b.data as T, b)}
          {b.note ? <p className="mt-2 text-[10px] text-faint">{b.note}</p> : null}
        </>
      )}
      {b ? (
        <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-faint">
          <span className="truncate">{b.source} · {timeAgo(b.ts, now)} ago</span>
          {b.mock ? <button onClick={() => void setDemo(k, false)} className="shrink-0 underline hover:text-text">use live data</button> : null}
        </div>
      ) : null}
    </Panel>
  );
}
