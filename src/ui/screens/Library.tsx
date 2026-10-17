import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useStore } from '../../state/store';
import { db, uid } from '../../db/db';
import { ClipThumb } from '../components/common';
import { go } from '../router';
import { PITCH_TYPES } from './ClipScreen';
import { autoSplit } from '../bullpen';

export function Library() {
  const { clips, order, setSlot, analyze, updateRecord } = useStore();
  const athletes = useLiveQuery(() => db.athletes.toArray(), []) ?? [];
  const sessions = useLiveQuery(() => db.sessions.toArray(), []) ?? [];
  const [q, setQ] = useState('');
  const [ath, setAth] = useState('');
  const [pt, setPt] = useState('');
  const [tag, setTag] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const all = order.map((id) => clips[id]).filter(Boolean);
  const tags = useMemo(() => [...new Set(all.flatMap((c) => c.record.tags))].sort(), [all]);
  const list = all.filter((c) =>
    (!q || c.record.name.toLowerCase().includes(q.toLowerCase())) && (!ath || c.record.athleteId === ath) && (!pt || c.record.pitchType === pt) && (!tag || c.record.tags.includes(tag)));
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-2)));
  const assignSession = async (ids: string[], athleteId: string) => {
    const date = new Date().toISOString().slice(0, 10);
    const existing = sessions.find((s) => s.athleteId === athleteId && s.date === date);
    const sid = existing?.id ?? uid();
    if (!existing) await db.sessions.put({ id: sid, athleteId, date });
    for (const id of ids) await updateRecord(id, { athleteId, sessionId: sid });
  };
  return (
    <div className="stack">
      <div className="row spread"><h1 style={{ margin: 0 }}>Library</h1>
        <div className="row tight">
          <button className="accent" disabled={sel.length !== 2} onClick={() => { setSlot('A', sel[0]); setSlot('B', sel[1]); go('/compare'); }}>Compare selected ({sel.length}/2)</button>
        </div>
      </div>
      <div className="card row">
        <input placeholder="Search clips" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select value={ath} onChange={(e) => setAth(e.target.value)} aria-label="Athlete"><option value="">All athletes</option>{athletes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <select value={pt} onChange={(e) => setPt(e.target.value)} aria-label="Pitch type"><option value="">All pitch types</option>{PITCH_TYPES.map((p) => <option key={p}>{p}</option>)}</select>
        <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag"><option value="">All tags</option>{tags.map((t) => <option key={t}>{t}</option>)}</select>
      </div>
      {list.length === 0 && <div className="card muted">No clips match. Drop videos anywhere on the page to add them.</div>}
      <div className="grid cols-auto">
        {list.map((c) => (
          <div key={c.id} className="card flat stack" style={{ padding: 10, outline: sel.includes(c.id) ? '2px solid var(--accent)' : undefined }}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input type="checkbox" checked={sel.includes(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.record.name}`} />
              <ClipThumb clip={c} />
            </div>
            <div>
              <a href={`#/clip/${c.id}`} style={{ fontWeight: 600 }}>{c.record.starred ? '★ ' : ''}{c.record.name}</a>
              <div className="tiny muted">{new Date(c.record.createdAt).toLocaleDateString()} · {c.record.pitchType ?? 'type?'} · {athletes.find((a) => a.id === c.record.athleteId)?.name ?? 'no athlete'} · {c.status === 'ready' ? 'analysed' : c.status}</div>
              {c.record.tags.length > 0 && <div className="row tight" style={{ marginTop: 4 }}>{c.record.tags.map((t) => <span key={t} className="pill na">{t}</span>)}</div>}
            </div>
            <div className="row tight">
              <button className="small" onClick={() => setSlot('A', c.id)}>→ A</button>
              <button className="small" onClick={() => setSlot('B', c.id)}>→ B</button>
              {c.kind === 'video' && c.status !== 'ready' && <button className="small" onClick={() => analyze(c.id)} disabled={c.status === 'analyzing'}>{c.status === 'analyzing' ? 'Analysing…' : 'Analyse'}</button>}
              {c.kind === 'video' && c.record.meta.durationS > 6 && <BullpenSplit id={c.id} />}
              {c.kind === 'video' && athletes.length > 0 && (
                <select className="small" aria-label="Assign athlete" value={c.record.athleteId ?? ''} onChange={(e) => e.target.value && assignSession([c.id], e.target.value)} style={{ minHeight: 30 }}>
                  <option value="">Athlete…</option>{athletes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BullpenSplit({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (msg) { const t = setTimeout(() => setMsg(null), 6000); return () => clearTimeout(t); } }, [msg]);
  return (
    <>
      <button className="small" disabled={busy} onClick={async () => { setBusy(true); try { const n = await autoSplit(id, (p) => setMsg(p)); setMsg(`Split into ${n} pitch${n === 1 ? '' : 'es'}`); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } }} title="Find each pitch in a long bullpen video and make a clip for each">
        {busy ? 'Splitting…' : 'Split bullpen'}
      </button>
      {msg && <span className="tiny muted">{msg}</span>}
    </>
  );
}
