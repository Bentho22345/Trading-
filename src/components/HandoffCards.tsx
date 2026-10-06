'use client';
import { useV2 } from '@/lib/v2';
import { fmtBp, fmtPct } from '@/lib/format';
import { Icon } from './ui';

/** Session handoff cards (Asia → London, London → NY): what moved, what's next, open risks. Dismissible. */
export function HandoffCards() {
  const handoffs = useV2((s) => s.handoffs);
  const dismissed = useV2((s) => s.dismissedHandoffs);
  const visible = handoffs.filter((h) => !dismissed.has(h.id) && Date.now() - h.ts < 6 * 3600_000).slice(0, 1);
  if (!visible.length) return null;
  const dismiss = (id: string) => useV2.getState().set({ dismissedHandoffs: new Set([...dismissed, id]) });
  return (
    <div className="px-1 pb-2">
      {visible.map((h) => (
        <div key={h.id} className="card-in glass relative rounded-xl border-accent/30 p-3">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">
            <Icon name="timeline" size={12} />Handoff · {h.from} → {h.to}
            <span className="num font-normal normal-case tracking-normal text-faint">{new Date(h.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
            <button onClick={() => dismiss(h.id)} className="ml-auto text-faint hover:text-text" aria-label="Dismiss handoff"><Icon name="x" size={13} /></button>
          </div>
          <div className="mt-2 grid gap-3 text-xs sm:grid-cols-3">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-faint">What moved</div>
              {h.moved.map((m) => <div key={m.symbol} className="flex justify-between"><span className="text-text">{m.symbol}</span><span className={`num ${m.change >= 0 ? 'text-up' : 'text-down'}`}>{m.bp ? fmtBp(m.change) : fmtPct(m.changePct)}</span></div>)}
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-faint">What&apos;s next</div>
              {h.next.length ? h.next.map((e) => <div key={e.id} className="truncate text-dim"><span className="num mr-1 text-faint">{new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>{e.currency} {e.title}</div>) : <div className="text-faint">Quiet calendar</div>}
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-faint">Open risks</div>
              {h.risks.length ? h.risks.map((r) => <div key={r} className="line-clamp-2 text-dim">{r}</div>) : <div className="text-faint">None flagged</div>}
            </div>
          </div>
          {h.briefId ? <button onClick={() => useV2.getState().openBrief(h.briefId!)} className="mt-2 text-[11px] text-faint hover:text-text">Open full handoff →</button> : null}
        </div>
      ))}
    </div>
  );
}
