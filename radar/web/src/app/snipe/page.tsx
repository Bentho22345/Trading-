'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { AnimatePresence, motion } from '@/components/motion';
import {
  type Appetite, APPETITES, DEFAULT_FILTERS, RiskMap, type Rule, saveStrategy, type SnipeFilters, SnipeCard, type SnipeRow,
  TRADE_LINKS, useSnipe, useSnipeAlerts, useStrategies,
} from '@/components/snipe';
import { CountUp, Reveal, Ring } from '@/components/whoop';
import { api } from '@/lib/api';

type MetricDef = { label: string; unit: string; kind: 'num' | 'bool' };
const LANES = [
  { key: 'BEST', title: 'Best for you', sub: 'Ranked by upside minus your risk penalty', color: 'var(--color-up)' },
  { key: 'NEW', title: 'Just born', sub: 'First 90 seconds, scored on every trade', color: 'var(--color-accent2)' },
  { key: 'STRETCH', title: 'Final stretch', sub: '70%+ of the bonding curve', color: 'var(--color-warn)' },
] as const;

export default function SnipePage() {
  const [f, setF] = useState<SnipeFilters>({ ...DEFAULT_FILTERS, appetite: 'balanced', hideBundled: false });
  useEffect(() => { try { setF((x) => ({ ...x, ...JSON.parse(localStorage.getItem('radar:snipe-f2') || '{}') })); } catch { /* */ } }, []);
  useEffect(() => { try { localStorage.setItem('radar:snipe-f2', JSON.stringify(f)); } catch { /* */ } }, [f]);
  const set = (p: Partial<SnipeFilters>) => setF((x) => ({ ...x, ...p }));
  const { list, meta, calls, now } = useSnipe(f);
  const { list: strategies, reload } = useStrategies();
  const names = useMemo(() => Object.fromEntries(strategies.map((s) => [s.id, s.name])), [strategies]);
  const alerts = useSnipeAlerts();
  const [builder, setBuilder] = useState(false);
  const [proof, setProof] = useState<any>(null);
  useEffect(() => { const l = () => api('/api/snipe/proof?hours=24').then(setProof).catch(() => {}); l(); const t = setInterval(l, 30000); return () => clearInterval(t); }, []);
  const ap = f.appetite || 'balanced';
  const lanes = useMemo(() => ({
    BEST: list.filter((r) => (r.scores?.[ap] ?? r.score) > 0 && now - r.created >= 8),
    NEW: list.filter((r) => now - r.created < 90).sort((a, b) => b.created - a.created),
    STRETCH: list.filter((r) => (r.progress ?? 0) >= 70 && !r.graduated_at),
  }), [list, now, ap]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of list) for (const s of r.strategies || []) c[s] = (c[s] || 0) + 1;
    return c;
  }, [list]);

  // keyboard sniping: J/K move, C copy CA, A/P/B/G open a terminal, Enter opens the coin (selection follows the coin)
  const router = useRouter();
  const order = useMemo(() => [...lanes.BEST, ...lanes.NEW, ...lanes.STRETCH].slice(0, 200).map((r) => r.mint), [lanes]);
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
      if (k === '1' || k === '2' || k === '3') { set({ appetite: (['safe', 'balanced', 'degen'] as Appetite[])[+k - 1] }); flash(`${['Safe', 'Balanced', 'Degen'][+k - 1]} mode`); return; }
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
  const activeStrat = strategies.find((s) => s.id === f.strategy);

  return (
    <div className="pt-4">
      <AnimatePresence>{toast && <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-white px-4 py-2 text-[12px] font-bold text-black shadow-xl">{toast}</motion.div>}</AnimatePresence>
      <Reveal className="mb-6 grid items-end gap-8 lg:grid-cols-[1fr_auto]">
        <div>
          <div className="eyebrow mb-3 flex items-center gap-2"><span className="live-dot h-1.5 w-1.5 rounded-full bg-up" />Sniper · pump.fun · scored per trade · Mayhem coins hidden</div>
          <h1 className="display text-[60px] md:text-[104px]">Snipe <span className="text-up">smarter.</span></h1>
          <p className="mt-3 max-w-2xl text-[15px] text-white/60">Every launch gets two numbers, from its first trade: <b className="text-up">upside</b> (top wallets in, curve speed, people talking,
            hot meta, socials) and <b className="text-down">risk</b> (bundlers, snipers, top-10 and dev bags, no socials). Pick how much risk you’ll take — a coin doesn’t need to be perfect to be worth a shot.</p>
        </div>
        <div className="flex flex-wrap gap-4 sm:gap-6">
          <Ring value={meta?.tracking} max={Math.max(50, meta?.tracking || 0)} size={104} color="var(--color-accent2)" label="Scoring now"><CountUp value={meta?.tracking} className="stat text-[28px]" /></Ring>
          <Ring value={st?.calls} max={Math.max(10, st?.calls || 0)} size={104} color="var(--color-up)" label="Calls · 24h"><CountUp value={st?.calls} className="stat text-[28px]" /></Ring>
          <Ring value={st?.hit_2x_pct ?? 0} max={100} size={104} color="var(--color-flash)" label="Hit 2× · 24h"><span className="stat text-[26px]">{st?.hit_2x_pct != null ? `${Math.round(st.hit_2x_pct)}%` : '—'}</span></Ring>
        </div>
      </Reveal>

      {/* appetite + controls */}
      <div className="sticky top-[60px] z-20 -mx-1 mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-white/[0.06] bg-black/80 p-2 backdrop-blur-xl">
        <div className="flex rounded-full border border-white/10 p-1">
          {APPETITES.map((a) => (
            <button key={a.value} onClick={() => set({ appetite: a.value })} title={a.sub}
              className={`relative rounded-full px-4 py-1.5 text-[12px] font-extrabold uppercase tracking-[0.12em] transition-colors ${ap === a.value ? (a.value === 'degen' ? 'text-black' : 'text-black') : 'text-white/55 hover:text-white'}`}>
              {ap === a.value && <motion.span layoutId="appetite" className={`absolute inset-0 -z-10 rounded-full ${a.value === 'degen' ? 'bg-warn' : a.value === 'safe' ? 'bg-up' : 'bg-white'}`} transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              {a.label}
            </button>
          ))}
        </div>
        <span className="hidden text-[11px] text-white/45 md:inline">{APPETITES.find((a) => a.value === ap)?.sub}</span>
        <button onClick={() => set({ hideBundled: !f.hideBundled })} className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold transition ${f.hideBundled ? 'border-white bg-white text-black' : 'border-white/10 text-white/60 hover:text-white'}`}>Hide bundles</button>
        <div className="flex rounded-full border border-white/10 p-0.5 text-[11px] font-bold">
          {[5, 15, 30].map((m) => (
            <button key={m} onClick={() => set({ maxAgeMin: m })} className={`rounded-full px-2.5 py-1 ${f.maxAgeMin === m ? 'bg-white text-black' : 'text-white/55 hover:text-white'}`}>≤{m}m</button>
          ))}
        </div>
        <button onClick={() => setBuilder(!builder)} className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition ${builder || f.rules?.length ? 'border-accent bg-accent/15 text-accent' : 'border-white/10 text-white/60 hover:text-white'}`}>
          <Icon name="settings" size={13} />Filters{f.rules?.length ? ` · ${f.rules.length}` : ''}
        </button>
        <button onClick={alerts.toggle} className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold ${alerts.on ? 'border-up/50 bg-up/10 text-up' : 'border-white/10 text-white/60 hover:text-white'}`}><Icon name={alerts.on ? 'sound' : 'mute'} size={13} />{alerts.on ? 'Alerts on' : 'Alerts'}</button>
        <span className="hidden items-center gap-1 text-[10.5px] text-white/40 2xl:flex">
          {[['1-3', 'appetite'], ['J/K', 'move'], ['C', 'copy'], ['A/P', 'Axiom/Photon'], ['↵', 'open']].map(([k, l]) => <span key={k} className="ml-1.5"><kbd className="rounded border border-white/15 px-1 font-mono text-white/70">{k}</kbd> {l}</span>)}
        </span>
        <span className="num ml-auto pr-2 text-[11px] text-white/45">{meta ? `${list.length} shown · ${meta.seen.toLocaleString()} scored` : 'connecting…'}</span>
      </div>

      {/* strategy rail */}
      <div className="scroll-x mb-3 flex gap-2 pb-1">
        <StratPill active={!f.strategy} onClick={() => set({ strategy: undefined })} name="Everything" count={list.length} />
        {strategies.filter((s) => s.enabled).map((s) => (
          <StratPill key={s.id} active={f.strategy === s.id} onClick={() => set({ strategy: f.strategy === s.id ? undefined : s.id, appetite: s.appetite || ap })}
            name={s.name} count={counts[s.id] || 0} hit={s.stats.hit_2x_pct} n={s.stats.hits} kind={s.source} />
        ))}
        <Link href="/playbook" className="flex shrink-0 items-center gap-1.5 rounded-2xl border border-dashed border-white/15 px-3 py-2 text-[12px] text-white/50 hover:text-white">+ Playbook</Link>
      </div>
      {activeStrat && (
        <p className="mb-3 text-[12px] text-white/55"><b className="text-white">{activeStrat.name}:</b> {activeStrat.description} {activeStrat.rules.map((r) => `${r.metric} ${r.op} ${String(r.value)}`).join(' · ')}</p>
      )}

      <AnimatePresence>{builder && <Builder rules={f.rules || []} onChange={(rules) => set({ rules })} onSaved={reload} appetite={ap} />}</AnimatePresence>

      {calls.length > 0 && (
        <div className="scroll-x mb-3 flex gap-2">
          {calls.slice(0, 8).map((c) => (
            <Link key={c.mint} href={`/token?a=${c.mint}`} className="snipe-glow flex shrink-0 items-center gap-2 rounded-full border border-up/40 bg-up/10 px-3 py-1 text-[12px]">
              <span className="text-up">🎯</span><b>{c.symbol}</b><span className="num text-up">{Math.round(c.score)}</span>
            </Link>
          ))}
        </div>
      )}

      <section className="glass mb-4 overflow-hidden rounded-[28px]">
        <header className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-3">
          <span className="display text-[24px]">Risk × Upside</span>
          <span className="text-[11px] text-white/45">every live launch · size = 5m volume · click a dot to select it</span>
        </header>
        <RiskMap rows={list} selected={sel} onPick={(m) => { setSel(m); document.querySelector(`[data-mint="${m}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }} className="h-[300px] md:h-[360px]" />
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        {LANES.map((c) => (
          <section key={c.key} className="glass flex h-[calc(100vh-230px)] min-h-[560px] flex-col overflow-hidden rounded-[28px]">
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
                    <SnipeCard r={r} now={now} selected={r.mint === sel} appetite={ap} names={names} />
                  </motion.div>
                ))}
              </AnimatePresence>
              {!lanes[c.key].length && <p className="p-10 text-center text-white/35">{meta ? 'Nothing here right now.' : ''}</p>}
              {!meta && [0, 1, 2].map((i) => <div key={i} className="skeleton m-1 h-36" />)}
            </div>
          </section>
        ))}
      </div>

      <Reveal className="mt-16 grid gap-6 lg:grid-cols-[1fr_1fr]">
        <div className="glass rounded-3xl p-8">
          <div className="eyebrow mb-3">How to snipe with Radar</div>
          <ol className="space-y-3 text-[14px] text-white/70">
            <li><b className="text-white">1 · Set your appetite.</b> Degen ranks by upside and barely counts risk; Safe counts every red flag in full. Keys 1-3 switch it.</li>
            <li><b className="text-white">2 · Pick a playbook.</b> Strategies come from what trader guides teach, the crowd consensus of everything digested on the Playbook page, or your own filters — each graded on Proof.</li>
            <li><b className="text-white">3 · Read the strip.</b> H holders · T10 top-10 % · DEV dev bag (or “sold”) · SNP snipers · BND bundlers · PRO pro traders. Green is inside the usual guide thresholds.</li>
            <li><b className="text-white">4 · Move fast.</b> J/K to move, C to copy the CA, A/P/B/G to open Axiom / Photon / BullX / GMGN. Radar never holds keys or trades for you.</li>
          </ol>
        </div>
        <div className="glass rounded-3xl p-8 text-[13px] leading-relaxed text-white/55">
          <div className="eyebrow mb-3">Honest limits</div>
          <p>Holder metrics come from Radar’s own copy of each coin’s trade stream; if Radar subscribed late, the card says “partial” and how much it saw.
            Insider detection needs wallet-funding history and isn’t estimated. Mayhem Mode launches are detected from their 2B supply (or an explicit flag) and hidden.
            Scores are probabilistic; most pump.fun coins go to zero, including well-scored ones. Only risk what you can lose.</p>
        </div>
      </Reveal>
    </div>
  );
}

function StratPill({ active, onClick, name, count, hit, n, kind }: { active: boolean; onClick: () => void; name: string; count: number; hit?: number | null; n?: number; kind?: string }) {
  return (
    <button onClick={onClick} className={`flex shrink-0 items-center gap-2 rounded-2xl border px-3 py-2 text-left transition ${active ? 'border-white bg-white text-black' : 'border-white/10 hover:border-white/30'}`}>
      <span>
        <span className="flex items-center gap-1.5 text-[12px] font-bold">{kind === 'playbook' && <span title="Crowd consensus from digested videos/guides">✦</span>}{kind === 'custom' && <span title="Yours">★</span>}{name}</span>
        <span className={`num block text-[10px] ${active ? 'text-black/60' : 'text-white/45'}`}>{hit != null ? `${hit}% hit 2× · ${n} graded` : n ? `${n} graded` : 'grading…'}</span>
      </span>
      <span className={`stat rounded-lg px-1.5 text-[16px] ${active ? 'bg-black/10' : 'bg-white/[0.06]'}`}>{count}</span>
    </button>
  );
}

function Builder({ rules, onChange, onSaved, appetite }: { rules: Rule[]; onChange: (r: Rule[]) => void; onSaved: () => void; appetite: Appetite }) {
  const [defs, setDefs] = useState<Record<string, MetricDef>>({});
  const [name, setName] = useState('');
  const [alert, setAlert] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { api('/api/snipe/metrics').then(setDefs).catch(() => {}); }, []);
  const keys = Object.keys(defs).filter((k) => !['upside', 'risk'].includes(k)).concat(['upside', 'risk']);
  const upd = (i: number, p: Partial<Rule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const QUICK: [string, Rule[]][] = [
    ['Guide-clean', [{ metric: 'top10_pct', op: '<=', value: 30 }, { metric: 'dev_hold_pct', op: '<=', value: 5 }, { metric: 'bundle_hold_pct', op: '<=', value: 10 }]],
    ['Has socials', [{ metric: 'socials', op: '>=', value: 1 }]],
    ['Dev sold', [{ metric: 'dev_sold', op: '==', value: true }]],
    ['People talking', [{ metric: 'social_authors', op: '>=', value: 2 }]],
    ['Under $20k', [{ metric: 'mcap_usd', op: '<=', value: 20000 }]],
    ['Buyers in control', [{ metric: 'buy_ratio_1m', op: '>=', value: 1.5 }]],
  ];
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-4 overflow-hidden">
      <div className="glass rounded-3xl p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="eyebrow">Filter builder</span>
          {QUICK.map(([l, rs]) => (
            <button key={l} onClick={() => onChange([...rules.filter((r) => !rs.some((q) => q.metric === r.metric && q.op === r.op)), ...rs])}
              className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-white/70 hover:border-white/40 hover:text-white">+ {l}</button>
          ))}
          {rules.length > 0 && <button onClick={() => onChange([])} className="ml-auto text-[11px] text-white/45 hover:text-white">Clear</button>}
        </div>
        <div className="space-y-2">
          {rules.map((r, i) => {
            const d = defs[r.metric];
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select value={r.metric} onChange={(e) => upd(i, { metric: e.target.value, value: defs[e.target.value]?.kind === 'bool' ? true : 0 })}
                  className="rounded-xl border border-white/10 bg-panel2 px-2 py-1.5 text-[12px]">
                  {keys.map((k) => <option key={k} value={k}>{defs[k]?.label || k}</option>)}
                </select>
                {d?.kind === 'bool' ? (
                  <select value={String(r.value)} onChange={(e) => upd(i, { op: '==', value: e.target.value === 'true' })} className="rounded-xl border border-white/10 bg-panel2 px-2 py-1.5 text-[12px]">
                    <option value="true">yes</option><option value="false">no</option>
                  </select>
                ) : (
                  <>
                    <select value={r.op} onChange={(e) => upd(i, { op: e.target.value })} className="rounded-xl border border-white/10 bg-panel2 px-2 py-1.5 text-[12px]">
                      {['<=', '>=', '<', '>'].map((o) => <option key={o}>{o}</option>)}
                    </select>
                    <input type="number" value={String(r.value)} onChange={(e) => upd(i, { value: +e.target.value })} className="num w-28 rounded-xl border border-white/10 bg-transparent px-2 py-1.5 text-[12px]" />
                    <span className="text-[11px] text-white/40">{d?.unit}</span>
                  </>
                )}
                <button onClick={() => onChange(rules.filter((_, j) => j !== i))} className="text-white/40 hover:text-down"><Icon name="x" size={14} /></button>
              </div>
            );
          })}
          <button onClick={() => onChange([...rules, { metric: 'holders', op: '>=', value: 20 }])} className="rounded-full border border-dashed border-white/20 px-3 py-1 text-[12px] text-white/60 hover:text-white">+ Add rule</button>
        </div>
        {rules.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this strategy" className="rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-[12px]" />
            <label className="flex items-center gap-1.5 text-[12px] text-white/60"><input type="checkbox" checked={alert} onChange={(e) => setAlert(e.target.checked)} />Alert me on every match</label>
            <button disabled={!name} onClick={() => saveStrategy({ name, rules, appetite, alert }).then(() => { setMsg('Saved — it’s graded on Proof from now on'); onSaved(); }).catch((e) => setMsg(String(e.message || e)))}
              className="btn-primary !py-2 !text-[11px] disabled:opacity-40">Save as strategy</button>
            <span className="text-[11px] text-white/50">{msg}</span>
          </div>
        )}
      </div>
    </motion.div>
  );
}
