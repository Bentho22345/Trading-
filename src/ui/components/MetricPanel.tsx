import { METRICS, PHASE_LABELS, type MetricDef, type Phase } from '../../core/catalog';
import type { Analysis } from '../../core/types';
import { fmtMetric, TierBadge, useUnits } from './common';
import { useStore } from '../../state/store';

const PHASES: Phase[] = ['windup', 'stride', 'cocking', 'release', 'follow'];

function isFlagged(def: MetricDef, v: number | null) {
  if (!def.flag || v === null) return false;
  return (def.flag.above !== undefined && v > def.flag.above) || (def.flag.below !== undefined && v < def.flag.below);
}

export function MetricPanel({ analysis, heightM, showNA }: { analysis: Analysis; heightM?: number; showNA: boolean }) {
  const units = useUnits();
  const youth = useStore((s) => s.settings.youth);
  return (
    <div className="stack">
      {PHASES.map((ph) => {
        const defs = METRICS.filter((d) => d.phase === ph && (showNA || analysis.metrics[d.key]?.tier !== 'na'));
        if (!defs.length) return null;
        return (
          <section key={ph}>
            <div className="section-label" style={{ marginBottom: 6 }}>{PHASE_LABELS[ph]}</div>
            <div className="metric-grid">
              {defs.map((d) => {
                const m = analysis.metrics[d.key];
                const flagged = m.tier !== 'low' && isFlagged(d, m.value);
                return (
                  <div key={d.key} className={`metric ${m.tier === 'na' ? 'na' : ''} ${flagged ? 'flagged' : ''}`} data-testid={`metric-${d.key}`}>
                    <div className="label"><span title={d.definition}>{d.label}</span><TierBadge tier={m.tier} /></div>
                    <div className="value" data-testid={`metric-value-${d.key}`}>{m.tier === 'na' ? <span className="faint" style={{ fontSize: '1rem' }}>Not measurable from this view</span> : fmtMetric(d, m.value, heightM, units)}</div>
                    {d.ref && m.tier !== 'na' && !youth && <div className="ref">Reference: {d.ref.text} <span title={d.ref.source}>ⓘ</span></div>}
                    <div className="meaning">{d.meaning}</div>
                    {flagged && <div className="small" style={{ color: 'var(--accent)' }}>⚑ {d.flag!.text}{d.flag!.stress ? ' Associated with higher arm stress in research.' : ''}</div>}
                    {m.note && <div className="tiny faint">{m.note}</div>}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
