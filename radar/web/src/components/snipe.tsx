'use client';
import Link from 'next/link';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { AnimatePresence, motion } from '@/components/motion';
import { api, apiCached, peek } from '@/lib/api';
import { short, usd } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

export type Detector = { key: string; label: string; points: number; good: boolean; detail: string; value?: number; eta_min?: number | null };
export type Metrics = {
  holders: number; top10_pct: number; dev_hold_pct: number; dev_sold: boolean; snipers: number; snipers_hold_pct: number; bundle_hold_pct: number;
  pro_traders: number; buys_1m: number; sells_1m: number; buy_ratio_1m: number; vol_1m_usd: number; vol_5m_usd: number;
  has_twitter: boolean; has_telegram: boolean; has_website: boolean; twitter_kind?: string | null; x_community: boolean; socials: number;
  social_authors: number; social_engagement: number; meta_hot: boolean; dev_graduated: number; coverage_pct: number; metrics_basis: 'complete' | 'partial';
};
export type Appetite = 'safe' | 'balanced' | 'degen';
export type Rule = { metric: string; op: string; value: number | boolean };
export type SnipeRow = {
  mint: string; symbol?: string; name?: string; deployer?: string; created: number; age_s: number; score: number;
  tier: 'SNIPE' | 'WATCH' | 'PASS' | 'TRAP'; flags: string[]; detectors: Detector[]; mcap_usd?: number | null; peak_mcap_usd?: number | null;
  mcap_sol?: number | null; progress?: number | null; graduated_at?: number | null; eta_min?: number | null; sol_per_min?: number; buys: number; sells: number;
  buyers: number; net_sol_1m: number; dev_buy_pct?: number | null; organic?: number | null; bundled: boolean; early_supply_pct?: number;
  confirming?: boolean; metrics?: Metrics; upside?: number; risk?: number; scores?: Record<Appetite, number>; why_up?: string[]; why_risk?: string[];
  strategies?: string[]; links?: { twitter?: string; telegram?: string; website?: string }; description?: string | null; image?: string | null;
  alpha: { wallet: string; rank?: number | null; label?: string | null; ts: number; sol: number }[]; called?: boolean;
};
export type SnipeFilters = {
  minScore: number; tiers: string[]; hideBundled: boolean; alphaOnly: boolean; provenDev: boolean; maxAgeMin: number;
  appetite?: Appetite; strategy?: string; rules?: Rule[];
};
export const DEFAULT_FILTERS: SnipeFilters = { minScore: 0, tiers: [], hideBundled: true, alphaOnly: false, provenDev: false, maxAgeMin: 30 };

export const TIER_STYLE: Record<string, string> = {
  SNIPE: 'bg-up text-black shadow-[0_0_18px_-2px_var(--color-up)]',
  WATCH: 'bg-warn/15 text-warn ring-1 ring-warn/40',
  PASS: 'bg-white/5 text-white/45',
  TRAP: 'bg-down/15 text-down ring-1 ring-down/40',
};
export const DET_ICON: Record<string, string> = { alpha: 'trophy', velocity: 'rocket', organic: 'social', dev: 'wallet', meta: 'narrative', social: 'signal' };
export const APPETITES: { value: Appetite; label: string; sub: string }[] = [
  { value: 'safe', label: 'Safe', sub: 'Risk counts in full' },
  { value: 'balanced', label: 'Balanced', sub: 'Upside first, risk still bites' },
  { value: 'degen', label: 'Degen', sub: 'Best upside, risk barely counts' },
];
const TIER_ORDER: Record<string, number> = { SNIPE: 0, WATCH: 1, PASS: 2, TRAP: 3 };

/** Flat view of a row for rule matching — mirrors the backend's `flat()` exactly. */
export function flatRow(r: SnipeRow): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(r)) if (v === null || typeof v !== 'object') out[k] = v;
  return { ...out, ...(r.metrics || {}), alpha: r.alpha?.length || 0, upside: r.upside, risk: r.risk };
}
const OPS: Record<string, (a: number, b: number) => boolean> = { '<=': (a, b) => a <= b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '>': (a, b) => a > b, '==': (a, b) => a === b, '!=': (a, b) => a !== b };
export function matchRules(rules: Rule[], row: Record<string, any>, mode: 'all' | 'any' = 'all') {
  if (!rules.length) return true;
  let hits = 0;
  for (const r of rules) {
    const v = row[r.metric];
    const op = OPS[r.op];
    const ok = v != null && op != null && (typeof v === 'boolean' || typeof r.value === 'boolean' ? op(+!!v, +!!r.value) : op(+v, +r.value));
    if (ok) hits++;
    else if (mode === 'all') return false;
  }
  return mode === 'all' ? hits === rules.length : hits > 0;
}

export type Strategy = { id: string; name: string; description?: string; rules: Rule[]; mode: 'all' | 'any'; appetite?: Appetite; source: string;
  enabled: number; alert: number; sources: string[]; stats: { hits: number; hit_2x_pct: number | null; hit_5x_pct: number | null; graduated_pct: number | null; up_1h_pct: number | null; median_peak_x: number | null } };

/** All strategies (presets, crowd consensus, yours) with their graded stats. */
export function useStrategies() {
  const [list, setList] = useState<Strategy[]>([]);
  const load = useCallback(() => apiCached<Strategy[]>('/api/strategies').then(setList).catch(() => {}), []);
  useEffect(() => { const c = peek('/api/strategies'); if (c) setList(c); load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  const byId = useMemo(() => Object.fromEntries(list.map((s) => [s.id, s])), [list]);
  return { list, byId, reload: load };
}

/** Live snipe board: one REST snapshot, then every launch is re-scored over the socket as it trades. */
export function useSnipe(f: SnipeFilters) {
  const [rows, setRows] = useState<Record<string, SnipeRow>>({});
  const [meta, setMeta] = useState<{ tracking: number; seen: number; as_of: number } | null>(null);
  const [calls, setCalls] = useState<SnipeRow[]>([]);
  const url = `/api/snipe?limit=300&max_age_min=${f.maxAgeMin}`;
  const load = useCallback(() => apiCached<{ rows: SnipeRow[]; tracking: number; seen: number; as_of: number }>(url)
    .then((d) => { setRows(Object.fromEntries(d.rows.map((r) => [r.mint, r]))); setMeta({ tracking: d.tracking, seen: d.seen, as_of: d.as_of }); })
    .catch(() => {}), [url]);
  useEffect(() => {
    const c = peek(url);
    if (c) setRows((p) => (Object.keys(p).length ? p : Object.fromEntries(c.rows.map((r: SnipeRow) => [r.mint, r]))));
    load(); const t = setInterval(load, 20000); return () => clearInterval(t);
  }, [load, url]);
  useLive(({ ch, data }) => {
    if (ch === 'snipe') setRows((p) => ({ ...p, [data.mint]: { ...p[data.mint], ...data } }));
    else if (ch === 'snipe_drop') setRows((p) => { const n = { ...p }; delete n[data.mint]; return n; });
    else if (ch === 'snipe_call') setCalls((c) => [data, ...c.filter((x) => x.mint !== data.mint)].slice(0, 20));
  });
  const now = useNow(1000);
  const list = useMemo(() => {
    const ap = f.appetite;
    return Object.values(rows)
      .filter((r) => now - r.created <= f.maxAgeMin * 60)
      .filter((r) => r.score >= f.minScore && (!f.tiers.length || f.tiers.includes(r.tier)))
      .filter((r) => !(f.hideBundled && r.bundled) && !(f.alphaOnly && !r.alpha?.length))
      .filter((r) => !f.provenDev || (r.metrics?.dev_graduated || 0) > 0)
      .filter((r) => !f.strategy || (r.strategies || []).includes(f.strategy))
      .filter((r) => !f.rules?.length || matchRules(f.rules, flatRow(r)))
      .sort(ap ? (a, b) => ((b.scores?.[ap] ?? -999) - (a.scores?.[ap] ?? -999)) || (b.created - a.created)
        : (a, b) => (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) || (b.score - a.score) || (b.created - a.created));
  }, [rows, f, now]);
  return { list, meta, calls, now, all: rows };
}

/** Sound + desktop notification the moment a coin is called SNIPE (opt-in, per browser). */
export function useSnipeAlerts() {
  const [on, setOn] = useState(false);
  const ctx = useRef<AudioContext | null>(null);
  useEffect(() => { try { setOn(localStorage.getItem('radar:snipe-alerts') === '1'); } catch { /* */ } }, []);
  const toggle = () => {
    const v = !on;
    setOn(v);
    try { localStorage.setItem('radar:snipe-alerts', v ? '1' : '0'); } catch { /* */ }
    if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    if (v && !ctx.current) ctx.current = new AudioContext();
  };
  useLive(({ ch, data }) => {
    if (ch !== 'snipe_call' || !on) return;
    try {
      const a = ctx.current || (ctx.current = new AudioContext());
      [880, 1320].forEach((hz, i) => {
        const o = a.createOscillator(), g = a.createGain();
        o.frequency.value = hz; o.type = 'sine';
        g.gain.setValueAtTime(0.0001, a.currentTime + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.18, a.currentTime + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + i * 0.12 + 0.18);
        o.connect(g).connect(a.destination); o.start(a.currentTime + i * 0.12); o.stop(a.currentTime + i * 0.12 + 0.2);
      });
    } catch { /* audio blocked */ }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      const n = new Notification(`🎯 SNIPE ${data.symbol || short(data.mint)} · ${Math.round(data.score)}`, { body: (data.why_up || []).slice(0, 4).join(' · '), tag: data.mint });
      n.onclick = () => { window.focus(); location.href = `/token?a=${data.mint}`; };
    }
  });
  return { on, toggle };
}

export function ScoreDial({ score, tier, size = 44, label }: { score: number; tier: string; size?: number; label?: string }) {
  const r = size / 2 - 3, c = 2 * Math.PI * r;
  const color = tier === 'SNIPE' ? 'var(--color-up)' : tier === 'WATCH' ? 'var(--color-warn)' : tier === 'TRAP' ? 'var(--color-down)' : 'var(--color-mute)';
  const v = Math.max(0, Math.min(100, score));
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} title={label}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-edge)" strokeWidth={3} />
        <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round"
          strokeDasharray={c} initial={false} animate={{ strokeDashoffset: c * (1 - v / 100) }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
      </svg>
      <span className="stat absolute text-[15px] leading-none" style={{ color }}>{Math.round(score)}</span>
    </span>
  );
}

/** Upside (green) vs risk (red) as two thin meters. */
function UpRisk({ r }: { r: SnipeRow }) {
  if (r.upside == null) return null;
  return (
    <div className="flex w-14 shrink-0 flex-col gap-1" title={`Upside ${r.upside}: ${(r.why_up || []).join(', ') || '—'}\nRisk ${r.risk}: ${(r.why_risk || []).join(', ') || 'nothing flagged'}`}>
      {[['UP', r.upside, 'var(--color-up)'], ['RISK', r.risk ?? 0, 'var(--color-down)']].map(([k, v, c]) => (
        <div key={k as string} className="flex items-center gap-1">
          <span className="w-6 text-[8px] font-bold tracking-wider text-white/40">{k}</span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
            <motion.div className="h-full rounded-full" style={{ background: c as string }} initial={false} animate={{ width: `${Math.min(100, v as number)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function CurveBar({ r }: { r: SnipeRow }) {
  const p = Math.max(0, Math.min(100, r.progress ?? 0));
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
        <motion.div className="absolute inset-y-0 left-0 rounded-full" style={{ background: 'linear-gradient(90deg, var(--color-accent), var(--color-up))' }}
          initial={false} animate={{ width: `${p}%` }} transition={{ type: 'spring', stiffness: 90, damping: 18 }} />
      </div>
      <span className="num w-[86px] shrink-0 text-right text-[10.5px] text-white/55">
        {r.graduated_at ? <span className="text-accent2">graduated</span> : r.eta_min != null ? <span className="text-up">ETA {r.eta_min < 1 ? '<1' : Math.round(r.eta_min)}m · {p.toFixed(0)}%</span> : `${p.toFixed(0)}% curve`}
      </span>
    </div>
  );
}

/** The terminal-style holder strip: green inside the thresholds trader guides use, red outside them. */
function MetricStrip({ m }: { m: Metrics }) {
  const cell = (k: string, v: string, good: boolean | null, title: string) => (
    <span key={k} title={title} className={`num rounded-md px-1.5 py-[1px] text-[10px] ${good == null ? 'bg-white/[0.04] text-white/60' : good ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>
      <span className="opacity-60">{k}</span> {v}
    </span>
  );
  return (
    <div className={`flex flex-wrap gap-1 ${m.metrics_basis === 'partial' ? 'opacity-70' : ''}`} title={m.metrics_basis === 'partial' ? `Partial: Radar saw ${m.coverage_pct}% of this coin's curve SOL trade` : undefined}>
      {cell('H', String(m.holders), m.holders >= 15 ? true : null, 'Holders (wallets with a balance, from the trade stream)')}
      {cell('T10', `${m.top10_pct.toFixed(0)}%`, m.top10_pct <= 30, 'Top 10 holders share of supply (guides: ≤ 30%)')}
      {cell('DEV', m.dev_sold ? 'sold' : `${m.dev_hold_pct.toFixed(0)}%`, m.dev_sold || m.dev_hold_pct <= 5, 'Dev holding (guides: ≤ 5%, dev sold read as positive)')}
      {cell('SNP', `${m.snipers_hold_pct.toFixed(0)}%`, m.snipers_hold_pct <= 20, `${m.snipers} sniper wallets (first 5s) still hold this share (guides: ≤ 20%)`)}
      {cell('BND', `${m.bundle_hold_pct.toFixed(0)}%`, m.bundle_hold_pct <= 10, 'Creation-block bundlers still hold this share (guides: ≤ 10%)')}
      {m.pro_traders > 0 && cell('PRO', String(m.pro_traders), true, 'Wallets from your Top Traders pool that bought')}
      {m.metrics_basis === 'partial' && cell('DATA', `${m.coverage_pct}%`, false, 'Share of curve SOL Radar saw trade — holder numbers are partial')}
    </div>
  );
}

function Socials({ r }: { r: SnipeRow }) {
  const l = r.links || {};
  const a = (href: string | undefined, label: string, title: string) => href
    ? <a key={label} href={href} target="_blank" rel="noreferrer" title={title} onClick={(e) => e.stopPropagation()} className="rounded-full border border-white/10 px-1.5 text-[9.5px] font-bold text-white/70 hover:border-white/40 hover:text-white">{label}</a>
    : null;
  const items = [a(l.twitter, r.metrics?.x_community ? 'X·COMM' : 'X', r.metrics?.twitter_kind ? `X ${r.metrics.twitter_kind}` : 'X'), a(l.telegram, 'TG', 'Telegram'), a(l.website, 'WEB', 'Website')].filter(Boolean);
  return items.length ? <span className="flex gap-1">{items}</span> : null;
}

export const TRADE_LINKS = (mint: string) => [
  { label: 'Axiom', href: `https://axiom.trade/t/${mint}` },
  { label: 'Photon', href: `https://photon-sol.tinyastro.io/en/lp/${mint}` },
  { label: 'BullX', href: `https://neo.bullx.io/terminal?chainId=1399811149&address=${mint}` },
  { label: 'GMGN', href: `https://gmgn.ai/sol/token/${mint}` },
  { label: 'pump', href: `https://pump.fun/coin/${mint}` },
];

function CopyCA({ mint }: { mint: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigator.clipboard?.writeText(mint).then(() => { setOk(true); setTimeout(() => setOk(false), 1000); }); }}
      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition active:scale-95 ${ok ? 'border-up/50 bg-up/10 text-up' : 'border-white/10 text-white/70 hover:border-white/40 hover:text-white'}`}
      title={`Copy ${mint}`}><Icon name={ok ? 'check' : 'copy'} size={11} />{ok ? 'Copied' : 'CA'}</button>
  );
}

/** One launch: score, upside vs risk, the holder strip traders filter on, socials, strategies it matches, links out. */
export const SnipeCard = memo(function SnipeCard({ r, now, dense = false, selected = false, appetite, names }: {
  r: SnipeRow; now: number; dense?: boolean; selected?: boolean; appetite?: Appetite; names?: Record<string, string>;
}) {
  const age = Math.max(0, now - r.created);
  const fired = r.detectors.filter((d) => d.points !== 0).sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const shown = appetite && r.scores ? r.scores[appetite] : r.score;
  return (
    <div data-mint={r.mint} className={`group relative rounded-2xl border px-3 py-2.5 transition-colors ${selected ? 'ring-2 ring-white/70 ring-offset-2 ring-offset-[var(--color-bg)] ' : ''}${r.tier === 'SNIPE' ? 'snipe-glow border-up/40 bg-up/[0.04]' : r.tier === 'TRAP' ? 'border-down/20 bg-down/[0.025]' : 'border-white/[0.07] bg-white/[0.015] hover:border-white/20'}`}>
      <div className="flex items-center gap-3">
        <ScoreDial score={shown} tier={r.tier} size={dense ? 38 : 44} label={appetite ? `${appetite} score = upside − risk penalty` : 'Snipe score'} />
        <Link href={`/token?a=${r.mint}`} className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {r.image && !dense && <img src={r.image} alt="" loading="lazy" className="h-5 w-5 rounded-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
            <b className="truncate text-[14px] tracking-tight">{r.symbol || short(r.mint)}</b>
            <span className={`rounded-full px-1.5 py-[1px] text-[9px] font-extrabold tracking-[0.12em] ${TIER_STYLE[r.tier]}`}>{r.tier}</span>
            {r.confirming && <span className="text-[9px] font-bold uppercase tracking-wider text-warn" title="Score is at SNIPE level; waiting for enough trades, buyers and age to call it">confirming…</span>}
            {r.called && <span className="text-[9px] font-bold uppercase tracking-wider text-up" title="Logged on the Proof page">● called</span>}
          </div>
          <div className="num mt-0.5 flex gap-2 whitespace-nowrap text-[10.5px] text-white/50">
            <span className={age < 60 ? 'text-up' : ''}>{age < 60 ? `${Math.floor(age)}s` : `${Math.floor(age / 60)}m`}</span>
            <span>MC <b className="text-white/85">{r.mcap_usd != null ? usd(r.mcap_usd) : r.mcap_sol != null ? `◎${Math.round(r.mcap_sol)}` : '—'}</b></span>
            <span>{r.buyers} buyers</span>
            <span className={r.net_sol_1m >= 0 ? 'text-up' : 'text-down'}>{r.net_sol_1m >= 0 ? '+' : ''}{r.net_sol_1m.toFixed(1)} SOL/1m</span>
          </div>
        </Link>
        <UpRisk r={r} />
        <div className="flex flex-col items-end gap-1">
          <CopyCA mint={r.mint} />
          <Socials r={r} />
        </div>
      </div>
      <div className="mt-2"><CurveBar r={r} /></div>
      {r.metrics && <div className="mt-2"><MetricStrip m={r.metrics} /></div>}
      {!dense && r.description && <p className="mt-1.5 line-clamp-1 text-[11px] italic text-white/45" title={r.description}>“{r.description}”</p>}
      {(fired.length > 0 || (!!r.strategies?.length && !!names)) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {names && (r.strategies || []).slice(0, dense ? 2 : 4).map((s) => (
            <span key={s} className="rounded-full bg-accent/15 px-2 py-[2px] text-[10px] font-bold text-accent" title="Matches this strategy">◆ {names[s] || s}</span>
          ))}
          {fired.slice(0, dense ? 3 : 6).map((d) => (
            <span key={d.key} title={d.detail}
              className={`flex items-center gap-1 rounded-full px-2 py-[2px] text-[10px] font-semibold ${d.points > 0 ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>
              <Icon name={DET_ICON[d.key] || 'bolt'} size={10} />{d.label}<span className="num opacity-70">{d.points > 0 ? '+' : ''}{Math.round(d.points)}</span>
            </span>
          ))}
          {r.flags.filter((x) => !fired.some((d) => d.detail.toLowerCase().includes(x))).map((x) => (
            <span key={x} className="rounded-full bg-down/10 px-2 py-[2px] text-[10px] font-semibold text-down">⚠ {x}</span>
          ))}
        </div>
      )}
      {!dense && (
        <div className="mt-2 flex flex-wrap items-center gap-1 opacity-70 transition group-hover:opacity-100">
          {TRADE_LINKS(r.mint).map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="rounded-full border border-white/10 px-2 py-[1px] text-[10px] font-semibold text-white/70 hover:border-white/40 hover:text-white">{l.label} ↗</a>
          ))}
        </div>
      )}
    </div>
  );
}, (a, b) => a.r === b.r && a.dense === b.dense && a.selected === b.selected && a.appetite === b.appetite && a.names === b.names && Math.floor(a.now) === Math.floor(b.now));

/** Live Risk × Upside map: every launch a dot; top-left is where the gems are, top-right where the degen plays are. */
export function RiskMap({ rows, onPick, selected, className = '' }: { rows: SnipeRow[]; onPick?: (m: string) => void; selected?: string | null; className?: string }) {
  const [hover, setHover] = useState<SnipeRow | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState({ w: 1000, h: 360 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setDim({ w: Math.max(320, e.contentRect.width), h: Math.max(200, e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const W = dim.w, H = dim.h, pad = 34;   // drawn at real pixel size so dots stay round and labels undistorted
  const pts = rows.filter((r) => r.upside != null).slice(0, 160);
  const x = (v: number) => pad + (Math.min(100, v) / 100) * (W - pad * 2);
  const y = (v: number) => H - pad - (Math.min(90, Math.max(0, v)) / 90) * (H - pad * 2);
  const rad = (r: SnipeRow) => 4 + Math.min(14, Math.sqrt((r.metrics?.vol_5m_usd || 0) / 400));
  return (
    <div ref={box} className={`relative ${className}`}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="absolute inset-0" role="img" aria-label="Risk versus upside map of live launches">
        <rect x={pad} y={pad} width={(W - pad * 2) * 0.4} height={y(35) - pad} fill="var(--color-up)" opacity={0.05} />
        <rect x={x(40)} y={pad} width={W - pad - x(40)} height={y(35) - pad} fill="var(--color-warn)" opacity={0.04} />
        <line x1={x(40)} x2={x(40)} y1={pad} y2={H - pad} stroke="var(--color-edge)" strokeDasharray="4 6" />
        <line x1={pad} x2={W - pad} y1={y(35)} y2={y(35)} stroke="var(--color-edge)" strokeDasharray="4 6" />
        {[['GEMS · high upside, low risk', pad + 10, pad + 18, 'var(--color-up)'], ['DEGEN PLAYS · high upside, high risk', x(40) + 10, pad + 18, 'var(--color-warn)'],
          ['SLEEPERS', pad + 10, H - pad - 10, 'var(--color-mute)'], ['AVOID', W - pad - 60, H - pad - 10, 'var(--color-down)']].map(([t, tx, ty, c]) => (
          <text key={t as string} x={tx as number} y={ty as number} fill={c as string} fontSize={11} fontWeight={700} letterSpacing={1} opacity={0.75}>{t}</text>
        ))}
        <text x={W / 2} y={H - 8} fill="var(--color-mute)" fontSize={11} textAnchor="middle">RISK →</text>
        <text x={12} y={H / 2} fill="var(--color-mute)" fontSize={11} transform={`rotate(-90 12 ${H / 2})`} textAnchor="middle">UPSIDE →</text>
        {pts.map((r) => {
          const c = r.tier === 'SNIPE' ? 'var(--color-up)' : r.tier === 'TRAP' ? 'var(--color-down)' : r.tier === 'WATCH' ? 'var(--color-warn)' : 'var(--color-accent2)';
          return (
            <motion.circle key={r.mint} initial={false} animate={{ cx: x(r.risk || 0), cy: y(r.upside || 0), r: rad(r) }} transition={{ type: 'spring', stiffness: 80, damping: 16 }}
              fill={c} fillOpacity={selected === r.mint ? 0.95 : 0.55} stroke={selected === r.mint ? 'var(--color-fg)' : c} strokeWidth={selected === r.mint ? 2.5 : 1}
              className="cursor-pointer" onMouseEnter={() => setHover(r)} onMouseLeave={() => setHover(null)} onClick={() => onPick?.(r.mint)} />
          );
        })}
      </svg>
      <AnimatePresence>
        {hover && (
          <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="glass pointer-events-none absolute right-3 top-3 w-64 rounded-2xl p-3 text-[11.5px]">
            <div className="flex items-center gap-2"><b className="text-[14px]">{hover.symbol}</b><span className={`rounded-full px-1.5 text-[9px] font-extrabold ${TIER_STYLE[hover.tier]}`}>{hover.tier}</span>
              <span className="num ml-auto text-white/50">{usd(hover.mcap_usd)}</span></div>
            <div className="mt-1 text-up">↑ {hover.upside} · {(hover.why_up || []).slice(0, 3).join(', ') || '—'}</div>
            <div className="text-down">⚠ {hover.risk} · {(hover.why_risk || []).slice(0, 3).join(', ') || 'nothing flagged'}</div>
          </motion.div>
        )}
      </AnimatePresence>
      {!pts.length && <div className="absolute inset-0 flex items-center justify-center text-[12px] text-white/40">Waiting for scored launches…</div>}
    </div>
  );
}

/** The dedicated sniping column on the Home terminal. */
export function SnipeColumn({ className = '' }: { className?: string }) {
  const [mode, setMode] = useState<Appetite>('balanced');
  const f = useMemo<SnipeFilters>(() => ({ ...DEFAULT_FILTERS, appetite: mode, hideBundled: mode !== 'degen' }), [mode]);
  const { list, meta, now } = useSnipe(f);
  const { byId } = useStrategies();
  const names = useMemo(() => Object.fromEntries(Object.values(byId).map((s) => [s.id, s.name])), [byId]);
  const alerts = useSnipeAlerts();
  return (
    <section className={`glass flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl ${className}`}>
      <header className="panel-head flex items-center gap-2 px-3.5 py-2">
        <Icon name="target" size={15} className="text-up" />
        <h2 className="text-[12.5px] font-semibold">Snipe</h2>
        <span className="flex items-center gap-1 text-[10.5px] text-up"><span className="live-dot h-1.5 w-1.5 rounded-full bg-up" />{meta?.tracking ?? 0} live</span>
        <span className="flex-1" />
        <div className="flex rounded-full border border-white/10 p-0.5 text-[10px] font-bold uppercase tracking-wider">
          {APPETITES.map((m) => (
            <button key={m.value} onClick={() => setMode(m.value)} title={m.sub} className={`rounded-full px-2 py-0.5 transition ${mode === m.value ? 'bg-white text-black' : 'text-white/50 hover:text-white'}`}>{m.label}</button>
          ))}
        </div>
        <button onClick={alerts.toggle} title={alerts.on ? 'SNIPE alerts on (sound + desktop)' : 'Turn on SNIPE alerts'} className={`rounded-full p-1 ${alerts.on ? 'text-up' : 'text-white/40 hover:text-white'}`}><Icon name={alerts.on ? 'sound' : 'mute'} size={14} /></button>
        <Link href="/snipe" className="text-[11px] text-white/50 hover:text-white">Open ↗</Link>
      </header>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
        <AnimatePresence initial={false} mode="popLayout">
          {list.slice(0, 40).map((r) => (
            <motion.div key={r.mint} layout="position" initial={{ opacity: 0, y: -10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 420, damping: 34 }}>
              <SnipeCard r={r} now={now} dense appetite={mode} names={names} />
            </motion.div>
          ))}
        </AnimatePresence>
        {!list.length && <p className="p-8 text-center text-[12px] text-white/40">Waiting for pump.fun launches… every new coin is scored from its first trade.</p>}
      </div>
    </section>
  );
}

export async function saveStrategy(s: { id?: string; name: string; description?: string; rules: Rule[]; mode?: string; appetite?: Appetite; alert?: boolean }) {
  return api<{ id: string }>('/api/strategies', { method: 'POST', body: JSON.stringify(s) });
}
