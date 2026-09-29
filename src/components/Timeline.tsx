'use client';
import { useEffect, useMemo, useState } from 'react';
import type { ClusterDetail } from '@shared/types';
import { useStore } from '@/lib/store';
import { clockTime, fmtPct, pairLabel } from '@/lib/format';
import { Overlay } from './Overlay';
import { PriceChart } from './charts';
import { Icon, IconButton, DemoChip, Chip } from './ui';

/** How coverage of a clustered story developed, with the related asset's price reaction overlaid. */
export function StoryTimeline() {
  const id = useStore((s) => s.timelineId);
  const set = useStore((s) => s.set);
  return (
    <Overlay open={!!id} onClose={() => set({ timelineId: null })} label="Story timeline" width="max-w-3xl">
      {id ? <TimelineBody id={id} /> : null}
    </Overlay>
  );
}

function TimelineBody({ id }: { id: string }) {
  const live = useStore((s) => s.clusters.find((c) => c.id === id));
  const symbols = useStore((s) => s.symbols);
  const set = useStore((s) => s.set);
  const [detail, setDetail] = useState<ClusterDetail | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/cluster/${id}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d: ClusterDetail) => alive && setDetail(d))
        .catch(() => alive && setErr(true));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, live?.articles.length]);

  const c = live ?? detail?.cluster;
  const articles = useMemo(() => [...(c?.articles ?? [])].sort((a, b) => a.publishedAt - b.publishedAt), [c]);
  const markers = useMemo(() => articles.map((a, i) => ({ t: a.publishedAt, label: String(i + 1) })), [articles]);

  if (!c) return <div className="glass rounded-2xl bg-panel-solid/95 p-6 text-sm text-faint">{err ? 'Story no longer available.' : 'Loading…'}</div>;
  const t0 = articles[0]?.publishedAt ?? c.publishedAt;
  const sym = detail?.symbol;
  const meta = sym ? symbols[sym] : undefined;
  const series = detail?.series ?? [];
  const reaction = (() => {
    if (series.length < 2) return null;
    const before = series.filter((p) => p.t <= t0).at(-1)?.c ?? series[0].c;
    const last = series[series.length - 1].c;
    return ((last - before) / before) * 100;
  })();

  return (
    <div className="glass max-h-[85vh] overflow-hidden rounded-2xl bg-panel-solid/95">
      <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-faint">
            <Icon name="timeline" size={12} /> Story timeline · {articles.length} report{articles.length === 1 ? '' : 's'} · impact {c.impact}
            {c.demo ? <DemoChip /> : null}
          </div>
          <h2 className="text-base font-semibold leading-snug text-text">{c.headline}</h2>
          {c.tldr ? <p className="mt-1 text-xs text-dim"><span className="font-semibold text-accent">TL;DR </span>{c.tldr}</p> : null}
          {c.why ? <p className="mt-0.5 text-xs text-faint"><span className="font-semibold text-dim">Why it matters </span>{c.why}</p> : null}
        </div>
        <IconButton label="Close" onClick={() => set({ timelineId: null })}><Icon name="x" size={14} /></IconButton>
      </header>
      <div className="grid max-h-[calc(85vh-90px)] grid-cols-1 gap-4 overflow-y-auto p-5 md:grid-cols-[1fr_1.1fr]">
        <ol className="relative ml-2 border-l border-line-strong">
          {articles.map((a, i) => (
            <li key={a.id} className="relative mb-4 pl-5">
              <span className="absolute -left-[9px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-accent/50 bg-panel-solid text-[9px] font-bold text-accent">{i + 1}</span>
              <div className="num text-[10px] text-faint">{clockTime(a.publishedAt, true)} {i > 0 ? <span className="text-dim">(+{Math.max(0, Math.round((a.publishedAt - t0) / 60_000))}m)</span> : <span className="text-accent">first report</span>}</div>
              <div className="text-[11px] font-semibold text-dim">{a.source}</div>
              <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-[13px] leading-snug text-text hover:underline">{a.headline}</a>
            </li>
          ))}
        </ol>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-faint">Price reaction</span>
            {sym ? (
              <button onClick={() => set({ drawerSymbol: sym })} className="flex items-center gap-2 text-xs">
                <span className="font-semibold text-text">{pairLabel(sym, meta?.assetClass)}</span>
                {reaction !== null ? <Chip className={reaction >= 0 ? 'border-up/40 text-up' : 'border-down/40 text-down'}>{fmtPct(reaction)} since first report</Chip> : null}
              </button>
            ) : null}
          </div>
          <div className="rounded-lg border border-line bg-bg-2/40 p-1">
            {!detail ? <div className="skeleton h-[220px]" /> : !sym || series.length < 2 ? (
              <div className="flex h-[220px] items-center justify-center px-6 text-center text-xs text-faint">No tradable asset linked to this story.</div>
            ) : (
              <PriceChart points={series} up={(reaction ?? 0) >= 0} height={220} markers={markers} decimals={meta?.decimals ?? 2} />
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {c.tags.map((t) => <Chip key={t}>{t}</Chip>)}
          </div>
        </div>
      </div>
    </div>
  );
}
