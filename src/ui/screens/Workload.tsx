import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, uid, type WorkloadEntry } from '../../db/db';
import { PITCH_SMART, PITCH_SMART_RULES, acwr, checkPitchSmart, restDays, rowForAge } from '../../data/pitchsmart';
import { LineChart } from '../components/Chart';
import { useCssColors } from '../components/common';

const today = () => new Date().toISOString().slice(0, 10);

export function WorkloadScreen() {
  const athletes = useLiveQuery(() => db.athletes.toArray(), []) ?? [];
  const [aid, setAid] = useState('');
  const athlete = athletes.find((a) => a.id === aid) ?? athletes[0];
  const entries = useLiveQuery(() => (athlete ? db.workload.where('athleteId').equals(athlete.id).toArray() : Promise.resolve([] as WorkloadEntry[])), [athlete?.id]) ?? [];
  const [form, setForm] = useState({ date: today(), pitches: '', intent: 'Medium', armFeel: '', pain: false, notes: '' });
  const col = useCssColors();
  const age = athlete?.birthYear ? new Date().getFullYear() - athlete.birthYear : undefined;
  const warnings = age !== undefined ? checkPitchSmart(age, entries.map((e) => ({ date: e.date, pitches: e.pitches, pain: e.pain }))) : [];
  const ratio = acwr(entries.map((e) => ({ date: e.date, load: e.pitches })), today());
  const last = [...entries].sort((a, b) => b.date.localeCompare(a.date))[0];
  const rest = age !== undefined && last ? restDays(age, last.pitches) : null;
  const nextOk = last && rest !== null ? new Date(Date.parse(last.date) + (rest + 1) * 86400000).toISOString().slice(0, 10) : null;

  const series = useMemo(() => {
    const days: string[] = [];
    for (let i = 41; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    const r = days.map((d) => acwr(entries.map((e) => ({ date: e.date, load: e.pitches })), d).ratio ?? NaN);
    return { t: days.map((_, i) => i - 41), r };
  }, [entries]);

  if (!athletes.length) return <div className="card">Add an athlete on the <a href="#/athletes">Athletes</a> page to log workload.</div>;
  return (
    <div className="stack">
      <div className="row spread">
        <h1 style={{ margin: 0 }}>Workload &amp; Pitch Smart</h1>
        <select value={athlete?.id} onChange={(e) => setAid(e.target.value)} aria-label="Athlete">{athletes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      </div>
      <div className="notice info small">Workload is the biggest controllable factor in youth arm injuries: pitching too often, pitching while tired and pitching with pain carry more risk than any mechanical flaw.</div>
      {entries.some((e) => e.pain) && <div className="notice bad"><b>Pitching with pain was logged.</b> Stop throwing and see a qualified professional (sports-medicine physician or physical therapist) before pitching again.</div>}
      <div className="grid cols-3">
        <div className="card"><div className="section-label">Age group</div><div className="num" style={{ fontSize: '2rem' }}>{age ?? '—'}</div><div className="small muted">{age !== undefined ? `Pitch Smart ${rowForAge(age)?.ages ?? 'n/a'} · daily max ${rowForAge(age)?.dailyMax ?? '—'}` : 'Add a birth year on the athlete profile'}</div></div>
        <div className="card"><div className="section-label">Next day OK to pitch</div><div className="num" style={{ fontSize: '2rem' }}>{nextOk ?? '—'}</div><div className="small muted">{last ? `${last.pitches} pitches on ${last.date} → ${rest ?? '?'} rest day(s)` : 'No outings logged'}</div></div>
        <div className="card"><div className="section-label">Acute : chronic (9 d : 28 d)</div><div className="num" style={{ fontSize: '2rem', color: ratio.ratio !== null && (ratio.ratio > 1.3 || ratio.ratio < 0.7) ? 'var(--accent)' : undefined }}>{ratio.ratio !== null ? ratio.ratio.toFixed(2) : '—'}</div><div className="small muted">Recommended 0.7–1.3. Above 1.3 = ramping up too fast.</div></div>
      </div>
      {warnings.map((w) => <div key={w} className="notice warn small">{w}</div>)}
      <div className="grid cols-2">
        <form className="card stack" onSubmit={async (e) => {
          e.preventDefault();
          if (!athlete || !form.pitches) return;
          await db.workload.put({ id: uid(), athleteId: athlete.id, date: form.date, pitches: Number(form.pitches), intent: form.intent as WorkloadEntry['intent'], armFeel: form.armFeel ? Number(form.armFeel) : undefined, pain: form.pain, notes: form.notes || undefined });
          setForm({ ...form, pitches: '', notes: '', pain: false });
        }}>
          <h2>Log an outing</h2>
          <div className="row">
            <label className="field">Date<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
            <label className="field">Pitches<input type="number" min={0} value={form.pitches} onChange={(e) => setForm({ ...form, pitches: e.target.value })} style={{ width: 90 }} required /></label>
            <label className="field">Intent<select value={form.intent} onChange={(e) => setForm({ ...form, intent: e.target.value })}>{['Recovery', 'Medium', 'Medium-High', 'High'].map((i) => <option key={i}>{i}</option>)}</select></label>
            <label className="field">Arm feel (1–10)<input type="number" min={1} max={10} value={form.armFeel} onChange={(e) => setForm({ ...form, armFeel: e.target.value })} style={{ width: 80 }} /></label>
          </div>
          <label className="row tight"><input type="checkbox" checked={form.pain} onChange={(e) => setForm({ ...form, pain: e.target.checked })} /> Pain while throwing</label>
          <input placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          <button className="primary" type="submit">Save</button>
        </form>
        <div className="card">
          <LineChart title="Acute:chronic workload ratio, last 6 weeks" unit="ratio" xLabel="days ago" series={[{ t: series.t, y: series.r, color: col.a, label: 'ACWR' }, { t: [-41, 0], y: [1.3, 1.3], color: col.accent, label: '1.3 upper', dashed: true }, { t: [-41, 0], y: [0.7, 0.7], color: col.text3, label: '0.7 lower', dashed: true }]} />
          <table className="metrics"><thead><tr><th>Date</th><th>Pitches</th><th>Intent</th><th>Feel</th><th /></tr></thead>
            <tbody>{[...entries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12).map((e) => <tr key={e.id}><td>{e.date}</td><td className="v">{e.pitches}</td><td>{e.intent}</td><td>{e.armFeel ?? ''}{e.pain ? ' ⚠︎ pain' : ''}</td><td><button className="small ghost" onClick={() => db.workload.delete(e.id)}>✕</button></td></tr>)}</tbody>
          </table>
          <PulseImport athleteId={athlete?.id} />
        </div>
      </div>
      <div className="card">
        <h2>MLB Pitch Smart guidelines</h2>
        <div className="table-scroll">
          <table className="metrics">
            <thead><tr><th>Age</th><th>Daily max</th><th>0 days rest</th><th>1 day</th><th>2 days</th><th>3 days</th><th>4 days</th><th>5 days</th></tr></thead>
            <tbody>{PITCH_SMART.map((r) => {
              const cells: string[] = [];
              let lo = 1;
              for (let i = 0; i < 6; i++) { const hi = r.bands[i]; if (hi === undefined) { cells.push('—'); continue; } cells.push(hi === Infinity ? `${lo}–${r.dailyMax}` : `${lo}–${hi}`); lo = hi + 1; }
              return <tr key={r.ages}><td>{r.ages}</td><td className="v">{r.dailyMax}</td>{cells.map((c, i) => <td key={i} className="mono small">{c}</td>)}</tr>;
            })}</tbody>
          </table>
        </div>
        <ul className="small">{PITCH_SMART_RULES.map((r) => <li key={r}>{r}</li>)}<li>Innings limits per 12 months: 80 (ages 9–12), 100 (13–18).</li></ul>
        <p className="tiny faint">Source: MLB / USA Baseball Pitch Smart (mlb.com/pitch-smart). Guidelines are revised from time to time — check the official site.</p>
      </div>
    </div>
  );
}

function PulseImport({ athleteId }: { athleteId?: string }) {
  const [msg, setMsg] = useState('');
  return (
    <label className="field small" style={{ marginTop: 10 }}>Import throws CSV (date + count columns, e.g. a Pulse export)
      <input type="file" accept=".csv,text/csv" onChange={async (e) => {
        const f = e.target.files?.[0];
        if (!f || !athleteId) return;
        const rows = (await f.text()).split(/\r?\n/).map((l) => l.split(','));
        const head = rows[0].map((h) => h.toLowerCase().trim());
        const di = head.findIndex((h) => h.includes('date')), ci = head.findIndex((h) => /throw|pitch|count/.test(h));
        if (di < 0 || ci < 0) { setMsg('Need a "date" column and a "throws"/"pitches"/"count" column.'); return; }
        const byDay = new Map<string, number>();
        for (const r of rows.slice(1)) { const d = new Date(r[di]); if (isNaN(+d)) continue; const k = d.toISOString().slice(0, 10); byDay.set(k, (byDay.get(k) ?? 0) + (Number(r[ci]) || 0)); }
        await db.workload.bulkPut([...byDay].map(([date, pitches]) => ({ id: uid(), athleteId, date, pitches, notes: 'imported' })));
        setMsg(`Imported ${byDay.size} days`);
      }} />
      {msg && <span className="muted">{msg}</span>}
    </label>
  );
}
