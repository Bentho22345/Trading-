'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Md } from '@/components/Md';
import { useAction } from '@/components/radar';
import { Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, pct, usd } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

/** Sequential (one hue) for share; diverging blue/orange with a gray midpoint for rotation. */
const seq = (v: number) => `color-mix(in oklab, var(--color-accent) ${Math.min(85, 8 + v * 1.6)}%, var(--color-panel))`;
const div = (v: number) => v === 0 ? 'var(--color-panel2)'
  : `color-mix(in oklab, ${v > 0 ? 'var(--color-div-hi)' : 'var(--color-div-lo)'} ${Math.min(80, 12 + Math.abs(v) * 6)}%, var(--color-panel2))`;

export default function RotationPage() {
  const now = useNow(5000);
  const [rot, setRot] = useState<any>(null);
  const [briefs, setBriefs] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);
  const { run, Msg } = useAction();
  useEffect(() => {
    const load = () => api('/api/rotation').then(setRot);
    load(); api('/api/briefs').then((b) => { setBriefs(b); setSel(b[0] || null); });
    const t = setInterval(load, 30000); return () => clearInterval(t);
  }, []);
  useLive(({ ch, data }) => { if (ch === 'brief') { setBriefs((b) => [data, ...b]); setSel(data); } });
  return (
    <div className="grid gap-2 pt-2 xl:grid-cols-[1fr_1fr]">
      <Panel title="Narrative rotation heatmap" right={rot && <span>{ago(rot.as_of, now)} ago</span>}>
        <div className="p-2">
          <p className="mb-2 text-[11px] text-mute">Share of tracked DEX volume per category in each window. <b className="text-fg">Rotation</b> = 1h share − 24h share: blue = capital rotating in, orange = rotating out. {rot?.note}</p>
          <table className="w-full num text-[12px]">
            <thead className="text-[11px] text-mute"><tr>{['Category', 'Tokens', '1h share', '6h share', '24h share', 'Rotation', 'Avg 1h', 'Mentions 1h/6h/24h', 'Leaders'].map((h) => <th key={h} className="px-1 py-1 text-left font-normal">{h}</th>)}</tr></thead>
            <tbody>
              {(rot?.categories || []).map((c: any) => (
                <tr key={c.category} className="border-t-2 border-panel">
                  <td className="px-1 font-semibold">{c.category}</td><td>{c.tokens}</td>
                  {['share_h1', 'share_h6', 'share_h24'].map((k) => <td key={k} className="px-1" style={{ background: seq(c[k]) }} title={`${c[k]}% of tracked volume`}>{c[k]}%</td>)}
                  <td className="px-1 font-bold" style={{ background: div(c.rotation) }} title="1h share minus 24h share (pts)">{c.rotation > 0 ? '▲' : c.rotation < 0 ? '▼' : ''} {c.rotation}</td>
                  <td className="px-1">{pct(c.avg_chg_h1)}</td>
                  <td className="px-1 text-mute">{c.mentions?.h1 ?? 0}/{c.mentions?.h6 ?? 0}/{c.mentions?.h24 ?? 0}</td>
                  <td className="px-1">{c.top.map((t: any) => <Link key={t.address} href={`/token?a=${t.address}`} className="mr-1 hover:text-accent" title={`vol 1h ${usd(t.vol_h1)}`}>{t.symbol}</Link>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rot?.categories?.length && <p className="p-4 text-mute">Needs fresh DexScreener data for tracked tokens.</p>}
        </div>
      </Panel>
      <Panel title="AI daily brief" right={<>
        <select value={sel?.id ?? ''} onChange={(e) => setSel(briefs.find((b) => b.id === +e.target.value))} className="rounded border border-line bg-panel2 px-1">
          {briefs.map((b) => <option key={b.id} value={b.id}>{new Date(b.ts * 1000).toLocaleString()} · {b.kind}</option>)}
        </select>
        <button onClick={() => run(() => api('/api/brief', { method: 'POST' }), 'Generated')} className="text-accent">generate now</button>
        <button onClick={() => run(() => api('/api/brief?deliver=true', { method: 'POST' }), 'Sent to your alert channels')} className="text-accent">+ send</button><Msg /></>}>
        <div className="p-3">{sel ? <><p className="mb-2 text-[11px] text-mute">model: {sel.model}</p><Md text={sel.body} /></> : <p className="text-mute">No brief yet. Scheduled morning/evening (Risk → settings), or generate one now.</p>}</div>
      </Panel>
    </div>
  );
}
