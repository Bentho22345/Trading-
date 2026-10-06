'use client';
import { useState } from 'react';
import type { ThemeItem } from '@shared/v2';
import { useStore } from '@/lib/store';
import { timeAgo } from '@/lib/format';
import { IntelPanel } from './shell';
import { Overlay } from '../Overlay';
import { Icon } from '../ui';

function ThemePage({ t, onClose }: { t: ThemeItem; onClose: () => void }) {
  const history = useStore((s) => s.sparks);
  return (
    <Overlay open onClose={onClose} side="right" label={t.label}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3"><h2 className="font-serif text-xl text-text">{t.label}{t.ai ? <span className="ml-2 text-[10px] text-faint">AI label</span> : null}</h2><button onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        <div className="flex flex-wrap gap-3 text-xs text-dim"><span>{t.volume} stories</span><span>momentum {t.momentum > 0 ? '+' : ''}{t.momentum}</span><span>sentiment {t.sentiment > 0 ? '+' : ''}{t.sentiment}</span><span>since {new Date(t.firstSeen).toLocaleDateString()}</span></div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Coverage timeline (6h buckets, 3 days)</div>
          <div className="flex h-16 items-end gap-1">{t.timeline.map((v, i) => <span key={i} className="flex-1 rounded-t bg-social/60" style={{ height: `${Math.max(4, (v / Math.max(1, ...t.timeline)) * 100)}%` }} title={`${v} stories`} />)}</div>
        </div>
        {t.assets.length ? (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Related assets</div>
            <div className="space-y-1">{t.assets.map((a) => { const sp = history[a] ?? []; const min = Math.min(...sp), max = Math.max(...sp); return (
              <button key={a} onClick={() => useStore.getState().set({ drawerSymbol: a })} className="flex w-full items-center gap-3 text-xs"><span className="w-16 text-left text-text">{a}</span>{sp.length > 2 ? <svg viewBox="0 0 100 20" className="h-5 flex-1"><polyline fill="none" stroke="var(--accent)" strokeWidth={1.2} points={sp.map((v, i) => `${(i / (sp.length - 1)) * 100},${19 - ((v - min) / (max - min || 1)) * 18}`).join(' ')} /></svg> : <span className="flex-1 text-faint">—</span>}</button>
            ); })}</div>
          </div>
        ) : null}
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Key headlines</div>
          <ul className="space-y-2">{t.quotes.map((q) => <li key={q.url + q.text}><a href={q.url} target="_blank" rel="noopener noreferrer" className="text-text hover:underline">“{q.text}”</a> <span className="text-xs text-faint">— {q.source}, {timeAgo(q.ts, Date.now())} ago</span></li>)}</ul>
        </div>
      </div>
    </Overlay>
  );
}

export function ThemesPanel() {
  const [open, setOpen] = useState<ThemeItem | null>(null);
  return (
    <IntelPanel<ThemeItem[]> k="themes" title="Theme radar" accent="var(--social)">
      {(themes) => {
        const maxV = Math.max(...themes.map((t) => t.volume));
        return (
          <>
            <svg viewBox="0 0 300 170" className="w-full" role="img" aria-label="Theme radar: x = momentum, size = coverage, colour = sentiment">
              <line x1="150" y1="8" x2="150" y2="160" stroke="var(--border)" />
              <line x1="10" y1="84" x2="290" y2="84" stroke="var(--border)" />
              <text x="14" y="164" fontSize="9" fill="var(--text-faint)">cooling</text>
              <text x="250" y="164" fontSize="9" fill="var(--text-faint)">heating</text>
              {themes.slice(0, 10).map((t, i) => {
                const x = 150 + t.momentum * 125, y = 20 + ((i * 37) % 130);
                const r = 6 + (t.volume / maxV) * 18;
                const col = t.sentiment > 0.1 ? 'var(--up)' : t.sentiment < -0.1 ? 'var(--down)' : 'var(--social)';
                return (
                  <g key={t.id} onClick={() => setOpen(t)} className="cursor-pointer" style={{ transition: 'transform 700ms ease' }}>
                    <circle cx={x} cy={y} r={r} fill={col} opacity={0.28} stroke={col} />
                    <text x={x} y={y + 3} textAnchor="middle" fontSize="8.5" fill="var(--text)">{t.label.slice(0, 18)}</text>
                  </g>
                );
              })}
            </svg>
            <ul className="mt-1 space-y-0.5 text-[11px]">{themes.slice(0, 5).map((t, i) => <li key={t.id}><button onClick={() => setOpen(t)} className="flex w-full justify-between text-left hover:text-text"><span className="text-dim"><span className="num mr-1 text-faint">{i + 1}</span>{t.label}</span><span className="num text-faint">{t.volume}</span></button></li>)}</ul>
            {open ? <ThemePage t={open} onClose={() => setOpen(null)} /> : null}
          </>
        );
      }}
    </IntelPanel>
  );
}
