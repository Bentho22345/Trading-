'use client';
import { useEffect, useState } from 'react';
import { Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, clock } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

export default function SocialPage() {
  const now = useNow();
  const [rows, setRows] = useState<any[]>([]);
  const [src, setSrc] = useState('');
  const [ca, setCa] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [flash, setFlash] = useState<any>(null);
  useEffect(() => { api(`/api/social?limit=200&source=${src}&with_ca=${ca}`).then(setRows); }, [src, ca]);
  useEffect(() => {
    const load = () => { api('/api/social/stats').then(setStats); api('/api/flash').then(setFlash); };
    load(); const t = setInterval(load, 10000); return () => clearInterval(t);
  }, []);
  useLive(({ ch, data }) => {
    if (ch === 'social' && (!src || data.source === src) && (!ca || data.cas?.length)) setRows((r) => [data, ...r].slice(0, 400));
  });
  return (
    <div className="grid gap-2 pt-2 lg:grid-cols-[1fr_380px]">
      <Panel title={<>Live social & news stream <span className="text-up">●</span></>} className="h-[calc(100vh-80px)]" right={<>
        <select value={src} onChange={(e) => setSrc(e.target.value)} className="rounded border border-line bg-panel2 px-1">
          <option value="">all sources</option>{['x', 'telegram', 'bluesky', '4chan', 'reddit', 'farcaster', 'youtube', 'rss', 'google_trends', 'polymarket', 'custom'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <label className="flex items-center gap-1"><input type="checkbox" checked={ca} onChange={(e) => setCa(e.target.checked)} />with CA</label></>}>
        <ul>
          {rows.map((r) => (
            <li key={r.id} className="flash-in border-b border-line/50 px-2 py-1">
              <div className="flex flex-wrap gap-2 text-[11px] text-mute">
                <span className="text-fg">{r.source}</span><span>{r.author_id?.split(':').slice(1).join(':')}</span>
                <span className={r.author_tier === 'vip' ? 'text-flash' : r.author_tier === 'new' ? 'text-down' : ''}>{r.author_tier}</span>
                <span>{clock(r.ts)}</span>{r.engagement ? <span>eng {Math.round(r.engagement)}</span> : null}
                {r.cashtags?.map((c: string) => <span key={c} className="text-accent">${c}</span>)}
                {r.cas?.map((c: string) => <a key={c} href={`/token?a=${c}`} className="text-flash">CA {c.slice(0, 6)}…</a>)}
                {r.is_fixture ? <span className="text-warn">TEST</span> : null}
              </div>
              <div className="break-words">{r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="hover:text-accent">{r.text}</a> : r.text}</div>
            </li>
          ))}
          {!rows.length && <li className="p-6 text-center text-mute">Waiting for posts…</li>}
        </ul>
      </Panel>
      <div className="space-y-2">
        <Panel title="Sources (last hour)">
          <table className="w-full num text-[11px]"><thead className="text-mute"><tr><th className="px-2 text-left font-normal">Source</th><th className="text-right font-normal">1h</th><th className="text-right font-normal">5m</th><th className="px-2 text-right font-normal">last</th></tr></thead>
            <tbody>{(stats?.by_source || []).map((s: any) => <tr key={s.source} className="border-t border-line/50"><td className="px-2">{s.source}</td><td className="text-right">{s.n}</td><td className="text-right">{s.n5}</td><td className="px-2 text-right text-mute">{ago(s.last, now)}</td></tr>)}</tbody></table>
        </Panel>
        <Panel title="FLASH log & latency">
          <div className="p-2 text-[11px]">
            {flash?.latency_ms?.n ? <p>VIP-CA flashes: {flash.latency_ms.n} · p50 {(flash.latency_ms.p50 / 1000).toFixed(2)}s · max {(flash.latency_ms.max / 1000).toFixed(2)}s · {flash.latency_ms.under_5s_pct}% under 5s (post time → screen)</p> : <p className="text-mute">No FLASH events yet.</p>}
            {(flash?.events || []).map((e: any) => (
              <div key={e.id} className="border-t border-line/50 py-1">
                <span className="text-flash">{e.kind}</span> {e.is_fixture ? <span className="text-warn">TEST</span> : null} <span className="text-mute">{ago(e.pushed_ts, now)} ago · {e.latency_ms != null ? `${(e.latency_ms / 1000).toFixed(2)}s` : ''}</span>
                <div className="truncate">{e.author ? `${e.author}: ` : ''}{e.text}</div>
                {e.token_address && <a className="text-accent" href={`/token?a=${e.token_address}`}>{e.token_address.slice(0, 8)}… →</a>}
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
