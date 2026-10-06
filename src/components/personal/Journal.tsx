'use client';
import { useEffect, useMemo, useState } from 'react';
import type { JournalEntry } from '@shared/v2';
import { useDocs, useV2, api } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { Markdown } from '@/lib/markdown';
import { Panel, Icon } from '../ui';
import { download } from '../settings/controls';

const today = () => new Date().toLocaleDateString('en-CA');

export async function addNote(link: JournalEntry['links'][number], title: string, body = '') {
  return useV2.getState().putDoc('journal_entries', { date: today(), kind: 'note', title, body, tags: [], links: [link], createdAt: Date.now(), updatedAt: Date.now() } satisfies Omit<JournalEntry, 'id'>);
}

export function JournalPanel() {
  const entries = useDocs<JournalEntry>('journal_entries');
  const day = entries.find((e) => e.kind === 'daily' && e.date === today());
  const notes = entries.filter((e) => e.kind === 'note').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  return (
    <Panel title="Journal" accent="var(--accent)" right={<button onClick={() => useV2.getState().set({ journalOpen: true })} className="text-[10px] text-faint hover:text-text">open</button>}>
      <button onClick={() => useV2.getState().set({ journalOpen: true })} className="w-full rounded-lg border border-line p-2 text-left hover:border-line-strong">
        <div className="text-xs font-medium text-text">{day ? day.title : "Start today's journal"}</div>
        <div className="mt-0.5 line-clamp-3 text-[11px] text-faint">{day ? day.body.replace(/[#*_]/g, '').slice(0, 220) : 'Pre-filled with the day’s top stories, alerts, playbook outcomes and P&L. You add the reflections.'}</div>
      </button>
      {notes.length ? <ul className="mt-2 space-y-1">{notes.map((n) => <li key={n.id} className="truncate text-[11px] text-dim">📝 {n.title}{n.links[0] ? <span className="text-faint"> · {n.links[0].kind} {n.links[0].label ?? n.links[0].ref}</span> : null}</li>)}</ul> : null}
    </Panel>
  );
}

export function JournalOverlay() {
  const open = useV2((s) => s.journalOpen);
  const entries = useDocs<JournalEntry>('journal_entries');
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<JournalEntry | null>(null);
  const [preview, setPreview] = useState(false);
  const sorted = useMemo(() => [...entries].sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt).filter((e) => !q || `${e.title} ${e.body} ${e.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase())), [entries, q]);
  useEffect(() => {
    if (!open) return;
    const cur = entries.find((e) => e.id === sel);
    if (cur) setDraft(structuredClone(cur));
    else if (!sel) {
      const d = entries.find((e) => e.kind === 'daily' && e.date === today());
      if (d) setSel(d.id);
    }
  }, [open, sel, entries.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), useV2.getState().set({ journalOpen: false }));
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [open]);
  if (!open) return null;
  const newDaily = async () => {
    const pre = await api<{ date: string; markdown: string }>('/api/journal/prefill');
    const e = await useV2.getState().putDoc('journal_entries', { date: pre.date, kind: 'daily', title: `Journal — ${pre.date}`, body: pre.markdown, tags: [], links: [], createdAt: Date.now(), updatedAt: Date.now() });
    setSel(e.id);
  };
  const save = async () => { if (draft) { await useV2.getState().putDoc('journal_entries', { ...draft, updatedAt: Date.now() }); useStore.getState().pushToast({ kind: 'info', title: 'Saved' }); } };
  const exportAll = () => download(`pulse-journal-${today()}.md`, sorted.map((e) => `# ${e.title}\n_${e.date}${e.tags.length ? ` · ${e.tags.map((t) => `#${t}`).join(' ')}` : ''}_\n\n${e.body}\n`).join('\n---\n\n'), 'text/markdown');
  return (
    <div className="fixed inset-0 z-[66] flex bg-bg/95 backdrop-blur" role="dialog" aria-modal="true" aria-label="Journal">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line p-3">
        <div className="mb-3 flex items-center justify-between"><span className="text-sm font-semibold text-text">Journal</span><button onClick={() => useV2.getState().set({ journalOpen: false })} className="text-xs text-faint hover:text-text">Close</button></div>
        <button onClick={() => void newDaily()} className="mb-2 rounded-lg border border-accent/40 bg-accent/10 px-2 py-1.5 text-xs text-text">Today&apos;s journal (pre-filled)</button>
        <label className="mb-2 flex items-center gap-2 rounded-lg border border-line px-2 py-1"><Icon name="search" size={12} className="text-faint" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all notes…" className="min-w-0 flex-1 bg-transparent text-xs text-text focus:outline-none" /></label>
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">{sorted.map((e) => <li key={e.id}><button onClick={() => setSel(e.id)} className={`w-full rounded-lg px-2 py-1.5 text-left text-xs ${sel === e.id ? 'bg-panel-hover text-text' : 'text-dim hover:bg-panel-hover/50'}`}>{e.kind === 'note' ? '📝 ' : ''}{e.title}<span className="block text-[10px] text-faint">{e.date}{e.tags.length ? ` · ${e.tags.join(', ')}` : ''}</span></button></li>)}</ul>
        <button onClick={exportAll} className="mt-2 rounded-lg border border-line px-2 py-1 text-xs text-dim hover:text-text">Export Markdown</button>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        {!draft ? <p className="pt-20 text-center text-sm text-faint">Start today&apos;s journal or pick a note.</p> : (
          <div className="mx-auto max-w-3xl space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <input className="flex-1 rounded-lg border border-line bg-bg-2 px-2 py-1 text-sm text-text" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              <button onClick={() => setPreview(!preview)} className="rounded-lg border border-line px-2 py-1 text-xs text-dim">{preview ? 'Edit' : 'Preview'}</button>
              <button onClick={() => void save()} className="rounded-lg border border-accent/50 bg-accent/15 px-3 py-1 text-xs text-text">Save</button>
              <button onClick={() => void api(`/api/journal/${draft.id}/notion`, { method: 'POST' }).then(() => useStore.getState().pushToast({ kind: 'info', title: 'Sent to Notion' })).catch((e) => useStore.getState().pushToast({ kind: 'error', title: 'Notion', body: (e as Error).message }))} className="rounded-lg border border-line px-2 py-1 text-xs text-dim">→ Notion</button>
              <button onClick={() => { void useV2.getState().delDoc('journal_entries', draft.id); setSel(null); setDraft(null); }} className="rounded-lg border border-line px-2 py-1 text-xs text-down">Delete</button>
            </div>
            <input className="w-full rounded-lg border border-line bg-bg-2 px-2 py-1 text-xs text-text" placeholder="Tags, comma separated" value={draft.tags.join(', ')} onChange={(e) => setDraft({ ...draft, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} />
            {draft.links.length ? <div className="flex flex-wrap gap-1.5">{draft.links.map((l, i) => <span key={i} className="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-dim">📌 {l.kind}: {l.label ?? l.ref}{l.price ? ` @ ${l.price}` : ''}</span>)}</div> : null}
            {preview ? <Markdown text={draft.body} /> : <textarea className="h-[60vh] w-full rounded-xl border border-line bg-bg-2/60 p-3 font-mono text-[13px] leading-relaxed text-text focus:outline-none" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />}
          </div>
        )}
      </main>
    </div>
  );
}
