'use client';
import type { EconEvent, EarningsItem } from '@shared/types';
import type { Auction, Brief, BriefSection, BriefStory, LevelHit, OutcomeCheck, PlaybookOutcome, RatePath, ScoreRow, SocialRow, StructureEvent, ThemeItem } from '@shared/v2';
import { fmtBp, fmtPct, fmtPrice, flag, timeAgo } from '@/lib/format';
import { useStore } from '@/lib/store';
import { useV2 } from '@/lib/v2';
import { CountUp, DrawSpark, EmptyCard, Pill, PinChip } from './bits';
import { Icon } from '../ui';

const time = (ts: number, tz: string) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz, hour12: false });
const move = (r: Pick<ScoreRow, 'bp' | 'change' | 'changePct'>) => (r.bp ? fmtBp(r.change) : fmtPct(r.changePct));
const openSymbol = (s: string) => useStore.getState().set({ drawerSymbol: s });

const GROUP_COLOR: Record<string, string> = { Indices: 'var(--eq)', FX: 'var(--fx)', Crypto: 'var(--crypto)', Commodities: 'var(--cmdty)', Rates: 'var(--rates)' };

function Scoreboard({ d }: { d: { rows: ScoreRow[] } }) {
  const groups = [...new Set(d.rows.map((r) => r.group))];
  return (
    <div className="@container"><div className="grid gap-x-8 gap-y-5 @lg:grid-cols-2 @4xl:grid-cols-3">
      {groups.map((g, gi) => (
        <div key={g}>
          <div className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
            <span className="h-2 w-2 rounded-full" style={{ background: GROUP_COLOR[g] ?? 'var(--accent)' }} />{g}
          </div>
          <ul className="divide-y divide-line">
            {d.rows.filter((r) => r.group === g).map((r, i) => (
              <li key={r.symbol}>
                <button onClick={() => openSymbol(r.symbol)} className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-3 py-1.5 text-left hover:bg-panel-hover/40" title={`${r.name} · ${r.source}${r.delayedMin ? ` · ${r.delayedMin}m delayed` : ''}`}>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-text">{r.symbol}</span>
                    <span className="block truncate text-[10px] text-faint">{r.name}{r.delayedMin ? ` · ${r.delayedMin}m delayed` : ''}{r.mock ? ' · demo' : ''}</span>
                  </span>
                  <DrawSpark data={r.spark} up={r.change >= 0} width={72} height={22} delay={gi * 80 + i * 40} baseline={r.from} />
                  <span className="w-[92px] text-right">
                    <CountUp from={r.from} to={r.last} decimals={r.decimals} className="block text-[13px] text-text" />
                    <span className={`num block text-[11px] ${r.change >= 0 ? 'text-up' : 'text-down'}`}>{move(r)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div></div>
  );
}

function Stories({ d }: { d: { stories: BriefStory[] } }) {
  return (
    <ol className="space-y-5">
      {d.stories.map((s, i) => (
        <li key={s.id} className={`grid grid-cols-[2.2rem_1fr] gap-3 ${s.inBook ? 'relevant rounded-r-lg pl-2' : ''}`}>
          <span className="font-serif text-3xl font-light leading-none text-faint">{i + 1}</span>
          <div className="min-w-0">
            <button onClick={() => useStore.getState().set({ timelineId: s.id })} className="text-left font-serif text-[19px] font-semibold leading-snug text-text hover:underline decoration-line-strong underline-offset-4">{s.headline}</button>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {s.inBook ? <PinChip /> : null}
              <Pill tone={s.impact >= 75 ? 'down' : s.impact >= 55 ? 'warn' : 'neutral'} title="Impact score">impact {s.impact}</Pill>
              {s.relevance > 1 ? <Pill tone="accent" title="Personal relevance multiplier">×{s.relevance}</Pill> : null}
            </div>
            <p className="mt-1.5 text-[14px] leading-relaxed text-dim">{s.tldr}</p>
            <p className="mt-1 text-[13px] italic leading-relaxed text-dim"><span className="not-italic font-semibold text-text">Why it matters · </span>{s.why}</p>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
              {s.sources.map((x) => <a key={x.url + x.source} href={x.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-faint hover:text-text">{x.source}<Icon name="external" size={10} /></a>)}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

type CalEvent = EconEvent & { avgSurprise?: { avg: number; n: number } | null; surprise?: number | null; meeting?: string | null };

function Calendar({ d, tz }: { d: { events: CalEvent[]; speakers: EconEvent[]; auctions: Auction[]; bmo: EarningsItem[]; amc: EarningsItem[]; structure: StructureEvent[] }; tz: string }) {
  return (
    <div className="space-y-4">
      {d.events.length ? (
        <table className="w-full text-[13px]">
          <thead><tr className="text-left text-[10px] uppercase tracking-wider text-faint"><th className="pb-1 font-medium">Time</th><th className="pb-1 font-medium">Release</th><th className="pb-1 text-right font-medium">Cons</th><th className="pb-1 text-right font-medium">Prev</th><th className="hidden pb-1 text-right font-medium sm:table-cell">Avg surprise</th></tr></thead>
          <tbody className="divide-y divide-line">
            {d.events.map((e) => (
              <tr key={e.id} className={e.meeting ? 'relevant' : ''}>
                <td className="num py-1.5 pr-2 text-dim">{time(e.time, tz)}</td>
                <td className="py-1.5 pr-2">
                  <span className="mr-1">{flag(e.country)}</span>
                  <span className={`text-text ${e.importance === 3 ? 'font-semibold' : ''}`}>{e.title}</span>
                  {e.actual !== null ? <span className={`num ml-2 text-[12px] font-semibold ${e.surprise === null || e.surprise === undefined ? 'text-text' : (e.surprise > 0) !== !!e.lowerIsBetter ? 'text-up' : 'text-down'}`}>{e.actual}{e.unit}</span> : null}
                  {e.meeting ? <div className="text-[11px] text-warn">⚠ You&apos;re in “{e.meeting}” at this time</div> : null}
                </td>
                <td className="num py-1.5 text-right text-dim">{e.consensus ?? '—'}{e.consensus !== null ? e.unit : ''}</td>
                <td className="num py-1.5 text-right text-faint">{e.previous ?? '—'}{e.previous !== null ? e.unit : ''}</td>
                <td className="num hidden py-1.5 text-right text-faint sm:table-cell" title={e.avgSurprise ? `Mean of actual − consensus over the last ${e.avgSurprise.n} releases` : 'Builds up as releases are recorded'}>{e.avgSurprise ? `${e.avgSurprise.avg > 0 ? '+' : ''}${e.avgSurprise.avg}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {d.speakers.length ? <div><div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Central bank speakers</div>{d.speakers.map((s) => <div key={s.id} className="text-[13px] text-dim"><span className="num mr-2">{time(s.time, tz)}</span>{flag(s.country)} {s.title}</div>)}</div> : null}
      {d.auctions.length ? <div><div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Treasury auctions</div>{d.auctions.map((a) => <div key={a.id} className="text-[13px] text-dim">{a.term} {a.security}{a.offering ? ` · $${(a.offering / 1e9).toFixed(0)}B` : ''}</div>)}</div> : null}
      {d.bmo.length || d.amc.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {([['Before the open', d.bmo], ['After the close', d.amc]] as const).map(([label, list]) => list.length ? (
            <div key={label}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">{label}</div>
              <div className="flex flex-wrap gap-1.5">{list.map((e) => <button key={e.symbol} onClick={() => openSymbol(e.symbol)} className="rounded-md border border-line px-1.5 py-0.5 text-[12px] text-text hover:border-line-strong">{e.symbol}{e.impliedMovePct ? <span className="num ml-1 text-faint">±{e.impliedMovePct}%</span> : null}</button>)}</div>
            </div>
          ) : null)}
        </div>
      ) : null}
      {d.structure.length ? <div className="flex flex-wrap gap-1.5">{d.structure.map((s) => <Pill key={s.id} tone="warn">{s.label}</Pill>)}</div> : null}
    </div>
  );
}

function Book({ d }: { d: { rows: { symbol: string; qty: number; price: number | null; pnl: number | null; pct: number | null }[]; total: number; news: { id: string; headline: string; url: string; source: string }[]; levels: LevelHit[] } }) {
  const privacy = useV2((s) => s.privacy);
  return (
    <div className={privacy ? 'blur-sm select-none' : ''}>
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wider text-faint">Overnight P&amp;L</span>
        <CountUp from={0} to={d.total} decimals={0} className={`text-2xl font-semibold ${d.total >= 0 ? 'text-up' : 'text-down'}`} format={(v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`} />
      </div>
      <ul className="divide-y divide-line text-[13px]">
        {d.rows.map((r) => (
          <li key={r.symbol} className="flex items-center justify-between py-1">
            <button onClick={() => openSymbol(r.symbol)} className="font-medium text-text hover:underline">{r.symbol} <span className="num text-[11px] text-faint">{r.qty}</span></button>
            <span className={`num ${r.pnl === null ? 'text-faint' : r.pnl >= 0 ? 'text-up' : 'text-down'}`}>{r.pnl === null ? 'no price' : `${r.pnl >= 0 ? '+' : '−'}$${Math.abs(r.pnl).toLocaleString('en-US', { maximumFractionDigits: 0 })} (${fmtPct(r.pct)})`}</span>
          </li>
        ))}
      </ul>
      {d.news.length ? <div className="mt-3 space-y-1">{d.news.map((n) => <a key={n.id} href={n.url} target="_blank" rel="noopener noreferrer" className="relevant block rounded-r pl-2 text-[13px] text-dim hover:text-text">📌 {n.headline} <span className="text-faint">· {n.source}</span></a>)}</div> : null}
      {d.levels.length ? <div className="mt-3 flex flex-wrap gap-1.5">{d.levels.map((l) => <Pill key={`${l.symbol}${l.level}`} tone={l.status === 'broken' ? 'down' : 'warn'}>{l.symbol} {l.label} {l.status}</Pill>)}</div> : null}
    </div>
  );
}

function Levels({ d }: { d: { levels: LevelHit[]; note?: string } }) {
  return (
    <div>
      <table className="w-full text-[13px]">
        <tbody className="divide-y divide-line">
          {d.levels.map((l) => (
            <tr key={`${l.symbol}-${l.kind}-${l.level}`} className={l.kind === 'user' ? 'relevant' : ''}>
              <td className="py-1 pl-2 font-medium text-text"><button onClick={() => openSymbol(l.symbol)} className="hover:underline">{l.symbol}</button></td>
              <td className="py-1 text-dim">{l.kind === 'user' ? '📌 ' : ''}{l.label}</td>
              <td className="num py-1 text-right text-text">{fmtPrice(l.level, l.decimals)}</td>
              <td className="num py-1 text-right text-faint">{l.distancePct === null ? '—' : `${l.distancePct > 0 ? '+' : ''}${l.distancePct}%`}</td>
              <td className="py-1 text-right">{l.status !== 'watch' ? <Pill tone={l.status === 'broken' ? 'down' : 'warn'}>{l.status}</Pill> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.note ? <p className="mt-2 text-[11px] text-faint">{d.note}</p> : null}
    </div>
  );
}

export function ProbBar({ m }: { m: { cut: number; hold: number; hike: number; delta?: number } }) {
  const seg = (v: number, color: string, label: string) => v > 0.5 ? <div className="ease-value flex h-full items-center justify-center overflow-hidden text-[9px] font-semibold text-white/90" style={{ width: `${v}%`, background: color }} title={`${label} ${v.toFixed(0)}%`}>{v >= 14 ? `${label} ${v.toFixed(0)}%` : ''}</div> : null;
  return (
    <div className="bar-grow flex h-4 w-full overflow-hidden rounded-md bg-bg-2">
      {seg(m.cut, 'var(--up)', 'Cut')}{seg(m.hold, 'color-mix(in oklab, var(--text-faint) 70%, transparent)', 'Hold')}{seg(m.hike, 'var(--down)', 'Hike')}
    </div>
  );
}

function RatePathSec({ d }: { d: { paths: RatePath[]; source: string; mock?: boolean; connected: boolean; note?: string } }) {
  return (
    <div className="space-y-3">
      {d.paths.map((p) => (
        <div key={p.bank}>
          <div className="mb-1 flex items-baseline justify-between text-[12px]"><span className="font-semibold text-text">{p.name}</span><span className="num text-faint">{p.rate.toFixed(2)}%</span></div>
          <div className="space-y-1">
            {p.meetings.slice(0, 3).map((m) => (
              <div key={m.date} className="grid grid-cols-[4.5rem_1fr_3rem] items-center gap-2">
                <span className="num text-[11px] text-faint">{m.date.slice(5)}</span>
                <ProbBar m={m} />
                <span className={`num text-right text-[11px] ${m.delta > 0 ? 'text-up' : m.delta < 0 ? 'text-down' : 'text-faint'}`}>{m.delta ? `${m.delta > 0 ? '▲' : '▼'}${Math.abs(m.delta).toFixed(0)}` : '·'}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="text-[11px] text-faint">{d.source}{d.mock ? ' · demo data' : ''}{d.note ? ` · ${d.note}` : ''}</p>
    </div>
  );
}

function Sentiment({ d }: { d: { fearGreed: { value: number; label: string } | null; vix: { price: number; changePct: number } | null; structure: string | null; putCall: { total: number; equity: number; index: number } | null; funding: number | null; buzz: SocialRow[]; regime: { score: number; label: string } | null } }) {
  const tile = (label: string, value: React.ReactNode, sub?: React.ReactNode) => (
    <div className="rounded-xl border border-line bg-bg-2/30 px-3 py-2.5"><div className="text-[10px] uppercase tracking-wider text-faint">{label}</div><div className="mt-0.5 text-lg font-semibold text-text">{value}</div>{sub ? <div className="text-[11px] text-faint">{sub}</div> : null}</div>
  );
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {d.fearGreed ? tile('Crypto fear & greed', <span className="num">{d.fearGreed.value}</span>, d.fearGreed.label) : null}
      {d.vix ? tile('VIX', <span className="num">{d.vix.price.toFixed(2)}</span>, <>{fmtPct(d.vix.changePct)}{d.structure ? ` · ${d.structure}` : ''}</>) : null}
      {d.putCall ? tile('Put / call', <span className="num">{d.putCall.total.toFixed(2)}</span>, `equity ${d.putCall.equity} · index ${d.putCall.index}`) : null}
      {d.funding !== null ? tile('Perp funding (avg)', <span className="num">{(d.funding * 100).toFixed(4)}%</span>, d.funding > 0 ? 'longs paying' : 'shorts paying') : null}
      {d.regime ? tile('Regime', <span className="capitalize">{d.regime.label}</span>, <span className="num">{d.regime.score > 0 ? '+' : ''}{d.regime.score.toFixed(0)}</span>) : null}
      {d.buzz.length ? tile('Buzz leaders', <span className="text-sm">{d.buzz.slice(0, 3).map((b) => b.symbol).join(' · ')}</span>, d.buzz[0] ? `${d.buzz[0].ratio.toFixed(1)}× normal mentions` : undefined) : null}
    </div>
  );
}

function WeekAhead({ d }: { d: { days: { date: string; events: EconEvent[]; earnings: string[]; structure: string[] }[] } }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
      {d.days.map((x) => (
        <div key={x.date} className="rounded-xl border border-line bg-bg-2/30 p-2.5">
          <div className="text-[11px] font-semibold text-text">{new Date(`${x.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}</div>
          <ul className="mt-1 space-y-0.5 text-[11px] text-dim">
            {x.events.map((e) => <li key={e.id}>{flag(e.country)} {e.title}</li>)}
            {x.earnings.length ? <li className="text-faint">Earnings: {x.earnings.join(', ')}</li> : null}
            {x.structure.map((s) => <li key={s} className="text-warn">{s}</li>)}
            {!x.events.length && !x.earnings.length && !x.structure.length ? <li className="text-faint">—</li> : null}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function OutcomeRow({ o }: { o: PlaybookOutcome }) {
  const hit = (c: OutcomeCheck, k: 'm5' | 'm30' | 'h2') => (c.hits[k] === undefined ? <span className="text-faint">·</span> : c.hits[k] ? <span className="text-up">✓</span> : <span className="text-down">✗</span>);
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <div className="text-[12px] font-semibold text-text">{o.playbookName} <span className="font-normal text-faint">· {o.eventTitle}</span></div>
      <div className="text-[11px] text-dim">{o.scenarioLabel ? `Scenario: ${o.scenarioLabel}` : 'No scenario matched'}{o.surprise !== null ? ` · surprise ${o.surprise > 0 ? '+' : ''}${o.surprise}` : ''}</div>
      {o.checks.length ? (
        <table className="mt-1 w-full text-[11px]"><thead><tr className="text-faint"><th className="text-left font-normal">Expect</th><th className="font-normal">5m</th><th className="font-normal">30m</th><th className="font-normal">2h</th></tr></thead>
          <tbody>{o.checks.map((c) => <tr key={c.symbol + c.direction}><td className="text-dim">{c.symbol} {c.direction === 'up' ? '▲' : '▼'}</td><td className="text-center">{hit(c, 'm5')}</td><td className="text-center">{hit(c, 'm30')}</td><td className="text-center">{hit(c, 'h2')}</td></tr>)}</tbody></table>
      ) : null}
    </div>
  );
}

function Scorecard({ d }: { d: { calls: { id: string; text: string; outcome: string; movePct: number | null }[]; outcomes: PlaybookOutcome[]; hitRate: number | null } }) {
  return (
    <div className="space-y-3">
      {d.hitRate !== null ? <div className="text-sm text-dim">Hit rate <span className="num text-lg font-semibold text-text">{Math.round(d.hitRate * 100)}%</span> <span className="text-[11px] text-faint">· sentiment-implied leans, not advice</span></div> : null}
      <ul className="space-y-1 text-[13px]">
        {d.calls.map((c) => (
          <li key={c.id} className="flex items-start gap-2">
            <span className={c.outcome === 'hit' ? 'text-up' : c.outcome === 'miss' ? 'text-down' : 'text-faint'}>{c.outcome === 'hit' ? '✓' : c.outcome === 'miss' ? '✗' : '·'}</span>
            <span className="flex-1 text-dim">{c.text}</span>
            {c.movePct !== null ? <span className="num text-faint">{c.movePct > 0 ? '+' : ''}{c.movePct}%</span> : null}
          </li>
        ))}
      </ul>
      {d.outcomes.length ? <div className="grid gap-2 sm:grid-cols-2">{d.outcomes.slice(0, 4).map((o) => <OutcomeRow key={o.id} o={o} />)}</div> : null}
    </div>
  );
}

function Movers({ d }: { d: { gainers: ScoreRow[]; losers: ScoreRow[] } }) {
  const col = (title: string, rows: ScoreRow[]) => (
    <div><div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">{title}</div>
      <ul className="divide-y divide-line">{rows.map((r) => <li key={r.symbol}><button onClick={() => openSymbol(r.symbol)} className="flex w-full items-center justify-between py-1 text-[13px] hover:bg-panel-hover/40"><span className="font-medium text-text">{r.symbol}</span><span className={`num ${r.change >= 0 ? 'text-up' : 'text-down'}`}>{move(r)}</span></button></li>)}</ul></div>
  );
  return <div className="grid gap-6 sm:grid-cols-2">{col('Gainers', d.gainers)}{col('Losers', d.losers)}</div>;
}

function Activity({ d }: { d: { cells: { t: number; n: number }[] } }) {
  const max = Math.max(1, ...d.cells.map((c) => c.n));
  const byKey = new Map(d.cells.map((c) => [c.t, c.n]));
  const start = Math.floor((Date.now() - 6 * 86400_000) / 86400_000) * 86400_000;
  return (
    <div className="overflow-x-auto">
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: 'auto repeat(24, minmax(8px, 1fr))' }}>
        {Array.from({ length: 7 }, (_, day) => {
          const d0 = start + day * 86400_000;
          return [
            <span key={`l${day}`} className="pr-1 text-[10px] text-faint">{new Date(d0).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</span>,
            ...Array.from({ length: 24 }, (_, h) => {
              const n = byKey.get(d0 + h * 3600_000) ?? 0;
              return <span key={`${day}-${h}`} title={`${n} stories`} className="h-3 rounded-[2px]" style={{ background: n ? `color-mix(in oklab, var(--accent) ${15 + (n / max) * 85}%, transparent)` : 'var(--bg-2)' }} />;
            }),
          ];
        })}
      </div>
      <p className="mt-1 text-[10px] text-faint">Stories ingested per hour (UTC), last 7 days</p>
    </div>
  );
}

export function SectionBody({ s, brief }: { s: BriefSection; brief: Brief }) {
  const openSettings = (sec: string) => useV2.getState().set({ settingsCenter: sec });
  if (s.empty) {
    const connect = s.type === 'ratePath' ? { action: 'Connect a provider', on: () => openSettings('integrations') }
      : s.type === 'book' ? { action: 'Import positions', on: () => useV2.getState().set({ libraryOpen: false, settingsCenter: 'portfolio' }) }
        : s.type === 'smartFeed' ? { action: 'Choose a feed', on: () => useV2.getState().set({ briefView: 'editor' }) } : null;
    return <EmptyCard text={s.empty} icon={s.type === 'book' ? 'layout' : s.type === 'ratePath' ? 'timeline' : 'sparkle'} action={connect?.action} onAction={connect?.on} />;
  }
  const d = s.data as never;
  switch (s.type) {
    case 'scoreboard': return <Scoreboard d={d} />;
    case 'stories': return <Stories d={d} />;
    case 'calendar': return <Calendar d={d} tz={brief.tz} />;
    case 'book': return <Book d={d} />;
    case 'levels': return <Levels d={d} />;
    case 'ratePath': return <RatePathSec d={d} />;
    case 'sentiment': return <Sentiment d={d} />;
    case 'weekAhead': return <WeekAhead d={d} />;
    case 'scorecard': return <Scorecard d={d} />;
    case 'movers': return <Movers d={d} />;
    case 'activity': return <Activity d={d} />;
    case 'nextUp': return <ul className="space-y-1 text-[13px]">{(s.data as { events: EconEvent[] }).events.map((e) => <li key={e.id} className="text-dim"><span className="num mr-2 text-faint">{time(e.time, brief.tz)}</span>{flag(e.country)} {e.title}</li>)}</ul>;
    case 'risks': return <ul className="space-y-1.5 text-[13px] text-dim">{(s.data as { risks: string[] }).risks.map((r) => <li key={r} className="flex gap-2"><span className="text-warn">•</span>{r}</li>)}</ul>;
    case 'themes': return <div className="flex flex-wrap gap-2">{(s.data as { themes: ThemeItem[] }).themes.map((t) => <span key={t.id} className="rounded-full border border-line px-2.5 py-1 text-[12px] text-text">{t.label} <span className="num text-faint">{t.volume}</span></span>)}</div>;
    case 'journal': return <JournalPrompt d={s.data as { prompt: string; alerts: { ts: number; message: string }[] }} />;
    case 'structure': return <ul className="space-y-1 text-[13px]">{(s.data as { items: StructureEvent[] }).items.map((x) => <li key={x.id} className="text-dim"><span className="num mr-2 text-faint">{x.date.slice(5)}</span>{x.label}</li>)}</ul>;
    case 'smartFeed': {
      const sd = s.data as { feed: { name: string; color: string }; stories: { id: string; headline: string; url: string; source: string; impact: number }[] };
      return <ul className="space-y-1.5 text-[13px]">{sd.stories.map((x) => <li key={x.id}><a href={x.url} target="_blank" rel="noopener noreferrer" className="text-text hover:underline">{x.headline}</a> <span className="text-faint">· {x.source}</span></li>)}</ul>;
    }
    default: return null;
  }
}

function JournalPrompt({ d }: { d: { prompt: string; alerts: { ts: number; message: string }[] } }) {
  return (
    <div>
      <p className="font-serif text-xl italic text-text">{d.prompt}</p>
      {d.alerts.length ? <ul className="mt-2 space-y-0.5 text-[12px] text-faint">{d.alerts.map((a) => <li key={a.ts}>🔔 {a.message} · {timeAgo(a.ts, Date.now())} ago</li>)}</ul> : null}
      <button onClick={() => useV2.getState().set({ journalOpen: true, briefOpen: false })} className="mt-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-text hover:bg-accent/20">Open today&apos;s journal</button>
    </div>
  );
}
