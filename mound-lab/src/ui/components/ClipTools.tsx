// Clip-screen panels: who was tracked (switch person), velocity, clip quality, drawing/measuring tools.

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { clipVelo, useStore, type RuntimeClip } from '../../state/store';
import { db, uid, type Annotation } from '../../db/db';
import { boxAt, type PersonSummary } from '../../core/people';
import { fit, label, type Affine } from '../draw';
import { Stage } from './Stage';
import { useCssColors } from './common';
import { DEFAULT_HEIGHT_M } from '../velocity';

// ------------------------------------------------------------------ people

const ROLE_TEXT: Record<PersonSummary['role'], string> = { pitcher: 'Pitcher', runner: 'Runner (ignored)', other: 'Other person' };

export function PeoplePanel({ clip }: { clip: RuntimeClip }) {
  const scan = clip.scan;
  const switchPerson = useStore((s) => s.switchPerson);
  const col = useCssColors();
  if (!scan || !clip.full) return null;
  const tr = clip.full.cleaned;
  const people = scan.people.filter((p) => p.presence > 0.15 || p.role === 'pitcher').slice(0, 6);
  const mid = Math.floor(tr.t.length / 2);
  const tMedia = tr.t[mid] * clip.record.slowmo;
  const busy = clip.status === 'analyzing';
  return (
    <div className="card">
      <div className="card-title"><h3>Who's tracked</h3><span className="tiny faint">{scan.people.length} {scan.people.length === 1 ? 'person' : 'people'} found{scan.smallPeople ? ' · far camera: zoomed search' : ''}</span></div>
      {people.length > 1 && (
        <Stage label="People found in the clip" aspect={tr.width / tr.height} deps={[clip.source, scan, col]} sources={[clip.source]}
          draw={(ctx, w, h) => {
            const f = fit(tr.width, tr.height, w, h);
            clip.source?.draw(ctx, mid, f.tx, f.ty, f.w, f.h);
            for (const p of people) {
              const t = scan.tracks.find((x) => x.id === p.id);
              if (!t) continue;
              const b = boxAt(t, tMedia);
              const c = p.role === 'pitcher' ? col.a : p.role === 'runner' ? col.accent : '#bbb';
              ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.setLineDash(p.role === 'pitcher' ? [] : [5, 4]);
              ctx.strokeRect(f.tx + b[0] * f.sx, f.ty + b[1] * f.sy, (b[2] - b[0]) * f.sx, (b[3] - b[1]) * f.sy);
              ctx.setLineDash([]);
              label(ctx, f.tx + b[0] * f.sx, f.ty + b[1] * f.sy - 4, `${ROLE_TEXT[p.role]} #${p.id}`, "#fff");
            }
          }} />
      )}
      <ul className="small" style={{ paddingLeft: 18, margin: '8px 0' }}>
        {people.map((p) => (
          <li key={p.id} style={{ marginBottom: 4 }}>
            <b>{ROLE_TEXT[p.role]} #{p.id}</b> <span className="faint">{Math.round(p.heightFrac * 100)}% of frame height</span>
            {p.reasons.length > 0 && <span className="muted"> — {p.reasons.join(', ')}</span>}
            {p.role !== 'pitcher' && clip.kind === 'video' && <> <button className="small" disabled={busy} onClick={() => switchPerson(clip.id, p.id)}>Track this one</button></>}
          </li>
        ))}
      </ul>
      {clip.kind === 'video' && (
        <p className="small" style={{ margin: '0 0 6px' }}>Wrong person, or the pitcher isn't listed? <button className="small" disabled={busy} data-testid="remark-btn"
          onClick={() => useStore.setState((s) => ({ clips: { ...s.clips, [clip.id]: { ...s.clips[clip.id], status: 'new', full: undefined, analysis: undefined } } }))}>Mark the pitcher by hand…</button></p>
      )}
      {(scan.backView || scan.mediapipeWeak) && <p className="tiny faint" style={{ margin: '0 0 6px' }}>{scan.backView ? 'Filmed from behind: ' : ''}the pitcher is tracked with MoveNet, which finds a body from any side without needing to see a face.</p>}
      <p className="tiny faint" style={{ margin: 0 }}>The pitcher is the person with one leg lift from a still set, a burst toward the plate and the fastest arm. Runners (moving fast the whole time, alternating legs) are ignored even when they're bigger or more central.</p>
    </div>
  );
}

// ------------------------------------------------------------------ velocity

export function VeloCard({ clip, marking, setMarking }: { clip: RuntimeClip; marking: boolean; setMarking: (v: boolean) => void }) {
  const measure = useStore((s) => s.measureVelo);
  const v = clipVelo(clip);
  const est = clip.velo;
  return (
    <div className="card" data-testid="velo-card">
      <div className="card-title"><h3>Pitch velocity</h3>{v && <span className="tiny faint">{v.source}</span>}</div>
      {clip.veloBusy ? <p className="small muted">Tracking the ball after release…</p> : v ? (
        <div>
          <div className="num" style={{ fontSize: '2.6rem', lineHeight: 1 }} data-testid="velo-mph">{v.mph.toFixed(0)}<span className="small faint"> mph</span></div>
          {v.low && v.high && <div className="small muted">likely {v.low.toFixed(0)}–{v.high.toFixed(0)} mph</div>}
        </div>
      ) : <p className="small muted">No estimate yet.</p>}
      {est?.notes.map((n) => <p key={n} className="tiny faint" style={{ margin: '4px 0 0' }}>{n}</p>)}
      <div className="row tight" style={{ marginTop: 8 }}>
        <button className="small" onClick={() => measure(clip.id)} disabled={clip.veloBusy}>Re-measure</button>
        <button className="small" aria-pressed={marking} onClick={() => setMarking(!marking)} title="Click the ball on two frames after release">{marking ? 'Cancel marking' : 'Mark the ball'}</button>
      </div>
      {marking && <p className="tiny" style={{ margin: '6px 0 0' }}>Step to a frame just after release and click the ball, then step a few frames on and click it again.</p>}
      <p className="tiny faint" style={{ margin: '6px 0 0' }}>Measured by tracking the ball across the frames after release (side view, 120+ fps). Uses the athlete's height for scale{clip.record.heightM ? '' : ` (assumed ${DEFAULT_HEIGHT_M} m)`}. A radar reading entered in ball data always wins.</p>
    </div>
  );
}

// ------------------------------------------------------------------ quality

export function QualityCard({ clip }: { clip: RuntimeClip }) {
  const q = clip.quality;
  if (!q) return null;
  const color = q.grade === 'A' ? 'var(--ok)' : q.grade === 'B' ? 'var(--tier-med)' : 'var(--accent)';
  return (
    <details className="card" data-testid="quality-card">
      <summary style={{ display: 'flex', alignItems: 'center', gap: 10, listStyle: 'none' }}>
        <span className="num" style={{ fontSize: '2rem', color }}>{q.grade}</span>
        <span><b>Clip quality {q.score}/100</b><br /><span className="tiny faint">{q.factors.filter((f) => f.advice).length ? `${q.factors.filter((f) => f.advice).length} tip(s) for the next clip — tap to see` : 'Great footage for analysis'}</span></span>
      </summary>
      <table className="metrics" style={{ marginTop: 8 }}>
        <tbody>
          {q.factors.map((f) => (
            <tr key={f.key}>
              <td>{f.label}<div className="tiny faint">{f.value}</div>{f.advice && <div className="tiny">{f.advice}</div>}</td>
              <td style={{ width: 90 }}><div className="bar" aria-label={`${Math.round(f.score * 100)}%`}><i style={{ width: `${f.score * 100}%`, background: f.score > 0.75 ? 'var(--ok)' : f.score > 0.5 ? 'var(--warn)' : 'var(--accent)' }} /></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

// ------------------------------------------------------------------ drawing & measuring

export type Tool = 'none' | 'line' | 'angle' | 'dist' | 'text' | 'free' | 'calib';
const TOOL_POINTS: Record<Tool, number> = { none: 0, line: 2, angle: 3, dist: 2, text: 1, free: 0, calib: 2 };
const TOOL_LABEL: Record<Tool, string> = { none: 'Off', line: 'Line', angle: 'Angle', dist: 'Distance', text: 'Text', free: 'Draw', calib: 'Calibrate' };

export function useAnnotations(clip: RuntimeClip) {
  const stored = useLiveQuery(() => db.annotations.where('clipId').equals(clip.id).toArray(), [clip.id]);
  const [local, setLocal] = useState<Annotation[]>([]); // demo clips aren't persisted
  const list = clip.kind === 'demo' ? local : stored ?? [];
  const add = async (a: Annotation) => { if (clip.kind === 'demo') setLocal((l) => [...l, a]); else await db.annotations.put(a); };
  const clear = async () => { if (clip.kind === 'demo') setLocal([]); else await db.annotations.where('clipId').equals(clip.id).delete(); };
  return { list, add, clear };
}

/** Pixels per metre in track coordinates: user calibration first, then athlete height. */
export function pxPerMetre(clip: RuntimeClip): { pxPerM: number; source: string } | null {
  if (clip.record.calibPxPerM) return { pxPerM: clip.record.calibPxPerM, source: 'calibration' };
  if (clip.record.heightM && clip.analysis) return { pxPerM: clip.analysis.scale.heightPx / clip.record.heightM, source: 'athlete height' };
  return null;
}

export function fmtLength(m: number, units: 'imperial' | 'metric') {
  if (units === 'metric') return m >= 1 ? `${m.toFixed(2)} m` : `${(m * 100).toFixed(0)} cm`;
  const inches = m / 0.0254;
  return inches >= 24 ? `${Math.floor(inches / 12)}′ ${Math.round(inches % 12)}″` : `${inches.toFixed(1)}″`;
}

function angleAt(a: [number, number], b: [number, number], c: [number, number]) {
  const u = [a[0] - b[0], a[1] - b[1]], v = [c[0] - b[0], c[1] - b[1]];
  const d = Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]) || 1;
  return (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / d))) * 180) / Math.PI;
}

export function drawAnnotations(ctx: CanvasRenderingContext2D, list: Annotation[], frame: number, T: Affine, clip: RuntimeClip, units: 'imperial' | 'metric', draft?: { tool: Tool; points: [number, number][] }) {
  const P = (p: [number, number]): [number, number] => [p[0] * T.sx + T.tx, p[1] * T.sy + T.ty];
  const cal = pxPerMetre(clip);
  const heightPx = clip.analysis?.scale.heightPx ?? 1;
  const all = [...list.filter((a) => a.frame === undefined || Math.abs(a.frame - frame) <= 0), ...(draft && draft.points.length ? [{ id: 'draft', clipId: clip.id, kind: draft.tool, points: draft.points, color: '#ffd166' } as Annotation] : [])];
  ctx.save();
  ctx.lineWidth = 2.5; ctx.lineCap = 'round';
  for (const a of all) {
    const col = a.color ?? '#ffd166';
    ctx.strokeStyle = col; ctx.fillStyle = col;
    const pts = a.points.map(P);
    if (a.kind === 'text' && pts[0]) { label(ctx, pts[0][0], pts[0][1], a.text ?? '', col); continue; }
    if (pts.length >= 2) { ctx.beginPath(); ctx.moveTo(...pts[0]); for (const q of pts.slice(1)) ctx.lineTo(...q); ctx.stroke(); }
    for (const q of pts) { if (a.kind !== 'free') { ctx.beginPath(); ctx.arc(q[0], q[1], 4, 0, Math.PI * 2); ctx.fill(); } }
    if ((a.kind === 'dist' || a.kind === 'calib') && a.points.length === 2) {
      const px = Math.hypot(a.points[1][0] - a.points[0][0], a.points[1][1] - a.points[0][1]);
      const txt = a.kind === 'calib' ? 'reference' : cal ? fmtLength(px / cal.pxPerM, units) : `${((px / heightPx) * 100).toFixed(1)}% ht`;
      label(ctx, (pts[0][0] + pts[1][0]) / 2 + 6, (pts[0][1] + pts[1][1]) / 2 - 6, txt, col);
    }
    if (a.kind === 'angle' && a.points.length === 3) label(ctx, pts[1][0] + 8, pts[1][1] - 8, `${angleAt(a.points[0], a.points[1], a.points[2]).toFixed(0)}°`, col);
  }
  ctx.restore();
}

export function AnnotationBar({ tool, setTool, persistent, setPersistent, onClear, count, calibrated }: {
  tool: Tool; setTool: (t: Tool) => void; persistent: boolean; setPersistent: (v: boolean) => void; onClear: () => void; count: number; calibrated: string | null;
}) {
  return (
    <div className="row tight small" role="toolbar" aria-label="Drawing and measuring tools">
      <span className="section-label">Draw</span>
      <div className="seg">
        {(['none', 'line', 'angle', 'dist', 'text', 'free', 'calib'] as Tool[]).map((t) => <button key={t} aria-pressed={tool === t} onClick={() => setTool(t)}>{TOOL_LABEL[t]}</button>)}
      </div>
      <label className="row tight"><input type="checkbox" checked={persistent} onChange={(e) => setPersistent(e.target.checked)} /> on every frame</label>
      {count > 0 && <button className="small ghost" onClick={onClear}>Clear drawings ({count})</button>}
      <span className="tiny faint">{tool === 'none' ? '' : tool === 'free' ? 'drag to draw' : `click ${TOOL_POINTS[tool]} point${TOOL_POINTS[tool] > 1 ? 's' : ''}`}{calibrated ? ` · scale from ${calibrated}` : ' · enter height or calibrate for real distances'}</span>
    </div>
  );
}

export const CALIB_PRESETS: [string, number][] = [['Pitching rubber (24 in)', 0.6096], ['Home plate width (17 in)', 0.4318], ['Rubber to plate (60 ft 6 in)', 18.44], ['Baseball (2.9 in)', 0.0737], ['1 metre', 1], ['1 foot', 0.3048]];

export { TOOL_POINTS, uid };
