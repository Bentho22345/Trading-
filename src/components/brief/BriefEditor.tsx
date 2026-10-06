'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import type { Brief, BriefProfile, BriefSectionConfig, BriefSectionType, SmartFeed } from '@shared/v2';
import { useV2, useDocs, api } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { Icon } from '../ui';
import { Reveal } from './bits';
import { SectionBody } from './sections';

const TITLES: Record<BriefSectionType, string> = {
  take: 'The take', scoreboard: 'Scoreboard', stories: 'Top stories', calendar: 'Calendar', book: 'Your book', levels: 'Key levels', ratePath: 'Rates path',
  sentiment: 'Sentiment', weekAhead: 'Week ahead', scorecard: 'Scorecard', smartFeed: 'Smart feed', movers: 'Movers', journal: 'Journal prompt',
  themes: 'Themes', nextUp: "What's next", risks: 'Open risks', structure: 'Market structure', activity: 'Activity heatmap',
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CLASSES = ['fx', 'crypto', 'equities', 'rates', 'commodities'];
const TZS = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Europe/Zurich', 'Asia/Tokyo', 'Asia/Hong_Kong', 'Asia/Singapore', 'Australia/Sydney', 'UTC'];
const input = 'rounded-lg border border-line bg-bg-2/60 px-2 py-1 text-xs text-text focus:border-accent/60 focus:outline-none';
const label = 'text-[10px] font-semibold uppercase tracking-wider text-faint';

function SectionRow({ s, onChange, onRemove, feeds }: { s: BriefSectionConfig; onChange: (s: BriefSectionConfig) => void; onRemove: () => void; feeds: SmartFeed[] }) {
  const controls = useDragControls();
  const [open, setOpen] = useState(false);
  const opt = (patch: Partial<BriefSectionConfig['options']>) => onChange({ ...s, options: { ...s.options, ...patch } });
  return (
    <Reorder.Item value={s} dragListener={false} dragControls={controls} className="list-none">
      <div className={`rounded-xl border border-line bg-panel ${s.enabled ? '' : 'opacity-50'}`}>
        <div className="flex items-center gap-2 px-2.5 py-2">
          <button onPointerDown={(e) => controls.start(e)} className="cursor-grab touch-none text-faint hover:text-text" aria-label={`Drag ${TITLES[s.type]}`}><Icon name="grip" size={14} /></button>
          <span className="flex-1 text-xs font-medium text-text">{s.options.title || TITLES[s.type]}</span>
          <select value={s.size} onChange={(e) => onChange({ ...s, size: e.target.value as BriefSectionConfig['size'] })} className={input} aria-label="Section width">
            <option value="full">Full</option><option value="half">Half</option><option value="third">Third</option>
          </select>
          <button onClick={() => setOpen(!open)} className="text-faint hover:text-text" aria-label="Section options"><Icon name="settings" size={13} /></button>
          <button onClick={() => onChange({ ...s, enabled: !s.enabled })} className="text-faint hover:text-text" aria-label={s.enabled ? 'Hide section' : 'Show section'}><Icon name={s.enabled ? 'eye' : 'eyeOff'} size={13} /></button>
          {s.type !== 'take' ? <button onClick={onRemove} className="text-faint hover:text-down" aria-label="Remove section"><Icon name="trash" size={13} /></button> : null}
        </div>
        {open ? (
          <div className="grid grid-cols-2 gap-2 border-t border-line px-3 py-2.5 text-xs">
            <label className="col-span-2 flex flex-col gap-1"><span className={label}>Title</span><input className={input} value={s.options.title ?? ''} placeholder={TITLES[s.type]} onChange={(e) => opt({ title: e.target.value || undefined })} /></label>
            {['stories', 'smartFeed', 'levels'].includes(s.type) ? <label className="flex flex-col gap-1"><span className={label}>Top N</span><input type="number" min={1} max={20} className={input} value={s.options.topN ?? (s.type === 'levels' ? 24 : 5)} onChange={(e) => opt({ topN: Number(e.target.value) })} /></label> : null}
            {s.type === 'calendar' ? <label className="flex flex-col gap-1"><span className={label}>Min importance</span><select className={input} value={s.options.minImportance ?? 2} onChange={(e) => opt({ minImportance: Number(e.target.value) as 1 | 2 | 3 })}><option value={1}>Low+</option><option value={2}>Medium+</option><option value={3}>High only</option></select></label> : null}
            {s.type === 'stories' ? <label className="flex items-center gap-2"><input type="checkbox" checked={!!s.options.myAssetsOnly} onChange={(e) => opt({ myAssetsOnly: e.target.checked })} />Only my asset classes</label> : null}
            {s.type === 'scoreboard' ? <label className="flex items-center gap-2"><input type="checkbox" checked={s.options.includeCrypto !== false} onChange={(e) => opt({ includeCrypto: e.target.checked })} />Include crypto overnight</label> : null}
            {s.type === 'smartFeed' ? (
              <label className="col-span-2 flex flex-col gap-1"><span className={label}>Smart feed</span>
                <select className={input} value={s.options.smartFeedId ?? ''} onChange={(e) => opt({ smartFeedId: e.target.value })}>
                  <option value="">Choose…</option>{feeds.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </label>
            ) : null}
          </div>
        ) : null}
      </div>
    </Reorder.Item>
  );
}

function Preview({ profile }: { profile: BriefProfile }) {
  const [b, setB] = useState<Brief | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api<Brief>('/api/briefs/preview', { method: 'POST', json: profile }).then((x) => { setB(x); setErr(null); }).catch((e) => setErr((e as Error).message));
    }, 450);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [profile]);
  if (err) return <p className="text-xs text-down">{err}</p>;
  if (!b) return <div className="skeleton h-64" />;
  return (
    <div className="origin-top scale-[0.92]">
      <div className="text-[10px] font-semibold uppercase tracking-[0.3em] text-faint">Live preview · current data</div>
      <h1 className="mt-2 font-serif text-3xl leading-tight text-text">{b.headline}</h1>
      <p className="mt-3 font-serif text-[15px] leading-relaxed text-text">{b.take.text}</p>
      <div className="mt-6 grid grid-cols-6 gap-x-6 gap-y-6">
        {b.sections.filter((s) => s.type !== 'take').map((s, i) => (
          <Reveal key={s.id} i={i} className={s.size === 'full' ? 'col-span-6' : s.size === 'half' ? 'col-span-3' : 'col-span-2'}>
            <h2 className="mb-2 border-t border-line-strong pt-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">{s.title}</h2>
            <div className="text-[12px]"><SectionBody s={s} brief={b} /></div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}

export function BriefEditor({ initialProfileId }: { initialProfileId: string }) {
  const profiles = useDocs<BriefProfile>('brief_profiles');
  const feeds = useDocs<SmartFeed>('smart_feeds');
  const putDoc = useV2((s) => s.putDoc);
  const delDoc = useV2((s) => s.delDoc);
  const sorted = useMemo(() => [...profiles].sort((a, b) => a.order - b.order), [profiles]);
  const [selId, setSelId] = useState(initialProfileId);
  const [draft, setDraft] = useState<BriefProfile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [destinations, setDestinations] = useState<{ id: string; label: string; enabled: boolean }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api<{ id: string; label: string; enabled: boolean; connected: boolean }[]>('/api/integrations').then((l) => setDestinations(l.filter((x) => x.connected))).catch(() => setDestinations([]));
  }, []);

  useEffect(() => {
    const p = sorted.find((x) => x.id === selId) ?? sorted[0];
    if (p && (!draft || draft.id !== p.id)) {
      setDraft(structuredClone(p));
      setDirty(false);
    }
  }, [sorted, selId, draft]);

  if (!draft) return <div className="mx-auto max-w-6xl"><div className="skeleton h-64" /></div>;

  const update = (patch: Partial<BriefProfile>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };
  const save = async () => {
    try {
      await putDoc('brief_profiles', draft);
      setDirty(false);
      useStore.getState().pushToast({ kind: 'info', title: 'Brief profile saved' });
    } catch (e) {
      useStore.getState().pushToast({ kind: 'error', title: 'Could not save', body: (e as Error).message });
    }
  };
  const create = async (from?: BriefProfile) => {
    const base: BriefProfile = from ? structuredClone(from) : { ...structuredClone(draft), sections: draft.sections.filter((s) => ['take', 'scoreboard', 'stories'].includes(s.type)) };
    const p = await putDoc('brief_profiles', { ...base, id: crypto.randomUUID(), name: from ? `${from.name} (copy)` : 'New brief', order: sorted.length, schedule: { ...base.schedule, enabled: false } });
    setSelId(p.id);
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ pulseBriefTemplate: 1, profile: { ...draft, id: undefined, destinations: [] } }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pulse-brief-${draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = async (f: File) => {
    try {
      const j = JSON.parse(await f.text()) as { profile?: BriefProfile };
      if (!j.profile?.sections) throw new Error('not a PULSE brief template');
      const p = await putDoc('brief_profiles', { ...j.profile, id: crypto.randomUUID(), order: sorted.length, destinations: [] });
      setSelId(p.id);
      useStore.getState().pushToast({ kind: 'info', title: `Imported “${p.name}”` });
    } catch (e) {
      useStore.getState().pushToast({ kind: 'error', title: 'Import failed', body: (e as Error).message });
    }
  };
  const addable = (Object.keys(TITLES) as BriefSectionType[]).filter((t) => t === 'smartFeed' || !draft.sections.some((s) => s.type === t));

  return (
    <div className="mx-auto grid max-w-[1400px] gap-6 xl:grid-cols-[13rem_minmax(0,26rem)_1fr]">
      <aside>
        <div className="mb-2 flex items-center justify-between"><span className={label}>Profiles</span><button onClick={() => void create()} className="text-faint hover:text-text" aria-label="New profile"><Icon name="plus" size={14} /></button></div>
        <ul className="space-y-1">
          {sorted.map((p) => (
            <li key={p.id}>
              <button onClick={() => setSelId(p.id)} className={`w-full rounded-lg px-2.5 py-1.5 text-left text-xs ${p.id === draft.id ? 'bg-panel-hover text-text' : 'text-dim hover:bg-panel-hover/50'}`}>
                {p.name}
                <span className="block text-[10px] text-faint">{p.kind}{p.schedule.enabled ? ` · ${p.schedule.times.filter(Boolean)[0] ?? ''} ${p.schedule.tz.split('/').pop()}` : ' · manual'}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap gap-1.5">
          <button onClick={() => void create(draft)} className="rounded-md border border-line px-2 py-1 text-[11px] text-dim hover:text-text">Duplicate</button>
          <button onClick={exportJson} className="rounded-md border border-line px-2 py-1 text-[11px] text-dim hover:text-text">Export JSON</button>
          <button onClick={() => fileRef.current?.click()} className="rounded-md border border-line px-2 py-1 text-[11px] text-dim hover:text-text">Import JSON</button>
          <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void importJson(e.target.files[0])} />
          {!['morning'].includes(draft.id) ? <button onClick={() => { void delDoc('brief_profiles', draft.id); setSelId('morning'); }} className="rounded-md border border-line px-2 py-1 text-[11px] text-down hover:border-down/50">Delete</button> : null}
        </div>
      </aside>

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <input className={`${input} flex-1 text-sm`} value={draft.name} onChange={(e) => update({ name: e.target.value })} aria-label="Profile name" />
          <button onClick={save} disabled={!dirty} className="rounded-lg border border-accent/50 bg-accent/15 px-3 py-1 text-xs font-medium text-text disabled:opacity-40">{dirty ? 'Save' : 'Saved'}</button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <label className="flex flex-col gap-1"><span className={label}>Kind</span><select className={input} value={draft.kind} onChange={(e) => update({ kind: e.target.value as BriefProfile['kind'] })}><option value="morning">Morning</option><option value="handoff">Handoff</option><option value="eod">End of day</option><option value="weekly">Weekly</option></select></label>
          <label className="flex flex-col gap-1"><span className={label}>AI tone</span><select className={input} value={draft.tone} onChange={(e) => update({ tone: e.target.value as BriefProfile['tone'] })}><option value="terse">Terse trader</option><option value="analyst">Analyst</option><option value="eli5">Explain like I&apos;m new</option></select></label>
          <label className="flex flex-col gap-1"><span className={label}>Length</span><select className={input} value={draft.length} onChange={(e) => update({ length: Number(e.target.value) as 50 | 150 | 300 })}><option value={50}>50 words</option><option value={150}>150 words</option><option value={300}>300 words</option></select></label>
        </div>
        <div>
          <span className={label}>My asset classes</span>
          <div className="mt-1 flex flex-wrap gap-1.5">{CLASSES.map((c) => <button key={c} onClick={() => update({ assetClasses: draft.assetClasses.includes(c) ? draft.assetClasses.filter((x) => x !== c) : [...draft.assetClasses, c] })} className={`rounded-full border px-2 py-0.5 text-[11px] capitalize ${draft.assetClasses.includes(c) ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-faint'}`}>{c}</button>)}</div>
        </div>
        <div className="rounded-xl border border-line p-3">
          <div className="flex items-center justify-between">
            <span className={label}>Schedule</span>
            <label className="flex items-center gap-2 text-xs text-dim"><input type="checkbox" checked={draft.schedule.enabled} onChange={(e) => update({ schedule: { ...draft.schedule, enabled: e.target.checked } })} />Enabled</label>
          </div>
          <select className={`${input} mt-2 w-full`} value={draft.schedule.tz} onChange={(e) => update({ schedule: { ...draft.schedule, tz: e.target.value } })} aria-label="Time zone">
            {[...new Set([draft.schedule.tz, ...TZS])].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <div className="mt-2 grid grid-cols-7 gap-1">
            {DAYS.map((d, i) => (
              <label key={d} className="flex flex-col items-center gap-1 text-[10px] text-faint">{d}
                <input inputMode="numeric" placeholder="—" maxLength={5} className={`${input} num w-full px-0.5 text-center text-[11px]`} value={draft.schedule.times[i] ?? ''} onChange={(e) => { const v = e.target.value.replace(/[^\d:]/g, ''); const times = [...draft.schedule.times]; times[i] = /^\d{1,2}:\d{2}$/.test(v) ? v.padStart(5, '0') : v || null; update({ schedule: { ...draft.schedule, times } }); }} aria-label={`${d} time`} />
              </label>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-dim"><input type="checkbox" checked={draft.autoOpen} onChange={(e) => update({ autoOpen: e.target.checked })} />Open automatically on the first visit of the day</label>
        </div>
        <div className="rounded-xl border border-line p-3">
          <span className={label}>Deliver to</span>
          {destinations.length ? (
            <div className="mt-1 flex flex-wrap gap-1.5">{destinations.map((d) => <button key={d.id} onClick={() => update({ destinations: draft.destinations.includes(d.id) ? draft.destinations.filter((x) => x !== d.id) : [...draft.destinations, d.id] })} className={`rounded-full border px-2 py-0.5 text-[11px] ${draft.destinations.includes(d.id) ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-faint'}`}>{d.label}</button>)}</div>
          ) : <p className="mt-1 text-[11px] text-faint">No destinations connected. <button className="underline" onClick={() => useV2.getState().set({ settingsCenter: 'integrations' })}>Connect email, Slack or Telegram</button>.</p>}
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className={label}>Sections · drag to reorder</span>
            <select className={input} value="" onChange={(e) => { const t = e.target.value as BriefSectionType; if (t) update({ sections: [...draft.sections, { id: `${t}-${Date.now().toString(36)}`, type: t, enabled: true, size: 'full', options: {} }] }); }} aria-label="Add section">
              <option value="">+ Add section</option>{addable.map((t) => <option key={t} value={t}>{TITLES[t]}</option>)}
            </select>
          </div>
          <Reorder.Group axis="y" values={draft.sections} onReorder={(sections) => update({ sections })} className="space-y-1.5">
            {draft.sections.map((s) => <SectionRow key={s.id} s={s} feeds={feeds} onChange={(ns) => update({ sections: draft.sections.map((x) => (x.id === s.id ? ns : x)) })} onRemove={() => update({ sections: draft.sections.filter((x) => x.id !== s.id) })} />)}
          </Reorder.Group>
        </div>
      </section>

      <section className="min-w-0 rounded-2xl border border-line bg-bg-2/30 p-5 xl:sticky xl:top-0 xl:max-h-[calc(100vh-9rem)] xl:overflow-y-auto">
        <Preview profile={draft} />
      </section>
    </div>
  );
}
