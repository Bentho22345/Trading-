// Comparison engine: per-metric deltas, noise-aware status, root-cause vs symptom ranking, verdict and setup checks.

import { CAUSES, METRICS, METRIC_BY_KEY, type MetricDef } from './catalog';
import type { Analysis, Tier } from './types';
import { viewClass } from './types';
import { mean, sd } from './signal';

export type Status = 'steady' | 'changed' | 'big';

export interface MetricDiff {
  key: string;
  a: number | null;
  b: number | null;
  delta: number | null; // b − a in the metric's unit
  pctChange: number | null;
  ratio: number; // |change| / threshold
  threshold: number;
  status: Status | 'na';
  tier: Tier;
  aSpread?: number; // group SD
  bSpread?: number;
  greyReason?: string;
}

export interface Finding {
  key: string;
  def: MetricDef;
  diff: MetricDiff;
  direction: 'up' | 'down';
  isRoot: boolean;
  causedBy: string[]; // keys of root findings that probably explain this one
  effects: string[]; // keys of changed metrics this one probably drives
  score: number;
  what: string;
  why: string;
  cause: string;
  cue?: string;
  drills: string[];
  stress: boolean;
  /** Is B's value better, worse, or just different (style) compared with A? */
  judgment: 'better' | 'worse' | 'neutral';
  judgmentWhy: string;
}

export interface VeloPair { a?: number | null; b?: number | null; source?: string }

export interface Scorecard {
  better: Finding[];
  worse: Finding[];
  neutral: Finding[];
  winner: 'A' | 'B' | 'tie' | 'none';
  headline: string;
  detail: string;
  velo?: { a: number; b: number; delta: number; source: string };
}

export interface SetupCheck {
  ok: boolean;
  warnings: string[];
}

export interface Comparison {
  diffs: MetricDiff[];
  findings: Finding[]; // ranked
  consistent: MetricDiff[];
  verdict: { headline: string; summary: string };
  setup: SetupCheck;
  flags: { clip: 'A' | 'B'; key: string; text: string; stress: boolean }[];
  thresholdSource: 'default' | 'athlete';
  scorecard: Scorecard;
}

const TIER_W: Record<Tier, number> = { high: 1, medium: 0.8, low: 0.5, na: 0 };
const CHAIN_W: Record<number, number> = { 1: 1.3, 2: 1.15, 3: 1, 4: 0.8 };
const minTier = (a: Tier, b: Tier): Tier => (['high', 'medium', 'low', 'na'].indexOf(a) > ['high', 'medium', 'low', 'na'].indexOf(b) ? a : b);

export function fmtVal(def: MetricDef, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(def.digits)}${def.unit === '°' ? '°' : ' ' + def.unit}`;
}

export function fmtDelta(def: MetricDef, d: MetricDiff): string {
  if (d.delta === null) return '—';
  const s = d.delta > 0 ? '+' : d.delta < 0 ? '−' : '±';
  const abs = Math.abs(d.delta).toFixed(def.digits);
  const pc = def.pct && d.pctChange !== null ? ` (${d.pctChange > 0 ? '+' : '−'}${Math.abs(d.pctChange).toFixed(0)}%)` : '';
  return `${s}${abs}${def.unit === '°' ? '°' : ' ' + def.unit}${pc}`;
}

export function checkSetup(a: Analysis, b: Analysis): SetupCheck {
  const warnings: string[] = [];
  if (viewClass(a.view) !== viewClass(b.view)) warnings.push(`The clips were filmed from different views (${a.view} vs ${b.view}). Only metrics both views can measure are compared.`);
  else if (a.view !== b.view) warnings.push(`One clip is from the open side and one from the closed side — arm metrics are less reliable.`);
  const fr = Math.max(a.fps, b.fps) / Math.min(a.fps, b.fps);
  if (fr > 1.5) warnings.push(`Frame rates differ (${Math.round(a.fps)} vs ${Math.round(b.fps)} fps). Timing and arm-speed numbers are less comparable.`);
  const hr = Math.max(a.scale.heightPx, b.scale.heightPx) / Math.min(a.scale.heightPx, b.scale.heightPx);
  if (hr > 1.25) warnings.push(`The pitcher looks ${Math.round((hr - 1) * 100)}% bigger in one clip — the camera distance or zoom changed. Measurements are normalised to body height, but perspective changes can still shift them.`);
  return { ok: warnings.length === 0, warnings };
}

export interface CompareOptions {
  /** Per-metric pooled SD from the athlete's own repeat pitches (≥3 clips). */
  variability?: Record<string, number>;
  differentAthlete?: boolean;
  pitchTypes?: [string | undefined, string | undefined];
  velo?: VeloPair;
}

function diffFor(def: MetricDef, a: Analysis, b: Analysis, setup: SetupCheck, variability?: Record<string, number>): MetricDiff {
  const ma = a.metrics[def.key], mb = b.metrics[def.key];
  const av = ma?.value ?? null, bv = mb?.value ?? null;
  let tier = minTier(ma?.tier ?? 'na', mb?.tier ?? 'na');
  let greyReason: string | undefined;
  if (def.fpsSensitive && Math.max(a.fps, b.fps) / Math.min(a.fps, b.fps) > 1.5 && tier !== 'na') {
    tier = tier === 'high' ? 'medium' : 'low';
    greyReason = 'Frame rates differ between the clips.';
  }
  void setup;
  let threshold = def.threshold;
  const sdv = variability?.[def.key];
  if (sdv !== undefined && Number.isFinite(sdv)) threshold = Math.max(def.threshold, 2 * sdv);
  if (av === null || bv === null || tier === 'na') {
    return { key: def.key, a: av, b: bv, delta: null, pctChange: null, ratio: 0, threshold, status: 'na', tier: 'na', greyReason };
  }
  const delta = bv - av;
  const pctChange = Math.abs(av) > 1e-9 ? (delta / Math.abs(av)) * 100 : null;
  const mag = def.pct ? Math.abs(pctChange ?? 0) : Math.abs(delta);
  const ratio = mag / threshold;
  const status: Status = ratio >= 2 ? 'big' : ratio >= 1 ? 'changed' : 'steady';
  return { key: def.key, a: av, b: bv, delta, pctChange, ratio, threshold, status, tier, greyReason };
}

const LABEL = (k: string) => METRIC_BY_KEY[k]?.label.toLowerCase() ?? k;

function buildFindings(diffs: MetricDiff[]): Finding[] {
  const changed = diffs.filter((d) => d.status === 'changed' || d.status === 'big');
  const changedKeys = new Set(changed.map((d) => d.key));
  const findings: Finding[] = changed.map((d) => {
    const def = METRIC_BY_KEY[d.key];
    const direction: 'up' | 'down' = (d.delta ?? 0) > 0 ? 'up' : 'down';
    const causedBy = Object.entries(CAUSES)
      .filter(([root, c]) => root !== d.key && changedKeys.has(root) && c.to.includes(d.key) && (METRIC_BY_KEY[root].chain <= def.chain))
      .map(([root]) => root);
    const effects = (CAUSES[d.key]?.to ?? []).filter((k) => changedKeys.has(k) && k !== d.key);
    const isRoot = causedBy.length === 0;
    const score = d.ratio * TIER_W[d.tier] * CHAIN_W[def.chain];
    const stress = !!def.flag?.stress;
    const cause = isRoot
      ? effects.length
        ? `Likely a root cause: ${CAUSES[d.key].why}. It probably explains the change in ${effects.map(LABEL).join(', ')}.`
        : 'No upstream change explains this, so treat it as its own issue.'
      : `Probably a knock-on effect of the change in ${causedBy.map(LABEL).join(' and ')} — fix that first and re-check this.`;
    const j = judge(def, d);
    return {
      judgment: j.judgment, judgmentWhy: j.why,
      key: d.key, def, diff: d, direction, isRoot, causedBy, effects, score,
      what: direction === 'up' ? def.up : def.down,
      why: def.meaning,
      cause,
      cue: direction === 'up' ? def.cueUp : def.cueDown,
      drills: (direction === 'up' ? def.drillsUp : def.drillsDown) ?? [],
      stress,
    };
  });
  findings.sort((x, y) => Number(y.isRoot) - Number(x.isRoot) || y.score - x.score);
  return findings;
}

function distToRange(v: number, lo: number, hi: number) { return v < lo ? lo - v : v > hi ? v - hi : 0; }

/** Better / worse / style for one changed metric (B relative to A). */
export function judge(def: MetricDef, d: MetricDiff): { judgment: 'better' | 'worse' | 'neutral'; why: string } {
  if (d.a === null || d.b === null || d.delta === null) return { judgment: 'neutral', why: '' };
  if (def.better === 'none') return { judgment: 'neutral', why: 'A style difference — neither better nor worse on its own.' };
  if (def.better === 'up' || def.better === 'down') {
    const good = def.better === 'up' ? d.delta > 0 : d.delta < 0;
    return { judgment: good ? 'better' : 'worse', why: def.better === 'up' ? (good ? 'More is linked to velocity or efficiency in research.' : 'Less of this is linked to lower velocity or efficiency.') : (good ? 'Less of this is better (linked to efficiency or lower arm stress).' : 'More of this is linked to energy leaks or higher arm stress.') };
  }
  const ref = def.ref;
  if (!ref) return { judgment: 'neutral', why: '' };
  const da = distToRange(d.a, ref.lo, ref.hi), db = distToRange(d.b, ref.lo, ref.hi);
  if (da === 0 && db === 0) return { judgment: 'neutral', why: `Both are inside the typical range (${ref.text}).` };
  const margin = 0.25 * def.threshold;
  if (db < da - margin) return { judgment: 'better', why: `Closer to the typical range (${ref.text}).` };
  if (db > da + margin) return { judgment: 'worse', why: `Further from the typical range (${ref.text}).` };
  return { judgment: 'neutral', why: `About as far from the typical range (${ref.text}) as before.` };
}

function buildScorecard(findings: Finding[], velo?: VeloPair): Scorecard {
  const better = findings.filter((f) => f.judgment === 'better');
  const worse = findings.filter((f) => f.judgment === 'worse');
  const neutral = findings.filter((f) => f.judgment === 'neutral');
  const w = (fs: Finding[]) => fs.reduce((s, f) => s + f.diff.ratio * TIER_W[f.diff.tier] * (f.isRoot ? 1 : 0.5), 0);
  let sb = w(better), sw = w(worse);
  let v: Scorecard['velo'];
  if (velo && Number.isFinite(velo.a) && Number.isFinite(velo.b) && velo.a && velo.b) {
    const delta = velo.b - velo.a;
    v = { a: velo.a, b: velo.b, delta, source: velo.source ?? 'estimate' };
    // ~2 mph is a meaningful change; velocity counts like a big root-cause change
    if (Math.abs(delta) >= 1.5) { if (delta > 0) sb += Math.abs(delta) / 1.5; else sw += Math.abs(delta) / 1.5; }
  }
  const names = (fs: Finding[]) => fs.slice(0, 3).map((f) => f.def.label.toLowerCase());
  const list = (a: string[]) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
  if (!findings.length && !v) return { better, worse, neutral, winner: 'none', headline: 'No meaningful difference between A and B.', detail: 'Every measurable metric is within normal pitch-to-pitch variation.', velo: v };
  let winner: Scorecard['winner'] = 'tie';
  if (sb > 1.25 * sw && sb > 0.8) winner = 'B';
  else if (sw > 1.25 * sb && sw > 0.8) winner = 'A';
  const veloTxt = v ? ` Velocity: ${v.a.toFixed(0)} → ${v.b.toFixed(0)} mph (${v.delta >= 0 ? '+' : ''}${v.delta.toFixed(1)}, ${v.source}).` : '';
  const headline = winner === 'A' ? 'Overall, A is the better delivery.' : winner === 'B' ? 'Overall, B is the better delivery.' : 'Mixed: B is better in some ways and worse in others.';
  const parts: string[] = [];
  if (worse.length) parts.push(`B is worse in ${worse.length} area${worse.length > 1 ? 's' : ''} (${list(names(worse))})`);
  if (better.length) parts.push(`better in ${better.length} (${list(names(better))})`);
  if (neutral.length) parts.push(`${neutral.length} change${neutral.length > 1 ? 's are' : ' is'} just style`);
  const detail = (parts.length ? parts.join(', ').replace(/^./, (c) => c.toUpperCase()) + '.' : '') + veloTxt;
  return { better, worse, neutral, winner, headline, detail, velo: v };
}

function buildVerdict(findings: Finding[], consistent: MetricDiff[]): { headline: string; summary: string } {
  if (!findings.length) {
    return {
      headline: 'No meaningful changes — these two deliveries look the same.',
      summary: `Every measurable metric stayed within normal pitch-to-pitch variation (${consistent.length} checked). If something felt different, film a few more pitches or add a second camera angle.`,
    };
  }
  const top = findings[0];
  const firstSentence = top.what.split(/(?<=\.)\s|—/)[0].trim().replace(/\.$/, '');
  const roots = findings.filter((f) => f.isRoot);
  const symptoms = findings.filter((f) => !f.isRoot);
  const parts: string[] = [];
  parts.push(`${top.def.label} changed the most relative to normal variation (${top.diff.status === 'big' ? 'a big change' : 'a clear change'}).`);
  if (top.effects.length) parts.push(`It likely explains the changes in ${top.effects.map(LABEL).join(', ')}.`);
  if (roots.length > 1) parts.push(`Other independent changes: ${roots.slice(1, 3).map((f) => f.def.label.toLowerCase()).join(' and ')}.`);
  if (symptoms.length && !top.effects.length) parts.push(`${symptoms.length} other change${symptoms.length > 1 ? 's look' : ' looks'} like knock-on effects.`);
  if (consistent.length) parts.push(`${consistent.length} metric${consistent.length > 1 ? 's' : ''} stayed consistent.`);
  return { headline: `Biggest change: ${top.def.label.toLowerCase()} — ${firstSentence.charAt(0).toLowerCase()}${firstSentence.slice(1)}.`, summary: parts.join(' ') };
}

function flagsFor(an: Analysis, clip: 'A' | 'B') {
  const out: Comparison['flags'] = [];
  for (const def of METRICS) {
    const m = an.metrics[def.key];
    if (!def.flag || !m || m.value === null || m.tier === 'na' || m.tier === 'low') continue;
    if ((def.flag.above !== undefined && m.value > def.flag.above) || (def.flag.below !== undefined && m.value < def.flag.below)) {
      out.push({ clip, key: def.key, text: def.flag.text, stress: !!def.flag.stress });
    }
  }
  return out;
}

export function compareAnalyses(a: Analysis, b: Analysis, opt: CompareOptions = {}): Comparison {
  const setup = checkSetup(a, b);
  if (opt.differentAthlete) setup.warnings.push('These are different athletes — differences include body type and style, not just changes.');
  const [pa, pb] = opt.pitchTypes ?? [];
  if (pa && pb && pa !== pb) setup.warnings.push(`Different pitch types (${pa} vs ${pb}) — some differences are normal for the pitch.`);
  setup.ok = setup.warnings.length === 0;
  const diffs = METRICS.map((def) => diffFor(def, a, b, setup, opt.variability));
  const findings = buildFindings(diffs);
  const consistent = diffs.filter((d) => d.status === 'steady' && (d.tier === 'high' || d.tier === 'medium'));
  return {
    diffs, findings, consistent,
    verdict: buildVerdict(findings, consistent),
    setup,
    flags: [...flagsFor(a, 'A'), ...flagsFor(b, 'B')],
    thresholdSource: opt.variability ? 'athlete' : 'default',
    scorecard: buildScorecard(findings, opt.velo),
  };
}

/** Pooled per-metric SD from groups of repeat pitches (e.g. pitches within each session). */
export function pooledVariability(groups: Analysis[][]): Record<string, number> | undefined {
  const usable = groups.filter((g) => g.length >= 2);
  const total = usable.reduce((s, g) => s + g.length, 0);
  if (total < 3) return undefined;
  const out: Record<string, number> = {};
  for (const def of METRICS) {
    let ss = 0, dof = 0;
    for (const g of usable) {
      const vals = g.map((x) => x.metrics[def.key]?.value).filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
      if (vals.length < 2) continue;
      const m = mean(vals);
      const vv = def.pct ? vals.map((v) => (v / (Math.abs(m) || 1)) * 100) : vals;
      const mm = mean(vv);
      ss += vv.reduce((s, v) => s + (v - mm) ** 2, 0);
      dof += vv.length - 1;
    }
    if (dof > 0) out[def.key] = Math.sqrt(ss / dof);
  }
  return out;
}

/** Average a group of analyses into one pseudo-analysis (metrics = means) and report spreads. */
export function averageGroup(group: Analysis[]): { avg: Analysis; spread: Record<string, number> } {
  if (!group.length) throw new Error('Empty group');
  const base = group[0];
  const metrics: Analysis['metrics'] = {};
  const spread: Record<string, number> = {};
  for (const def of METRICS) {
    const ms = group.map((g) => g.metrics[def.key]).filter((m) => m && m.value !== null && m.tier !== 'na');
    if (ms.length < Math.ceil(group.length / 2)) { metrics[def.key] = { value: null, tier: 'na' }; continue; }
    const vals = ms.map((m) => m!.value as number);
    const order: Tier[] = ['high', 'medium', 'low', 'na'];
    const worst = ms.reduce<Tier>((w, m) => (order.indexOf(m!.tier) > order.indexOf(w) ? m!.tier : w), 'high');
    metrics[def.key] = { value: mean(vals), tier: worst };
    spread[def.key] = sd(vals);
  }
  return { avg: { ...base, metrics }, spread };
}

export function compareGroups(ga: Analysis[], gb: Analysis[], opt: CompareOptions = {}): Comparison {
  const A = averageGroup(ga), B = averageGroup(gb);
  const variability = opt.variability ?? pooledVariability([ga, gb]);
  const c = compareAnalyses(A.avg, B.avg, { ...opt, variability });
  for (const d of c.diffs) { d.aSpread = A.spread[d.key]; d.bSpread = B.spread[d.key]; }
  return c;
}
