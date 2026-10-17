import { useEffect, useMemo, useRef, useState } from 'react';
import { clipVideoUrl, useStore, type RuntimeClip } from '../../state/store';
import { EVENT_CODES, EVENT_LABELS, J, JOINTS, resolvedEvents, type EventCode, type View } from '../../core/types';
import { SERIES_INFO } from '../../core/metrics';
import { analyzeTrack } from '../../core/analyze';
import { jn } from '../../core/clean';
import { db, trackKey } from '../../db/db';
import { CLIP_SPEEDS, SUPPORTED_HINT } from '../../video/meta';
import { Stage } from '../components/Stage';
import { Timeline, TransportBar } from '../components/Timeline';
import { usePlayback, useKeys } from '../components/playback';
import { MetricPanel } from '../components/MetricPanel';
import { AngleAngle, LineChart } from '../components/Chart';
import { Disclaimer, Progress, useCssColors } from '../components/common';
import { drawAngleLabels, drawSkeleton, drawTrail, fit, label, pt } from '../draw';
import { go } from '../router';
import { exportClipCsv, exportClipJson } from '../export';

const VIEWS: View[] = ['side-open', 'side-closed', 'front', 'back', 'oblique'];
export const PITCH_TYPES = ['FB', 'SI', 'CT', 'SL', 'SW', 'CB', 'CH', 'SPL', 'KN', 'Other'];

export function ClipScreen({ id }: { id: string }) {
  const clip = useStore((s) => s.clips[id]);
  if (!clip) return <div className="card"><h2>Clip not found</h2><a href="#/library">Back to the library</a></div>;
  return (
    <div className="stack">
      <ClipHeader clip={clip} />
      {clip.status === 'ready' && clip.analysis && clip.full ? <Breakdown clip={clip} /> : <PreAnalysis clip={clip} />}
    </div>
  );
}

function ClipHeader({ clip }: { clip: RuntimeClip }) {
  const { updateRecord, removeClip, setSlot } = useStore();
  const r = clip.record;
  const [name, setName] = useState(r.name);
  useEffect(() => setName(r.name), [r.name]);
  return (
    <div className="card">
      <div className="row spread">
        <input aria-label="Clip name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== r.name && updateRecord(clip.id, { name })} style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 700, flex: '1 1 260px', border: 0, background: 'transparent', padding: 0 }} />
        <div className="row tight">
          <button className="small" onClick={() => setSlot('A', clip.id)}><span className="chip-a">A</span> Put in A</button>
          <button className="small" onClick={() => setSlot('B', clip.id)}><span className="chip-b">B</span> Put in B</button>
          {clip.kind === 'video' && <button className="small ghost" onClick={async () => { if (confirm('Delete this clip and its video from this device?')) { await removeClip(clip.id); go('/library'); } }}>Delete</button>}
        </div>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="field">Pitch type
          <select value={r.pitchType ?? ''} onChange={(e) => updateRecord(clip.id, { pitchType: e.target.value || undefined })}>
            <option value="">—</option>{PITCH_TYPES.map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label className="field">Clip speed
          <select value={r.slowmo} disabled={clip.kind === 'demo'} onChange={(e) => updateRecord(clip.id, { slowmo: Number(e.target.value) })} title="For slow-motion exports: how many times slower than real time the file plays">
            {CLIP_SPEEDS.map((s) => <option key={s} value={s}>{s === 1 ? 'Real time' : `${s}× slow-mo`}</option>)}
          </select>
        </label>
        <label className="field">Athlete height
          <HeightInput value={r.heightM} onChange={(heightM) => updateRecord(clip.id, { heightM })} />
        </label>
        <label className="field">Effort %
          <input type="number" min={0} max={100} value={r.effortPct ?? ''} onChange={(e) => updateRecord(clip.id, { effortPct: e.target.value ? Number(e.target.value) : undefined })} style={{ width: 80 }} />
        </label>
        <label className="field">Tags
          <input value={r.tags.join(', ')} onChange={(e) => updateRecord(clip.id, { tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="bullpen, new leg lift" />
        </label>
        <label className="field row tight" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <input type="checkbox" checked={!!r.starred} onChange={(e) => updateRecord(clip.id, { starred: e.target.checked })} /> Best-pitch reference ★
        </label>
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>
        {r.meta.width ? `${r.meta.width}×${r.meta.height}` : ''} · {Math.round(r.meta.fpsMedia)} fps media ({r.meta.fpsSource}) {r.slowmo > 1 ? `→ ${Math.round(r.meta.fpsMedia * r.slowmo)} fps real` : ''}
        {r.meta.vfr ? ' · variable frame rate' : ''}{r.meta.codec ? ` · ${r.meta.codec}` : ''} · {r.meta.durationS.toFixed(2)} s
      </div>
    </div>
  );
}

export function HeightInput({ value, onChange }: { value?: number; onChange: (m?: number) => void }) {
  const units = useStore((s) => s.settings.units);
  if (units === 'metric') return <input type="number" step={1} min={100} max={230} value={value ? Math.round(value * 100) : ''} placeholder="cm" onChange={(e) => onChange(e.target.value ? Number(e.target.value) / 100 : undefined)} style={{ width: 90 }} />;
  const totalIn = value ? value / 0.0254 : undefined;
  const ft = totalIn ? Math.floor(totalIn / 12) : '';
  const inch = totalIn ? Math.round(totalIn - Number(ft) * 12) : '';
  return (
    <span className="row tight">
      <input aria-label="feet" type="number" min={3} max={7} value={ft} placeholder="ft" style={{ width: 56 }} onChange={(e) => onChange(e.target.value ? (Number(e.target.value) * 12 + Number(inch || 0)) * 0.0254 : undefined)} />
      <input aria-label="inches" type="number" min={0} max={11} value={inch} placeholder="in" style={{ width: 56 }} onChange={(e) => onChange(ft ? (Number(ft) * 12 + Number(e.target.value || 0)) * 0.0254 : undefined)} />
    </span>
  );
}

function PreAnalysis({ clip }: { clip: RuntimeClip }) {
  const { analyze, cancel, updateRecord, settings, setSettings } = useStore();
  const [url, setUrl] = useState<string | null>(clip.url ?? null);
  const video = useRef<HTMLVideoElement>(null);
  const [pickMode, setPickMode] = useState(false);
  useEffect(() => { void clipVideoUrl(clip).then(setUrl); }, [clip]);
  const r = clip.record;
  const fps = r.meta.fpsMedia || 30;
  const step = (k: number) => { const v = video.current; if (v) { v.pause(); v.currentTime = Math.max(0, v.currentTime + k / fps); } };
  return (
    <div className="grid cols-2">
      <div className="card">
        {url ? (
          <div style={{ position: 'relative' }}>
            <video ref={video} src={url} controls playsInline muted style={{ width: '100%', borderRadius: 8, background: '#000', maxHeight: '60vh' }}
              onClick={(e) => {
                if (!pickMode) return;
                e.preventDefault();
                const rc = e.currentTarget.getBoundingClientRect();
                const v = e.currentTarget;
                const f = fit(v.videoWidth, v.videoHeight, rc.width, rc.height);
                const x = (e.clientX - rc.left - f.tx) / f.w, y = (e.clientY - rc.top - f.ty) / f.h;
                setPickMode(false);
                void analyze(clip.id, { pick: { x, y } });
              }} />
            {pickMode && <div className="notice info small" style={{ position: 'absolute', top: 8, left: 8, right: 8 }}>Tap the pitcher in the video</div>}
          </div>
        ) : <div className="notice warn">Video preview unavailable in this browser. {r.meta.notes.join(' ')}</div>}
        <div className="controls">
          <button className="small" onClick={() => step(-1)}>◀︎ frame</button>
          <button className="small" onClick={() => step(1)}>frame ▶︎</button>
          <button className="small" onClick={() => video.current && updateRecord(clip.id, { trim: { ...r.trim, inS: video.current.currentTime } })}>Set start here</button>
          <button className="small" onClick={() => video.current && updateRecord(clip.id, { trim: { ...r.trim, outS: video.current.currentTime } })}>Set end here</button>
        </div>
        <div className="row small">
          <label className="field">Start (s)<input type="number" step={0.01} min={0} value={r.trim.inS.toFixed(2)} onChange={(e) => updateRecord(clip.id, { trim: { ...r.trim, inS: Number(e.target.value) } })} style={{ width: 90 }} /></label>
          <label className="field">End (s)<input type="number" step={0.01} min={0} value={r.trim.outS.toFixed(2)} onChange={(e) => updateRecord(clip.id, { trim: { ...r.trim, outS: Number(e.target.value) } })} style={{ width: 90 }} /></label>
          <span className="muted">{Math.max(0, Math.round((r.trim.outS - r.trim.inS) * fps))} frames to analyse</span>
        </div>
      </div>
      <div className="card stack">
        <h2>Analyse this pitch</h2>
        {!r.meta.playable && <div className="notice bad small">This browser can't play this video{r.meta.codec ? ` (${r.meta.codec})` : ''}, so it may not be able to analyse it either. {SUPPORTED_HINT}</div>}
        {(clip.info ?? r.meta.notes).map((n) => <div key={n} className="notice warn small">{n}</div>)}
        <p className="small muted">Trim to roughly half a second before the first move through the finish. The pose model runs on this device. Analysis takes ~5–30 s for a 3-second clip depending on your device.</p>
        <label className="field">Pose model
          <select value={settings.model} onChange={(e) => setSettings({ model: e.target.value as 'full' | 'lite' })}>
            <option value="full">Accurate (MediaPipe Pose full)</option>
            <option value="lite">Fast preview (MediaPipe Pose lite)</option>
          </select>
        </label>
        {clip.status === 'analyzing' && clip.progress ? (
          <div className="stack">
            <Progress value={clip.progress.total ? clip.progress.done / clip.progress.total : 0} label={`${clip.progress.stage} ${clip.progress.total ? `${clip.progress.done}/${clip.progress.total} frames` : ''}${clip.progress.etaS ? ` · ~${Math.ceil(clip.progress.etaS)} s left` : ''}`} />
            <button onClick={() => cancel(clip.id)}>Cancel</button>
          </div>
        ) : clip.progress ? <Progress value={0} label={clip.progress.stage} /> : (
          <div className="row">
            <button className="accent" onClick={() => analyze(clip.id)} data-testid="analyze-btn" disabled={r.trim.outS - r.trim.inS < 0.5}>Analyse</button>
            <button onClick={() => setPickMode(true)} title="Use when more than one person is in the frame">Pick the pitcher…</button>
          </div>
        )}
        {clip.status === 'error' && <div className="notice bad">{clip.error} <br /><span className="small">Tips: make sure the whole body is visible, the clip is well lit, and the file plays in this browser. You can also try the other pose model.</span></div>}
      </div>
    </div>
  );
}

function Breakdown({ clip }: { clip: RuntimeClip }) {
  const { editEvents, setView, updateRecord } = useStore();
  const a = clip.analysis!, full = clip.full!;
  const tr = full.cleaned;
  const fps = a.fps;
  const ev = resolvedEvents(a);
  const duration = (tr.t.length - 1) / fps;
  const [tour, setTour] = useState(false);
  const pb = usePlayback(duration, fps, { pauseAt: tour ? EVENT_CODES.map((k) => ev[k] / fps) : undefined });
  const frame = Math.round(pb.t * fps);
  const [show, setShow] = useState({ skeleton: true, labels: true, trails: true, video: true });
  const [editJoints, setEditJoints] = useState(false);
  const [showNA, setShowNA] = useState(false);
  const [tab, setTab] = useState<'metrics' | 'charts' | 'sequence'>('metrics');
  const col = useCssColors();
  const drag = useRef<{ j: number; ox: number; oy: number } | null>(null);
  const [rawEdit, setRawEdit] = useState(0);

  useEffect(() => { pb.setT(ev.FS / fps); /* start at foot strike */ }, [clip.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const prevNext = (dir: 1 | -1) => {
    const ts = EVENT_CODES.map((k) => ev[k]).sort((x, y) => x - y);
    const target = dir > 0 ? ts.find((x) => x > frame) : [...ts].reverse().find((x) => x < frame);
    if (target !== undefined) { pb.pause(); pb.setT(target / fps); }
  };
  useKeys({
    Space: () => pb.toggle(), ArrowLeft: () => pb.step(-1), ArrowRight: () => pb.step(1), '[': () => prevNext(-1), ']': () => prevNext(1),
    ...Object.fromEntries(EVENT_CODES.map((k, i) => [String(i + 1), () => { pb.pause(); pb.setT(ev[k] / fps); }])),
  });

  const setEvent = (k: EventCode, f: number | undefined) => {
    const edits = { ...clip.record.edits };
    if (f === undefined) delete edits[k]; else edits[k] = Math.max(0, Math.min(tr.t.length - 1, f));
    editEvents(clip.id, edits);
  };

  const draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const f = fit(tr.width, tr.height, w, h);
    if (show.video) clip.source?.draw(ctx, frame, f.tx, f.ty, f.w, f.h);
    if (show.trails) {
      drawTrail(ctx, tr, J[jn(a.roles.throw, 'Wrist')], frame - Math.round(fps * 0.25), frame, f, col.b);
      drawTrail(ctx, tr, J.nose, frame - Math.round(fps * 0.4), frame, f, '#9be7ff');
    }
    if (show.skeleton) drawSkeleton(ctx, tr, frame, f, { color: col.a, width: 3, showConfidence: true });
    if (show.labels) drawAngleLabels(ctx, tr, a, frame, f, '#fff');
    // ground line + rubber marker
    ctx.strokeStyle = 'rgba(255,200,80,0.6)'; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(f.tx, a.scale.groundY * f.sy + f.ty); ctx.lineTo(f.tx + f.w, a.scale.groundY * f.sy + f.ty); ctx.stroke(); ctx.setLineDash([]);
    const atEvent = EVENT_CODES.find((k) => ev[k] === frame);
    if (atEvent) label(ctx, f.tx + 8, f.ty + f.h - 12, `${atEvent} · ${EVENT_LABELS[atEvent]}`, '#ffd166');
  };

  const onPointer = (kind: 'down' | 'move' | 'up', x: number, y: number, w: number, h: number) => {
    if (!editJoints) return;
    const f = fit(tr.width, tr.height, w, h);
    if (kind === 'down') {
      let best = 18, bj = -1;
      for (let j = 0; j < JOINTS.length; j++) { const [px, py] = pt(tr, j, frame, f); const d = Math.hypot(px - x, py - y); if (d < best) { best = d; bj = j; } }
      drag.current = bj >= 0 ? { j: bj, ox: tr.x[bj][frame], oy: tr.y[bj][frame] } : null;
    } else if (kind === 'move' && drag.current) {
      // move in the cleaned track for instant feedback
      tr.x[drag.current.j][frame] = (x - f.tx) / f.sx; tr.y[drag.current.j][frame] = (y - f.ty) / f.sy;
      setRawEdit((v) => v + 1);
    } else if (kind === 'up' && drag.current) {
      const { j, ox, oy } = drag.current;
      drag.current = null;
      void applyJointEdit(clip, j, frame, (x - f.tx) / f.sx - ox, (y - f.ty) / f.sy - oy);
    }
  };

  const fsT = ev.FS / fps;
  const tRel = useMemo(() => tr.t.map((t) => t - fsT), [tr.t, fsT]);
  const evLines = EVENT_CODES.map((k) => ({ t: ev[k] / fps - fsT, label: k }));

  return (
    <div className="stack">
      {a.warnings.map((w) => <div key={w} className="notice warn small">{w}</div>)}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(280px, 2fr)' }}>
        <div>
          <Stage
            label={`Pitch video frame ${frame} with skeleton overlay`}
            draw={draw}
            deps={[frame, show, clip.source, a, col, rawEdit]}
            aspect={tr.width / tr.height}
            sources={[clip.source]}
            onPointer={onPointer}
            hud={<><span>{(pb.t * 1000).toFixed(0)} ms</span><span>{a.view}</span><span>{Math.round(fps)} fps</span>{editJoints && <span>drag a joint to fix it</span>}</>}
          />
          <Timeline duration={duration} pb={pb} events={EVENT_CODES.map((k) => ({ code: k, t: ev[k] / fps, color: col.a, row: 0, edited: clip.record.edits[k] !== undefined }))} />
          <TransportBar pb={pb} fps={fps} eventTimes={Object.fromEntries(EVENT_CODES.map((k) => [k, ev[k] / fps]))} tour={tour} setTour={setTour} />
          <div className="row small" style={{ marginTop: 6 }}>
            {(['skeleton', 'labels', 'trails', 'video'] as const).map((k) => (
              <label key={k} className="row tight"><input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} /> {k}</label>
            ))}
            <label className="row tight"><input type="checkbox" checked={editJoints} onChange={(e) => setEditJoints(e.target.checked)} disabled={clip.kind === 'demo'} /> fix joints</label>
          </div>
        </div>
        <div className="stack">
          <EventEditor clip={clip} frame={frame} fps={fps} onSet={setEvent} onJump={(f) => { pb.pause(); pb.setT(f / fps); }} />
          <div className="card">
            <div className="row spread">
              <label className="field">Camera view
                <select value={clip.record.view ?? ''} onChange={(e) => setView(clip.id, (e.target.value || undefined) as View | undefined)}>
                  <option value="">Auto ({a.viewAuto})</option>
                  {VIEWS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              <div className="small muted">Throws: <b>{a.roles.throw === 'R' ? 'right' : 'left'}</b> · lead leg: {a.roles.lead === 'L' ? 'left' : 'right'}</div>
            </div>
            <p className="tiny faint" style={{ marginTop: 6 }}>The throwing arm is the one whose wrist moves fastest; the lead leg is the one whose knee lifts highest — so left/right mix-ups in the pose model don't matter.</p>
            <div className="row tight">
              <button className="small" onClick={() => exportClipCsv(clip)}>Export CSV</button>
              <button className="small" onClick={() => exportClipJson(clip)}>Export JSON</button>
              <button className="small" onClick={() => { useStore.getState().setSlot('A', clip.id); go('/report'); }}>Report / PDF</button>
            </div>
          </div>
        </div>
      </div>

      <KeyFrames clip={clip} onPick={(f) => { pb.pause(); pb.setT(f / fps); }} />

      <div className="card">
        <div className="tabs" role="tablist">
          {(['metrics', 'charts', 'sequence'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === 'metrics' ? 'Metrics' : t === 'charts' ? 'Charts' : 'Sequence & speeds'}</button>)}
          <span style={{ flex: 1 }} />
          {tab === 'metrics' && <label className="small row tight"><input type="checkbox" checked={showNA} onChange={(e) => setShowNA(e.target.checked)} /> show metrics this view can't measure</label>}
        </div>
        {tab === 'metrics' && <MetricPanel analysis={a} heightM={clip.record.heightM} showNA={showNA} />}
        {tab === 'charts' && (
          <div className="grid cols-2">
            {['leadKneeFlex', 'trunkTilt', 'forearm', 'elbowFlex', 'handHeight', 'gloveDist'].map((k) => (
              <LineChart key={k} title={SERIES_INFO[k].label} unit={SERIES_INFO[k].unit} series={[{ t: tRel, y: a.series[k], color: col.a, label: clip.record.name }]} events={evLines} cursor={pb.t - fsT} onSeek={(t) => { pb.pause(); pb.setT(t + fsT); }} />
            ))}
            <AngleAngle xLabel="Front knee bend (°)" yLabel="Trunk tilt (°)" sets={[{ x: a.series.leadKneeFlex, y: a.series.trunkTilt, color: col.a, label: clip.record.name, from: ev.FS, to: Math.min(tr.t.length - 1, ev.MIR), mark: ev.BR }]} />
          </div>
        )}
        {tab === 'sequence' && <SequencePanel clip={clip} cursor={pb.t - fsT} tRel={tRel} evLines={evLines} onSeek={(t) => { pb.pause(); pb.setT(t + fsT); }} />}
      </div>
      <Disclaimer />
      <div className="small faint">Re-run with different settings? Change the clip speed or trim and press <button className="small" onClick={async () => { await db.tracks.delete(trackKey(clip.record, clip.record.analyzedWith ?? 'full')); await updateRecord(clip.id, { analyzedWith: undefined }); useStore.setState((s) => ({ clips: { ...s.clips, [clip.id]: { ...s.clips[clip.id], status: 'new', full: undefined, analysis: undefined } } })); }} disabled={clip.kind === 'demo'}>Re-analyse</button></div>
    </div>
  );
}

async function applyJointEdit(clip: RuntimeClip, j: number, frame: number, dx: number, dy: number) {
  const raw = clip.full!.raw;
  // shift the raw track around the frame with a smooth falloff so neighbours follow the correction
  const k = Math.max(2, Math.round(raw.fps * 0.02));
  for (let d = -k * 2; d <= k * 2; d++) {
    const i = frame + d;
    if (i < 0 || i >= raw.t.length) continue;
    const w = Math.exp(-(d * d) / (2 * k * k));
    raw.x[j][i] += dx * w; raw.y[j][i] += dy * w;
    if (d === 0) raw.c[j][i] = 1;
  }
  const next = analyzeTrack(raw, { view: clip.record.view, heightM: clip.record.heightM, editedEvents: clip.record.edits });
  useStore.setState((s) => ({ clips: { ...s.clips, [clip.id]: { ...s.clips[clip.id], full: next, analysis: next.analysis } } }));
  if (clip.kind === 'video' && clip.record.analyzedWith) await db.tracks.put({ id: trackKey(clip.record, clip.record.analyzedWith), track: raw });
}

function EventEditor({ clip, frame, fps, onSet, onJump }: { clip: RuntimeClip; frame: number; fps: number; onSet: (k: EventCode, f?: number) => void; onJump: (f: number) => void }) {
  const a = clip.analysis!;
  const ev = resolvedEvents(a);
  return (
    <div className="card">
      <div className="card-title"><h3>Events</h3><span className="tiny faint">edit → every metric updates</span></div>
      <table className="metrics" style={{ fontSize: '0.85rem' }}>
        <tbody>
          {EVENT_CODES.map((k) => {
            const edited = clip.record.edits[k] !== undefined;
            return (
              <tr key={k}>
                <td><button className="small ghost" onClick={() => onJump(ev[k])} title={EVENT_LABELS[k]}><b>{k}</b></button></td>
                <td className="small">{EVENT_LABELS[k]}</td>
                <td className="mono small">{ev[k]}{edited && <span className="faint"> (auto {a.events.auto[k]})</span>}<div className="faint">{((ev[k] - ev.FS) / fps * 1000).toFixed(0)} ms</div></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="small icon" aria-label={`${k} one frame earlier`} onClick={() => onSet(k, ev[k] - 1)}>−</button>
                  <button className="small icon" aria-label={`${k} one frame later`} onClick={() => onSet(k, ev[k] + 1)}>+</button>
                  <button className="small" onClick={() => onSet(k, frame)} data-testid={`set-${k}`}>here</button>
                  {edited && <button className="small ghost" onClick={() => onSet(k, undefined)}>auto</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function KeyFrames({ clip, onPick }: { clip: RuntimeClip; onPick: (f: number) => void }) {
  const a = clip.analysis!;
  const ev = resolvedEvents(a);
  const col = useCssColors();
  return (
    <div className="keyframes" aria-label="Key frames">
      {(['PKH', 'HS', 'FS', 'MER', 'BR', 'MIR'] as EventCode[]).map((k) => (
        <button key={k} className="keyframe" onClick={() => onPick(ev[k])}>
          <Stage label={`${EVENT_LABELS[k]} key frame`} aspect={16 / 10} deps={[ev[k], clip.source, col]} sources={[clip.source]}
            draw={(ctx, w, h) => { const f = fit(clip.full!.cleaned.width, clip.full!.cleaned.height, w, h); clip.source?.draw(ctx, ev[k], f.tx, f.ty, f.w, f.h); drawSkeleton(ctx, clip.full!.cleaned, ev[k], f, { color: col.a, width: 2, jointRadius: 2 }); }} />
          <span className="cap"><b>{k}</b><span>{EVENT_LABELS[k]}</span></span>
        </button>
      ))}
    </div>
  );
}

/** 2D kinematic-sequence proxies: normalised speed curves with peak order. */
export function SequencePanel({ clip, cursor, tRel, evLines, onSeek, other }: { clip: RuntimeClip; cursor: number; tRel: number[]; evLines: { t: number; label: string }[]; onSeek: (t: number) => void; other?: RuntimeClip }) {
  const a = clip.analysis!;
  const fps = a.fps;
  const ev = resolvedEvents(a);
  const col = useCssColors();
  const curves = useMemo(() => {
    const s = a.series;
    const n = s.hipSpeed.length;
    const trunkVel = new Float32Array(n);
    for (let i = 1; i < n - 1; i++) trunkVel[i] = ((s.trunkTilt[i + 1] - s.trunkTilt[i - 1]) * fps) / 2;
    const from = Math.max(0, ev.PKH), to = Math.min(n - 1, ev.MIR);
    const norm = (x: ArrayLike<number>) => { let m = 1e-9; for (let i = from; i <= to; i++) m = Math.max(m, x[i]); return Float32Array.from(x as ArrayLike<number>, (v, i) => (i < from || i > to ? NaN : v / m)); };
    const peak = (x: ArrayLike<number>) => { let m = -Infinity, k = from; for (let i = from; i <= to; i++) if (x[i] > m) { m = x[i]; k = i; } return k; };
    const list = [
      { key: 'Front knee extension', y: norm(s.kneeExtVel), p: peak(s.kneeExtVel), color: '#7a8a99' },
      { key: 'Hips toward plate', y: norm(s.hipSpeed), p: peak(s.hipSpeed), color: col.a },
      { key: 'Trunk forward bend', y: norm(trunkVel), p: peak(trunkVel), color: '#2b7a52' },
      { key: 'Hand', y: norm(s.handSpeed), p: peak(s.handSpeed), color: col.b },
    ];
    return list;
  }, [a, fps, ev.PKH, ev.MIR, col]);
  const order = [...curves].sort((x, y) => x.p - y.p);
  const fsT = ev.FS / fps;
  void other;
  return (
    <div className="stack">
      <div className="notice info small">These are <b>2D proxies</b> from one camera (forward speed and bending in the camera plane), not true pelvis/trunk rotational velocities — those need a second camera (3D mode). Use them to compare the same pitcher on the same setup.</div>
      <LineChart title="Speed curves, each scaled to its own peak" unit="fraction of peak" series={curves.map((c) => ({ t: tRel, y: c.y, color: c.color, label: c.key }))} events={evLines} cursor={cursor} onSeek={onSeek} height={230} />
      <div className="small"><b>Peak order:</b> {order.map((c, i) => <span key={c.key}>{i > 0 && ' → '}{c.key} <span className="mono faint">({((c.p / fps - fsT) * 1000).toFixed(0)} ms)</span></span>)}</div>
      <p className="small muted">Ideal pattern is ground-up: front-leg block and hips first, then trunk, then arm. Peaks out of order can mean energy leaks — but check that the events are right first.</p>
      <div className="grid cols-2">
        <LineChart title="Hip speed toward plate" unit="ht/s" series={[{ t: tRel, y: a.series.hipSpeed, color: col.a, label: 'hips' }]} events={evLines} cursor={cursor} onSeek={onSeek} />
        <LineChart title="Hand speed (in camera plane)" unit="ht/s" series={[{ t: tRel, y: a.series.handSpeed, color: col.b, label: 'hand' }]} events={evLines} cursor={cursor} onSeek={onSeek} />
      </div>
    </div>
  );
}
