'use client';
import { useEffect, useRef, useState } from 'react';
import type { Copilot } from '@shared/v2';
import { api, useV2 } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { Markdown } from '@/lib/markdown';
import { Icon, Kbd } from '../ui';

const SUGGEST = ['Why is JPY bid?', 'Summarize everything on NVDA today', "What's on the calendar that could move gold?", 'What does the regime panel say right now?'];

function renderCited(text: string, cites: NonNullable<Copilot['citations']>) {
  const order = cites.map((c) => c.id);
  return text.replace(/\[c:([^\]]+)\]/g, (_, id) => {
    const n = order.indexOf(id);
    return n >= 0 ? ` [${n + 1}]` : '';
  });
}

export function CopilotPanel() {
  const open = useV2((s) => s.copilotOpen);
  const explain = useV2((s) => s.explain);
  const [msgs, setMsgs] = useState<Copilot[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [connect, setConnect] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs, busy]);
  useEffect(() => { void api<{ enabled: boolean }>('/api/copilot/status').then((s) => setConnect(!s.enabled)).catch(() => {}); }, []);

  const send = async (text: string, ex?: typeof explain) => {
    if (busy) return;
    const next = text ? [...msgs, { role: 'user' as const, text }] : msgs;
    if (ex) next.push({ role: 'user', text: `Explain: ${ex.label}` });
    setMsgs(next);
    setQ('');
    setBusy(true);
    try {
      const r = await api<{ message: Copilot; connect?: boolean }>('/api/copilot', { method: 'POST', json: { messages: text ? next : msgs, explain: ex ?? undefined } });
      if (r.connect) setConnect(true);
      else setMsgs([...next, r.message]);
    } catch (e) {
      setMsgs([...next, { role: 'assistant', text: `Something went wrong: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (open && explain) { void send('', explain); useV2.getState().set({ explain: null }); }
  }, [open, explain]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  return (
    <aside className="fixed inset-y-0 right-0 z-[62] flex w-full max-w-[420px] flex-col border-l border-line bg-panel-solid/97 shadow-2xl backdrop-blur-xl" aria-label="Ask Pulse">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-text"><Icon name="sparkle" size={14} />Ask Pulse</span>
        <span className="flex items-center gap-2"><Kbd>⌘J</Kbd><button onClick={() => useV2.getState().set({ copilotOpen: false })} aria-label="Close"><Icon name="x" /></button></span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {connect ? (
          <div className="rounded-xl border border-dashed border-line p-4 text-sm">
            <p className="text-dim">Ask Pulse answers from PULSE&apos;s own articles, quotes and calendar, with citations. It needs an Anthropic API key on the server.</p>
            <p className="mt-2 text-[11px] text-faint">Add <code>ANTHROPIC_API_KEY=…</code> to <code>.env</code> (or run <code>npm run setup</code>) and restart. A daily token budget keeps costs capped.</p>
            <button onClick={() => useV2.getState().set({ settingsCenter: 'ai' })} className="mt-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1 text-xs text-text">Connect Anthropic API key</button>
          </div>
        ) : !msgs.length ? (
          <div className="space-y-2">
            <p className="text-xs text-faint">Answers use only PULSE data and cite the cards they came from. Press <Kbd>E</Kbd> on any story or number to explain it.</p>
            {SUGGEST.map((s) => <button key={s} onClick={() => void send(s)} className="block w-full rounded-lg border border-line px-3 py-2 text-left text-xs text-dim hover:border-line-strong hover:text-text">{s}</button>)}
          </div>
        ) : msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'ml-8 rounded-xl bg-accent/12 px-3 py-2 text-sm text-text' : ''}>
            {m.role === 'user' ? m.text : (
              <>
                <Markdown text={renderCited(m.text, m.citations ?? [])} />
                {m.citations?.length ? (
                  <ol className="mt-2 space-y-0.5 border-t border-line pt-2 text-[11px]">
                    {m.citations.map((c, n) => (
                      <li key={c.id} className="truncate text-faint">
                        [{n + 1}] {c.kind === 'story' ? <button onClick={() => useStore.getState().set({ timelineId: c.id })} className="text-dim hover:text-text hover:underline">{c.label}</button> : c.kind === 'quote' ? <button onClick={() => useStore.getState().set({ drawerSymbol: c.id.replace('quote:', '') })} className="text-dim hover:underline">{c.label}</button> : <span className="text-dim">{c.label}</span>}
                        {c.ts ? <span> · {new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span> : null}
                        {c.url && c.url !== '#' ? <a href={c.url} target="_blank" rel="noopener noreferrer" className="ml-1 underline">source</a> : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </>
            )}
          </div>
        ))}
        {busy ? <div className="flex gap-1 py-2"><span className="skeleton h-2 w-2 rounded-full" /><span className="skeleton h-2 w-2 rounded-full" /><span className="skeleton h-2 w-2 rounded-full" /></div> : null}
        <div ref={end} />
      </div>
      {!connect ? (
        <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) void send(q.trim()); }} className="border-t border-line p-3">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about markets, news, your book…" className="w-full rounded-lg border border-line bg-bg-2 px-3 py-2 text-sm text-text focus:border-accent/60 focus:outline-none" />
          <p className="mt-1 text-[10px] text-faint">Informational only — not investment advice.</p>
        </form>
      ) : null}
    </aside>
  );
}
