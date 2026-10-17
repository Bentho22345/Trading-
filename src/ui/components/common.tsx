import { useEffect, useRef, useState } from 'react';
import type { MetricDef } from '../../core/catalog';
import type { Tier } from '../../core/types';
import { useStore, type RuntimeClip } from '../../state/store';
import { cssVar } from '../draw';

const TIER_TEXT: Record<Tier, string> = { high: 'High', medium: 'Medium', low: 'Low', na: 'Not measurable' };
const TIER_HELP: Record<Tier, string> = {
  high: 'High confidence: this camera view measures it well (single-camera trunk/pelvis/leg errors in published validation ≈ 6–9°).',
  medium: 'Medium confidence: measurable from this view, but with more error (arm joints ≈ 12–14° in published single-camera validation) or frame-rate limits.',
  low: 'Low confidence: a rough estimate — the motion is partly toward/away from the camera. Use for trends on the same setup only.',
  na: 'Not measurable from this camera view. Film from the view listed in the definition.',
};

export function TierBadge({ tier }: { tier: Tier }) {
  return <span className={`badge tier-${tier}`} title={TIER_HELP[tier]}>{tier === 'na' ? 'n/a' : TIER_TEXT[tier]}</span>;
}

export function StatusPill({ status }: { status: 'steady' | 'changed' | 'big' | 'na' }) {
  const t = { steady: 'Steady', changed: 'Changed', big: 'Big change', na: 'n/a' }[status];
  return <span className={`pill ${status}`}>{t}</span>;
}

export function useUnits() {
  return useStore((s) => s.settings.units);
}

/** Format a metric value; % height values get a real-distance conversion when height is known. */
export function fmtMetric(def: MetricDef, v: number | null | undefined, heightM?: number, units: 'imperial' | 'metric' = 'imperial'): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const base = `${v.toFixed(def.digits)}${def.unit === '°' ? '°' : ' ' + def.unit}`;
  if (def.canConvertToFeet && heightM) {
    const m = (v / 100) * heightM;
    return units === 'imperial' ? `${base} · ${(m * 3.28084).toFixed(1)} ft` : `${base} · ${m.toFixed(2)} m`;
  }
  return base;
}

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div>
      {label && <div className="small muted" style={{ marginBottom: 4 }}>{label}</div>}
      <div className="progress" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.round(value * 100)}%` }} /></div>
    </div>
  );
}

/** Small thumbnail: the stored JPEG for videos, a rendered frame for demo clips. */
export function ClipThumb({ clip, frame }: { clip: RuntimeClip; frame?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (clip.record.thumb) { const u = URL.createObjectURL(clip.record.thumb); setUrl(u); return () => URL.revokeObjectURL(u); }
  }, [clip.record.thumb]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !clip.source || clip.record.thumb) return;
    const ctx = c.getContext('2d')!;
    const i = frame ?? (clip.analysis ? clip.analysis.events.auto.FS : 0);
    const draw = () => clip.source!.draw(ctx, i, 0, 0, c.width, c.height);
    draw();
    return clip.source.subscribe(draw);
  }, [clip.source, clip.analysis, clip.record.thumb, frame]);
  return (
    <div className="thumb">
      {url ? <img src={url} alt="" /> : clip.source ? <canvas ref={ref} width={192} height={108} /> : <span className="tiny faint">video</span>}
    </div>
  );
}

export function useCssColors() {
  const theme = useStore((s) => s.settings.theme);
  const [c, setC] = useState({ a: '#2463d6', b: '#c27400', accent: '#c8102e', text: '#1a1c20', text3: '#767b84', line: '#d9d4ca', surface: '#fff' });
  useEffect(() => {
    const read = () => setC({ a: cssVar('--a'), b: cssVar('--b'), accent: cssVar('--accent'), text: cssVar('--text'), text3: cssVar('--text-3'), line: cssVar('--line'), surface: cssVar('--surface') });
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, [theme]);
  return c;
}

export function Term({ id, children }: { id: string; children: React.ReactNode }) {
  return <a className="term" href={`#/glossary/${id}`} title="Open in glossary">{children}</a>;
}

export function Disclaimer() {
  return (
    <div className="notice info small">
      <span>ℹ︎</span>
      <span>These are 2D video estimates for training and education — not a medical device. Mechanics are only part of arm health: in youth pitchers the strongest injury risks are <b>pitching too much, pitching while tired and pitching with pain</b>. Pain → stop and see a qualified professional.</span>
    </div>
  );
}
