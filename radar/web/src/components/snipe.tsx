'use client';
import Link from 'next/link';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { AnimatePresence, motion } from '@/components/motion';
import { apiCached, peek } from '@/lib/api';
import { short, usd } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

export type Detector = { key: string; label: string; points: number; good: boolean; detail: string; value?: number; eta_min?: number | null };
export type SnipeRow = {
  mint: string; symbol?: string; name?: string; deployer?: string; created: number; age_s: number; score: number;
  tier: 'SNIPE' | 'WATCH' | 'PASS' | 'TRAP'; flags: string[]; detectors: Detector[]; mcap_usd?: number | null; peak_mcap_usd?: number | null;
  mcap_sol?: number | null; progress?: number | null; graduated_at?: number | null; eta_min?: number | null; sol_per_min?: number; buys: number; sells: number;
  buyers: number; net_sol_1m: number; dev_buy_pct?: number | null; organic?: number | null; bundled: boolean; early_supply_pct?: number;
  confirming?: boolean;
  alpha: { wallet: string; rank?: number | null; label?: string | null; ts: number; sol: number }[]; called?: boolean;
};
export type SnipeFilters = { minScore: number; tiers: string[]; hideBundled: boolean; alphaOnly: boolean; provenDev: boolean; maxAgeMin: number };
export const DEFAULT_FILTERS: SnipeFilters = { minScore: 0, tiers: [], hideBundled: true, alphaOnly: false, provenDev: false, maxAgeMin: 30 };

export const TIER_STYLE: Record<string, string> = {
  SNIPE: 'bg-up text-black shadow-[0_0_18px_-2px_var(--color-up)]',
  WATCH: 'bg-warn/15 text-warn ring-1 ring-warn/40',
  PASS: 'bg-white/5 text-white/45',
  TRAP: 'bg-down/15 text-down ring-1 ring-down/40',
};
export const DET_ICON: Record<string, string> = { alpha: 'trophy', velocity: 'rocket', organic: 'social', dev: 'wallet', meta: 'narrative', social: 'signal' };
const TIER_ORDER: Record<string, number> = { SNIPE: 0, WATCH: 1, PASS: 2, TRAP: 3 };

/** Live snipe board: one REST snapshot, then every launch is re-scored over the socket as it trades. */
export function useSnipe(f: SnipeFilters) {
  const [rows, setRows] = useState<Record<string, SnipeRow>>({});
  const [meta, setMeta] = useState<{ tracking: number; seen: number; as_of: number } | null>(null);
  const [calls, setCalls] = useState<SnipeRow[]>([]);
  const load = useCallback(() => apiCached<{ rows: SnipeRow[]; tracking: number; seen: number; as_of: number }>(`/api/snipe?limit=300&max_age_min=${f.maxAgeMin}`)
    .then((d) => { setRows(Object.fromEntries(d.rows.map((r) => [r.mint, r]))); setMeta({ tracking: d.tracking, seen: d.seen, as_of: d.as_of }); })
    .catch(() => {}), [f.maxAgeMin]);
  useEffect(() => {
    const c = peek(`/api/snipe?limit=300&max_age_min=${f.maxAgeMin}`);
    if (c) setRows((p) => (Object.keys(p).length ? p : Object.fromEntries(c.rows.map((r: SnipeRow) => [r.mint, r]))));
    load(); const t = setInterval(load, 20000); return () => clearInterval(t);
  }, [load, f.maxAgeMin]);
  useLive(({ ch, data }) => {
    if (ch === 'snipe') setRows((p) => ({ ...p, [data.mint]: { ...p[data.mint], ...data } }));
    else if (ch === 'snipe_call') setCalls((c) => [data, ...c.filter((x) => x.mint !== data.mint)].slice(0, 20));
  });
  const now = useNow(1000);
  const list = useMemo(() => Object.values(rows)
    .filter((r) => now - r.created <= f.maxAgeMin * 60)
    .filter((r) => r.score >= f.minScore && (!f.tiers.length || f.tiers.includes(r.tier)))
    .filter((r) => !(f.hideBundled && r.bundled) && !(f.alphaOnly && !r.alpha?.length))
    .filter((r) => !f.provenDev || r.detectors.some((d) => d.key === 'dev' && d.points > 0))
    .sort((a, b) => (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) || (b.score - a.score) || (b.created - a.created)),
  [rows, f, now]);
  return { list, meta, calls, now };
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
      const n = new Notification(`🎯 SNIPE ${data.symbol || short(data.mint)} · ${Math.round(data.score)}`, { body: (data.detectors || []).filter((d: Detector) => d.points > 0).map((d: Detector) => d.label).join(' · '), tag: data.mint });
      n.onclick = () => { window.focus(); location.href = `/token?a=${data.mint}`; };
    }
  });
  return { on, toggle };
}

export function ScoreDial({ score, tier, size = 44 }: { score: number; tier: string; size?: number }) {
  const r = size / 2 - 3, c = 2 * Math.PI * r;
  const color = tier === 'SNIPE' ? 'var(--color-up)' : tier === 'WATCH' ? 'var(--color-warn)' : tier === 'TRAP' ? 'var(--color-down)' : 'var(--color-mute)';
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-edge)" strokeWidth={3} />
        <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round"
          strokeDasharray={c} initial={false} animate={{ strokeDashoffset: c * (1 - Math.min(100, score) / 100) }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
      </svg>
      <span className="stat absolute text-[15px] leading-none" style={{ color }}>{Math.round(score)}</span>
    </span>
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

/** One launch: score dial, tier, curve/ETA, the detectors that fired, and one-click links to your own trading terminal. */
export const SnipeCard = memo(function SnipeCard({ r, now, dense = false, selected = false }: { r: SnipeRow; now: number; dense?: boolean; selected?: boolean }) {
  const age = Math.max(0, now - r.created);
  const fired = r.detectors.filter((d) => d.points !== 0).sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return (
    <div data-mint={r.mint} className={`group relative rounded-2xl border px-3 py-2.5 transition-colors ${selected ? 'ring-2 ring-white/70 ring-offset-2 ring-offset-[var(--color-bg)] ' : ''}${r.tier === 'SNIPE' ? 'snipe-glow border-up/40 bg-up/[0.04]' : r.tier === 'TRAP' ? 'border-down/20 bg-down/[0.025]' : 'border-white/[0.07] bg-white/[0.015] hover:border-white/20'}`}>
      <div className="flex items-center gap-3">
        <ScoreDial score={r.score} tier={r.tier} size={dense ? 38 : 44} />
        <Link href={`/token?a=${r.mint}`} className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
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
        <div className="flex flex-col items-end gap-1">
          <CopyCA mint={r.mint} />
        </div>
      </div>
      <div className="mt-2"><CurveBar r={r} /></div>
      {fired.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {fired.slice(0, dense ? 4 : 6).map((d) => (
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
}, (a, b) => a.r === b.r && a.dense === b.dense && a.selected === b.selected && Math.floor(a.now) === Math.floor(b.now));

/** The dedicated sniping column on the Home terminal. */
export function SnipeColumn({ className = '' }: { className?: string }) {
  const [mode, setMode] = useState<'hot' | 'all' | 'fresh'>('hot');
  const f = useMemo<SnipeFilters>(() => ({ ...DEFAULT_FILTERS, tiers: mode === 'hot' ? ['SNIPE', 'WATCH'] : [], maxAgeMin: mode === 'fresh' ? 2 : 30, hideBundled: mode !== 'all' }), [mode]);
  const { list, meta, now } = useSnipe(f);
  const alerts = useSnipeAlerts();
  return (
    <section className={`glass flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl ${className}`}>
      <header className="panel-head flex items-center gap-2 px-3.5 py-2">
        <Icon name="target" size={15} className="text-up" />
        <h2 className="text-[12.5px] font-semibold">Snipe</h2>
        <span className="flex items-center gap-1 text-[10.5px] text-up"><span className="live-dot h-1.5 w-1.5 rounded-full bg-up" />{meta?.tracking ?? 0} live</span>
        <span className="flex-1" />
        <div className="flex rounded-full border border-white/10 p-0.5 text-[10px] font-bold uppercase tracking-wider">
          {(['hot', 'fresh', 'all'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`rounded-full px-2 py-0.5 transition ${mode === m ? 'bg-white text-black' : 'text-white/50 hover:text-white'}`}>{m === 'hot' ? 'Hot' : m === 'fresh' ? '<2m' : 'All'}</button>
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
              <SnipeCard r={r} now={now} dense />
            </motion.div>
          ))}
        </AnimatePresence>
        {!list.length && <p className="p-8 text-center text-[12px] text-white/40">{mode === 'hot' ? 'No launch is hot right now. New pump.fun coins are scored from their first trade.' : 'Waiting for pump.fun launches…'}</p>}
      </div>
    </section>
  );
}
