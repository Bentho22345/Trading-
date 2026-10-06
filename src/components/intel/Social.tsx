'use client';
import type { PredictionMarket, SocialRow } from '@shared/v2';
import { fmtCompact } from '@/lib/format';
import { useStore } from '@/lib/store';
import { IntelPanel } from './shell';

export function SocialPanel() {
  return (
    <IntelPanel<SocialRow[]> k="social" title="Social pulse" accent="var(--social)">
      {(rows) => (
        <ul className="space-y-1">
          {rows.slice(0, 12).map((r) => {
            const max = Math.max(1, ...r.spark);
            return (
              <li key={r.symbol} className="grid grid-cols-[4rem_1fr_4.2rem] items-center gap-2 text-[11px]">
                <button onClick={() => useStore.getState().set({ drawerSymbol: r.symbol })} className="truncate text-left font-medium text-text hover:underline">{r.symbol}</button>
                <span className="flex h-4 items-end gap-px">{r.spark.map((v, i) => <span key={i} className="flex-1 rounded-sm" style={{ height: `${Math.max(6, (v / max) * 100)}%`, background: i === 23 && r.spike ? 'var(--social)' : 'color-mix(in oklab, var(--social) 40%, transparent)' }} />)}</span>
                <span className={`num text-right ${r.spike ? 'font-semibold text-social' : 'text-faint'}`}>{r.spike ? `${r.ratio}× normal` : `${r.mentions1h}/h`}</span>
              </li>
            );
          })}
        </ul>
      )}
    </IntelPanel>
  );
}

export function PredictionPanel() {
  return (
    <IntelPanel<PredictionMarket[]> k="prediction" title="Prediction markets" accent="var(--social)">
      {(rows) => (
        <>
          <ul className="space-y-2">
            {rows.slice(0, 12).map((m) => (
              <li key={m.id}>
                <a href={m.url} target="_blank" rel="noopener noreferrer" className="block text-[11px] leading-snug text-dim hover:text-text">{m.question}</a>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="relative h-1.5 flex-1 rounded-full bg-bg-2"><span className="ease-value absolute inset-y-0 left-0 rounded-full bg-social" style={{ width: `${Math.max(1, Math.min(100, m.yes))}%` }} /></span>
                  <span className="num w-10 text-right text-[11px] text-text">{m.yes.toFixed(0)}%</span>
                  <span className={`num w-10 text-right text-[10px] ${(m.change24h ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>{m.change24h === null ? '' : `${m.change24h > 0 ? '+' : ''}${m.change24h.toFixed(1)}`}</span>
                  <span className="w-20 truncate text-right text-[10px] text-faint">{m.venue}{m.volume24h ? ` · $${fmtCompact(m.volume24h)}` : ''}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-faint">Market odds from public prediction markets — not forecasts and not advice.</p>
        </>
      )}
    </IntelPanel>
  );
}
