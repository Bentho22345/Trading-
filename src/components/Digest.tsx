'use client';
import { useEffect, useRef, useState } from 'react';
import type { Digest as DigestT } from '@shared/types';
import { useStore } from '@/lib/store';
import { fmtPct, pairLabel, timeAgo } from '@/lib/format';
import { Overlay } from './Overlay';
import { Icon, IconButton } from './ui';
import { MagneticButton } from './Magnetic';

const AWAY_MS = 10 * 60_000;

/** Tracks tab visibility; after >10 minutes away, offers a compact "while you were away" summary. */
export function AwayTracker() {
  const hiddenAt = useRef<number | null>(null);
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) hiddenAt.current = Date.now();
      else if (hiddenAt.current && Date.now() - hiddenAt.current > AWAY_MS) {
        useStore.getState().set({ digestSince: hiddenAt.current });
        hiddenAt.current = null;
      } else hiddenAt.current = null;
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  return null;
}

export function DigestModal() {
  const since = useStore((s) => s.digestSince);
  const symbols = useStore((s) => s.symbols);
  const set = useStore((s) => s.set);
  const [d, setD] = useState<DigestT | null>(null);

  useEffect(() => {
    if (!since) return setD(null);
    let alive = true;
    fetch(`/api/digest?since=${since}`).then((r) => r.json()).then((x: DigestT) => alive && setD(x)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [since]);

  const close = () => set({ digestSince: null });
  const mins = since ? Math.round((Date.now() - since) / 60_000) : 0;

  return (
    <Overlay open={!!since} onClose={close} label="While you were away" width="max-w-2xl">
      <div className="glass rounded-2xl bg-panel-solid/95">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-text">While you were away</h2>
            <p className="text-[11px] text-faint">Last {mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`} · top stories and biggest moves</p>
          </div>
          <IconButton label="Close" onClick={close}><Icon name="x" size={14} /></IconButton>
        </header>
        <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-[1.5fr_1fr]">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint">Top stories</div>
            {!d ? <div className="space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-10" />)}</div> : !d.clusters.length ? <div className="text-xs text-faint">Nothing major.</div> : (
              <ol className="space-y-1.5">
                {d.clusters.map((c, i) => (
                  <li key={c.id}>
                    <button onClick={() => set({ digestSince: null, timelineId: c.id, selectedId: c.id })} className="flex w-full gap-2 rounded-md px-1 py-1 text-left hover:bg-panel-hover">
                      <span className="num mt-0.5 w-4 text-[11px] text-faint">{i + 1}</span>
                      <span className="flex-1">
                        <span className="block text-[13px] leading-snug text-text">{c.headline}</span>
                        <span className="num text-[10px] text-faint">{c.source} · {timeAgo(c.publishedAt, Date.now())} ago · impact {c.impact}{c.articles.length > 1 ? ` · ${c.articles.length} sources` : ''}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint">Biggest moves</div>
            {!d ? <div className="space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-6" />)}</div> : (
              <ul className="space-y-0.5">
                {d.movers.map((m) => (
                  <li key={m.symbol}>
                    <button onClick={() => set({ digestSince: null, drawerSymbol: m.symbol })} className="flex w-full items-center justify-between rounded px-1 py-1 text-xs hover:bg-panel-hover">
                      <span className="font-semibold text-text">{pairLabel(m.symbol, symbols[m.symbol]?.assetClass)}</span>
                      <span className={`num ${m.pct >= 0 ? 'text-up' : 'text-down'}`}>{fmtPct(m.pct)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <footer className="flex justify-end border-t border-line px-5 py-3"><MagneticButton onClick={close}>Back to live</MagneticButton></footer>
      </div>
    </Overlay>
  );
}
