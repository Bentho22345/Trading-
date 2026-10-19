import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { clipVelo, useStore, type RuntimeClip } from '../../state/store';
import { exportKeyframeSheet } from '../images';
import { compareAnalyses, compareGroups, fmtDelta, pooledVariability, type Comparison, type Finding } from '../../core/compare';
import { CAUSES, METRICS, METRIC_BY_KEY, PHASE_LABELS, type Phase } from '../../core/catalog';
import { makeSync, type SyncMode } from '../../core/sync';
import { EVENT_CODES, EVENT_LABELS, JOINTS, resolvedEvents, type Analysis, type EventCode } from '../../core/types';
import { SERIES_INFO } from '../../core/metrics';
import { Stage } from '../components/Stage';
import { EventButtons, Timeline, TransportBar, type TimelineEvent } from '../components/Timeline';
import { usePlayback, useKeys } from '../components/playback';
import { LineChart, AngleAngle } from '../components/Chart';
import { ClipThumb, Disclaimer, fmtMetric, StatusPill, TierBadge, useCssColors, useUnits } from '../components/common';
import { arrow, compose, drawSkeleton, isSmallPitcher, label, normalizeBtoA, pitcherView, pt, type Affine } from '../draw';
import { DRILL_BY_ID } from '../../data/drills';
import { go } from '../router';
import { exportComparisonCsv, recordComposite } from '../export';

const AICoach = lazy(() => import('../components/AICoach').then((m) => ({ default: m.AICoach })));

const PHASE_EVENT: Record<Phase, EventCode> = { windup: 'PKH', stride: 'FS', cocking: 'MER', release: 'BR', follow: 'MIR' };

type Layout = 'side' | 'overlay';
type OverlayMode = 'skel-video' | 'video-video' | 'skel-only';

export function CompareScreen() {
  const { clips, order, slotA, slotB, setSlot, analyze } = useStore();
  const A = slotA ? clips[slotA] : undefined, B = slotB ? clips[slotB] : undefined;
  const [group, setGroup] = useState(false);
  const options = order.map((id) => clips[id]).filter(Boolean);

  return (
    <div className="stack">
      <div className="card">
        <div className="row spread">
          <h1 style={{ margin: 0 }}>Compare</h1>
          <Presets />
        </div>
        <div className="grid cols-2" style={{ marginTop: 10 }}>
          {(['A', 'B'] as const).map((s) => {
            const c = s === 'A' ? A : B;
            return (
              <div key={s} className={`slot ${s.toLowerCase()}`} data-drop={s}>
                <span className={s === 'A' ? 'chip-a' : 'chip-b'}>{s}</span>
                {c && <ClipThumb clip={c} />}
                <div style={{ flex: 1, minWidth: 0 }} className="stack">
                  <select aria-label={`Clip in slot ${s}`} value={c?.id ?? ''} onChange={(e) => setSlot(s, e.target.value || undefined)} style={{ width: '100%' }}>
                    <option value="">— choose a clip —</option>
                    {options.map((o) => <option key={o.id} value={o.id}>{o.record.name}{o.record.pitchType ? ` (${o.record.pitchType})` : ''}</option>)}
                  </select>
                  {c && c.status !== 'ready' && (
                    c.status === 'analyzing' ? <div className="small muted">Analysing… {c.progress?.total ? `${c.progress.done}/${c.progress.total}` : ''}</div>
                      : <button className="small accent" onClick={() => analyze(c.id)}>Analyse {s}</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="row small" style={{ marginTop: 8 }}>
          <label className="row tight"><input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} /> Group compare: average every analysed pitch in A's session vs B's session</label>
        </div>
      </div>
      {A?.status === 'ready' && B?.status === 'ready' && A.analysis && B.analysis
        ? <CompareView A={A} B={B} group={group} />
        : <div className="card muted">Choose two clips and analyse them. Tip: drop two videos anywhere on the page — they go straight into A and B.</div>}
    </div>
  );
}

function Presets() {
  const { clips, order, slotA, slotB, setSlot } = useStore();
  const list = order.map((id) => clips[id]).filter(Boolean);
  const cur = slotB ? clips[slotB] : slotA ? clips[slotA] : undefined;
  const ath = cur?.record.athleteId;
  const best = list.find((c) => c.record.starred && (!ath || c.record.athleteId === ath));
  const byDate = list.filter((c) => !ath || c.record.athleteId === ath).sort((a, b) => b.record.createdAt - a.record.createdAt);
  const latest = byDate[0];
  const prevSession = byDate.find((c) => c.record.sessionId && c.record.sessionId !== latest?.record.sessionId);
  const fb = byDate.find((c) => c.record.pitchType === 'FB'), ch = byDate.find((c) => c.record.pitchType === 'CH');
  const ref = clips['demo-good'];
  return (
    <div className="row tight">
      <button className="small" disabled={!best || !cur} onClick={() => { setSlot('A', best!.id); setSlot('B', cur!.id); }} title="A = your starred best pitch, B = this pitch">vs my best pitch</button>
      <button className="small" disabled={!latest || !prevSession} onClick={() => { setSlot('A', prevSession!.id); setSlot('B', latest!.id); }}>Today vs last session</button>
      <button className="small" disabled={!fb || !ch} onClick={() => { setSlot('A', fb!.id); setSlot('B', ch!.id); }} title="Do your fastball and changeup look the same? (tipping check)">FB vs CH</button>
      <button className="small" disabled={!ref || !slotB} onClick={() => { setSlot('A', 'demo-good'); }} title="Different athlete: differences include body type and style">vs reference delivery</button>
      {slotA && slotB && <button className="small ghost" onClick={() => useStore.getState().swapSlots()}>Swap</button>}
    </div>
  );
}

function sessionGroup(clips: Record<string, RuntimeClip>, c: RuntimeClip): Analysis[] {
  if (!c.record.sessionId) return [c.analysis!];
  return Object.values(clips).filter((x) => x.record.sessionId === c.record.sessionId && x.analysis && (x.record.pitchType ?? 'FB') === (c.record.pitchType ?? 'FB')).map((x) => x.analysis!);
}

function CompareView({ A, B, group }: { A: RuntimeClip; B: RuntimeClip; group: boolean }) {
  const clips = useStore((s) => s.clips);
  const youth = useStore((s) => s.settings.youth);
  const a = A.analysis!, b = B.analysis!;
  const differentAthlete = !!(A.record.athleteId && B.record.athleteId && A.record.athleteId !== B.record.athleteId) || (A.kind === 'demo') !== (B.kind === 'demo');

  const cmp: Comparison & { groupSizes?: [number, number] } = useMemo(() => {
    const va = clipVelo(A), vb = clipVelo(B);
    const velo = va && vb ? { a: va.mph, b: vb.mph, source: va.source === vb.source ? va.source : `${va.source} / ${vb.source}` } : undefined;
    const opt = { differentAthlete, pitchTypes: [A.record.pitchType, B.record.pitchType] as [string | undefined, string | undefined], velo };
    const ga = sessionGroup(clips, A), gb = sessionGroup(clips, B);
    if (group && ga.length >= 2 && gb.length >= 2) return { ...compareGroups(ga, gb, opt), groupSizes: [ga.length, gb.length] };
    // athlete's own noise: pool every multi-pitch session of this athlete
    const ath = A.record.athleteId === B.record.athleteId ? A.record.athleteId : undefined;
    let variability: Record<string, number> | undefined;
    if (ath) {
      const bySession = new Map<string, Analysis[]>();
      for (const c of Object.values(clips)) if (c.record.athleteId === ath && c.record.sessionId && c.analysis) bySession.set(c.record.sessionId, [...(bySession.get(c.record.sessionId) ?? []), c.analysis]);
      variability = pooledVariability([...bySession.values()]);
    }
    return compareAnalyses(a, b, { ...opt, variability });
  }, [a, b, group, clips, A, B, differentAthlete, A.velo, B.velo]); // eslint-disable-line react-hooks/exhaustive-deps

  const [layout, setLayout] = useState<Layout>('side');
  const [ovMode, setOvMode] = useState<OverlayMode>('skel-video');
  const [opacity, setOpacity] = useState(0.5);
  const [sync, setSync] = useState<SyncMode>('phase');
  const [syncEvent, setSyncEvent] = useState<EventCode>('FS');
  const [tour, setTour] = useState(false);
  const [arrows, setArrows] = useState(true);
  const col = useCssColors();
  const units = useUnits();
  const top = useRef<HTMLDivElement>(null);

  const evA = resolvedEvents(a), evB = resolvedEvents(b);
  const trA = A.full!.cleaned, trB = B.full!.cleaned;
  const durA = (trA.t.length - 1) / a.fps;
  const map = useMemo(() => makeSync(sync, { n: trA.t.length, fps: a.fps, events: evA }, { n: trB.t.length, fps: b.fps, events: evB }, { event: syncEvent, bodyA: A.full!.body, bodyB: B.full!.body }), [sync, syncEvent, a, b, A.full, B.full, trA.t.length, trB.t.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const inv = useMemo(() => (tb: number) => { let lo = -5, hi = durA + 5; for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (map(m) < tb) lo = m; else hi = m; } return (lo + hi) / 2; }, [map, durA]);
  const pb = usePlayback(durA, a.fps, { pauseAt: tour ? EVENT_CODES.map((k) => evA[k] / a.fps) : undefined });
  const fA = Math.round(pb.t * a.fps);
  const tB = map(pb.t);
  const fB = Math.max(0, Math.min(trB.t.length - 1, Math.round(tB * b.fps)));

  useEffect(() => { pb.setT(evA.PKH / a.fps); }, [A.id, B.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const prevNext = (dir: 1 | -1) => {
    const ts = EVENT_CODES.map((k) => evA[k] / a.fps).sort((x, y) => x - y);
    const tt = dir > 0 ? ts.find((x) => x > pb.t + 1e-6) : [...ts].reverse().find((x) => x < pb.t - 1e-6);
    if (tt !== undefined) { pb.pause(); pb.setT(tt); }
  };
  useKeys({
    Space: () => pb.toggle(), ArrowLeft: () => pb.step(-1), ArrowRight: () => pb.step(1), '[': () => prevNext(-1), ']': () => prevNext(1),
    o: () => setLayout((l) => (l === 'side' ? 'overlay' : 'side')), O: () => setLayout((l) => (l === 'side' ? 'overlay' : 'side')),
    s: () => setSync((m) => (m === 'phase' ? 'event' : m === 'event' ? 'dtw' : 'phase')), S: () => setSync((m) => (m === 'phase' ? 'event' : m === 'event' ? 'dtw' : 'phase')),
    ...Object.fromEntries(EVENT_CODES.map((k, i) => [String(i + 1), () => { pb.pause(); pb.setT(evA[k] / a.fps); }])),
  });

  const BtoA = normalizeBtoA(a, b);
  const diffJoints = () => {
    // per-joint distance (body heights) between A and normalised B at the current synced frame
    const out: { j: number; d: number }[] = [];
    for (let j = 0; j < JOINTS.length; j++) {
      const [ax, ay] = pt(trA, j, fA, { sx: 1, sy: 1, tx: 0, ty: 0 });
      const [bx, by] = pt(trB, j, fB, BtoA);
      out.push({ j, d: Math.hypot(ax - bx, ay - by) / a.scale.heightPx });
    }
    return out.sort((x, y) => y.d - x.d);
  };

  const drawPane = (ctx: CanvasRenderingContext2D, w: number, h: number, which: 'A' | 'B') => {
    const clip = which === 'A' ? A : B, tr = which === 'A' ? trA : trB, f = which === 'A' ? fA : fB;
    const an = which === 'A' ? a : b, evx = which === 'A' ? evA : evB;
    const T = pitcherView(tr, evx.FM, evx.END, w, h, isSmallPitcher(an.scale.heightPx, tr.height));
    clip.source?.draw(ctx, f, T.tx, T.ty, T.w, T.h);
    drawSkeleton(ctx, tr, f, T, { color: which === 'A' ? col.a : col.b, width: 3 });
    const ev = which === 'A' ? evA : evB;
    const at = EVENT_CODES.find((k) => ev[k] === f);
    label(ctx, T.tx + 6, T.ty + 18, `${which} · ${((f - ev.FS) / (which === 'A' ? a.fps : b.fps) * 1000).toFixed(0)} ms from FS${at ? ` · ${at}` : ''}`, which === 'A' ? col.a : col.b);
  };

  const drawOverlay = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const T = pitcherView(trA, evA.FM, evA.END, w, h, isSmallPitcher(a.scale.heightPx, trA.height));
    const TB: Affine = compose(T, BtoA);
    if (ovMode !== 'skel-only') A.source?.draw(ctx, fA, T.tx, T.ty, T.w, T.h);
    else { ctx.fillStyle = '#15181d'; ctx.fillRect(T.tx, T.ty, T.w, T.h); }
    if (ovMode === 'video-video' && B.source) {
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.beginPath(); ctx.rect(T.tx, T.ty, T.w, T.h); ctx.clip();
      ctx.translate(TB.tx, TB.ty); ctx.scale(TB.sx, TB.sy);
      B.source.draw(ctx, fB, 0, 0, trB.width, trB.height);
      ctx.restore();
    }
    drawSkeleton(ctx, trA, fA, T, { color: col.a, width: 3 });
    drawSkeleton(ctx, trB, fB, TB, { color: col.b, width: 3, alpha: 0.95 });
    if (arrows) {
      const top3 = diffJoints().filter((d) => d.d > 0.035).slice(0, 4);
      for (const { j, d } of top3) {
        const [ax, ay] = pt(trA, j, fA, T), [bx, by] = pt(trB, j, fB, TB);
        arrow(ctx, ax, ay, bx, by, d > 0.08 ? col.accent : '#ffd166');
      }
    }
    label(ctx, T.tx + 6, T.ty + 18, `A blue · B amber (scaled to A's height, aligned at the rubber and ground)`, '#fff');
  };

  const eventsTimeline: TimelineEvent[] = [
    ...EVENT_CODES.map((k) => ({ code: k, t: evA[k] / a.fps, color: col.a, row: 0 as const })),
    ...EVENT_CODES.map((k) => ({ code: k, t: inv(evB[k] / b.fps), color: col.b, row: 1 as const })),
  ];

  const readouts: [string, string, string][] = [['leadKneeFlex', 'Front knee', '°'], ['trunkTilt', 'Trunk tilt', '°'], ['elbowFlex', 'Elbow', '°'], ['forearm', 'Forearm', '°'], ['handSpeed', 'Hand speed', 'ht/s']];
  const showMe = (f: Finding) => { pb.pause(); pb.setT(evA[PHASE_EVENT[f.def.phase]] / a.fps); top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  const canvasRef = useRef<HTMLDivElement>(null);

  return (
    <div className="stack">
      <div ref={top} />
      <div className="card">
        <div className="row spread" style={{ marginBottom: 8 }}>
          <div className="row tight">
            <div className="seg" role="group" aria-label="Layout">
              <button aria-pressed={layout === 'side'} onClick={() => setLayout('side')}>Side by side</button>
              <button aria-pressed={layout === 'overlay'} onClick={() => setLayout('overlay')} data-testid="overlay-btn">Overlay</button>
            </div>
            {layout === 'overlay' && (
              <div className="seg" role="group" aria-label="Overlay mode">
                <button aria-pressed={ovMode === 'skel-video'} onClick={() => setOvMode('skel-video')}>Skeletons on video</button>
                <button aria-pressed={ovMode === 'video-video'} onClick={() => setOvMode('video-video')}>Video on video</button>
                <button aria-pressed={ovMode === 'skel-only'} onClick={() => setOvMode('skel-only')}>Skeletons only</button>
              </div>
            )}
            {layout === 'overlay' && ovMode === 'video-video' && <label className="small row tight">B opacity <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></label>}
            {layout === 'overlay' && <label className="small row tight"><input type="checkbox" checked={arrows} onChange={(e) => setArrows(e.target.checked)} /> difference arrows</label>}
          </div>
          <div className="row tight">
            <span className="section-label">Sync</span>
            <div className="seg" role="group" aria-label="Sync mode">
              <button aria-pressed={sync === 'phase'} onClick={() => setSync('phase')} title="Both pitches hit every event at the same moment">By phase</button>
              <button aria-pressed={sync === 'event'} onClick={() => setSync('event')} title="Real time, lined up at one event — shows tempo differences honestly">Real time</button>
              <button aria-pressed={sync === 'dtw'} onClick={() => setSync('dtw')} title="Dynamic time warping on body positions — smoothest pose match">Pose match</button>
            </div>
            {sync === 'event' && <select aria-label="Align at event" value={syncEvent} onChange={(e) => setSyncEvent(e.target.value as EventCode)}>{EVENT_CODES.map((k) => <option key={k} value={k}>at {EVENT_LABELS[k]}</option>)}</select>}
          </div>
        </div>
        <div ref={canvasRef}>
          {layout === 'side' ? (
            <div className="grid cols-2" style={{ gap: 8 }}>
              <Stage label="Clip A" aspect={trA.width / trA.height} draw={(c, w, h) => drawPane(c, w, h, 'A')} deps={[fA, A.source, col]} sources={[A.source]} />
              <Stage label="Clip B" aspect={trB.width / trB.height} draw={(c, w, h) => drawPane(c, w, h, 'B')} deps={[fB, B.source, col]} sources={[B.source]} />
            </div>
          ) : (
            <div className="stage-limit" style={{ ['--ar' as string]: trA.width / trA.height }}>
              <Stage label="A and B overlaid" aspect={trA.width / trA.height} draw={drawOverlay} deps={[fA, fB, ovMode, opacity, arrows, A.source, B.source, col]} sources={[A.source, B.source]} />
            </div>
          )}
        </div>
        <div className="sticky-bottom">
          <Timeline duration={durA} pb={pb} events={eventsTimeline} />
          <TransportBar split pb={pb} fps={a.fps} eventTimes={Object.fromEntries(EVENT_CODES.map((k) => [k, evA[k] / a.fps]))} tour={tour} setTour={setTour} />
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <EventButtons pb={pb} eventTimes={Object.fromEntries(EVENT_CODES.map((k) => [k, evA[k] / a.fps]))} />
          <button className="small" onClick={() => recordComposite(canvasRef.current, pb, durA)} title="Record the synced playback as a video file">Export video</button>
        </div>
        <div className="table-scroll">
          <table className="metrics" style={{ marginTop: 8 }}>
            <thead><tr><th>Live readout</th><th className="text-a">A</th><th className="text-b">B</th><th>B − A</th></tr></thead>
            <tbody>
              {readouts.map(([k, l, u]) => {
                const va = a.series[k]?.[fA], vb = b.series[k]?.[fB];
                return <tr key={k}><td>{l}</td><td className="v text-a">{va?.toFixed(k === 'handSpeed' ? 1 : 0)}{u === '°' ? '°' : ''}</td><td className="v text-b">{vb?.toFixed(k === 'handSpeed' ? 1 : 0)}{u === '°' ? '°' : ''}</td><td className="v">{va !== undefined && vb !== undefined ? `${vb - va > 0 ? '+' : ''}${(vb - va).toFixed(k === 'handSpeed' ? 1 : 0)}` : ''}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Report cmp={cmp} A={A} B={B} onShow={showMe} youth={youth} units={units} />

      <ChartsAB A={A} B={B} cursor={pb.t - evA.FS / a.fps} onSeek={(t) => { pb.pause(); pb.setT(t + evA.FS / a.fps); }} />
      <Suspense fallback={<div className="card muted small">Loading AI coach…</div>}><AICoach A={A} B={B} cmp={cmp} /></Suspense>
      <div className="row"><button onClick={() => go('/report')}>Open printable report (PDF)</button><button onClick={() => exportComparisonCsv(A, B, cmp)}>Export comparison CSV</button><button onClick={() => exportKeyframeSheet(A, B, cmp.scorecard.headline + ' ' + cmp.scorecard.detail)}>Key-frame sheet (PNG)</button></div>
      <Disclaimer />
    </div>
  );
}

function Report({ cmp, A, B, onShow, youth, units }: { cmp: Comparison & { groupSizes?: [number, number] }; A: RuntimeClip; B: RuntimeClip; onShow: (f: Finding) => void; youth: boolean; units: 'imperial' | 'metric' }) {
  const roots = cmp.findings.filter((f) => f.isRoot);
  const symptoms = cmp.findings.filter((f) => !f.isRoot);
  const heightM = A.record.heightM ?? B.record.heightM;
  const shown = youth ? cmp.findings.slice(0, 3) : cmp.findings;
  const anyStress = cmp.flags.some((f) => f.stress) || cmp.findings.some((f) => f.stress);
  return (
    <div className="stack">
      <div className="verdict" data-testid="verdict">
        <div className="section-label">{cmp.groupSizes ? `Session average: ${cmp.groupSizes[0]} pitches vs ${cmp.groupSizes[1]} pitches` : 'Verdict'}</div>
        <h2>{cmp.verdict.headline}</h2>
        <p className="muted" style={{ marginBottom: 0 }}>{cmp.verdict.summary}</p>
        <p className="tiny faint" style={{ margin: '6px 0 0' }}>“Changed” means bigger than {cmp.thresholdSource === 'athlete' ? "this athlete's own pitch-to-pitch variation (2 × SD from repeat pitches)" : 'default thresholds for normal pitch-to-pitch variation (film 3+ pitches per session to personalise)'}.</p>
      </div>
      <ScorecardCard cmp={cmp} onShow={onShow} />
      {cmp.setup.warnings.map((w) => <div key={w} className="notice warn small">⚠︎ {w}</div>)}
      {cmp.flags.filter((f) => f.clip === 'B').map((f) => <div key={f.key} className="notice bad small">⚑ <span><b>B:</b> {f.text}{f.stress ? ' This pattern is associated with higher elbow/shoulder stress in research — it is not a diagnosis.' : ''}</span></div>)}
      {anyStress && <div className="notice info small">Workload matters more than mechanics for arm health: track pitch counts and rest on the <a href="#/workload">Workload</a> page. Pain → stop and see a qualified professional.</div>}

      <section>
        <h2>What changed {youth && <span className="small muted">(top 3)</span>}</h2>
        {!cmp.findings.length && <div className="notice ok">Nothing changed beyond normal variation.</div>}
        <div className="stack">
          {shown.slice(0, 5).map((f, i) => <FindingCard key={f.key} f={f} rank={i + 1} heightM={heightM} units={units} onShow={() => onShow(f)} youth={youth} />)}
          {shown.length > 5 && (
            <details>
              <summary>{shown.length - 5} more change{shown.length - 5 > 1 ? 's' : ''} (mostly knock-on effects)</summary>
              <div className="stack" style={{ marginTop: 10 }}>
                {shown.slice(5).map((f, i) => <FindingCard key={f.key} f={f} rank={i + 6} heightM={heightM} units={units} onShow={() => onShow(f)} youth={youth} />)}
              </div>
            </details>
          )}
        </div>
      </section>

      {(roots.length > 0 && symptoms.length > 0) && <CausalChain cmp={cmp} />}

      <section className="card">
        <h3>What stayed consistent</h3>
        <p className="small muted">These didn't move beyond normal variation — that's good news, keep them.</p>
        <div className="row tight">{cmp.consistent.map((d) => <span key={d.key} className="pill steady" title={METRIC_BY_KEY[d.key].definition}>{METRIC_BY_KEY[d.key].short}</span>)}</div>
      </section>

      <BallDeltas A={A} B={B} />

      <section className="card">
        <h3>All metrics</h3>
        <div className="table-scroll">
          <table className="metrics" data-testid="metrics-table">
            <thead><tr><th>Metric</th><th className="text-a">A</th><th className="text-b">B</th><th>Change</th><th>Status</th><th>Confidence</th></tr></thead>
            <tbody>
              {(Object.keys(PHASE_LABELS) as Phase[]).map((ph) => {
                const rows = METRICS.filter((d) => d.phase === ph).map((d) => ({ d, diff: cmp.diffs.find((x) => x.key === d.key)! }));
                const visible = rows.filter((r) => r.diff.status !== 'na');
                if (!visible.length) return null;
                return [
                  <tr key={ph} className="group"><td colSpan={6}>{PHASE_LABELS[ph]}</td></tr>,
                  ...visible.map(({ d, diff }) => (
                    <tr key={d.key}>
                      <td title={d.definition}>{d.label}{diff.greyReason && <div className="tiny faint">{diff.greyReason}</div>}</td>
                      <td className="v text-a">{fmtMetric(d, diff.a, heightM, units)}{diff.aSpread !== undefined && <span className="tiny faint"> ±{diff.aSpread.toFixed(d.digits)}</span>}</td>
                      <td className="v text-b">{fmtMetric(d, diff.b, heightM, units)}{diff.bSpread !== undefined && <span className="tiny faint"> ±{diff.bSpread.toFixed(d.digits)}</span>}</td>
                      <td className="v">{fmtDelta(d, diff)}</td>
                      <td><StatusPill status={diff.status} /></td>
                      <td><TierBadge tier={diff.tier} /></td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>
        <details style={{ marginTop: 8 }}>
          <summary>Not measurable from these views ({cmp.diffs.filter((d) => d.status === 'na').length})</summary>
          <p className="small muted">{cmp.diffs.filter((d) => d.status === 'na').map((d) => METRIC_BY_KEY[d.key].label).join(' · ')}. Add a front view (from behind home plate) for arm slot, side bend and stride direction.</p>
        </details>
      </section>
    </div>
  );
}

function ScorecardCard({ cmp, onShow }: { cmp: Comparison; onShow: (f: Finding) => void }) {
  const sc = cmp.scorecard;
  if (sc.winner === 'none') return null;
  const col = (title: string, list: Finding[], tone: 'ok' | 'bad' | 'na', empty: string) => (
    <div className={`card flat`} style={{ borderTop: `4px solid ${tone === 'ok' ? 'var(--ok)' : tone === 'bad' ? 'var(--accent)' : 'var(--line-strong)'}` }}>
      <h4 style={{ marginBottom: 6 }}>{title} <span className="faint">({list.length})</span></h4>
      {!list.length && <p className="small muted" style={{ margin: 0 }}>{empty}</p>}
      <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
        {list.slice(0, 5).map((f) => (
          <li key={f.key} style={{ marginBottom: 4 }}>
            <button className="ghost small" style={{ padding: 0, minHeight: 0, textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--font-body)', fontWeight: 600 }} onClick={() => onShow(f)}>{f.def.label}</button>{' '}
            <span className="muted">{fmtDelta(f.def, f.diff)}</span>
            <div className="tiny faint">{f.judgmentWhy}</div>
          </li>
        ))}
      </ul>
      {list.length > 5 && (
        <details className="small" style={{ marginTop: 4 }}>
          <summary>{list.length - 5} more</summary>
          <ul style={{ paddingLeft: 18, margin: '4px 0 0' }}>{list.slice(5).map((f) => <li key={f.key}>{f.def.label} <span className="muted">{fmtDelta(f.def, f.diff)}</span></li>)}</ul>
        </details>
      )}
    </div>
  );
  return (
    <section className="card" data-testid="scorecard">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>{sc.headline}</h2>
        {sc.winner !== 'tie' && <span className={sc.winner === 'A' ? 'chip-a' : 'chip-b'} style={{ width: 34, height: 34, fontSize: '1.3rem' }}>{sc.winner}</span>}
      </div>
      <p className="muted" style={{ marginTop: 4 }}>{sc.detail}</p>
      {sc.velo && (
        <div className="row" style={{ gap: 18, margin: '6px 0 12px' }}>
          <span className="num" style={{ fontSize: '1.6rem' }}><span className="text-a">{sc.velo.a.toFixed(0)}</span> <span className="faint">→</span> <span className="text-b">{sc.velo.b.toFixed(0)}</span> <span className="small faint">mph</span></span>
          <span className={`pill ${Math.abs(sc.velo.delta) >= 1.5 ? (sc.velo.delta > 0 ? 'steady' : 'big') : 'na'}`}>{sc.velo.delta >= 0 ? '+' : ''}{sc.velo.delta.toFixed(1)} mph</span>
          <span className="tiny faint">{sc.velo.source}</span>
        </div>
      )}
      <div className="grid cols-3">
        {col('B is worse', sc.worse, 'bad', 'Nothing got worse.')}
        {col('B is better', sc.better, 'ok', 'Nothing got better.')}
        {col('Just different (style)', sc.neutral, 'na', 'No style-only changes.')}
      </div>
      <p className="tiny faint" style={{ marginBottom: 0 }}>"Better" means closer to what research links to velocity, efficiency or lower arm stress — not a guarantee for every pitcher. Changes smaller than normal pitch-to-pitch variation aren't counted.</p>
    </section>
  );
}

function FindingCard({ f, rank, heightM, units, onShow, youth }: { f: Finding; rank: number; heightM?: number; units: 'imperial' | 'metric'; onShow: () => void; youth: boolean }) {
  const d = f.diff;
  return (
    <article className={`finding ${d.status}`} data-testid="finding">
      <div className="row spread">
        <div className="row tight">
          <span className="num" style={{ fontSize: '1.4rem', color: 'var(--text-3)' }}>#{rank}</span>
          <h3 style={{ margin: 0 }}>{f.def.label}</h3>
          <span className={`pill ${f.isRoot ? 'root' : 'symptom'}`}>{f.isRoot ? 'Likely root cause' : 'Likely symptom'}</span>
          <StatusPill status={d.status === 'na' ? 'na' : d.status} />
          <TierBadge tier={d.tier} />
        </div>
        <button className="small" onClick={onShow}>Show me ▸</button>
      </div>
      {!youth && (
        <div className="ab">
          <span className="text-a">{fmtMetric(f.def, d.a, heightM, units)}</span>
          <span className="faint">→</span>
          <span className="text-b">{fmtMetric(f.def, d.b, heightM, units)}</span>
          <span className="small muted" style={{ fontFamily: 'var(--font-body)', fontWeight: 400 }}>{fmtDelta(f.def, d)} · {d.ratio.toFixed(1)}× normal variation</span>
        </div>
      )}
      <div className={`bar ${d.status}`} aria-hidden><i style={{ width: `${Math.min(100, (d.ratio / 4) * 100)}%` }} /></div>
      <dl>
        <dt>What changed</dt><dd>{f.what}</dd>
        <dt>Why it matters</dt><dd>{f.why}</dd>
        <dt>Probable cause</dt><dd>{f.cause}</dd>
        {f.cue && <><dt>Cue</dt><dd><b>“{f.cue}”</b></dd></>}
        {f.drills.length > 0 && <><dt>Drills</dt><dd>{f.drills.map((id, i) => <span key={id}>{i > 0 && ' · '}<a href={`#/drills/${id}`}>{DRILL_BY_ID[id]?.name ?? id}</a></span>)}</dd></>}
        {f.stress && <><dt>Note</dt><dd className="small">Associated with higher arm stress in research. Not a diagnosis.</dd></>}
        <dt>How sure</dt><dd className="small muted">{d.tier === 'high' ? 'Measured well from this view.' : d.tier === 'medium' ? 'Measurable from this view, with some error — confirm with another clip.' : 'Rough estimate from this view — film from the recommended view to confirm.'} {f.def.views.F && !f.def.views.S ? '' : !f.def.views.F ? '' : 'A front view would confirm this.'}</dd>
      </dl>
    </article>
  );
}

function CausalChain({ cmp }: { cmp: Comparison }) {
  const roots = cmp.findings.filter((f) => f.isRoot && f.effects.length);
  if (!roots.length) return null;
  const rowH = 34;
  const effects = [...new Set(roots.flatMap((r) => r.effects))];
  const h = Math.max(roots.length, effects.length) * rowH + 20;
  const yR = (i: number) => 20 + i * rowH + (h - 20 - roots.length * rowH) / 2;
  const yE = (i: number) => 20 + i * rowH + (h - 20 - effects.length * rowH) / 2;
  return (
    <section className="card">
      <h3>Causal chain</h3>
      <p className="small muted">How the root changes probably flow through the kinetic chain into the other changes.</p>
      <svg viewBox={`0 0 600 ${h}`} style={{ width: '100%', maxWidth: 760 }} role="img" aria-label="Causal chain diagram">
        {roots.map((r, i) => r.effects.map((e) => {
          const j = effects.indexOf(e);
          return <path key={r.key + e} d={`M 230 ${yR(i)} C 300 ${yR(i)}, 300 ${yE(j)}, 370 ${yE(j)}`} fill="none" stroke="var(--line-strong)" strokeWidth={2} markerEnd="url(#arr)" />;
        }))}
        <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--line-strong)" /></marker></defs>
        {roots.map((r, i) => (
          <g key={r.key}>
            <rect x={4} y={yR(i) - 13} width={226} height={26} rx={5} fill="var(--text)" />
            <text x={14} y={yR(i) + 5} fill="var(--surface)" fontSize="13" fontFamily="var(--font-display)" fontWeight="700">{r.def.short} {r.direction === 'up' ? '▲' : '▼'}</text>
          </g>
        ))}
        {effects.map((e, j) => {
          const f = cmp.findings.find((x) => x.key === e)!;
          return (
            <g key={e}>
              <rect x={372} y={yE(j) - 13} width={224} height={26} rx={5} fill="var(--bg-2)" stroke="var(--line-strong)" />
              <text x={382} y={yE(j) + 5} fill="var(--text)" fontSize="13" fontFamily="var(--font-display)" fontWeight="600">{METRIC_BY_KEY[e].short} {f.direction === 'up' ? '▲' : '▼'}</text>
            </g>
          );
        })}
      </svg>
      <div className="tiny faint">{roots.map((r) => `${r.def.short}: ${CAUSES[r.key]?.why}`).join(' · ')}</div>
    </section>
  );
}

function BallDeltas({ A, B }: { A: RuntimeClip; B: RuntimeClip }) {
  const a = A.record.ballData, b = B.record.ballData;
  if (!a || !b) return null;
  const rows: [keyof typeof a, string, string][] = [['velo', 'Velocity', 'mph'], ['spin', 'Spin', 'rpm'], ['spinEff', 'Spin efficiency', '%'], ['ivb', 'Induced vertical break', 'in'], ['hb', 'Horizontal break', 'in'], ['extension', 'Extension', 'ft'], ['relHeight', 'Release height', 'ft'], ['relSide', 'Release side', 'ft']];
  return (
    <section className="card">
      <h3>Ball flight</h3>
      <table className="metrics"><thead><tr><th>Metric</th><th className="text-a">A</th><th className="text-b">B</th><th>Change</th></tr></thead>
        <tbody>{rows.filter(([k]) => a[k] !== undefined && b[k] !== undefined).map(([k, l, u]) => <tr key={k}><td>{l}</td><td className="v text-a">{a[k]} {u}</td><td className="v text-b">{b[k]} {u}</td><td className="v">{((b[k] as number) - (a[k] as number)).toFixed(1)} {u}</td></tr>)}</tbody>
      </table>
    </section>
  );
}

function ChartsAB({ A, B, cursor, onSeek }: { A: RuntimeClip; B: RuntimeClip; cursor: number; onSeek: (t: number) => void }) {
  const col = useCssColors();
  const a = A.analysis!, b = B.analysis!;
  const evA = resolvedEvents(a), evB = resolvedEvents(b);
  const tA = useMemo(() => A.full!.cleaned.t.map((t) => t - evA.FS / a.fps), [A.full, evA.FS, a.fps]);
  const tB = useMemo(() => B.full!.cleaned.t.map((t) => t - evB.FS / b.fps), [B.full, evB.FS, b.fps]);
  const lines = EVENT_CODES.map((k) => ({ t: evA[k] / a.fps - evA.FS / a.fps, label: k }));
  return (
    <section className="card">
      <h3>A vs B over time <span className="small muted">(aligned at foot strike, real time)</span></h3>
      <div className="grid cols-2">
        {['leadKneeFlex', 'trunkTilt', 'forearm', 'handSpeed', 'hipSpeed', 'gloveDist'].map((k) => (
          <LineChart key={k} title={SERIES_INFO[k].label} unit={SERIES_INFO[k].unit} cursor={cursor} onSeek={onSeek} events={lines}
            series={[{ t: tA, y: a.series[k], color: col.a, label: 'A' }, { t: tB, y: b.series[k], color: col.b, label: 'B', dashed: true }]} />
        ))}
        <AngleAngle xLabel="Front knee bend (°)" yLabel="Trunk tilt (°)" sets={[
          { x: a.series.leadKneeFlex, y: a.series.trunkTilt, color: col.a, label: 'A', from: evA.FS, to: evA.MIR, mark: evA.BR },
          { x: b.series.leadKneeFlex, y: b.series.trunkTilt, color: col.b, label: 'B', from: evB.FS, to: evB.MIR, mark: evB.BR },
        ]} />
      </div>
      <p className="tiny faint">Hip speed is the centre-of-mass proxy (hip centre, toward the plate). Speeds are in body heights per second, measured in the camera plane — compare only clips filmed the same way.</p>
    </section>
  );
}
