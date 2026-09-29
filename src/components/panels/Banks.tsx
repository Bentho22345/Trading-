'use client';
import { useStore } from '@/lib/store';
import { useNow } from '@/lib/hooks';
import { countdown, flag, timeAgo } from '@/lib/format';
import { Panel, SkeletonRows } from '../ui';

export function BanksPanel() {
  const banks = useStore((s) => s.banks);
  const now = useNow(1000);
  return (
    <Panel title="Central bank watch" accent="var(--macro)" right={banks[0] ? <span className="text-[10px] text-faint" title={banks[0].source}>ref. {banks[0].asOf}</span> : null}>
      {!banks.length ? (
        <SkeletonRows n={5} />
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
          {banks.map((b) => {
            const ms = b.nextMeeting ? b.nextMeeting - now : null;
            const imminent = ms !== null && ms < 3 * 86400_000;
            return (
              <div key={b.id} className="card-hover rounded-lg border border-line bg-bg-2/50 p-2">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[12px] font-semibold text-text"><span aria-hidden>{flag(b.country)}</span>{b.short}</span>
                  <span className="num text-[13px] font-semibold text-text" title={`Policy rate as of ${b.asOf}`}>{b.rateLabel}</span>
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[10px] text-faint">
                  <span>
                    {b.lastChange ? (
                      <span className={b.lastChange.bps < 0 ? 'text-up' : b.lastChange.bps > 0 ? 'text-down' : ''} title={`Last change ${b.lastChange.date}`}>
                        {b.lastChange.bps > 0 ? '+' : ''}{b.lastChange.bps}bp
                      </span>
                    ) : null}
                  </span>
                  <span className={`num ${imminent ? 'text-warn' : ''}`}>
                    {ms === null ? 'next: TBA' : ms <= 0 ? 'meeting today' : `next ${countdown(ms, false)}`}
                  </span>
                </div>
                {b.latest ? (
                  <a href={b.latest.url} target="_blank" rel="noopener noreferrer" className="mt-1 line-clamp-2 block text-[11px] leading-snug text-dim hover:text-text hover:underline" title={`${b.latest.source} · ${new Date(b.latest.ts).toLocaleString()}`}>
                    <span className="num mr-1 text-faint">{timeAgo(b.latest.ts, now)}</span>{b.latest.title}
                  </a>
                ) : (
                  <div className="mt-1 text-[11px] text-faint">No recent statement headlines</div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-2 text-[10px] text-faint">Rates & meeting dates: editable reference file (verify with each bank). Headlines: live news feed.</div>
    </Panel>
  );
}
