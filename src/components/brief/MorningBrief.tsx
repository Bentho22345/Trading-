'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { Brief, BriefMeta, BriefProfile } from '@shared/v2';
import { diffBriefs } from '@shared/briefDiff';
import { useV2, api } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { useSettings } from '@/lib/settings';
import { Narrator, chaptersOf, type NarratorState } from '@/lib/tts';
import { Icon, Kbd } from '../ui';
import { Reveal, EmptyCard, Pill } from './bits';
import { SectionBody } from './sections';

const BriefEditor = dynamic(() => import('./BriefEditor').then((m) => m.BriefEditor), { ssr: false });

const KIND_LABEL: Record<string, string> = { morning: 'The Morning Brief', handoff: 'Session Handoff', eod: 'End-of-Day Wrap', weekly: 'The Weekly Review' };
const SPAN: Record<string, string> = { full: 'md:col-span-6', half: 'md:col-span-3', third: 'md:col-span-2' };

function useProfiles() {
  const docs = useV2((s) => s.docs.brief_profiles) as unknown as BriefProfile[] | undefined;
  const [fallback, setFallback] = useState<BriefProfile[]>([]);
  useEffect(() => {
    if (!docs?.length) void api<BriefProfile[]>('/api/brief-profiles').then(setFallback).catch(() => {});
  }, [docs?.length]);
  return useMemo(() => [...(docs?.length ? docs : fallback)].sort((a, b) => a.order - b.order), [docs, fallback]);
}

function ListenBar({ brief }: { brief: Brief }) {
  const [st, setSt] = useState<NarratorState | null>(null);
  const n = useRef<Narrator | null>(null);
  const rate = useSettings((s) => s.ttsRate);
  const voice = useSettings((s) => s.ttsVoice);
  const server = useSettings((s) => s.ttsServer);
  const chapters = useMemo(() => chaptersOf(brief), [brief]);
  useEffect(() => () => n.current?.destroy(), []);
  useEffect(() => {
    n.current?.destroy();
    n.current = null;
    setSt(null);
  }, [brief.id]);
  if (!Narrator.supported() && !server) return null;
  const start = () => {
    if (!n.current) n.current = new Narrator(chapters, setSt, { rate, voice, server });
    n.current.toggle();
  };
  return (
    <div className="flex items-center gap-2">
      <button onClick={start} className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs text-dim hover:border-line-strong hover:text-text" aria-label={st?.playing ? 'Pause' : 'Listen'}>
        <span aria-hidden>{st?.playing ? '❚❚' : '▶'}</span>{st?.playing ? 'Pause' : 'Listen'}
      </button>
      {st ? (
        <>
          <button onClick={() => n.current?.prev()} className="text-faint hover:text-text" aria-label="Previous chapter">⏮</button>
          <div className="relative h-1.5 w-28 overflow-hidden rounded-full bg-bg-2" role="progressbar" aria-valuenow={Math.round(st.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-300" style={{ width: `${st.progress * 100}%` }} />
          </div>
          <button onClick={() => n.current?.next()} className="text-faint hover:text-text" aria-label="Next chapter">⏭</button>
          <span className="hidden max-w-[10rem] truncate text-[11px] text-faint lg:inline">{chapters[st.chapter]?.title}</span>
        </>
      ) : null}
    </div>
  );
}

function ExportMenu({ brief }: { brief: Brief }) {
  const [open, setOpen] = useState(false);
  const item = 'block w-full rounded-md px-2 py-1.5 text-left text-xs text-dim hover:bg-panel-hover hover:text-text';
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs text-dim hover:border-line-strong hover:text-text">Export <Icon name="chevron" size={12} /></button>
      {open ? (
        <div className="absolute right-0 top-8 z-10 w-44 rounded-xl border border-line bg-panel-solid p-1 shadow-xl" onMouseLeave={() => setOpen(false)}>
          <a className={item} href={`/api/briefs/${brief.id}/export/md`}>Markdown (.md)</a>
          <a className={item} href={`/api/briefs/${brief.id}/export/html`} target="_blank" rel="noreferrer">HTML email</a>
          <a className={item} href={`/api/briefs/${brief.id}/export/json`}>JSON</a>
          <button className={item} onClick={() => { setOpen(false); setTimeout(() => window.print(), 50); }}>PDF (print)</button>
          <button className={item} onClick={() => { void navigator.clipboard.writeText(`${brief.headline}\n\n${brief.take.text}\n\n— PULSE · informational only, not investment advice`); setOpen(false); useStore.getState().pushToast({ kind: 'info', title: 'Copied for chat' }); }}>Copy for chat</button>
        </div>
      ) : null}
    </div>
  );
}

function Archive({ onOpen, onDiff }: { onOpen: (id: string) => void; onDiff: (a: string, b: string) => void }) {
  const [list, setList] = useState<BriefMeta[] | null>(null);
  const [kind, setKind] = useState<string>('');
  useEffect(() => {
    void api<BriefMeta[]>(`/api/briefs?limit=300${kind ? `&kind=${kind}` : ''}`).then(setList).catch(() => setList([]));
  }, [kind]);
  const byMonth = useMemo(() => {
    const m = new Map<string, BriefMeta[]>();
    for (const b of list ?? []) m.set(b.date.slice(0, 7), [...(m.get(b.date.slice(0, 7)) ?? []), b]);
    return [...m.entries()];
  }, [list]);
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="font-serif text-3xl text-text">Archive</h2>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-lg border border-line bg-bg-2 px-2 py-1 text-xs text-text">
          <option value="">All briefs</option><option value="morning">Morning</option><option value="handoff">Handoffs</option><option value="eod">End of day</option><option value="weekly">Weekly</option>
        </select>
      </div>
      {list === null ? <div className="skeleton h-40" /> : !list.length ? <EmptyCard text="No briefs yet. The first one is generated at the scheduled time, or press Regenerate." /> : byMonth.map(([month, items]) => (
        <div key={month} className="mb-6">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</div>
          <ul className="divide-y divide-line">
            {items.map((b, i) => {
              const prevSame = items.slice(i + 1).find((x) => x.profileId === b.profileId) ?? null;
              return (
                <li key={b.id} className="flex items-center gap-3 py-2">
                  <span className="num w-20 text-xs text-faint">{b.date.slice(5)} {new Date(b.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                  <button onClick={() => onOpen(b.id)} className="min-w-0 flex-1 truncate text-left font-serif text-[16px] text-text hover:underline">{b.headline}</button>
                  <Pill>{b.kind}</Pill>
                  {b.label ? <Pill tone="accent">{b.label}</Pill> : null}
                  {prevSame ? <button onClick={() => onDiff(prevSame.id, b.id)} className="text-[11px] text-faint hover:text-text">diff</button> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function DiffView({ ids }: { ids: [string, string] }) {
  const [pair, setPair] = useState<[Brief, Brief] | null>(null);
  useEffect(() => {
    void Promise.all(ids.map((id) => api<Brief>(`/api/briefs/${id}`))).then((p) => setPair(p as [Brief, Brief])).catch(() => setPair(null));
  }, [ids]);
  if (!pair) return <div className="mx-auto max-w-3xl"><div className="skeleton h-40" /></div>;
  const d = diffBriefs(pair[0], pair[1]);
  const block = (title: string, children: React.ReactNode) => <section className="mb-6"><h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{title}</h3>{children}</section>;
  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="font-serif text-3xl text-text">What changed</h2>
      <p className="mb-6 mt-1 text-sm text-faint">{pair[0].date} {pair[0].profileName} → {pair[1].date} {pair[1].profileName}</p>
      {block('The take', <div className="space-y-1 text-[15px] leading-relaxed">{d.takeRemoved.map((s) => <p key={`-${s}`} className="rounded bg-down/10 px-2 text-dim line-through decoration-down/60">{s}</p>)}{d.takeAdded.map((s) => <p key={`+${s}`} className="rounded bg-up/10 px-2 text-text">{s}</p>)}{!d.takeAdded.length && !d.takeRemoved.length ? <p className="text-faint">Unchanged.</p> : null}</div>)}
      {block('Stories', <ul className="space-y-1 text-[14px]">{d.storiesNew.map((s) => <li key={s.id} className="text-text"><span className="mr-2 text-up">new</span>{s.headline}</li>)}{d.storiesKept.map((k) => <li key={k.story.id} className="text-dim"><span className="num mr-2 text-faint">#{k.rankFrom}→#{k.rankTo}</span>{k.story.headline}</li>)}{d.storiesDropped.map((s) => <li key={s.id} className="text-faint line-through">{s.headline}</li>)}</ul>)}
      {block('Scoreboard', <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">{d.moves.map((m) => <div key={m.symbol} className="flex justify-between text-[13px]"><span className="text-text">{m.symbol}</span><span className="num text-faint">{m.before.toFixed(m.bp ? 0 : 2)} → <span className={m.after >= 0 ? 'text-up' : 'text-down'}>{m.after.toFixed(m.bp ? 0 : 2)}{m.bp ? 'bp' : '%'}</span></span></div>)}</div>)}
      {block('Calendar', <div className="text-[13px] text-dim">{d.eventsNew.map((e) => <div key={e}><span className="mr-2 text-up">+</span>{e}</div>)}{d.eventsDropped.map((e) => <div key={e} className="text-faint"><span className="mr-2 text-down">−</span>{e}</div>)}{!d.eventsNew.length && !d.eventsDropped.length ? 'No changes.' : null}</div>)}
    </div>
  );
}

function BriefPage({ brief }: { brief: Brief }) {
  return (
    <article className="mx-auto max-w-5xl print-root" aria-label={brief.headline}>
      <Reveal i={0}>
        <div className="flex items-center justify-between border-b border-line-strong pb-2 text-[10px] font-semibold uppercase tracking-[0.3em] text-faint">
          <span>{KIND_LABEL[brief.kind] ?? 'Brief'}{brief.profileName && !(KIND_LABEL[brief.kind] ?? '').toLowerCase().includes(brief.profileName.toLowerCase()) ? ` · ${brief.profileName}` : ''}</span>
          <span className="num">{new Date(`${brief.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</span>
        </div>
        <h1 className="mt-5 font-serif text-[clamp(2rem,4.6vw,3.6rem)] font-medium leading-[1.05] tracking-tight text-text">{brief.headline}</h1>
        <div className="mt-6 grid gap-6 md:grid-cols-[1fr_14rem]">
          <p className="font-serif text-[clamp(1.1rem,1.6vw,1.35rem)] leading-[1.6] text-text first-letter:float-left first-letter:mr-2 first-letter:font-serif first-letter:text-[3.4em] first-letter:font-semibold first-letter:leading-[0.85] first-letter:text-accent">{brief.take.text}</p>
          <aside className="space-y-2 border-l border-line pl-4 text-[11px] text-faint">
            <div>{brief.take.ai ? <>AI narrative <span className="text-dim">({brief.take.model})</span>, written only from the data below</> : 'Template narrative built from the data below (add an Anthropic key for an AI-written take)'}</div>
            <div className="num">Generated {new Date(brief.createdAt).toLocaleString([], { hour12: false })}{brief.label ? ` · ${brief.label}` : ''}</div>
            <div>Every number shows its source; delayed data is marked.</div>
          </aside>
        </div>
      </Reveal>
      <div className="mt-10 grid grid-cols-1 gap-x-10 gap-y-10 md:grid-cols-6">
        {brief.sections.filter((s) => s.type !== 'take').map((s, i) => (
          <Reveal key={s.id} i={i + 1} className={SPAN[s.size] ?? 'md:col-span-6'}>
            <section aria-label={s.title}>
              <h2 className="mb-3 flex items-baseline justify-between border-t border-line-strong pt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-dim">
                <span>{s.title}</span>
                {s.sources?.length ? <span className="max-w-[60%] truncate font-normal normal-case tracking-normal text-faint">{s.sources.slice(0, 3).join(' · ')}</span> : null}
              </h2>
              <SectionBody s={s} brief={brief} />
            </section>
          </Reveal>
        ))}
      </div>
      <footer className="mt-12 border-t border-line pt-3 text-[11px] text-faint">Informational only — not investment advice. Data may be delayed; links go to the original publishers.</footer>
    </article>
  );
}

export function MorningBrief() {
  const open = useV2((s) => s.briefOpen);
  const id = useV2((s) => s.briefId);
  const view = useV2((s) => s.briefView);
  const diffIds = useV2((s) => s.diffIds);
  const set = useV2((s) => s.set);
  const profiles = useProfiles();
  const [profileId, setProfileId] = useState<string>('morning');
  const [brief, setBrief] = useState<Brief | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const close = useCallback(() => set({ briefOpen: false, briefView: 'read' }), [set]);

  const load = useCallback(async () => {
    setBrief(undefined);
    try {
      const b = id ? await api<Brief>(`/api/briefs/${id}`) : await api<Brief | null>(`/api/briefs/latest?profile=${encodeURIComponent(profileId)}&kind=${profiles.find((p) => p.id === profileId)?.kind ?? 'morning'}`);
      setBrief(b);
      if (b) {
        setProfileId(b.profileId);
        try { localStorage.setItem('pulse.brief.seen', b.id); } catch { /* storage unavailable */ }
      }
    } catch {
      setBrief(null);
    }
  }, [id, profileId, profiles]);

  useEffect(() => {
    if (open && view === 'read') void load();
  }, [open, view, load]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (view !== 'read') set({ briefView: 'read' });
        else close();
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [open, view, close, set]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [brief?.id, view]);

  if (!open) return null;

  const regenerate = async () => {
    setBusy(true);
    try {
      const b = await api<Brief>('/api/briefs/regenerate', { method: 'POST', json: { profileId } });
      set({ briefId: b.id });
      setBrief(b);
    } catch (e) {
      useStore.getState().pushToast({ kind: 'error', title: 'Could not regenerate', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const tab = (v: typeof view, label: string) => <button onClick={() => set({ briefView: v })} className={`rounded-md px-2 py-1 text-xs ${view === v ? 'bg-panel-hover text-text' : 'text-faint hover:text-dim'}`}>{label}</button>;

  return (
    <div className="brief-paper fixed inset-0 z-[70] flex flex-col" role="dialog" aria-modal="true" aria-label="Morning brief">
      <div className="no-print flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <span className="text-xs font-bold tracking-[0.3em] text-text">PULSE</span>
        <div className="ml-2 flex flex-wrap gap-1">
          {profiles.map((p) => (
            <button key={p.id} onClick={() => { setProfileId(p.id); set({ briefId: null, briefView: 'read' }); }} className={`rounded-full border px-2.5 py-0.5 text-[11px] ${profileId === p.id && view === 'read' ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-faint hover:text-dim'}`}>{p.name}</button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {view === 'read' && brief ? <ListenBar brief={brief} /> : null}
          <div className="flex rounded-lg border border-line p-0.5">{tab('read', 'Read')}{tab('archive', 'Archive')}{tab('editor', 'Edit')}</div>
          {view === 'read' && brief ? <ExportMenu brief={brief} /> : null}
          <button onClick={regenerate} disabled={busy} className="rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-medium text-text hover:bg-accent/20 disabled:opacity-60">{busy ? 'Building…' : 'Regenerate now'}</button>
          <button onClick={close} className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-dim hover:text-text" aria-label="Close brief">Close <Kbd>Esc</Kbd></button>
        </div>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8 sm:py-12">
        {view === 'editor' ? <BriefEditor initialProfileId={profileId} />
          : view === 'archive' ? <Archive onOpen={(bid) => set({ briefId: bid, briefView: 'read' })} onDiff={(a, b) => set({ diffIds: [a, b], briefView: 'diff' })} />
            : view === 'diff' && diffIds ? <DiffView ids={diffIds} />
              : brief === undefined ? <div className="mx-auto max-w-5xl space-y-4"><div className="skeleton h-6 w-64" /><div className="skeleton h-16 w-full" /><div className="skeleton h-40 w-full" /></div>
                : brief === null ? <div className="mx-auto max-w-xl pt-10"><EmptyCard text="No brief for this profile yet. It's generated on schedule, or build one now from live data." action="Generate now" onAction={regenerate} /></div>
                  : <BriefPage key={brief.id} brief={brief} />}
      </div>
    </div>
  );
}

/** Opens today's morning brief on the first visit of the day (per browser). */
export function BriefAutoOpen() {
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const latest = await api<Brief | null>('/api/briefs/latest?kind=morning');
        if (!latest) return;
        const profiles = await api<BriefProfile[]>('/api/brief-profiles');
        const p = profiles.find((x) => x.id === latest.profileId);
        const today = new Date().toLocaleDateString('en-CA', { timeZone: latest.tz });
        const key = 'pulse.brief.autoOpened';
        if (latest.date === today && p?.autoOpen !== false && localStorage.getItem(key) !== today) {
          localStorage.setItem(key, today);
          useV2.getState().openBrief(latest.id);
        }
      } catch {
        /* the brief is optional; the terminal works without it */
      }
    }, 1500);
    return () => clearTimeout(t);
  }, []);
  return null;
}
