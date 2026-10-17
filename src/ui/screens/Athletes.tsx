import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, uid, type Athlete, type BallData } from '../../db/db';
import { useStore, type RuntimeClip } from '../../state/store';
import { METRICS, METRIC_BY_KEY } from '../../core/catalog';
import { mean, sd } from '../../core/signal';
import { DRILL_BY_ID } from '../../data/drills';
import { LineChart } from '../components/Chart';
import { useCssColors } from '../components/common';
import { HeightInput } from './ClipScreen';
import { go } from '../router';

export function AthletesScreen({ id }: { id?: string }) {
  const athletes = useLiveQuery(() => db.athletes.toArray(), []) ?? [];
  const [name, setName] = useState('');
  if (id) {
    const a = athletes.find((x) => x.id === id);
    return a ? <Profile a={a} /> : <p className="muted">Loading…</p>;
  }
  return (
    <div className="stack">
      <h1>Athletes</h1>
      <form className="card row" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; const nid = uid(); await db.athletes.put({ id: nid, name: name.trim(), throws: useStore.getState().settings.handedness, createdAt: Date.now() }); setName(''); go(`/athletes/${nid}`); }}>
        <input placeholder="New athlete name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Athlete name" />
        <button className="primary" type="submit">Add athlete</button>
        <span className="small muted">Profiles stay on this device. Don't store minors' full names if you share backups.</span>
      </form>
      <div className="grid cols-auto">
        {athletes.map((a) => (
          <a key={a.id} className="card" href={`#/athletes/${a.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
            <h3>{a.name}</h3>
            <div className="small muted">{a.throws === 'R' ? 'RHP' : 'LHP'}{a.level ? ` · ${a.level}` : ''}{a.birthYear ? ` · born ${a.birthYear}` : ''}</div>
          </a>
        ))}
      </div>
    </div>
  );
}

const TREND_KEYS = ['stride', 'forearmFS', 'kneeBlock', 'trunkTiltBR', 'extension', 'handSpeed', 'tFsBr', 'gloveDistBR', 'releaseHeight', 'armSlot', 'latTiltBR'];

function Profile({ a }: { a: Athlete }) {
  const clips = useStore((s) => s.clips);
  const sessions = useLiveQuery(() => db.sessions.where('athleteId').equals(a.id).toArray(), [a.id]) ?? [];
  const markers = useLiveQuery(() => db.markers.where('athleteId').equals(a.id).toArray(), [a.id]) ?? [];
  const assignments = useLiveQuery(() => db.assignments.where('athleteId').equals(a.id).toArray(), [a.id]) ?? [];
  const mine = Object.values(clips).filter((c) => c.record.athleteId === a.id && c.analysis).sort((x, y) => x.record.createdAt - y.record.createdAt);
  const [metric, setMetric] = useState('stride');
  const [marker, setMarker] = useState('');
  const col = useCssColors();
  const save = (p: Partial<Athlete>) => db.athletes.put({ ...a, ...p });

  // personal baseline: starred clips + clips from sessions that contain a starred clip
  const goodSessions = new Set(mine.filter((c) => c.record.starred).map((c) => c.record.sessionId));
  const baseline = useMemo(() => {
    const good = mine.filter((c) => c.record.starred || goodSessions.has(c.record.sessionId));
    const out: Record<string, { m: number; s: number }> = {};
    for (const k of TREND_KEYS) {
      const v = good.map((c) => c.analysis!.metrics[k]?.value).filter((x): x is number => x !== null && x !== undefined);
      if (v.length >= 2) out[k] = { m: mean(v), s: sd(v) };
    }
    return out;
  }, [mine, goodSessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const latest = mine[mine.length - 1];
  const drift = latest ? TREND_KEYS.filter((k) => { const b = baseline[k]; const v = latest.analysis!.metrics[k]?.value; const def = METRIC_BY_KEY[k]; return b && v !== null && v !== undefined && Math.abs(v - b.m) > Math.max(def.threshold * (def.pct ? Math.abs(b.m) / 100 : 1), 2 * b.s); }) : [];

  const days = (c: RuntimeClip) => (c.record.createdAt - (mine[0]?.record.createdAt ?? 0)) / 86400000;
  const def = METRIC_BY_KEY[metric];
  const pts = mine.filter((c) => c.analysis!.metrics[metric]?.value !== null && c.analysis!.metrics[metric]?.tier !== 'na');
  const t0 = mine[0]?.record.createdAt ?? Date.now();

  return (
    <div className="stack">
      <div className="row spread"><h1 style={{ margin: 0 }}>{a.name}</h1><a href="#/athletes">All athletes</a></div>
      <div className="card row">
        <label className="field">Throws<select value={a.throws} onChange={(e) => save({ throws: e.target.value as 'R' | 'L' })}><option value="R">Right</option><option value="L">Left</option></select></label>
        <label className="field">Birth year<input type="number" value={a.birthYear ?? ''} onChange={(e) => save({ birthYear: e.target.value ? Number(e.target.value) : undefined })} style={{ width: 90 }} /></label>
        <label className="field">Height<HeightInput value={a.heightCm ? a.heightCm / 100 : undefined} onChange={(m) => save({ heightCm: m ? Math.round(m * 100) : undefined })} /></label>
        <label className="field">Weight (kg)<input type="number" value={a.weightKg ?? ''} onChange={(e) => save({ weightKg: e.target.value ? Number(e.target.value) : undefined })} style={{ width: 80 }} /></label>
        <label className="field">Level<input value={a.level ?? ''} onChange={(e) => save({ level: e.target.value })} placeholder="12U, HS, college…" /></label>
        <label className="field">Team<input value={a.team ?? ''} onChange={(e) => save({ team: e.target.value })} /></label>
      </div>

      {drift.length > 0 && <div className="notice warn">Latest clip drifted from this athlete's baseline on: {drift.map((k) => METRIC_BY_KEY[k].label).join(', ')}.</div>}

      <section className="card stack">
        <div className="row spread"><h2 style={{ margin: 0 }}>Progress</h2>
          <select value={metric} onChange={(e) => setMetric(e.target.value)} aria-label="Metric">{TREND_KEYS.map((k) => <option key={k} value={k}>{METRIC_BY_KEY[k].label}</option>)}</select>
        </div>
        {pts.length < 2 ? <p className="muted small">Analyse at least two clips for this athlete (assign them in the Library) to see trends.</p> : (
          <LineChart title={def.label} unit={def.unit} xLabel="days since first clip"
            series={[
              { t: pts.map(days), y: pts.map((c) => c.analysis!.metrics[metric].value as number), color: col.a, label: 'pitch' },
              ...(baseline[metric] ? [{ t: [0, days(pts[pts.length - 1])], y: [baseline[metric].m, baseline[metric].m], color: col.text3, label: 'baseline', dashed: true }] : []),
            ]}
            events={markers.map((m) => ({ t: (Date.parse(m.date) - t0) / 86400000, label: m.text.slice(0, 18), color: col.accent }))} />
        )}
        <div className="row">
          <input placeholder='Training change, e.g. "started weighted balls"' value={marker} onChange={(e) => setMarker(e.target.value)} style={{ flex: 1 }} />
          <button onClick={async () => { if (!marker.trim()) return; await db.markers.put({ id: uid(), athleteId: a.id, date: new Date().toISOString().slice(0, 10), text: marker.trim() }); setMarker(''); }}>Mark today</button>
        </div>
        <div className="grid cols-auto">
          {TREND_KEYS.map((k) => <Spark key={k} k={k} clips={mine} baseline={baseline[k]} onClick={() => setMetric(k)} />)}
        </div>
      </section>

      <section className="card stack">
        <h2>Sessions &amp; fatigue</h2>
        {sessions.length === 0 && <p className="small muted">No sessions yet. Assign clips to this athlete in the Library — clips assigned on the same day form a session.</p>}
        {sessions.sort((x, y) => y.date.localeCompare(x.date)).map((s) => <SessionRow key={s.id} sid={s.id} date={s.date} clips={mine.filter((c) => c.record.sessionId === s.id)} />)}
      </section>

      <section className="card stack">
        <h2>Ball data</h2>
        <BallImport clips={mine} />
        <Scatter clips={mine} />
      </section>

      <section className="card">
        <h2>Assigned drills</h2>
        {assignments.length === 0 ? <p className="small muted">Assign drills from the <a href="#/drills">drill library</a>.</p> : (
          <ul style={{ listStyle: 'none', padding: 0 }}>{assignments.map((as) => (
            <li key={as.id} className="row"><label className="row tight"><input type="checkbox" checked={as.done} onChange={(e) => db.assignments.put({ ...as, done: e.target.checked })} /> <a href={`#/drills/${as.drillId}`}>{DRILL_BY_ID[as.drillId]?.name}</a></label><span className="tiny faint">{DRILL_BY_ID[as.drillId]?.dose}</span><button className="small ghost" onClick={() => db.assignments.delete(as.id)}>✕</button></li>
          ))}</ul>
        )}
      </section>
    </div>
  );
}

function Spark({ k, clips, baseline, onClick }: { k: string; clips: RuntimeClip[]; baseline?: { m: number; s: number }; onClick: () => void }) {
  const def = METRIC_BY_KEY[k];
  const v = clips.map((c) => c.analysis!.metrics[k]?.value).filter((x): x is number => x !== null && x !== undefined);
  if (!v.length) return null;
  const lo = Math.min(...v), hi = Math.max(...v);
  const d = v.map((x, i) => `${(i / Math.max(1, v.length - 1)) * 100},${28 - ((x - lo) / (hi - lo || 1)) * 24}`).join(' ');
  return (
    <button className="card flat" onClick={onClick} style={{ textAlign: 'left', display: 'block', textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--font-body)' }}>
      <div className="small">{def.short}</div>
      <div className="num" style={{ fontSize: '1.3rem' }}>{v[v.length - 1].toFixed(def.digits)}<span className="small faint"> {def.unit}</span></div>
      <svg viewBox="0 0 100 30" style={{ width: '100%', height: 30 }} aria-hidden><polyline points={d} fill="none" stroke="var(--a)" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>
      {baseline && <div className="tiny faint">baseline {baseline.m.toFixed(def.digits)} ± {baseline.s.toFixed(def.digits)}</div>}
    </button>
  );
}

function SessionRow({ sid, date, clips }: { sid: string; date: string; clips: RuntimeClip[] }) {
  const col = useCssColors();
  const [k, setK] = useState('trunkTiltBR');
  const setSlot = useStore((s) => s.setSlot);
  const v = clips.map((c, i) => ({ i: i + 1, y: c.analysis!.metrics[k]?.value ?? NaN }));
  return (
    <details>
      <summary>{date} · {clips.length} pitch{clips.length === 1 ? '' : 'es'}</summary>
      <div className="stack" style={{ marginTop: 8 }}>
        <div className="row small">
          Fatigue view — how
          <select value={k} onChange={(e) => setK(e.target.value)}>{METRICS.filter((m) => TREND_KEYS.includes(m.key)).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select>
          drifts from pitch 1 to pitch {clips.length}
        </div>
        {clips.length >= 2 ? <LineChart title={METRIC_BY_KEY[k].label} unit={METRIC_BY_KEY[k].unit} xLabel="pitch number" series={[{ t: v.map((p) => p.i), y: v.map((p) => p.y), color: col.b, label: 'pitch' }]} height={150} /> : <p className="small muted">Needs 2+ analysed pitches.</p>}
        <div className="row tight">{clips.map((c) => <button key={c.id} className="small" onClick={() => { setSlot('B', c.id); go(`/clip/${c.id}`); }}>{c.record.name}</button>)}</div>
        <span hidden>{sid}</span>
      </div>
    </details>
  );
}

const BALL_COLS: [keyof BallData, RegExp][] = [
  ['velo', /velo|speed|rel.?speed/i], ['spin', /^(total )?spin( rate)?$|spinrate|total spin/i], ['spinEff', /spin eff|efficiency/i], ['gyro', /gyro/i],
  ['ivb', /induced vert|ivb|vertical break|vert.?break/i], ['hb', /horizontal break|horz.?break|hb\b/i], ['relHeight', /release height|rel.?height/i], ['relSide', /release side|rel.?side/i], ['extension', /extension/i],
];

function BallImport({ clips }: { clips: RuntimeClip[] }) {
  const updateRecord = useStore((s) => s.updateRecord);
  const [msg, setMsg] = useState('');
  return (
    <label className="field small">Import Rapsodo / TrackMan / Yakkertech / generic CSV — rows are attached to this athlete's analysed clips in date order
      <input type="file" accept=".csv,text/csv" onChange={async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const lines = (await f.text()).split(/\r?\n/).filter((l) => l.trim());
        const hi = lines.findIndex((l) => /velo|speed|spin/i.test(l));
        if (hi < 0) { setMsg('Could not find a header row with velocity or spin.'); return; }
        const head = lines[hi].split(',').map((h) => h.replace(/"/g, '').trim());
        const map = BALL_COLS.map(([k, re]) => [k, head.findIndex((h) => re.test(h))] as const).filter(([, i]) => i >= 0);
        const rows = lines.slice(hi + 1).map((l) => l.split(',').map((c) => c.replace(/"/g, '').trim()));
        let n = 0;
        for (let i = 0; i < Math.min(rows.length, clips.length); i++) {
          const bd: BallData = {};
          for (const [k, idx] of map) { const v = Number(rows[i][idx]); if (Number.isFinite(v)) bd[k] = v; }
          await updateRecord(clips[i].id, { ballData: bd }); n++;
        }
        setMsg(`Mapped columns: ${map.map(([k]) => k).join(', ') || 'none'} · attached ${n} rows`);
      }} />
      {msg && <span className="muted">{msg}</span>}
    </label>
  );
}

function Scatter({ clips }: { clips: RuntimeClip[] }) {
  const [x, setX] = useState('stride');
  const pts = clips.filter((c) => c.record.ballData?.velo !== undefined && c.analysis!.metrics[x]?.value !== null).map((c) => ({ x: c.analysis!.metrics[x].value as number, y: c.record.ballData!.velo as number }));
  if (pts.length < 3) return <p className="small muted">Attach velocity to 3+ analysed clips to see how mechanics relate to velo for this athlete.</p>;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const mx = mean(xs), my = mean(ys);
  const r = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / ((pts.length - 1) * sd(xs) * sd(ys));
  const X = (v: number) => 30 + ((v - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs) || 1)) * 260;
  const Y = (v: number) => 150 - ((v - Math.min(...ys)) / (Math.max(...ys) - Math.min(...ys) || 1)) * 130;
  return (
    <div>
      <div className="row small">Velocity vs <select value={x} onChange={(e) => setX(e.target.value)}>{TREND_KEYS.map((k) => <option key={k} value={k}>{METRIC_BY_KEY[k].label}</option>)}</select> <span className="muted">r = {r.toFixed(2)} (n = {pts.length}; correlation, not cause)</span></div>
      <svg viewBox="0 0 300 170" style={{ width: '100%', maxWidth: 520 }} role="img" aria-label="Scatter plot">
        <line x1="30" y1="155" x2="295" y2="155" stroke="var(--line-strong)" /><line x1="30" y1="10" x2="30" y2="155" stroke="var(--line-strong)" />
        {pts.map((p, i) => <circle key={i} cx={X(p.x)} cy={Y(p.y)} r="4" fill="var(--a)" />)}
        <text x="160" y="168" fontSize="9" textAnchor="middle" fill="var(--text-3)">{METRIC_BY_KEY[x].label}</text>
        <text x="4" y="12" fontSize="9" fill="var(--text-3)">mph</text>
      </svg>
    </div>
  );
}
