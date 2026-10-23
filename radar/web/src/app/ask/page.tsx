'use client';
import { useState } from 'react';
import { Md } from '@/components/Md';
import { api } from '@/lib/api';

const EXAMPLES = ['Why did the top token by 1h volume pump?', "What's the strongest PolitiFi narrative right now?", 'Which BUY signals worked best in the last 24h?', 'Is the market risk-on or risk-off?'];

export default function AskPage() {
  const [q, setQ] = useState('');
  const [msgs, setMsgs] = useState<{ role: string; content: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true);
    const history = msgs.slice(-8);
    setMsgs((m) => [...m, { role: 'user', content: question }]);
    setQ('');
    try {
      const r = await api('/api/ask', { method: 'POST', body: JSON.stringify({ question, history }) });
      setMsgs((m) => [...m, { role: 'assistant', content: r.answer }]);
    } catch (e: any) { setMsgs((m) => [...m, { role: 'assistant', content: `Error: ${e.message}` }]); }
    setBusy(false);
  };
  return (
    <div className="mx-auto max-w-3xl space-y-2 pt-2">
      <h1 className="text-lg font-bold">Ask Radar</h1>
      <p className="text-[11px] text-mute">Claude answers from Radar’s own live data (tokens, signals, narratives, social posts, scorecard, market) via tools. No guessing.</p>
      <div className="space-y-2">
        {msgs.map((m, i) => (
          <div key={i} className={`rounded border p-2 ${m.role === 'user' ? 'border-accent/40 bg-accent/5' : 'border-line bg-panel'}`}>
            {m.role === 'user' ? <b>{m.content}</b> : <Md text={m.content} />}
          </div>
        ))}
        {busy && <p className="text-mute">Thinking (querying Radar’s data)…</p>}
      </div>
      {!msgs.length && <div className="flex flex-wrap gap-2">{EXAMPLES.map((e) => <button key={e} onClick={() => ask(e)} className="rounded border border-line px-2 py-1 text-left hover:border-accent">{e}</button>)}</div>}
      <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything about the market Radar is watching…" className="flex-1 rounded border border-line bg-panel px-2 py-2 outline-none focus:border-accent" />
        <button disabled={busy} className="rounded bg-accent/20 px-4 text-accent disabled:opacity-40">Ask</button>
      </form>
    </div>
  );
}
