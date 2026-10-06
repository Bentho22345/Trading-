'use client';
import { memo, useState } from 'react';
import type { NewsCluster } from '@shared/types';
import { useStore } from '@/lib/store';
import { useNow } from '@/lib/hooks';
import { DOMAIN_LABEL, primaryDomain, timeAgo, pairLabel } from '@/lib/format';
import { copyText, shareCard, storyForChat } from '@/lib/share';
import { useV2 } from '@/lib/v2';
import { addNote } from './personal/Journal';
import { Chip, DemoChip, Icon } from './ui';

/** CSS-only (transform) so cards re-rendering every second don't touch the animation library. */
export function ImpactMeter({ value, animate }: { value: number; animate: boolean }) {
  const color = value >= 75 ? 'var(--down)' : value >= 55 ? 'var(--warn)' : 'var(--text-faint)';
  return (
    <div className="flex items-center gap-1.5" title={`Impact score ${value}/100`}>
      <div className="h-1 w-12 overflow-hidden rounded-full bg-line">
        <div
          className={`impact-fill h-full w-full origin-left rounded-full ${animate ? 'impact-in' : ''}`}
          style={{ background: color, transform: `scaleX(${value / 100})` }}
        />
      </div>
      <span className="num text-[10px] text-faint">{value}</span>
    </div>
  );
}

function SymbolChip({ s }: { s: string }) {
  const meta = useStore((st) => st.symbols[s]);
  const q = useStore((st) => st.quotes[s]);
  const clickable = !!meta;
  return (
    <button
      disabled={!clickable}
      onClick={(e) => {
        e.stopPropagation();
        if (clickable) useStore.getState().set({ drawerSymbol: s });
      }}
      className={`num inline-flex items-center gap-1 rounded-md border border-line bg-bg-2/60 px-1.5 py-px text-[10px] font-semibold ${clickable ? 'text-text hover:border-line-strong' : 'cursor-default text-faint'}`}
      title={meta ? `${meta.name} — open detail` : s}
    >
      {pairLabel(s, meta?.assetClass)}
      {q ? <span className={q.changePct >= 0 ? 'text-up' : 'text-down'}>{q.changePct >= 0 ? '+' : ''}{q.changePct.toFixed(2)}%</span> : null}
    </button>
  );
}

interface Props {
  c: NewsCluster;
  fresh: boolean;
  selected: boolean;
  read: boolean;
  saved: boolean;
  inBook?: boolean;
}

function CardMenu({ c }: { c: NewsCluster }) {
  const [open, setOpen] = useState(false);
  const item = 'block w-full rounded px-2 py-1 text-left text-[11px] text-dim hover:bg-panel-hover hover:text-text';
  const run = (fn: () => void | Promise<void>) => (e: React.MouseEvent) => { e.stopPropagation(); setOpen(false); void fn(); };
  return (
    <span className="relative">
      <button onClick={(e) => { e.stopPropagation(); setOpen(!open); }} className="rounded-md px-1 text-faint opacity-0 transition-opacity hover:text-text group-hover:opacity-100 focus:opacity-100" aria-label="More actions">⋯</button>
      {open ? (
        <span className="absolute right-0 top-5 z-30 block w-44 rounded-lg border border-line bg-panel-solid p-1 shadow-xl" onMouseLeave={() => setOpen(false)}>
          <button className={item} onClick={run(async () => { await copyText(storyForChat(c)); useStore.getState().pushToast({ kind: 'info', title: 'Copied for chat' }); })}>Copy for chat</button>
          <button className={item} onClick={run(() => shareCard({ kicker: `${DOMAIN_LABEL[primaryDomain(c.domains)]} · impact ${c.impact}`, title: c.headline, body: c.tldr ?? c.summary.slice(0, 240), meta: `${c.source}${c.articles.length > 1 ? ` +${c.articles.length - 1} sources` : ''} · ${new Date(c.publishedAt).toLocaleString()}`, filename: `pulse-story-${c.id}.png` }))}>Export PNG card</button>
          <button className={item} onClick={run(() => useV2.getState().set({ explain: { kind: 'story', ref: c.id, label: c.headline }, copilotOpen: true }))}>Explain this (E)</button>
          <button className={item} onClick={run(async () => { await addNote({ kind: 'story', ref: c.id, label: c.headline, ts: c.publishedAt }, c.headline.slice(0, 80), `[${c.headline}](${c.url})\n\n`); useV2.getState().set({ journalOpen: true }); })}>Add note</button>
        </span>
      ) : null}
    </span>
  );
}

export const NewsCard = memo(function NewsCard({ c, fresh, selected, read, saved, inBook }: Props) {
  const now = useNow(1000);
  const [expanded, setExpanded] = useState(false);
  const dom = primaryDomain(c.domains);
  const symbols = [...c.tickers, ...c.currencies.filter((x) => x.length === 6)].slice(0, 5);
  const extra = c.articles.length - 1;
  const s = useStore.getState;
  const high = c.impact >= 70;

  const open = () => {
    s().markRead(c.id);
    if (c.url && c.url !== '#') window.open(c.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <article
      data-cluster={c.id}
      data-explain={c.id}
      data-explain-kind="story"
      data-explain-label={c.headline}
      onClick={() => s().set({ selectedId: c.id })}
      className={`d-${dom} group relative overflow-hidden rounded-xl border bg-panel p-3 pl-4 card-hover ${fresh ? 'card-in' : ''} ${fresh && high ? 'glow-sweep' : ''} ${selected ? 'border-accent/60 ring-1 ring-accent/30' : c.watchHit ? 'border-[color-mix(in_oklab,var(--warn)_45%,transparent)]' : 'border-line'} ${read ? 'opacity-60' : ''} ${inBook || c.watchHit ? 'relevant' : ''}`}
      aria-current={selected || undefined}
    >
      <span className="absolute inset-y-2 left-1.5 w-[3px] rounded-full" style={{ background: 'var(--d)' }} />
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-faint">
        <span className="font-semibold uppercase tracking-wider" style={{ color: 'var(--d)' }}>{DOMAIN_LABEL[dom]}</span>
        {c.breaking ? <span className="rounded bg-down/15 px-1 font-bold uppercase tracking-wider text-down">Breaking</span> : null}
        {inBook ? <span className="rounded bg-accent/15 px-1 font-semibold text-accent" title="Touches a position in your book (or a correlated proxy)">📌 In your book</span> : null}
        {c.watchHit ? <span className="rounded bg-warn/15 px-1 font-semibold uppercase text-warn" title="Matches your watchlist">{inBook ? '' : '📌 '}Watchlist</span> : null}
        <span className="num" title={new Date(c.publishedAt).toLocaleString()}>{timeAgo(c.publishedAt, now)}</span>
        <span>·</span>
        <span className="truncate text-dim">{c.source}</span>
        {c.demo ? <DemoChip /> : null}
        <span className="ml-auto" />
        <span className="flex items-center gap-0.5">
          <button onClick={(e) => { e.stopPropagation(); s().set({ timelineId: c.id }); }} className="rounded-md p-0.5 text-faint opacity-0 transition-opacity hover:text-text group-hover:opacity-100 focus:opacity-100" aria-label="Story timeline" title="Story timeline (Enter)">
            <Icon name="timeline" size={13} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); s().toggleSaved(c.id); }} className={`rounded-md p-0.5 transition-opacity hover:text-text ${saved ? 'text-warn opacity-100' : 'text-faint opacity-0 group-hover:opacity-100 focus:opacity-100'}`} aria-label={saved ? 'Remove from saved' : 'Save for later'} title="Save (S)">
            <Icon name="bookmark" size={13} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); open(); }} className="rounded-md p-0.5 text-faint opacity-0 transition-opacity hover:text-text group-hover:opacity-100 focus:opacity-100" aria-label="Open source" title="Open source (O)">
            <Icon name="external" size={13} />
          </button>
          <CardMenu c={c} />
        </span>
        <ImpactMeter value={c.impact} animate={fresh} />
      </div>

      <h3 className="text-[14px] font-medium leading-[1.45] text-text">
        <a
          href={c.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.stopPropagation();
            s().markRead(c.id);
          }}
          className="hover:underline decoration-line-strong underline-offset-2"
        >
          {c.headline}
        </a>
      </h3>

      {c.tldr ? (
        <div className="mt-1.5 space-y-0.5 text-[12px] leading-relaxed">
          <p className="text-dim"><span className="mr-1 inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase text-accent"><Icon name="sparkle" size={10} />TL;DR</span>{c.tldr}</p>
          {c.why ? <p className="text-faint"><span className="mr-1 text-[10px] font-semibold uppercase text-dim">Why it matters</span>{c.why}</p> : null}
        </div>
      ) : c.summary ? (
        <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-faint">{c.summary}</p>
      ) : null}

      {symbols.length || c.tags.length || extra > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {symbols.map((x) => <SymbolChip key={x} s={x} />)}
          {c.tags.slice(0, 3).map((t) => <Chip key={t}>{t}</Chip>)}
          {extra > 0 ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              className="ml-auto rounded-md border border-line px-1.5 py-px text-[10px] font-semibold text-dim hover:border-line-strong hover:text-text"
              aria-expanded={expanded}
            >
              +{extra} source{extra > 1 ? 's' : ''}
            </button>
          ) : null}
        </div>
      ) : null}

      {expanded && (
          <ul className="fade-in mt-2 overflow-hidden border-t border-line pt-2">
            {c.articles.map((a) => (
              <li key={a.id} className="flex items-baseline gap-2 py-0.5 text-[11px]">
                <span className="num w-8 shrink-0 text-faint">{timeAgo(a.publishedAt, now)}</span>
                <span className="w-28 shrink-0 truncate font-medium text-dim">{a.source}</span>
                <a href={a.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="truncate text-faint hover:text-text hover:underline">{a.headline}</a>
              </li>
            ))}
          </ul>
      )}
    </article>
  );
});
