'use client';
import { useEffect, useState } from 'react';
import { Dot, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useNow } from '@/lib/live';

export default function HealthPage() {
  const [h, setH] = useState<any>(null);
  const [err, setErr] = useState('');
  const now = useNow();
  useEffect(() => {
    const load = () => api('/api/health').then((d) => { setH(d); setErr(''); }).catch((e) => setErr(String(e.message || e)));
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  if (err) return <p className="p-6 text-down">Backend unreachable: {err}</p>;
  if (!h) return <p className="p-6 text-mute">Loading…</p>;
  return (
    <div className="mx-auto max-w-6xl space-y-2 pt-2">
      <div className="flex flex-wrap gap-4 text-mute">
        <span>uptime {ago(now - h.uptime_s, now)}</span><span>UI clients {h.ui_clients}</span>
        <span>live trade subscriptions {h.trade_subscriptions}</span>
        {Object.entries(h.db).map(([k, v]) => <span key={k}>{k} {(v as number).toLocaleString()}</span>)}
      </div>
      <Panel title="Adapters">
        <table className="w-full num">
          <thead className="bg-panel2 text-[11px] text-mute">
            <tr>{['', 'Adapter', 'Type', 'Status', 'Last OK', 'p50', 'p95', 'Req 1h', 'Errors', '429s', 'Headroom', 'Last error'].map((c) => <th key={c} className="px-2 py-1 text-left font-normal">{c}</th>)}</tr>
          </thead>
          <tbody>
            {h.adapters.map((a: any) => (
              <tr key={a.name} className="border-t border-line/60 align-top">
                <td className="px-2 py-1"><Dot status={a.status} /></td>
                <td className="px-2"><b>{a.name}</b><div className="text-[11px] text-mute">{a.description}</div></td>
                <td className="px-2">{a.kind}{a.kind === 'stream' ? ` · ${a.messages} msgs` : ''}</td>
                <td className="px-2">{a.status}</td>
                <td className="px-2">{a.last_ok ? `${ago(a.last_ok, now)} ago` : '—'}</td>
                <td className="px-2">{a.latency_p50_ms != null ? `${a.latency_p50_ms}ms` : '—'}</td>
                <td className="px-2">{a.latency_p95_ms != null ? `${a.latency_p95_ms}ms` : '—'}</td>
                <td className="px-2">{a.requests_1h ?? '—'}</td>
                <td className="px-2">{a.errors}</td>
                <td className="px-2">{a.rate_limited}</td>
                <td className="px-2">{a.headroom != null ? (
                  <span className="inline-flex items-center gap-1"><span className="inline-block h-1.5 w-12 rounded bg-line"><span className="block h-1.5 rounded bg-accent" style={{ width: `${a.headroom * 100}%` }} /></span>{Math.round(a.headroom * 100)}%</span>) : '—'}</td>
                <td className="max-w-[320px] break-words px-2 text-[11px] text-down">{a.last_error_msg && a.status !== 'ok' ? a.last_error_msg : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <p className="text-[11px] text-mute">Statuses: ok · pending (no call yet) · degraded (last call failed) · stale (no success recently) · down (never succeeded / socket closed). Rate budgets are set below each API’s published free limit in backend/radar/config.py.</p>
    </div>
  );
}
