'use client';
import { useState } from 'react';
import type { Filing, StatementDiff } from '@shared/v2';
import { useIntel } from '@/lib/v2';
import { useNow } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import { IntelPanel } from './shell';
import { Segmented } from '../ui';

export function FilingsPanel() {
  const [tab, setTab] = useState<'filings' | 'statements'>('filings');
  const statements = useIntel<StatementDiff[]>('statements');
  const now = useNow(10_000);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <IntelPanel<Filing[]> k="filings" title="Filings & statements" accent="var(--reg)" right={<Segmented label="View" value={tab} onChange={setTab} options={[{ value: 'filings', label: 'EDGAR' }, { value: 'statements', label: 'CB diffs' }]} />}>
      {(list) => tab === 'filings' ? (
        <ul className="space-y-1.5">
          {list.slice(0, 25).map((f) => (
            <li key={f.id} className={`text-[11px] ${f.watch ? 'relevant pl-1.5' : ''}`}>
              <a href={f.url} target="_blank" rel="noopener noreferrer" className="flex items-baseline gap-2 hover:text-text">
                <span className="w-12 shrink-0 rounded bg-reg/15 px-1 text-center text-[9px] font-semibold text-reg">{f.form}</span>
                <span className="min-w-0 flex-1 truncate text-dim">{f.watch ? '📌 ' : ''}<span className="text-text">{f.ticker}</span> {f.company}</span>
                <span className="num shrink-0 text-faint">{timeAgo(f.ts, now)}</span>
              </a>
              {f.oneLiner ? <div className="pl-14 text-[10px] italic text-faint">{f.oneLiner}</div> : null}
            </li>
          ))}
        </ul>
      ) : !statements?.data?.length ? <p className="py-4 text-center text-[11px] text-faint">{statements?.note ?? 'Waiting for the next central-bank statement.'}</p> : (
        <div className="space-y-2">
          {statements.data.map((s) => (
            <div key={s.id} className="rounded-lg border border-line p-2 text-[11px]">
              <button onClick={() => setOpen(open === s.id ? null : s.id)} className="flex w-full justify-between text-left"><span className="text-text">{s.bank} · {s.title}</span><span className="text-faint">+{s.added.length} −{s.removed.length}</span></button>
              {open === s.id ? (
                <div className="mt-2 space-y-1">
                  {s.removed.map((x) => <p key={`-${x}`} className="rounded bg-down/10 px-1.5 text-dim line-through decoration-down/50">{x}</p>)}
                  {s.added.map((x) => <p key={`+${x}`} className="rounded bg-up/10 px-1.5 text-text">{x}</p>)}
                  {!s.added.length && !s.removed.length ? <p className="text-faint">First statement recorded; the diff appears with the next one.</p> : null}
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-faint underline">Read the statement</a>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </IntelPanel>
  );
}
