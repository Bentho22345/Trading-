'use client';
import { useMemo } from 'react';
import { useStore } from '@/lib/store';
import { useFlash, useQuote, useNow } from '@/lib/hooks';
import { fmtChange, fmtCompact, fmtPct, timeAgo } from '@/lib/format';
import { Odometer } from '../Odometer';
import { TermChart } from '../charts';
import { Panel, SkeletonRows, StreamBadge, SourceStamp, Chip, DelayChip } from '../ui';

export function VolPanel() {
  const vol = useStore((s) => s.vol);
  const vix = useQuote('VIX');
  const ref = useFlash<HTMLDivElement>(vix?.price);
  const now = useNow(1000);
  const term = useMemo(() => (vol?.termStructure ?? []).map((p) => ({ t: p.expiry, v: p.value, label: p.label })), [vol?.termStructure]);

  return (
    <Panel title="Volatility & options" accent="var(--eq)" right={<StreamBadge id="vol" />}>
      {!vol ? (
        <SkeletonRows n={6} />
      ) : (
        <>
          <div className="flex items-end justify-between">
            <div ref={ref} className="rounded-md px-1">
              <div className="text-[10px] uppercase tracking-wider text-faint">VIX</div>
              {vix ? (
                <div className="flex items-baseline gap-2">
                  <Odometer value={vix.price.toFixed(2)} className="text-2xl font-semibold text-text" />
                  <span className={`num text-xs ${vix.change >= 0 ? 'text-down' : 'text-up'}`}>{fmtChange(vix.change)} ({fmtPct(vix.changePct)})</span>
                </div>
              ) : <div className="text-sm text-faint">—</div>}
              {vix ? <DelayChip min={vix.delayedMin} /> : null}
            </div>
            {vol.structure ? (
              <Chip className={vol.structure === 'backwardation' ? 'border-down/40 text-down' : vol.structure === 'contango' ? 'border-up/40 text-up' : ''} title={vol.structure === 'backwardation' ? 'Near-term vol above longer-dated: stress signal' : 'Longer-dated vol above near-term: normal, calm regime'}>
                {vol.structure}
              </Chip>
            ) : null}
          </div>
          <div className="mt-1"><TermChart points={term} /></div>
          <SourceStamp source={vol.termSource} ts={vol.ts} delayedMin={vol.termDelayedMin} mock={vol.termSource.startsWith('Demo')} />

          <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3">
            {(['equity', 'index', 'total'] as const).map((k) => (
              <div key={k} className="rounded-md border border-line bg-bg-2/50 px-2 py-1">
                <div className="text-[9px] uppercase tracking-wider text-faint">P/C {k}</div>
                <div className="num text-sm font-semibold text-text">{vol.putCall ? vol.putCall[k].toFixed(2) : '—'}</div>
              </div>
            ))}
          </div>
          {!vol.putCallConnected ? <div className="mt-1 text-[10px] text-faint">Put/call: demo values — <span className="text-dim">connect an options provider</span></div> : null}

          <div className="mt-3 border-t border-line pt-2">
            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-faint">
              <span>Earnings</span>
              <StreamBadge id="earnings" />
            </div>
            <ul className="max-h-36 space-y-0.5 overflow-y-auto">
              {vol.earnings.slice(0, 10).map((e) => (
                <li key={`${e.symbol}${e.date}`}>
                  <button onClick={() => useStore.getState().set({ drawerSymbol: e.symbol })} className="grid w-full grid-cols-[46px_1fr_40px_50px] items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] hover:bg-panel-hover">
                    <span className="font-semibold text-text">{e.symbol}</span>
                    <span className="truncate text-faint">{new Date(e.date).toLocaleDateString([], { weekday: 'short', day: 'numeric' })} · {e.session.toUpperCase()}</span>
                    <span className="num text-right text-faint">{e.epsEst !== null ? e.epsEst.toFixed(2) : '—'}</span>
                    <span className="num text-right text-eq" title="Options-implied move">{e.impliedMovePct !== null ? `±${e.impliedMovePct.toFixed(1)}%` : 'n/a'}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-0.5 text-[9px] text-faint">{vol.earningsSource} · EPS est · implied move</div>
          </div>

          <div className="mt-3 border-t border-line pt-2">
            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-faint">
              <span>Unusual options activity</span>
              {!vol.unusualConnected ? <Chip className="border-accent/40 text-accent" title="No free provider for options flow — this is a demo adapter">demo · connect a provider</Chip> : null}
            </div>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto">
              {vol.unusual.slice(0, 10).map((u) => (
                <li key={u.id} className="grid grid-cols-[28px_42px_1fr_52px] items-center gap-2 text-[11px]">
                  <span className="num text-faint">{timeAgo(u.ts, now)}</span>
                  <span className="font-semibold text-text">{u.symbol}</span>
                  <span className="num truncate text-dim">
                    <span className={u.type === 'call' ? 'text-up' : 'text-down'}>{u.strike}{u.type === 'call' ? 'C' : 'P'}</span> {u.expiry.slice(5)} · {u.volOi}× OI · {u.side}
                  </span>
                  <span className="num text-right text-text">{fmtCompact(u.premiumUsd, '$')}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </Panel>
  );
}
