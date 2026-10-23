'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chips } from '@/components/motion';
import { Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

type Item = {
  id: string; source: string; publisher?: string; title: string; link?: string; published?: number; fetched: number;
  group?: string; tags: string[]; metas: string[]; tickers: string[]; sentiment?: number; impact?: number;
  story_id?: string; coverage?: number; outlets?: string[]; fresh?: boolean;
};
type Facets = { total: number; per_min: number; sentiment: number; groups: Record<string, number>; tags: Record<string, number>;
  metas: { id: string; name: string; n: number }[]; tickers: Record<string, number> };

const GROUPS = ['', 'memecoin', 'listings', 'crypto', 'solana', 'politics', 'celebrity', 'viral', 'hacks', 'regulation', 'breaking', 'macro', 'reddit', 'trends', 'social'];
const GROUP_LABEL: Record<string, string> = { '': 'All', memecoin: 'Memecoins', listings: 'Listings', crypto: 'Crypto', solana: 'Solana', politics: 'Politics',
  celebrity: 'Celebs', viral: 'Viral', hacks: 'Hacks', regulation: 'Regulation', breaking: 'Breaking', macro: 'Macro', reddit: 'Reddit', trends: 'Trends', social: 'Social' };
const TAG_CLS: Record<string, string> = {
  listing: 'bg-up/15 text-up', launch: 'bg-flash/20 text-flash', hack: 'bg-down/20 text-down', delisting: 'bg-down/15 text-down',
  regulation: 'bg-warn/15 text-warn', etf: 'bg-accent/20 text-accent', airdrop: 'bg-accent2/15 text-accent2',
};

function impactCls(v = 0) {
  return v >= 75 ? 'bg-down text-bg' : v >= 55 ? 'bg-warn text-bg' : v >= 35 ? 'bg-accent/70 text-bg' : 'bg-white/10 text-mute';
}

export default function NewsPage() {
  const now = useNow();
  const [group, setGroup] = useState('');
  const [tag, setTag] = useState('');
  const [meta, setMeta] = useState('');
  const [ticker, setTicker] = useState('');
  const [q, setQ] = useState('');
  const [hot, setHot] = useState(false);
  const [paused, setPaused] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [feeds, setFeeds] = useState<{ total: number; failing: number } | null>(null);
  const queued = useRef<Item[]>([]);
  const [queuedN, setQueuedN] = useState(0);

  const params = useMemo(() => {
    const p = new URLSearchParams({ limit: '200', hours: '24' });
    if (group) p.set('group', group);
    if (tag) p.set('tag', tag);
    if (meta) p.set('meta', meta);
    if (ticker) p.set('ticker', ticker);
    if (q) p.set('q', q);
    if (hot) p.set('min_impact', '55');
    return p.toString();
  }, [group, tag, meta, ticker, q, hot]);

  const load = useCallback(() => api<{ items: Item[] }>(`/api/news/feed?${params}`).then((d) => setItems(d.items)).catch(() => {}), [params]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const f = () => {
      api<Facets>('/api/news/facets?hours=6').then(setFacets).catch(() => {});
      api<{ total: number; failing: number }>('/api/news/sources').then(setFeeds).catch(() => {});
    };
    f();
    const t = setInterval(f, 30000);
    return () => clearInterval(t);
  }, []);

  const matches = useCallback((it: Item) => (!group || it.group === group) && (!tag || it.tags?.includes(tag)) && (!meta || it.metas?.includes(meta))
    && (!ticker || it.tickers?.includes(ticker)) && (!q || it.title.toLowerCase().includes(q.toLowerCase())) && (!hot || (it.impact || 0) >= 55), [group, tag, meta, ticker, q, hot]);

  const merge = useCallback((incoming: Item[]) => {
    setItems((prev) => {
      const next = [...prev];
      const add: Item[] = [];
      for (const it of incoming) {
        const i = next.findIndex((x) => (x.story_id || x.id) === (it.story_id || it.id));
        if (i >= 0) {
          const s = next[i];
          const pub = it.publisher || it.source;
          if (!s.outlets?.includes(pub)) next[i] = { ...s, outlets: [...(s.outlets || []), pub], coverage: (s.coverage || 1) + 1, impact: Math.max(s.impact || 0, it.impact || 0), fresh: true };
        } else add.push({ ...it, outlets: [it.publisher || it.source], coverage: 1, fresh: true });
      }
      return [...add, ...next].slice(0, 400);
    });
  }, []);

  useLive(({ ch, data }) => {
    if (ch !== 'news' || !Array.isArray(data)) return;
    const fresh = (data as Item[]).filter(matches).sort((a, b) => (b.published || b.fetched) - (a.published || a.fetched));
    if (!fresh.length) return;
    if (paused) { queued.current = [...fresh, ...queued.current].slice(0, 300); setQueuedN(queued.current.length); return; }
    merge(fresh);
  });
  const resume = () => { merge(queued.current); queued.current = []; setQueuedN(0); setPaused(false); };

  const clear = () => { setGroup(''); setTag(''); setMeta(''); setTicker(''); setQ(''); setHot(false); };
  const filtered = !!(tag || meta || ticker || q || hot);
  const sent = facets?.sentiment ?? 0;

  return (
    <div className="grid gap-2 pt-2 xl:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-bold">Newsroom</h1>
          <span className="flex items-center gap-1.5 rounded-full border border-up/30 bg-up/10 px-2 py-0.5 text-[11px] text-up">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-up" />{facets ? `${facets.per_min} new/min` : 'live'}</span>
          {feeds && <span className="text-[11px] text-mute" title="Feeds that error back off and retry automatically">{feeds.total - feeds.failing}/{feeds.total} feeds healthy</span>}
          <span className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1 text-[12px] text-mute"><input type="checkbox" checked={hot} onChange={(e) => setHot(e.target.checked)} />High impact</label>
            <button onClick={() => (paused ? resume() : setPaused(true))}
              className={`rounded-lg border px-2 py-1 text-[12px] ${paused ? 'border-warn/50 text-warn' : 'border-white/10 text-mute hover:text-fg'}`}>
              {paused ? `Resume${queuedN ? ` (${queuedN} new)` : ''}` : 'Pause'}
            </button>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chips id="news-group" value={group} onChange={setGroup}
            options={GROUPS.map((g) => ({ value: g, label: <>{GROUP_LABEL[g]}{g && facets?.groups[g] ? <span className="ml-1 text-[10px] text-mute">{facets.groups[g]}</span> : null}</> }))} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search headlines…"
            className="w-56 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] outline-none focus:border-accent/60" />
          {tag && <Pill onClear={() => setTag('')}>tag: {tag}</Pill>}
          {meta && <Pill onClear={() => setMeta('')}>meta: {meta}</Pill>}
          {ticker && <Pill onClear={() => setTicker('')}>${ticker}</Pill>}
          {filtered && <button onClick={clear} className="text-[11px] text-mute hover:text-fg">clear filters</button>}
        </div>
        <Panel title={`${items.length} stories`} right={<span className="hidden sm:inline">near-duplicate headlines are grouped; the badge counts outlets</span>}>
          <ul>
            {items.map((n) => {
              const ts = n.published || n.fetched;
              return (
                <li key={n.story_id || n.id} className={`border-b border-white/5 px-3 py-2 ${n.fresh ? 'flash-in' : ''}`}>
                  <div className="flex items-start gap-2">
                    <span className={`mt-0.5 w-8 shrink-0 rounded-md text-center text-[10px] font-bold num ${impactCls(n.impact)}`} title="impact score: how likely this moves memecoins">{Math.round(n.impact || 0)}</span>
                    <div className="min-w-0 flex-1">
                      <a href={n.link} target="_blank" rel="noreferrer" className="text-[13px] font-medium leading-snug hover:text-accent">{n.title}</a>
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-mute">
                        <span className={(n.sentiment || 0) > 0.2 ? 'text-up' : (n.sentiment || 0) < -0.2 ? 'text-down' : ''} title={`sentiment ${n.sentiment ?? 0}`}>●</span>
                        <span>{n.publisher || n.source}</span>
                        {(n.coverage || 1) > 1 && <span className="rounded bg-accent/20 px-1 text-accent" title={(n.outlets || []).join(', ')}>{n.coverage} outlets</span>}
                        <span>· {ago(ts, now)} ago</span>
                        {n.group && <button onClick={() => setGroup(n.group!)} className="rounded bg-white/5 px-1 hover:text-fg">{GROUP_LABEL[n.group] || n.group}</button>}
                        {n.tags?.map((t) => <button key={t} onClick={() => setTag(t)} className={`rounded px-1 ${TAG_CLS[t] || 'bg-white/5'}`}>{t}</button>)}
                        {n.tickers?.map((t) => <button key={t} onClick={() => setTicker(t)} className="rounded bg-up/10 px-1 font-semibold text-up">${t}</button>)}
                        {n.metas?.slice(0, 3).map((m) => <Link key={m} href={`/narratives?meta=${m}`} className="rounded bg-accent2/10 px-1 text-accent2">#{m.replace('_', ' ')}</Link>)}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
            {!items.length && <li className="p-6 text-center text-mute">{filtered || group ? 'Nothing matches these filters in the last 24h.' : 'Waiting for feeds…'}</li>}
          </ul>
        </Panel>
      </div>

      <div className="space-y-2 xl:sticky xl:top-14 xl:self-start">
        <Panel title="Last 6 hours">
          <div className="space-y-3 p-3 text-[12px]">
            <div className="flex items-center gap-2">
              <span className="text-mute">Headline mood</span>
              <span className="relative h-2 flex-1 rounded bg-gradient-to-r from-down/60 via-white/10 to-up/60">
                <span className="absolute -top-1 h-4 w-1 rounded bg-fg" style={{ left: `${((sent + 1) / 2) * 100}%` }} />
              </span>
              <span className={`num ${sent > 0.05 ? 'text-up' : sent < -0.05 ? 'text-down' : 'text-mute'}`}>{sent > 0 ? '+' : ''}{sent}</span>
            </div>
            <Facet title="Coins in the news" entries={Object.entries(facets?.tickers || {})} render={(k) => `$${k}`} onPick={setTicker} />
            <Facet title="Metas in the news" entries={(facets?.metas || []).map((m) => [m.id, m.n] as [string, number])}
              render={(k) => (facets?.metas.find((m) => m.id === k)?.name || k)} onPick={setMeta} />
            <Facet title="Catalyst tags" entries={Object.entries(facets?.tags || {})} render={(k) => k} onPick={setTag} />
            <p className="text-[10px] text-mute">{facets?.total ?? 0} headlines from crypto newsrooms, Google News searches for every memecoin meta, exchange listings, hacks, regulation, politics, celebrities, viral culture, Reddit, Mastodon and Google Trends. Edit config/sources.yaml to add feeds, or add your own on the Connectors page.</p>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Pill({ children, onClear }: { children: React.ReactNode; onClear: () => void }) {
  return <span className="flex items-center gap-1 rounded-lg bg-accent/15 px-2 py-0.5 text-[11px] text-accent">{children}<button onClick={onClear} aria-label="remove filter">✕</button></span>;
}

function Facet({ title, entries, render, onPick }: { title: string; entries: [string, number][]; render: (k: string) => string; onPick: (k: string) => void }) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return (
    <div>
      <h3 className="mb-1 text-[10px] uppercase text-mute">{title}</h3>
      {entries.slice(0, 10).map(([k, v]) => (
        <button key={k} onClick={() => onPick(k)} className="flex w-full items-center gap-2 py-0.5 text-left hover:text-accent">
          <span className="w-28 truncate">{render(k)}</span>
          <span className="h-1.5 flex-1 rounded bg-line"><span className="block h-1.5 rounded bg-accent" style={{ width: `${(v / max) * 100}%` }} /></span>
          <span className="w-6 text-right num text-mute">{v}</span>
        </button>
      ))}
      {!entries.length && <p className="text-mute">—</p>}
    </div>
  );
}
