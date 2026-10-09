'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { AnimatePresence, motion } from '@/components/motion';
import { DEFAULT_FILTERS, DET_ICON, type SnipeFilters, SnipeCard, type SnipeRow, TRADE_LINKS, useSnipe, useSnipeAlerts } from '@/components/snipe';
import { CountUp, Reveal, Ring } from '@/components/whoop';
import { api } from '@/lib/api';

const LANES = [
  { key: 'SNIPE', title: 'Snipe', sub: 'Every signal lines up — logged on Proof', color: 'var(--color-up)' },
  { key: 'WATCH', title: 'Heating', sub: 'Building — one or two detectors firing', color: 'var(--color-warn)' },
  { key: 'NEW', title: 'Just born', sub: 'First 90 seconds, scored on every trade', color: 'var(--color-accent2)' },
] as const;

const DETECTORS = [
  ['alpha', 'Alpha entry', 'Top-1,000 ranked wallets (real P&L) or wallets you follow buying in the first minutes.'],
  ['velocity', 'Curve velocity', 'SOL per minute flowing into the bonding curve, buyer acceleration, and a graduation ETA from the curve’s actual trajectory.'],
  ['organic', 'Organic flow', 'Distinct buyers vs bundles: wallets grabbing supply in the creation block, identical bot-sized buys, top-3 concentration.'],
  ['dev', 'Dev track record', 'Every coin this deployer launched in the last 30 days that Radar saw: how many graduated, best peak — and live dev selling.'],
  ['meta', 'Meta match', 'The name fits a meta that is hot right now (live heat from social, launches and volume), or copies a trending ticker.'],
  ['social', 'Social spread', 'Distinct authors and sources posting the contract or $ticker in the last 30 minutes, and whether a VIP did.'],
];

export default function SnipePage() {
  const [f, setF] = useState<SnipeFilters>(() => {
    try { return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem('radar:snipe-f') || '{}') }; } catch { return DEFAULT_FILTERS; }
  });
  useEffect(() => { try { localStorage.setItem('radar:snipe-f', JSON.stringify(f)); } catch { /* */ } }, [f]);
  const { list, meta, calls, now } = useSnipe({ ...f, tiers: [] });
  const alerts = useSnipeAlerts();
  const [proof, setProof] = useState<any>(null);
  useEffect(() => { const l = () => api('/api/snipe/proof?hours=24').then(setProof).catch(() => {}); l(); const t = setInterval(l, 30000); return () => clearInterval(t); }, []);
  const lanes = useMemo(() => ({
    SNIPE: list.filter((r) => r.tier === 'SNIPE'),
    WATCH: list.filter((r) => r.tier === 'WATCH'),
    NEW: list.filter((r) => now - r.created < 90 && r.tier !== 'SNIPE' && r.tier !== 'WATCH').sort((a, b) => b.created - a.created),
  }), [list, now]);
  const set = (p: Partial<SnipeFilters>) => setF((x) => ({ ...x, ...p }));

  // keyboard sniping: J/K (or ↓/↑) move through Snipe → Heating → Just born, C copies the CA, A/P/B/G open a terminal,
  // Enter opens the coin. The selection follows the coin (not the slot), so live re-sorting never moves it under you.
  const router = useRouter();
  const order = useMemo(() => [...lanes.SNIPE, ...lanes.WATCH, ...lanes.NEW].slice(0, 180).map((r) => r.mint), [lanes]);
  const [sel, setSel] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const orderRef = useRef(order);
  orderRef.current = order;
  useEffect(() => {
    const flash = (m: string) => { setToast(m); window.setTimeout(() => setToast(''), 1200); };
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const o = orderRef.current;
      if (!o.length) return;
      const k = e.key.toLowerCase();
      const i = sel ? o.indexOf(sel) : -1;
      if (k === 'j' || e.key === 'ArrowDown' || k === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = o[Math.max(0, Math.min(o.length - 1, i + (k === 'j' || e.key === 'ArrowDown' ? 1 : -1)))] ?? o[0];
        setSel(next);
        document.querySelector(`[data-mint="${next}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const m = sel && o.includes(sel) ? sel : o[0];
      if (k === 'c') { e.preventDefault(); navigator.clipboard?.writeText(m).then(() => flash('CA copied')); }
      else if (e.key === 'Enter') router.push(`/token?a=${m}`);
      else if ('apbg'.includes(k) && k.length === 1) {
        const l = TRADE_LINKS(m)[{ a: 0, p: 1, b: 2, g: 3 }[k as 'a' | 'p' | 'b' | 'g']];
        window.open(l.href, '_blank', 'noopener');
        flash(`Opened ${l.label}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, router]);
  const st = proof?.stats;

  return (
    <div className="pt-4">
      <AnimatePresence>{toast && <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-white px-4 py-2 text-[12px] font-bold text-black shadow-xl">{toast}</motion.div>}</AnimatePresence>
      <Reveal className="mb-8 grid items-end gap-8 lg:grid-cols-[1fr_auto]">
        <div>
          <div className="eyebrow mb-3 flex items-center gap-2"><span className="live-dot h-1.5 w-1.5 rounded-full bg-up" />Sniper · pump.fun · scored per trade</div>
          <h1 className="display text-[64px] md:text-[112px]">Be <span className="text-up">first.</span></h1>
          <p className="mt-4 max-w-2xl text-[16px] text-white/60">Every new pump.fun coin is scored from its very first trade by six live detectors, pushed to this page in milliseconds.
            When everything lines up it’s called <b className="text-up">SNIPE</b> and logged — then its real outcome is tracked on <Link href="/proof" className="underline decoration-white/30 underline-offset-4 hover:text-white">Proof</Link>.</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button onClick={alerts.toggle} className={alerts.on ? 'btn-primary' : 'btn-ghost'}><Icon name={alerts.on ? 'sound' : 'mute'} size={14} />{alerts.on ? 'Alerts on' : 'Turn on alerts'}</button>
            <Link href="/proof" className="btn-ghost">See the proof <Icon name="arrow" size={14} /></Link>
          </div>
        </div>
        <div className="flex flex-wrap gap-4 sm:gap-6 [&>div]:scale-[.82] [&>div]:origin-top-left sm:[&>div]:scale-100">
          <Ring value={meta?.tracking} max={Math.max(50, meta?.tracking || 0)} size={116} color="var(--color-accent2)" label="Scoring now"><CountUp value={meta?.tracking} className="stat text-[30px]" /></Ring>
          <Ring value={st?.calls} max={Math.max(10, st?.calls || 0)} size={116} color="var(--color-up)" label="Calls · 24h"><CountUp value={st?.calls} className="stat text-[30px]" /></Ring>
          <Ring value={st?.hit_2x_pct ?? 0} max={100} size={116} color="var(--color-flash)" label="Hit 2× · 24h">
            <span className="stat text-[28px]">{st?.hit_2x_pct != null ? `${Math.round(st.hit_2x_pct)}%` : '—'}</span>
          </Ring>
        </div>
      </Reveal>

      <div className="sticky top-[60px] z-20 -mx-1 mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-white/[0.06] bg-black/80 p-2 backdrop-blur-xl">
        <label className="flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-[12px] text-white/70">
          Min score <input type="range" min={0} max={90} step={5} value={f.minScore} onChange={(e) => set({ minScore: +e.target.value })} className="w-28 accent-[var(--color-up)]" />
          <b className="num w-6 text-white">{f.minScore}</b>
        </label>
        {([['hideBundled', 'Hide bundles'], ['alphaOnly', 'Top wallets in'], ['provenDev', 'Proven dev']] as const).map(([k, l]) => (
          <button key={k} onClick={() => set({ [k]: !f[k] } as Partial<SnipeFilters>)}
            className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold transition ${f[k] ? 'border-white bg-white text-black' : 'border-white/10 text-white/60 hover:text-white'}`}>{l}</button>
        ))}
        <div className="flex rounded-full border border-white/10 p-0.5 text-[11px] font-bold">
          {[5, 15, 30].map((m) => (
            <button key={m} onClick={() => set({ maxAgeMin: m })} className={`rounded-full px-2.5 py-1 ${f.maxAgeMin === m ? 'bg-white text-black' : 'text-white/55 hover:text-white'}`}>≤{m}m</button>
          ))}
        </div>
        <span className="hidden items-center gap-1 text-[10.5px] text-white/40 xl:flex" title="Keyboard sniping">
          {[['J/K', 'move'], ['C', 'copy CA'], ['A', 'Axiom'], ['P', 'Photon'], ['↵', 'open']].map(([k, l]) => <span key={k} className="ml-1.5"><kbd className="rounded border border-white/15 px-1 font-mono text-white/70">{k}</kbd> {l}</span>)}
        </span>
        <span className="num ml-auto pr-2 text-[11px] text-white/45">{meta ? `${meta.seen.toLocaleString()} launches scored since start` : 'connecting…'}</span>
      </div>

      <AnimatePresence>
        {calls.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mb-4 overflow-hidden">
            <div className="scroll-x flex gap-2">
              {calls.slice(0, 8).map((c) => (
                <Link key={c.mint} href={`/token?a=${c.mint}`} className="snipe-glow flex shrink-0 items-center gap-2 rounded-full border border-up/40 bg-up/10 px-3 py-1 text-[12px]">
                  <span className="text-up">🎯</span><b>{c.symbol}</b><span className="num text-up">{Math.round(c.score)}</span>
                </Link>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid gap-4 lg:grid-cols-3">
        {LANES.map((c) => (
          <section key={c.key} className="glass flex h-[calc(100vh-250px)] min-h-[560px] flex-col overflow-hidden rounded-[28px]">
            <header className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-4">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.color, boxShadow: `0 0 10px ${c.color}` }} />
              <span className="display text-[26px]">{c.title}</span>
              <span className="stat ml-1 text-[20px] text-white/35">{lanes[c.key].length}</span>
              <span className="ml-auto text-right text-[11px] text-white/40">{c.sub}</span>
            </header>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
              <AnimatePresence initial={false} mode="popLayout">
                {lanes[c.key].slice(0, 60).map((r: SnipeRow) => (
                  <motion.div key={r.mint} layout="position" initial={{ opacity: 0, y: -12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, x: 30 }} transition={{ type: 'spring', stiffness: 420, damping: 34 }}>
                    <SnipeCard r={r} now={now} selected={r.mint === sel} />
                  </motion.div>
                ))}
              </AnimatePresence>
              {!lanes[c.key].length && <p className="p-10 text-center text-white/35">{meta ? 'Nothing here right now.' : ''}</p>}
              {!meta && [0, 1, 2].map((i) => <div key={i} className="skeleton m-1 h-32" />)}
            </div>
          </section>
        ))}
      </div>

      <Reveal className="mt-16">
        <div className="eyebrow mb-3">How the score is built</div>
        <h2 className="display mb-8 text-[44px] md:text-[64px]">Six detectors. Real data only.</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {DETECTORS.map(([k, t, d], i) => {
            const s = st?.by_detector?.[k];
            return (
              <Reveal key={k} delay={i * 0.05} className="glass spotlight rounded-3xl p-6">
                <div className="mb-3 flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-up/10 text-up"><Icon name={DET_ICON[k]} size={18} /></span>
                  <h3 className="display text-[26px]">{t}</h3>
                  {s && <span className="num ml-auto text-right text-[11px] text-white/50">{s.calls} calls<br /><b className="text-white">{s.hit_2x_pct}%</b> hit 2×</span>}
                </div>
                <p className="text-[13px] leading-relaxed text-white/60">{d}</p>
              </Reveal>
            );
          })}
        </div>
      </Reveal>

      <Reveal className="mt-16 grid gap-6 lg:grid-cols-[1fr_1fr]">
        <div className="glass rounded-3xl p-8">
          <div className="eyebrow mb-3">Best way to snipe with Radar</div>
          <ol className="space-y-3 text-[14px] text-white/70">
            <li><b className="text-white">1 · Keep this page open.</b> Launches arrive over the socket the instant pump.fun emits them and are re-scored on every trade — no refresh, no polling.</li>
            <li><b className="text-white">2 · Turn on alerts.</b> Sound + desktop notification on every SNIPE call; Telegram too if it’s connected in Connectors.</li>
            <li><b className="text-white">3 · Filter hard.</b> Hide bundles, require top wallets or a proven dev. Fewer, better calls.</li>
            <li><b className="text-white">4 · One click to your terminal.</b> Copy CA or jump to Axiom / Photon / BullX / GMGN. Radar never holds keys and never trades for you.</li>
            <li><b className="text-white">5 · Calibrate on Proof.</b> Every call is logged with its inputs and its real outcome — trust the detectors that earn it.</li>
          </ol>
        </div>
        <div className="glass rounded-3xl p-8 text-[13px] leading-relaxed text-white/55">
          <div className="eyebrow mb-3">Honest limits</div>
          <p>Scores are probabilistic, not advice. Most pump.fun coins go to zero, including many that score well. A peak multiple is the highest value reached after the call — not a realized
            return after slippage, fees and the time it takes you to act. Radar only sees what its connected sources see: PumpPortal’s live stream, your Top Traders pool, your social
            connectors and the public trending lists. Only risk money you can afford to lose.</p>
        </div>
      </Reveal>
    </div>
  );
}
