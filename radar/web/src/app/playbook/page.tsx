'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { AnimatePresence, motion } from '@/components/motion';
import { useStrategies } from '@/components/snipe';
import { Reveal } from '@/components/whoop';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useNow } from '@/lib/live';

type Src = { id: number; kind: string; url: string; title: string; author?: string; views?: number; status: string; summary?: string;
  rules: { metric: string; op: string; value: any; why?: string }[]; unsupported: string[]; extractor?: string; error?: string; added: number; digested?: number; text_len?: number };

const KIND: Record<string, string> = { youtube: 'YouTube', tiktok: 'TikTok', x: 'X', guide: 'Guide', text: 'Notes' };

export default function PlaybookPage() {
  const [d, setD] = useState<any>(null);
  const now = useNow(10000);
  const { list: strategies, reload } = useStrategies();
  const load = useCallback(() => api('/api/playbook').then(setD).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  const label = (m: string) => d?.metrics?.[m]?.label || m;
  const fmt = (r: any) => `${label(r.metric)} ${typeof r.value === 'boolean' ? (r.value ? '= yes' : '= no') : `${r.op} ${r.value}${d?.metrics?.[r.metric]?.unit === '%' ? '%' : ''}`}`;

  return (
    <div className="pt-4">
      <Reveal className="mb-10">
        <div className="eyebrow mb-3">Playbook · how traders pick coins, digested</div>
        <h1 className="display text-[60px] md:text-[104px]">The <span className="text-up">playbook.</span></h1>
        <p className="mt-4 max-w-3xl text-[16px] text-white/60">Radar reads memecoin strategy videos, guides and posts, pulls out the concrete filters they recommend
          (top-10 %, dev bag, bundlers, snipers, holders, socials, dev sold…) and keeps a live <b className="text-white">crowd consensus</b> strategy from what most of them agree on.
          Every strategy is then run on every new launch and graded on <Link href="/proof" className="underline decoration-white/30 underline-offset-4">Proof</Link> — so you learn which advice actually works.</p>
        <div className="mt-5 flex flex-wrap gap-2 text-[12px]">
          <span className={`rounded-full px-3 py-1 font-semibold ${d?.youtube_connected ? 'bg-up/15 text-up' : 'bg-white/[0.06] text-white/55'}`}>{d?.youtube_connected ? `● YouTube search on (${d?.queries?.length ?? 14} queries, rotating every 3h)` : '○ YouTube: add a key in Connectors for automatic discovery'}</span>
          <span className={`rounded-full px-3 py-1 font-semibold ${d?.ai_connected ? 'bg-up/15 text-up' : 'bg-white/[0.06] text-white/55'}`}>{d?.ai_connected ? '● Claude extraction on' : '○ Built-in parser (connect Anthropic for Claude extraction)'}</span>
          {d?.youtube_quota && <span className="num rounded-full bg-white/[0.06] px-3 py-1 font-semibold text-white/60">YouTube quota {d.youtube_quota.used.toLocaleString()} / {d.youtube_quota.cap.toLocaleString()} units today · {d.channels_followed} creators followed · top comments digested</span>}
          {d?.youtube_connected && <button onClick={() => api('/api/playbook/discover', { method: 'POST' }).then(load).catch(() => {})} className="rounded-full border border-white/15 px-3 py-1 text-white/70 hover:text-white">Search YouTube now</button>}
        </div>
      </Reveal>

      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <div className="space-y-6">
          <section className="glass rounded-[28px] p-6">
            <div className="mb-4 flex items-center gap-2"><span className="text-up">✦</span><span className="display text-[28px]">Crowd consensus</span>
              <span className="text-[11px] text-white/45">weighted median across {d?.sources?.filter((s: Src) => s.rules.length).length ?? 0} sources with filters</span></div>
            <div className="flex flex-wrap gap-2">
              {(d?.consensus || []).map((r: any) => (
                <span key={`${r.metric}${r.op}`} className="rounded-2xl border border-white/10 px-3 py-2 text-[13px]">
                  <b>{fmt(r)}</b><span className="ml-2 text-[11px] text-white/45">{r.support} source{r.support > 1 ? 's' : ''}</span>
                </span>
              ))}
              {d && !d.consensus?.length && <p className="text-white/45">No filters digested yet.</p>}
            </div>
          </section>

          <AddSource onAdded={load} />

          <section className="glass overflow-hidden rounded-[28px]">
            <header className="border-b border-white/[0.06] px-6 py-4"><span className="display text-[28px]">Digested sources</span></header>
            <ul>
              <AnimatePresence initial={false}>
                {(d?.sources || []).map((s: Src) => (
                  <motion.li key={s.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="border-t border-white/[0.05] px-6 py-4 first:border-t-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">{KIND[s.kind] || s.kind}</span>
                      {s.url.startsWith('http') ? <a href={s.url} target="_blank" rel="noreferrer" className="font-semibold hover:underline">{s.title}</a> : <b>{s.title}</b>}
                      {s.author && <span className="text-[12px] text-white/45">· {s.author}</span>}
                      {s.views ? <span className="num text-[12px] text-white/45">· {Math.round(s.views).toLocaleString()} views</span> : null}
                      <span className="ml-auto text-[11px] text-white/40">{s.status === 'digested' ? `${s.extractor} · ${ago(s.digested, now)} ago` : 'digesting…'}</span>
                    </div>
                    {s.summary && <p className="mt-1 text-[12.5px] text-white/60">{s.summary}</p>}
                    {s.rules.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {s.rules.map((r, i) => <span key={i} title={r.why} className="rounded-full bg-up/10 px-2 py-0.5 text-[11px] font-semibold text-up">{fmt(r)}</span>)}
                      </div>
                    )}
                    {s.unsupported?.length > 0 && <p className="mt-1.5 text-[11px] text-white/35">Not measurable here: {s.unsupported.join(' · ')}</p>}
                    {s.kind === 'youtube' && !s.rules.length && s.status === 'digested' && <p className="mt-1 text-[11px] text-white/35">Only the title/description were available — paste the transcript below to digest the full video.</p>}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </section>
        </div>

        <aside className="space-y-4">
          <div className="glass rounded-[28px] p-6">
            <div className="eyebrow mb-3">Strategies · graded on live launches (7d)</div>
            <ul className="space-y-2">
              {strategies.map((s) => (
                <li key={s.id} className="rounded-2xl border border-white/[0.07] p-3">
                  <div className="flex items-center gap-2">
                    <b className="text-[13px]">{s.source === 'playbook' ? '✦ ' : s.source === 'custom' ? '★ ' : ''}{s.name}</b>
                    <span className="num ml-auto text-[11px] text-white/50">{s.stats.hits} hits</span>
                  </div>
                  <div className="num mt-1 flex gap-3 text-[11px] text-white/55">
                    <span>2× <b className={s.stats.hit_2x_pct != null && s.stats.hit_2x_pct >= 30 ? 'text-up' : 'text-white'}>{s.stats.hit_2x_pct ?? '—'}%</b></span>
                    <span>grad <b className="text-white">{s.stats.graduated_pct ?? '—'}%</b></span>
                    <span>med peak <b className="text-white">{s.stats.median_peak_x ? `${s.stats.median_peak_x}×` : '—'}</b></span>
                  </div>
                  <div className="mt-2 flex gap-2 text-[11px]">
                    <button onClick={() => api(`/api/strategies/${s.id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled: !s.enabled }) }).then(reload)}
                      className={`rounded-full px-2 py-0.5 font-semibold ${s.enabled ? 'bg-up/15 text-up' : 'bg-white/[0.06] text-white/50'}`}>{s.enabled ? 'On' : 'Off'}</button>
                    <button onClick={() => api(`/api/strategies/${s.id}/toggle`, { method: 'POST', body: JSON.stringify({ alert: !s.alert }) }).then(reload)}
                      className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${s.alert ? 'bg-warn/15 text-warn' : 'bg-white/[0.06] text-white/50'}`}><Icon name={s.alert ? 'sound' : 'mute'} size={11} />Alert</button>
                    <Link href="/snipe" className="ml-auto text-white/45 hover:text-white">Open in Snipe →</Link>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="glass rounded-[28px] p-6 text-[12.5px] leading-relaxed text-white/55">
            <div className="eyebrow mb-2">What Radar can and can’t watch</div>
            YouTube: new strategy videos are found automatically with your YouTube Data API key, but the API only gives titles and descriptions — not other creators’ captions.
            TikTok has no public API for this. For any video (TikTok, YouTube, X), paste its link and transcript or your notes, and it’s digested the same way.
            Radar never scrapes those sites.
          </div>
        </aside>
      </div>
    </div>
  );
}

function AddSource({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <section className="glass rounded-[28px] p-6">
      <div className="display mb-1 text-[28px]">Feed it a video or post</div>
      <p className="mb-4 text-[12.5px] text-white/50">Paste a TikTok / YouTube / X link and its transcript, caption or your notes. Radar extracts the filters and folds them into the consensus.</p>
      <div className="grid gap-2 md:grid-cols-2">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.tiktok.com/@trader/video/…" className="rounded-xl border border-white/10 bg-transparent px-3 py-2 text-[13px]" />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" className="rounded-xl border border-white/10 bg-transparent px-3 py-2 text-[13px]" />
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Transcript / caption / notes — e.g. “I only ape if top 10 is under 25%, dev has sold, there's an X community and at least 50 holders…”"
        className="mt-2 w-full rounded-xl border border-white/10 bg-transparent px-3 py-2 text-[13px]" />
      <button disabled={busy || (!url && !text)} onClick={() => { setBusy(true); api('/api/playbook', { method: 'POST', body: JSON.stringify({ url: url || undefined, title: title || undefined, text: text || undefined }) })
        .then(() => { setUrl(''); setTitle(''); setText(''); setTimeout(onAdded, 600); }).finally(() => setBusy(false)); }}
        className="btn-primary mt-3 disabled:opacity-40">{busy ? 'Digesting…' : 'Digest it'} <Icon name="arrow" size={14} /></button>
    </section>
  );
}
