'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Spark } from '@/components/radar';
import { Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, pct, pctClass, price, short, usd } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

const STAGE: Record<string, string> = { birth: 'text-accent', ignition: 'text-up', peak: 'text-warn', fading: 'text-down' };

export default function NarrativesPage() {
  const now = useNow();
  const [rows, setRows] = useState<any[]>([]);
  const [cat, setCat] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const load = useCallback(() => api(`/api/narratives?limit=60&category=${cat}`).then(setRows).catch(() => {}), [cat]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useLive(({ ch }) => { if (ch === 'narrative_new') load(); });
  const cats = Array.from(new Set(rows.map((r) => r.category).filter(Boolean)));
  return (
    <div className="grid gap-2 pt-2 xl:grid-cols-[1fr_520px]">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-bold">Narrative board</h1>
          <select value={cat} onChange={(e) => setCat(e.target.value)} className="rounded border border-line bg-panel2 px-1">
            <option value="">all categories</option>{['politifi', 'ai', 'animal', 'celebrity', 'news', 'sports', 'gaming', 'meme', 'other', ...cats].filter((v, i, a) => a.indexOf(v) === i).map((c) => <option key={c}>{c}</option>)}
          </select>
          <span className="text-[11px] text-mute">Lifecycle: BIRTH → IGNITION → PEAK → FADING. Narratives typically live 24–72h.</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {rows.map((n) => (
            <button key={n.id} onClick={() => setSel(n.id)} className={`rounded border bg-panel p-2 text-left hover:border-accent ${n.flash ? 'border-flash flash-pulse' : sel === n.id ? 'border-accent' : 'border-line'}`}>
              <div className="flex items-center gap-2">
                <span className={`text-[11px] font-bold uppercase ${STAGE[n.stage] || ''}`}>{n.stage}</span>
                {n.flash && <span className="text-[11px] font-bold text-flash">⚡ FLASH</span>}
                <span className="rounded bg-panel2 px-1 text-[10px] text-mute">{n.category}</span>
                {n.flags?.vip_mention && <span className="rounded bg-flash/20 px-1 text-[10px] text-flash">VIP</span>}
                {n.flags?.breaking_news && <span className="rounded bg-warn/20 px-1 text-[10px] text-warn">BREAKING</span>}
                {n.flags?.exchange_listing && <span className="rounded bg-accent/20 px-1 text-[10px] text-accent">LISTING</span>}
                <span className="ml-auto text-[11px] text-mute">{ago(n.first_seen, now)} old</span>
              </div>
              <div className="mt-1 font-semibold">{n.title}</div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-mute num">
                <Spark data={n.spark} label="posts/min" />
                <span>{n.vel_5m}/min</span><span>z {n.zscore ?? '—'}</span><span>{n.posts} posts · {n.authors} authors</span>
                <span>bots {Math.round((n.bot_share || 0) * 100)}%</span><span>strength {n.strength}</span>
              </div>
              <div className="mt-1 text-[11px] text-mute">{(n.sources || []).join(' → ')} · {(n.tickers || []).slice(0, 5).map((t: string) => `$${t}`).join(' ')}</div>
              {!!n.tokens?.length && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {n.tokens.map((t: any) => (
                    <span key={t.token_address} className={`rounded border px-1 text-[11px] ${t.is_likely_fake ? 'border-down/40 text-down line-through' : 'border-up/40 text-up'}`} title={t.is_likely_fake ? 'likely copycat' : `legit score ${t.legit_score}`}>
                      {t.symbol || short(t.token_address)} {t.chg_h1 != null ? pct(t.chg_h1) : ''}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
          {!rows.length && <p className="p-6 text-mute">No narratives yet — they form as posts from X, Telegram, Bluesky, 4chan, Reddit, news and trends cluster together.</p>}
        </div>
      </div>
      {sel ? <NarrativeDetail id={sel} now={now} /> : <Panel title="Detail"><p className="p-4 text-mute">Select a narrative.</p></Panel>}
    </div>
  );
}

function NarrativeDetail({ id, now }: { id: number; now: number }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { const load = () => api(`/api/narrative/${id}`).then(setD).catch(() => {}); load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [id]);
  if (!d) return <Panel title="Detail"><p className="p-4 text-mute">Loading…</p></Panel>;
  const n = d.narrative;
  const total = Object.values(d.buzz_by_source as Record<string, number>).reduce((a, b) => a + b, 0) || 1;
  return (
    <Panel title={n.title} className="xl:sticky xl:top-14 xl:max-h-[calc(100vh-70px)]">
      <div className="space-y-3 p-2">
        <div><h3 className="text-[10px] uppercase text-mute">Mentions / min (2h)</h3><Spark data={d.spark} w={480} h={50} label="posts/min" /></div>
        <div>
          <h3 className="text-[10px] uppercase text-mute">Buzz by platform</h3>
          {Object.entries(d.buzz_by_source as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([s, c]) => (
            <div key={s} className="flex items-center gap-2 text-[11px]"><span className="w-20">{s}</span>
              <span className="h-2 flex-1 rounded bg-line"><span className="block h-2 rounded bg-accent" style={{ width: `${(c / total) * 100}%` }} /></span><span className="w-8 text-right num">{c}</span></div>
          ))}
        </div>
        <div>
          <h3 className="text-[10px] uppercase text-mute">Matched tokens — real vs copycats</h3>
          <table className="w-full num text-[11px]"><tbody>
            {d.tokens.map((t: any) => (
              <tr key={t.token_address} className="border-t border-line/50 align-top">
                <td className="py-1"><Link href={`/token?a=${t.token_address}`} className={t.is_likely_fake ? 'text-down line-through' : 'font-bold text-up'}>{t.symbol || short(t.token_address)}</Link>
                  <div className="text-mute">{(t.reasons || []).join(' · ')}</div></td>
                <td>legit {t.legit_score}</td><td>{price(t.price_usd)}</td><td>vol1h {usd(t.vol_h1)}</td><td className={pctClass(t.chg_h1)}>{pct(t.chg_h1)}</td>
                <td>{t.mint_authority ? <span className="text-down">MINT</span> : ''}</td>
              </tr>
            ))}
          </tbody></table>
          {!d.tokens.length && <p className="text-mute">No matching token launched yet.</p>}
        </div>
        <div>
          <h3 className="text-[10px] uppercase text-mute">Top voices</h3>
          {d.influencers.map((a: any) => <div key={a.author} className="flex gap-2 text-[11px]"><span className="flex-1 truncate">{a.author}</span><span className="text-mute">{a.tier}</span><span>{a.posts} posts</span>{a.bot_score >= 0.5 && <span className="text-down">bot?</span>}</div>)}
        </div>
        <div>
          <h3 className="text-[10px] uppercase text-mute">Posts</h3>
          {d.posts.slice(0, 60).map((p: any) => (
            <div key={p.id} className="border-t border-line/50 py-1 text-[11px]">
              <span className="text-mute">{p.source} · {p.author_id?.split(':').slice(1).join(':')} · {p.author_tier} · {ago(p.ts, now)}</span>
              <div>{p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="hover:text-accent">{p.text}</a> : p.text}</div>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}
