'use client';
import { useEffect, useState } from 'react';
import type { AlertHistoryItem } from '@shared/v2';
import { api, useV2 } from '@/lib/v2';
import { useNow } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import { Panel } from '../ui';

const SEV: Record<string, string> = { low: 'text-faint', normal: 'text-dim', high: 'text-warn', critical: 'text-down' };

export function AlertHistoryPanel() {
  const live = useV2((s) => s.alertHistory);
  const [list, setList] = useState<AlertHistoryItem[]>([]);
  const now = useNow(10_000);
  useEffect(() => { void api<AlertHistoryItem[]>('/api/alert-history?limit=100').then(setList).catch(() => {}); }, [live.length]);
  const act = async (id: string, what: 'ack' | 'snooze') => {
    await api(`/api/alert-history/${id}/${what}`, { method: 'POST', json: what === 'snooze' ? { minutes: 30 } : {} });
    setList(await api<AlertHistoryItem[]>('/api/alert-history?limit=100'));
  };
  return (
    <Panel title="Alert history" accent="var(--warn)">
      {!list.length ? <p className="py-4 text-center text-[11px] text-faint">No alerts fired yet.</p> : (
        <ul className="space-y-1.5">
          {list.slice(0, 40).map((a) => (
            <li key={a.id} className={`text-[11px] ${a.status === 'new' ? '' : 'opacity-60'}`}>
              <div className="flex items-baseline gap-2"><span className={`text-[9px] font-semibold uppercase ${SEV[a.severity]}`}>{a.severity}</span><span className="min-w-0 flex-1 text-dim">{a.message}</span><span className="num shrink-0 text-faint">{timeAgo(a.ts, now)}</span></div>
              <div className="flex gap-2 pl-10 text-[10px] text-faint">
                <span>{a.status}{a.routes.length ? ` · ${a.routes.join(', ')}` : ''}</span>
                {a.status === 'new' || a.status === 'escalated' ? <><button onClick={() => void act(a.id, 'ack')} className="underline hover:text-text">ack</button><button onClick={() => void act(a.id, 'snooze')} className="underline hover:text-text">snooze 30m</button></> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
