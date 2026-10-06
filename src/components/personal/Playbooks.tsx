'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Playbook, PlaybookOutcome, PlaybookScenario } from '@shared/v2';
import { matchesEvent } from '@shared/playbook';
import { useDocs, useV2, api } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { useCalm, useNow } from '@/lib/hooks';
import { countdown } from '@/lib/format';
import { Panel, Icon } from '../ui';
import { OutcomeRow } from '../brief/sections';
import { EmptyCard } from '../brief/bits';

function Burst() {
  const calm = useCalm();
  if (calm) return null;
  return <span className="pointer-events-none absolute right-3 top-3" aria-hidden>{Array.from({ length: 10 }, (_, i) => <span key={i} className="burst-dot absolute h-1.5 w-1.5 rounded-full" style={{ background: i % 2 ? 'var(--up)' : 'var(--accent)', ['--bx' as string]: `${Math.cos((i / 10) * 6.28) * 26}px`, ['--by' as string]: `${Math.sin((i / 10) * 6.28) * 26}px` }} />)}</span>;
}

export function PlaybooksPanel() {
  const books = useDocs<Playbook>('playbooks').filter((p) => !p.template);
  const calendar = useStore((s) => s.calendar);
  const outcomes = useV2((s) => s.outcomes);
  const now = useNow(1000);
  const [ring, setRing] = useState<string | null>(null);
  const [burst, setBurst] = useState<string | null>(null);
  useEffect(() => {
    const h = (e: Event) => {
      const o = (e as CustomEvent<PlaybookOutcome>).detail;
      if (o.status === 'pending' && !o.checks.some((c) => c.moves.m5 !== undefined)) { setRing(o.playbookId); setTimeout(() => setRing(null), 1300); }
      if (o.status === 'done' && o.checks.length && o.checks.every((c) => c.hits.m30)) { setBurst(o.playbookId); setTimeout(() => setBurst(null), 900); }
    };
    window.addEventListener('pulse:playbook', h);
    return () => window.removeEventListener('pulse:playbook', h);
  }, []);
  return (
    <Panel title="Event playbooks" accent="var(--warn)" right={<button onClick={() => useV2.getState().set({ playbooksOpen: true })} className="text-[10px] text-faint hover:text-text">manage</button>}>
      {!books.length ? <EmptyCard text="Pre-plan your reaction to CPI, NFP or a rate decision. PULSE evaluates the scenario the moment the number posts." action="Create from a template" onAction={() => useV2.getState().set({ playbooksOpen: true })} /> : (
        <ul className="space-y-2">
          {books.map((p) => {
            const next = calendar.find((e) => e.time > now && matchesEvent(p, e));
            const last = outcomes.find((o) => o.playbookId === p.id);
            return (
              <li key={p.id} className={`relative rounded-xl border border-line p-2.5 ${ring === p.id ? 'ring-pulse border-accent/60' : ''} ${p.enabled ? 'relevant' : 'opacity-60'}`}>
                {burst === p.id ? <Burst /> : null}
                <button onClick={() => useV2.getState().set({ playbooksOpen: true })} className="w-full text-left">
                  <div className="flex items-center justify-between text-xs"><span className="font-medium text-text">📌 {p.name}</span>{next ? <span className="num text-[10px] text-warn">{countdown(next.time - now, false)}</span> : <span className="text-[10px] text-faint">no event scheduled</span>}</div>
                  <div className="mt-0.5 text-[10px] text-faint">{p.scenarios.map((s) => s.label).join(' · ')}</div>
                </button>
                {last ? <div className="mt-2"><OutcomeRow o={last} /></div> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

const inp = 'rounded-md border border-line bg-bg-2 px-1.5 py-0.5 text-[11px] text-text';

function ScenarioEditor({ s, onChange, onRemove }: { s: PlaybookScenario; onChange: (s: PlaybookScenario) => void; onRemove: () => void }) {
  return (
    <div className="rounded-lg border border-line p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <input className={`${inp} w-40`} value={s.label} onChange={(e) => onChange({ ...s, label: e.target.value })} placeholder="Scenario name" />
        <span className="text-[11px] text-faint">if</span>
        <select className={inp} value={s.condition.metric} onChange={(e) => onChange({ ...s, condition: { ...s.condition, metric: e.target.value as 'surprise' | 'actual' } })}><option value="surprise">actual − consensus</option><option value="actual">actual</option></select>
        <select className={inp} value={s.condition.op} onChange={(e) => onChange({ ...s, condition: { ...s.condition, op: e.target.value as PlaybookScenario['condition']['op'] } })}>{['>', '>=', '<', '<=', 'between'].map((o) => <option key={o}>{o}</option>)}</select>
        <input type="number" step="any" className={`${inp} w-20`} value={s.condition.value} onChange={(e) => onChange({ ...s, condition: { ...s.condition, value: Number(e.target.value) } })} />
        {s.condition.op === 'between' ? <input type="number" step="any" className={`${inp} w-20`} value={s.condition.value2 ?? 0} onChange={(e) => onChange({ ...s, condition: { ...s.condition, value2: Number(e.target.value) } })} /> : null}
        <button onClick={onRemove} className="ml-auto text-faint hover:text-down" aria-label="Remove scenario"><Icon name="trash" size={12} /></button>
      </div>
      <div className="mt-1.5 space-y-1">
        {s.expect.map((x, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-faint">→ watch</span>
            <input className={`${inp} w-20`} value={x.symbol} onChange={(e) => onChange({ ...s, expect: s.expect.map((y, j) => (j === i ? { ...y, symbol: e.target.value.toUpperCase() } : y)) })} />
            <select className={inp} value={x.direction} onChange={(e) => onChange({ ...s, expect: s.expect.map((y, j) => (j === i ? { ...y, direction: e.target.value as 'up' | 'down' } : y)) })}><option value="up">up</option><option value="down">down</option></select>
            <input type="number" step="any" placeholder="level (opt.)" className={`${inp} w-24`} value={x.level ?? ''} onChange={(e) => onChange({ ...s, expect: s.expect.map((y, j) => (j === i ? { ...y, level: e.target.value ? Number(e.target.value) : undefined } : y)) })} />
            <button onClick={() => onChange({ ...s, expect: s.expect.filter((_, j) => j !== i) })} className="text-faint hover:text-down">×</button>
          </div>
        ))}
        <button onClick={() => onChange({ ...s, expect: [...s.expect, { symbol: 'USDJPY', direction: 'up' }] })} className="text-[11px] text-faint hover:text-text">+ expectation</button>
      </div>
      <textarea className={`${inp} mt-1.5 w-full`} rows={2} placeholder="Notes (e.g. short gold if it fails at the overnight high)" value={s.notes} onChange={(e) => onChange({ ...s, notes: e.target.value })} />
    </div>
  );
}

export function PlaybooksManager() {
  const open = useV2((s) => s.playbooksOpen);
  const books = useDocs<Playbook>('playbooks').filter((p) => !p.template);
  const calendar = useStore((s) => s.calendar);
  const [templates, setTemplates] = useState<Omit<Playbook, 'id' | 'createdAt'>[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Playbook | null>(null);
  const [stats, setStats] = useState<{ outcomes: PlaybookOutcome[]; stats: Record<string, { hits: number; total: number; rate: number | null }> } | null>(null);
  const [test, setTest] = useState({ actual: '', consensus: '' });
  const [testResult, setTestResult] = useState<string | null>(null);
  useEffect(() => { if (open) void api<typeof templates>('/api/playbooks/templates').then(setTemplates); }, [open]);
  useEffect(() => {
    const p = books.find((b) => b.id === sel) ?? null;
    setDraft(p ? structuredClone(p) : null);
    if (p) void api<typeof stats>(`/api/playbooks/outcomes?playbook=${p.id}`).then(setStats);
  }, [sel, books.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const upcoming = useMemo(() => draft ? calendar.filter((e) => e.time > Date.now() && matchesEvent({ ...draft, enabled: true }, e)).slice(0, 3) : [], [draft, calendar]);
  if (!open) return null;
  const close = () => useV2.getState().set({ playbooksOpen: false });
  const clone = async (t: Omit<Playbook, 'id' | 'createdAt'>) => {
    const p = await useV2.getState().putDoc('playbooks', { ...structuredClone(t), template: false, createdAt: Date.now() });
    setSel(p.id);
  };
  const save = async () => { if (draft) { await useV2.getState().putDoc('playbooks', draft); useStore.getState().pushToast({ kind: 'info', title: 'Playbook saved' }); } };
  return (
    <div className="fixed inset-0 z-[66] flex bg-bg/95 backdrop-blur" role="dialog" aria-modal="true" aria-label="Playbooks">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-line p-3">
        <div className="mb-3 flex items-center justify-between"><span className="text-sm font-semibold text-text">Playbooks</span><button onClick={close} className="text-xs text-faint hover:text-text">Close</button></div>
        <button onClick={() => void clone({ name: 'New playbook', eventMatch: '', enabled: true, scenarios: [], notes: '' })} className="mb-2 w-full rounded-lg border border-dashed border-line px-2 py-1.5 text-xs text-dim hover:text-text">+ New playbook</button>
        <ul className="space-y-1">{books.map((p) => <li key={p.id}><button onClick={() => setSel(p.id)} className={`w-full rounded-lg px-2 py-1.5 text-left text-xs ${sel === p.id ? 'bg-panel-hover text-text' : 'text-dim hover:bg-panel-hover/50'}`}>{p.name}<span className="block text-[10px] text-faint">{p.eventMatch || 'no event'} {p.enabled ? '' : '· off'}</span></button></li>)}</ul>
        <div className="mb-1 mt-5 text-[10px] font-semibold uppercase tracking-wider text-faint">Template library</div>
        <ul className="space-y-1">{templates.map((t) => <li key={t.name}><button onClick={() => void clone(t)} className="w-full rounded-lg border border-line px-2 py-1.5 text-left text-xs text-dim hover:border-line-strong hover:text-text">{t.name}<span className="block text-[10px] text-faint">clone & edit</span></button></li>)}</ul>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        {!draft ? <div className="mx-auto max-w-lg pt-16"><EmptyCard text="Pick a playbook or clone a template. Scenarios are evaluated automatically when the release posts, then graded at +5m, +30m and +2h." /></div> : (
          <div className="mx-auto max-w-3xl space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <input className={`${inp} flex-1 text-sm`} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <label className="flex items-center gap-1 text-xs text-dim"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />enabled</label>
              <button onClick={save} className="rounded-lg border border-accent/50 bg-accent/15 px-3 py-1 text-xs text-text">Save</button>
              <button onClick={() => { void useV2.getState().delDoc('playbooks', draft.id); setSel(null); }} className="rounded-lg border border-line px-2 py-1 text-xs text-down">Delete</button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-faint">Event title contains</span><input className={`${inp} w-56`} value={draft.eventMatch} onChange={(e) => setDraft({ ...draft, eventMatch: e.target.value })} placeholder="e.g. CPI m/m" list="pb-events" />
              <datalist id="pb-events">{[...new Set(calendar.map((e) => e.title))].map((t) => <option key={t} value={t} />)}</datalist>
              <span className="text-faint">currency</span><input className={`${inp} w-14`} value={draft.currency ?? ''} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() || undefined })} placeholder="USD" />
            </div>
            <div className="text-[11px] text-faint">{upcoming.length ? <>Next: {upcoming.map((e) => `${e.currency} ${e.title} · ${new Date(e.time).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`).join(' — ')}</> : 'No matching event on the calendar right now.'}</div>
            <div className="space-y-2">
              {draft.scenarios.map((s, i) => <ScenarioEditor key={s.id} s={s} onChange={(ns) => setDraft({ ...draft, scenarios: draft.scenarios.map((x, j) => (j === i ? ns : x)) })} onRemove={() => setDraft({ ...draft, scenarios: draft.scenarios.filter((_, j) => j !== i) })} />)}
              <button onClick={() => setDraft({ ...draft, scenarios: [...draft.scenarios, { id: crypto.randomUUID().slice(0, 8), label: 'Beat', condition: { metric: 'surprise', op: '>', value: 0 }, expect: [], notes: '' }] })} className="text-xs text-faint hover:text-text">+ Add scenario</button>
            </div>
            <textarea className={`${inp} w-full`} rows={3} placeholder="General notes" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
            <div className="rounded-xl border border-line p-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Test a hypothetical print</div>
              <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-faint">actual</span><input className={`${inp} w-20`} value={test.actual} onChange={(e) => setTest({ ...test, actual: e.target.value })} /><span className="text-faint">consensus</span><input className={`${inp} w-20`} value={test.consensus} onChange={(e) => setTest({ ...test, consensus: e.target.value })} />
                <button className="rounded-md border border-line px-2 py-0.5 text-dim hover:text-text" onClick={() => void api<{ scenario: PlaybookScenario | null }>('/api/playbooks/test', { method: 'POST', json: { playbook: draft, actual: Number(test.actual), consensus: Number(test.consensus) } }).then((r) => setTestResult(r.scenario ? `→ “${r.scenario.label}”: ${r.scenario.expect.map((x) => `${x.symbol} ${x.direction}`).join(', ') || 'no expectations'}` : '→ no scenario matches'))}>Evaluate</button>
                {testResult ? <span className="text-text">{testResult}</span> : null}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Scorecard</div>
              {stats?.outcomes.length ? (
                <>
                  <div className="mb-2 flex gap-4 text-xs">{(['m5', 'm30', 'h2'] as const).map((k) => <span key={k} className="text-dim">{k === 'h2' ? '2h' : k.slice(1) + 'm'}: <span className="num text-text">{stats.stats[k].rate === null ? '—' : `${Math.round(stats.stats[k].rate! * 100)}%`}</span> <span className="text-faint">({stats.stats[k].hits}/{stats.stats[k].total})</span></span>)}</div>
                  <div className="grid gap-2 sm:grid-cols-2">{stats.outcomes.slice(0, 8).map((o) => <OutcomeRow key={o.id} o={o} />)}</div>
                </>
              ) : <p className="text-[11px] text-faint">No outcomes yet — this fills in after the first matching release.</p>}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
