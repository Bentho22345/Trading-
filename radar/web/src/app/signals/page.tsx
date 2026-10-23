'use client';
import { useEffect, useState } from 'react';
import { SignalCard } from '@/components/radar';
import { api } from '@/lib/api';
import { useLive, useNow } from '@/lib/live';

export default function SignalsPage() {
  const now = useNow();
  const [rows, setRows] = useState<any[]>([]);
  const [verdict, setVerdict] = useState('');
  const [avoid, setAvoid] = useState(false);
  useEffect(() => {
    api(`/api/signals?limit=200&verdict=${verdict}&include_avoid=${avoid}`).then(setRows).catch(() => {});
  }, [verdict, avoid]);
  useLive(({ ch, data }) => {
    if (ch === 'signal' && (!verdict || data.verdict === verdict) && (avoid || verdict || data.verdict !== 'AVOID'))
      setRows((r) => [{ ...data, reasons: { why: data.reasons, risks: data.risks } }, ...r].slice(0, 300));
    if (ch === 'signal_writeup') setRows((r) => r.map((s) => (s.id === data.id ? { ...s, writeup: data.writeup } : s)));
  });
  return (
    <div className="mx-auto max-w-5xl space-y-2 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold">Signal feed</h1>
        {['', 'BUY', 'WATCH', 'AVOID'].map((v) => (
          <button key={v} onClick={() => setVerdict(v)} className={`rounded px-2 py-0.5 ${verdict === v ? 'bg-panel2 text-accent' : 'text-mute'}`}>{v || 'BUY + WATCH'}</button>
        ))}
        {!verdict && <label className="flex items-center gap-1 text-mute"><input type="checkbox" checked={avoid} onChange={(e) => setAvoid(e.target.checked)} />include AVOID</label>}
        <span className="ml-auto text-[11px] text-mute">Every evaluation that changes a verdict is logged with its exact inputs and paper-traded.</span>
      </div>
      {rows.map((s, i) => <SignalCard key={s.id} s={s} now={now} compact={i > 4} />)}
      {!rows.length && <p className="p-6 text-center text-mute">No signals yet. Signals appear once live market data and safety reports arrive.</p>}
    </div>
  );
}
