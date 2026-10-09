'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { AnimatePresence, motion } from '@/components/motion';
import { Reveal } from '@/components/whoop';
import { RaceList, TIER_TONE, TweetCard, useXTweets } from '@/components/x';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useNow, usePoll } from '@/lib/live';

const CATS = ['', 'celebrity', 'politician', 'founder', 'kol', 'caller', 'news', 'culture', 'exchange', 'launchpad', 'ecosystem', 'onchain', 'search'];
const compact = (v?: number | null) => (v == null ? '—' : Intl.NumberFormat('en', { notation: 'compact' }).format(v));

export default function XRadarPage() {
  const [minScore, setMinScore] = useState(0);
  const [cat, setCat] = useState('');
  const rows = useXTweets(24, 150, minScore);
  const [st, setSt] = useState<any>(null);
  const [callers, setCallers] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const now = useNow(5000);
  usePoll(() => api('/api/x/status').then(setSt).catch(() => {}), 10000);
  usePoll(() => { api('/api/x/callers?days=7').then(setCallers).catch(() => {}); api('/api/x/events?limit=40').then(setEvents).catch(() => {}); }, 30000);
  const shown = useMemo(() => rows.filter((t) => !cat || t.category === cat), [rows, cat]);

  return (
    <div className="pt-4">
      <Reveal className="mb-8">
        <div className="eyebrow mb-3">X Radar · where memecoin narratives are born</div>
        <h1 className="display text-[60px] md:text-[104px]">Every tweet that <span className="text-flash">could be a coin.</span></h1>
        <p className="mt-4 max-w-3xl text-[16px] text-white/60">
          Radar watches the accounts that move memecoins — Elon, Trump and family, founders, the big KOLs, viral-culture and breaking-news
          accounts, exchanges. Each tweet is scored for <b className="text-white">coinability</b>: who posted it, whether it has a picture,
          short catchy wording, new names and phrases, how fast it&apos;s spreading, and what Claude thinks. Radar matches the tweet against
          every pump.fun launch that follows (<b className="text-white">coin races</b>), grades every coin an account calls, and learns which
          callers are worth following. It also watches the top accounts&apos; names, bios, profile pictures and newest follows.
        </p>
        <div className="num mt-5 flex flex-wrap gap-2 text-[12px]">
          <span className={`rounded-full px-3 py-1 font-semibold ${st?.connected ? 'bg-up/15 text-up' : 'bg-white/[0.06] text-white/55'}`}>{st?.connected ? '● live' : '○ add your X bearer token on Connectors'}</span>
          <span className="rounded-full bg-white/[0.06] px-3 py-1">{st?.accounts ?? '—'} accounts · S {st?.tiers?.S ?? 0} / A {st?.tiers?.A ?? 0} / B {st?.tiers?.B ?? 0}</span>
          <span className="rounded-full bg-white/[0.06] px-3 py-1">{compact(st?.posts)} tweets read · {compact(st?.ai_read)} read by Claude</span>
          <span className="rounded-full bg-flash/15 px-3 py-1 text-flash">🏁 {st?.spawns ?? 0} coins spawned · {st?.races ?? 0} races · {st?.calls ?? 0} calls graded</span>
          {st?.last_error && <span className="rounded-full bg-down/15 px-3 py-1 text-down">{st.last_error}</span>}
        </div>
      </Reveal>

      <div className="grid gap-6 xl:grid-cols-[1fr_400px]">
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <select value={cat} onChange={(e) => setCat(e.target.value)} className="rounded-full border border-white/15 bg-transparent px-3 py-1.5 text-[12px]">
              {CATS.map((c) => <option key={c} value={c} className="bg-[var(--color-bg)]">{c || 'All accounts'}</option>)}
            </select>
            {[0, 35, 50, 70].map((v) => (
              <button key={v} onClick={() => setMinScore(v)} className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${minScore === v ? 'bg-white text-black' : 'border border-white/15 text-white/65'}`}>
                {v ? `Score ≥ ${v}` : 'All tweets'}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-white/40">{shown.length} tweets · last 24h · newest &amp; strongest first</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <AnimatePresence initial={false} mode="popLayout">
              {shown.map((t) => (
                <motion.div key={t.id} layout="position" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <TweetCard t={t} now={now} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
          {!shown.length && <div className="glass rounded-[28px] p-10 text-center text-white/45">{st?.connected ? 'Watching… tweets appear here as the roster posts.' : 'Connect X on the Connectors page.'}</div>}
        </div>

        <aside className="space-y-4">
          <div className="glass rounded-[28px] p-5">
            <div className="mb-3 flex items-center gap-2"><span className="text-flash">🏁</span><span className="display text-[24px]">Coin races</span></div>
            <RaceList rows={rows} now={now} limit={8} />
          </div>
          <Callers rows={callers} />
          <div className="glass rounded-[28px] p-5">
            <div className="mb-3 flex items-center gap-2"><Icon name="eye" size={15} /><span className="display text-[24px]">Watchers</span></div>
            <p className="mb-3 text-[11.5px] text-white/45">Name, bio and profile-picture changes on S-tier accounts, new follows by {(st?.follow_watch || ['elonmusk']).map((h: string) => `@${h}`).join(', ')}, and roster changes Radar learned.</p>
            <ul className="space-y-2">
              {events.map((e) => (
                <li key={e.id} className="text-[12px]">
                  <span className={`mr-1.5 rounded-full px-1.5 text-[9.5px] font-bold uppercase ${e.kind === 'learned' ? 'bg-accent/15 text-accent' : 'bg-warn/15 text-warn'}`}>{e.kind}</span>
                  <b>@{e.handle}</b> <span className="text-white/60">{e.detail}</span> <span className="text-white/35">· {ago(e.ts, now)} ago</span>
                </li>
              ))}
              {!events.length && <li className="text-[12px] text-white/40">Nothing yet.</li>}
            </ul>
          </div>
          <Roster now={now} />
          <Budget st={st} onSaved={setSt} />
        </aside>
      </div>
    </div>
  );
}

function Callers({ rows }: { rows: any[] }) {
  return (
    <div className="glass rounded-[28px] p-5">
      <div className="mb-1 flex items-center gap-2"><Icon name="trophy" size={15} /><span className="display text-[24px]">Caller scoreboard</span></div>
      <p className="mb-3 text-[11.5px] text-white/45">Every $ticker / contract tweeted, graded from the market cap at the tweet. Callers with 40%+ of calls hitting 2× get promoted automatically.</p>
      <table className="num w-full text-[12px]">
        <thead><tr className="text-left text-[10.5px] uppercase tracking-wider text-white/40"><th className="pb-1">Account</th><th>Calls</th><th>2×</th><th>Avg peak</th></tr></thead>
        <tbody>
          {rows.slice(0, 15).map((r) => (
            <tr key={r.handle} className="border-t border-white/[0.05]">
              <td className="py-1.5"><a href={`https://x.com/${r.handle}`} target="_blank" rel="noreferrer" className="font-semibold hover:underline">@{r.handle}</a>
                {r.tier && <span className={`ml-1 rounded-full px-1 text-[9px] font-bold ${TIER_TONE[r.tier]}`}>{r.tier}</span>}</td>
              <td>{r.calls}</td>
              <td className={r.hit_2x_pct >= 40 ? 'font-bold text-up' : ''}>{r.hit_2x_pct}%</td>
              <td>{r.avg_peak_x}×</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="text-[12px] text-white/40">No graded calls yet.</p>}
    </div>
  );
}

function Roster({ now }: { now: number }) {
  const [rows, setRows] = useState<any[]>([]);
  const [h, setH] = useState('');
  const [tier, setTier] = useState('B');
  const [cat, setCat] = useState('kol');
  const [replies, setReplies] = useState(false);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api('/api/x/accounts').then(setRows).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const add = () => api('/api/x/accounts', { method: 'POST', body: JSON.stringify({ handle: h, tier, category: cat, replies }) })
    .then(() => { setH(''); setMsg('✓ added — polling starts within seconds'); load(); }).catch((e) => setMsg(e.message));
  const list = rows.filter((r) => !q || r.handle.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="glass rounded-[28px] p-5">
      <div className="mb-3 flex items-center gap-2"><Icon name="social" size={15} /><span className="display text-[24px]">Roster</span><span className="num ml-auto text-[11px] text-white/45">{rows.length} accounts</span></div>
      <div className="flex flex-wrap gap-1.5">
        <input value={h} onChange={(e) => setH(e.target.value)} placeholder="@handle or x.com link" className="min-w-0 flex-1 rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-[12px]" />
        <select value={tier} onChange={(e) => setTier(e.target.value)} className="rounded-xl border border-white/10 bg-transparent px-2 text-[12px]">
          {['S', 'A', 'B'].map((t) => <option key={t} value={t} className="bg-[var(--color-bg)]">tier {t}</option>)}
        </select>
        <select value={cat} onChange={(e) => setCat(e.target.value)} className="rounded-xl border border-white/10 bg-transparent px-2 text-[12px]">
          {CATS.filter((c) => c && c !== 'search').map((c) => <option key={c} value={c} className="bg-[var(--color-bg)]">{c}</option>)}
        </select>
        <label className="flex items-center gap-1 text-[11px] text-white/55"><input type="checkbox" checked={replies} onChange={(e) => setReplies(e.target.checked)} /> replies</label>
        <button onClick={add} disabled={!h} className="rounded-xl bg-white px-3 text-[12px] font-bold text-black disabled:opacity-30">Add</button>
      </div>
      {msg && <p className={`mt-1 text-[11px] ${msg.startsWith('✓') ? 'text-up' : 'text-down'}`}>{msg}</p>}
      <p className="mt-2 text-[11px] text-white/40">S checked every ~10s, A ~30s, B ~90s. Checking is free; X bills each new tweet, so a chatty account costs more than a quiet one.</p>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…" className="mt-3 w-full rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-[12px]" />
      <ul className="mt-2 max-h-[420px] space-y-1 overflow-y-auto pr-1">
        {list.map((r) => (
          <li key={r.handle} className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-[12px] hover:bg-white/[0.03]">
            {r.avatar ? <img src={r.avatar} alt="" className="h-6 w-6 rounded-full" loading="lazy" /> : <span className="h-6 w-6 rounded-full bg-white/10" />}
            <a href={`https://x.com/${r.handle}`} target="_blank" rel="noreferrer" className="truncate font-semibold hover:underline">@{r.handle}</a>
            <span className={`rounded-full px-1.5 text-[9px] font-bold ${TIER_TONE[r.tier]}`}>{r.tier}</span>
            <span className="text-[10.5px] text-white/40">{r.category}{r.source === 'learned' ? ' · learned' : ''}</span>
            <span className="num ml-auto text-[10.5px] text-white/40" title="tweets seen · coins spawned">{r.tweets || 0}·{r.spawns || 0}{r.last_tweet ? ` · ${ago(r.last_tweet, now)}` : ''}</span>
            <button onClick={() => api(`/api/x/accounts/${r.handle}`, { method: 'DELETE' }).then(load)} className="text-white/30 hover:text-down" title="Stop watching">✕</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Budget({ st, onSaved }: { st: any; onSaved: (s: any) => void }) {
  const [v, setV] = useState('');
  useEffect(() => { if (st && !v) setV(String(st.budget_usd ?? 5)); }, [st, v]);
  const perDay = Number(v || 0) / (st?.cost_per_post || 0.005);
  return (
    <div className="glass rounded-[28px] p-5">
      <div className="mb-2 flex items-center gap-2"><Icon name="settings" size={15} /><span className="display text-[24px]">X budget</span></div>
      <div className="num mb-2 text-[12px] text-white/60">Spent today <b className="text-white">${(st?.spent_usd ?? 0).toFixed(3)}</b> of ${(st?.budget_usd ?? 0).toFixed(2)}</div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-flash" style={{ width: `${Math.min(100, ((st?.spent_usd || 0) / Math.max(0.01, st?.budget_usd || 1)) * 100)}%` }} /></div>
      <div className="mt-3 flex gap-2">
        <input value={v} onChange={(e) => setV(e.target.value)} className="num w-24 rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-[13px]" />
        <button onClick={() => api('/api/x/budget', { method: 'POST', body: JSON.stringify({ daily_usd: Number(v) }) }).then(onSaved)} className="btn-primary">Save $/day</button>
      </div>
      <p className="mt-2 text-[11px] text-white/45">≈ {Math.round(perDay).toLocaleString()} tweets a day at ${st?.cost_per_post ?? 0.005}/tweet. Near the cap, B-tier and keyword searches pause first; S-tier keeps going to the last cent.</p>
    </div>
  );
}
