'use client';
import Link from 'next/link';
import { useState } from 'react';
import { short, usd } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

type Ev = { id: string; ts: number; kind: string; text: string; href?: string; tone: 'up' | 'down' | 'accent' | 'flash' | 'warn' | 'mute' };
const TONE: Record<Ev['tone'], string> = { up: 'text-up', down: 'text-down', accent: 'text-accent2', flash: 'text-flash', warn: 'text-warn', mute: 'text-mute' };

/** Immediate updater: every live event on one strip (newest first), plus a scrolling ticker; events/min meter. */
export function LiveTape() {
  const [evs, setEvs] = useState<Ev[]>([]);
  const now = useNow(1000);
  const push = (e: Omit<Ev, 'id' | 'ts'>) => setEvs((p) => [{ ...e, id: `${Date.now()}-${Math.random()}`, ts: Date.now() }, ...p].slice(0, 60));
  useLive(({ ch, data }) => {
    if (ch === 'launch') push({ kind: 'NEW', text: `${data.symbol} launched${data.mcap_usd ? ` · ${usd(data.mcap_usd)}` : ''}`, href: `/token?a=${data.address}`, tone: 'accent' });
    else if (ch === 'graduated') push({ kind: 'GRAD', text: `${data.symbol || short(data.address)} graduated to AMM`, href: `/token?a=${data.address}`, tone: 'up' });
    else if (ch === 'signal' && data.verdict !== 'AVOID') push({ kind: data.verdict, text: `${data.symbol} · score ${data.score}`, href: `/token?a=${data.token_address}`, tone: data.verdict === 'BUY' ? 'up' : 'warn' });
    else if (ch === 'flash') push({ kind: 'FLASH', text: data.kind === 'vip_ca' ? `${data.author} posted a CA` : `breakout: ${data.title}`, href: data.token_address ? `/token?a=${data.token_address}` : '/narratives', tone: 'flash' });
    else if (ch === 'narrative_new') push({ kind: 'NARRATIVE', text: data.title, href: `/narratives?n=${data.id}`, tone: 'accent' });
    else if (ch === 'wallet_trade') push({ kind: data.kind === 'kol' ? 'KOL' : 'SMART', text: `${data.label || short(data.wallet)} ${data.side} ${short(data.mint)}`, href: `/token?a=${data.mint}`, tone: data.side === 'buy' ? 'up' : 'down' });
    else if (ch === 'launch_watch_hit') push({ kind: 'WATCH HIT', text: `${data.token.symbol} matches “${data.term}”`, href: `/token?a=${data.token.address}`, tone: 'flash' });
    else if (ch === 'alert' && data.kind === 'rug') push({ kind: 'RUG', text: data.title.replace(/^🚨\s*/, ''), href: data.token_address ? `/token?a=${data.token_address}` : undefined, tone: 'down' });
    else if (ch === 'story') push({ kind: 'STORY', text: `${(data.narratives?.[0]?.title) || 'narrative found'}`, href: `/token?a=${data.token_address}`, tone: 'mute' });
  });
  const rate = evs.filter((e) => e.ts > now * 1000 - 60000).length;
  // launches are high-volume: they scroll in the ticker; the pinned chips are for higher-signal events
  const important = evs.filter((e) => e.kind !== 'NEW');
  const head = important.slice(0, 4);
  const headIds = new Set(head.map((e) => e.id));
  const tape = evs.filter((e) => !headIds.has(e.id)).slice(0, 40);
  const launchesPerMin = evs.filter((e) => e.kind === 'NEW' && e.ts > now * 1000 - 60000).length;
  return (
    <div className="glass mb-3 flex items-stretch overflow-hidden rounded-2xl">
      <div className="flex shrink-0 flex-col justify-center border-r border-white/5 px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-up"><span className="live-dot h-1.5 w-1.5 rounded-full bg-up" />LIVE</span>
        <span className="num text-[11px] text-mute" title="events per minute">{rate}/min</span>
        <span className="num text-[10px] text-accent2" title="new launches per minute">🚀 {launchesPerMin}</span>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">
        {head.map((e, i) => (
          <div key={e.id} className="tape-in shrink-0" style={{ opacity: 1 - i * 0.12 }}>
            <Chip e={e} />
          </div>
        ))}
        {!evs.length && <span className="text-mute">Waiting for the first live event…</span>}
        {tape.length > 3 && (
          <div className="marquee-mask min-w-0 flex-1 overflow-hidden">
            <div className="marquee-track gap-2">{[...tape, ...tape].map((e, i) => <Chip key={`${e.id}-${i}`} e={e} dim />)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ e, dim = false }: { e: Ev; dim?: boolean }) {
  const inner = (
    <span className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-white/5 bg-white/[0.03] px-2 py-1 text-[12px] ${dim ? 'opacity-70' : ''}`}>
      <span className={`text-[10px] font-bold tracking-wider ${TONE[e.tone]}`}>{e.kind}</span>
      <span className="max-w-[220px] truncate">{e.text}</span>
    </span>
  );
  return e.href ? <Link href={e.href} className="mx-1 inline-block hover:opacity-100">{inner}</Link> : <span className="mx-1 inline-block">{inner}</span>;
}
