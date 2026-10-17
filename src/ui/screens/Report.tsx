// Printable multi-page report (browser "Save as PDF"): summary, key frames, arm action, lower body, timing,
// comparison, fix plan and drills.

import { useMemo } from 'react';
import { useStore, type RuntimeClip } from '../../state/store';
import { compareAnalyses } from '../../core/compare';
import { METRICS, METRIC_BY_KEY, type Phase } from '../../core/catalog';
import { EVENT_LABELS, resolvedEvents, type EventCode } from '../../core/types';
import { DRILL_BY_ID } from '../../data/drills';
import { Stage } from '../components/Stage';
import { fmtMetric, TierBadge, useCssColors, useUnits } from '../components/common';
import { drawSkeleton, fit } from '../draw';

const PAGES: { title: string; phases: Phase[] }[] = [
  { title: 'Lower body & stride', phases: ['windup', 'stride'] },
  { title: 'Arm action, trunk & release', phases: ['cocking', 'release', 'follow'] },
];

function Frames({ clip }: { clip: RuntimeClip }) {
  const col = useCssColors();
  const ev = resolvedEvents(clip.analysis!);
  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
      {(['PKH', 'FS', 'MER', 'BR', 'MIR', 'HS'] as EventCode[]).slice(0, 6).map((k) => (
        <figure key={k} style={{ margin: 0 }}>
          <Stage label={EVENT_LABELS[k]} aspect={16 / 10} deps={[clip.source, ev[k]]} sources={[clip.source]} draw={(ctx, w, h) => { const tr = clip.full!.cleaned; const f = fit(tr.width, tr.height, w, h); clip.source?.draw(ctx, ev[k], f.tx, f.ty, f.w, f.h); drawSkeleton(ctx, tr, ev[k], f, { color: col.a, width: 2, jointRadius: 2 }); }} />
          <figcaption className="tiny">{k} · {EVENT_LABELS[k]}</figcaption>
        </figure>
      ))}
    </div>
  );
}

export function ReportScreen() {
  const { clips, slotA, slotB, settings } = useStore();
  const units = useUnits();
  const A = slotA ? clips[slotA] : undefined, B = slotB ? clips[slotB] : undefined;
  const cmp = useMemo(() => (A?.analysis && B?.analysis ? compareAnalyses(A.analysis, B.analysis) : null), [A, B]);
  if (!A?.analysis) return <div className="card">Put an analysed clip in slot A (and optionally B) to build a report.</div>;
  const main = B?.analysis ? B : A;
  const heightM = main.record.heightM;
  return (
    <div className="stack" style={{ maxWidth: 960, margin: '0 auto' }}>
      <div className="row no-print"><button className="primary" onClick={() => window.print()}>Print / Save as PDF</button><span className="small muted">Uses your browser's print dialog — choose "Save as PDF". Generated on this device.</span></div>
      <section className="card">
        <div className="section-label">Mound Lab biomechanics report · {new Date().toLocaleDateString()}</div>
        <h1>{main.record.name}</h1>
        <p className="small muted">View: {main.analysis!.view} · {Math.round(main.analysis!.fps)} fps · throws {main.analysis!.roles.throw === 'R' ? 'right' : 'left'}{main.record.pitchType ? ` · ${main.record.pitchType}` : ''}{B?.analysis ? ` · compared with ${A.record.name}` : ''}</p>
        {cmp && <div className="verdict"><h2>{cmp.verdict.headline}</h2><p className="small" style={{ margin: 0 }}>{cmp.verdict.summary}</p></div>}
        <h3 style={{ marginTop: 14 }}>Key frames</h3>
        <Frames clip={main} />
        <p className="tiny faint">Events: PKH peak leg lift · FS foot strike · MER max layback (2D proxy) · BR release · MIR end of deceleration · HS hand separation.</p>
      </section>
      {PAGES.map((pg) => (
        <section key={pg.title} className="card page-break">
          <h2>{pg.title}</h2>
          <table className="metrics">
            <thead><tr><th>Metric</th>{cmp && <th className="text-a">A</th>}<th className={cmp ? 'text-b' : ''}>{cmp ? 'B' : 'Value'}</th><th>Reference</th><th>Confidence</th></tr></thead>
            <tbody>
              {METRICS.filter((d) => pg.phases.includes(d.phase) && main.analysis!.metrics[d.key].tier !== 'na').map((d) => (
                <tr key={d.key}>
                  <td>{d.label}<div className="tiny faint">{d.meaning}</div></td>
                  {cmp && <td className="v text-a">{fmtMetric(d, A.analysis!.metrics[d.key].value, heightM, units)}</td>}
                  <td className="v">{fmtMetric(d, main.analysis!.metrics[d.key].value, heightM, units)}</td>
                  <td className="small">{settings.youth ? '' : d.ref?.text ?? ''}</td>
                  <td><TierBadge tier={main.analysis!.metrics[d.key].tier} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <section className="card page-break">
        <h2>Timing</h2>
        <table className="metrics"><tbody>
          {['tFmPkh', 'tPkhFs', 'tFsMer', 'tFsBr'].map((k) => { const d = METRIC_BY_KEY[k]; return <tr key={k}><td>{d.label}</td><td className="v">{fmtMetric(d, main.analysis!.metrics[k].value)}</td><td><TierBadge tier={main.analysis!.metrics[k].tier} /></td></tr>; })}
        </tbody></table>
        <p className="small muted">True pelvis/trunk rotational velocities and kinematic sequence need two cameras; single-camera speed proxies are on the clip screen.</p>
      </section>
      {cmp && (
        <section className="card page-break">
          <h2>What changed &amp; fix plan</h2>
          {cmp.findings.slice(0, settings.youth ? 3 : 8).map((f, i) => (
            <div key={f.key} style={{ marginBottom: 10 }}>
              <h3 style={{ marginBottom: 2 }}>{i + 1}. {f.def.label} {f.isRoot ? '(likely root cause)' : '(likely symptom)'}</h3>
              <div className="small">{fmtMetric(f.def, f.diff.a, heightM, units)} → {fmtMetric(f.def, f.diff.b, heightM, units)} — {f.what}</div>
              <div className="small muted">{f.cause}</div>
              {f.cue && <div className="small"><b>Cue:</b> “{f.cue}”</div>}
              {f.drills.length > 0 && <div className="small"><b>Drills:</b> {f.drills.map((id) => `${DRILL_BY_ID[id]?.name} (${DRILL_BY_ID[id]?.dose})`).join('; ')}</div>}
            </div>
          ))}
          {cmp.consistent.length > 0 && <p className="small"><b>Stayed consistent:</b> {cmp.consistent.map((d) => METRIC_BY_KEY[d.key].short).join(', ')}.</p>}
          {cmp.setup.warnings.map((w) => <p key={w} className="small">⚠︎ {w}</p>)}
        </section>
      )}
      <p className="tiny faint">Mound Lab gives 2D video estimates for training and education. It is not a medical device and does not diagnose injuries. Workload (pitch counts, rest, fatigue) matters more than mechanics for arm health; pain means stop and see a qualified professional.</p>
    </div>
  );
}
