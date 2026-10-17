import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DRILLS, DRILL_BY_ID, type Drill } from '../../data/drills';
import { METRICS } from '../../core/catalog';
import { db, uid } from '../../db/db';

const CATS = [...new Set(DRILLS.map((d) => d.category))];

export function DrillsScreen({ focus }: { focus?: string }) {
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const athletes = useLiveQuery(() => db.athletes.toArray(), []) ?? [];
  useEffect(() => { if (focus) document.getElementById(`drill-${focus}`)?.scrollIntoView({ block: 'center' }); }, [focus]);
  const list = DRILLS.filter((d) => (!cat || d.category === cat) && (!q || `${d.name} ${d.fault} ${d.purpose}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="stack">
      <h1>Drill library <span className="small muted">({DRILLS.length} drills)</span></h1>
      <p className="muted">Every finding in a comparison links here. Drills are teaching tools, not prescriptions — for young athletes prefer simple external cues, and stop anything that hurts.</p>
      <div className="row">
        <input placeholder="Search by fault, e.g. late arm" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search drills" />
        <div className="seg" role="group" aria-label="Category">
          <button aria-pressed={!cat} onClick={() => setCat('')}>All</button>
          {CATS.map((c) => <button key={c} aria-pressed={cat === c} onClick={() => setCat(c)}>{c}</button>)}
        </div>
      </div>
      <div className="grid cols-2">
        {list.map((d) => <DrillCard key={d.id} d={d} highlight={focus === d.id} athletes={athletes} />)}
      </div>
      <ArmCareBuilder />
    </div>
  );
}

function DrillCard({ d, highlight, athletes }: { d: Drill; highlight: boolean; athletes: { id: string; name: string }[] }) {
  const linked = METRICS.filter((m) => [...(m.drillsUp ?? []), ...(m.drillsDown ?? [])].includes(d.id));
  const [msg, setMsg] = useState('');
  return (
    <article id={`drill-${d.id}`} className="card stack" style={highlight ? { outline: '3px solid var(--accent)' } : undefined}>
      <div className="row spread"><h3 style={{ margin: 0 }}>{d.name}</h3><span className="pill na">{d.category}</span></div>
      <div className="small"><b>Purpose:</b> {d.purpose}</div>
      <div className="small"><b>Targets:</b> {d.fault}</div>
      <div className="small"><b>How:</b> {d.how}</div>
      <div className="small"><b>Cues:</b> {d.cues.map((c) => `“${c}”`).join(' · ')}</div>
      <div className="small muted">{d.dose} · {d.equipment} · Level: {d.level}</div>
      {linked.length > 0 && <div className="tiny faint">Linked metrics: {linked.map((m) => m.short).join(', ')}</div>}
      <div className="thumb" style={{ width: '100%', height: 90, fontSize: '0.75rem', color: 'var(--text-3)' }}>Demo video slot — add your own clip</div>
      {athletes.length > 0 && (
        <div className="row tight">
          <select aria-label="Assign to athlete" defaultValue="" onChange={async (e) => { if (!e.target.value) return; await db.assignments.put({ id: uid(), athleteId: e.target.value, drillId: d.id, createdAt: Date.now(), done: false }); setMsg('Assigned'); e.target.value = ''; }}>
            <option value="">Assign to…</option>{athletes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          {msg && <span className="small muted">{msg}</span>}
        </div>
      )}
    </article>
  );
}

const ROUTINE_POOL = ['band-pull-apart', 'money-drill', 'prone-ytw', 'scap-pushup', 'separation-stretch', 'hip-mobility', 'sidelying-toss', 'reverse-throw', 'plyo-progression', 'wrist-weight', 'sleeper'];

function ArmCareBuilder() {
  const [picked, setPicked] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('armcare') ?? '[]'); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem('armcare', JSON.stringify(picked)); } catch { /* ignore */ } }, [picked]);
  return (
    <section className="card stack">
      <h2>Arm-care &amp; warm-up builder</h2>
      <p className="small muted">Pick the pieces for a daily routine (about 10–15 minutes). Bands → mobility → light plyo.</p>
      <div className="row tight">{ROUTINE_POOL.map((id) => <button key={id} className="small" aria-pressed={picked.includes(id)} onClick={() => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}>{DRILL_BY_ID[id].name}</button>)}</div>
      {picked.length > 0 && (
        <ol>{picked.map((id) => <li key={id}><b>{DRILL_BY_ID[id].name}</b> — {DRILL_BY_ID[id].dose}</li>)}</ol>
      )}
      {picked.length > 0 && <button className="small" onClick={() => window.print()}>Print routine</button>}
    </section>
  );
}
