'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { AnimatePresence, motion } from '@/components/motion';
import { Reveal } from '@/components/whoop';
import { api, apiCached, peek } from '@/lib/api';
import { ago, short } from '@/lib/format';
import { useLive, useNow, usePoll } from '@/lib/live';

type Ev = { ts: number; engine: string; kind: string; title: string; body?: string; mint?: string | null; url?: string; symbol?: string };
const ENGINE: Record<string, { label: string; tone: string; icon: string }> = {
  helius: { label: 'Helius', tone: 'text-[#ff7a45]', icon: 'link' },
  claude: { label: 'Claude', tone: 'text-accent', icon: 'ask' },
  youtube: { label: 'YouTube', tone: 'text-down', icon: 'flame' },
  dune: { label: 'Dune', tone: 'text-warn', icon: 'trophy' },
  telegram: { label: 'Telegram', tone: 'text-accent2', icon: 'signal' },
  x: { label: 'X', tone: 'text-flash', icon: 'x' },
};
const nf = (v?: number | null) => (v == null ? '—' : Intl.NumberFormat('en').format(Math.round(v)));
const compact = (v?: number | null) => (v == null ? '—' : Intl.NumberFormat('en', { notation: 'compact' }).format(v));

function Meter({ used, cap, parts }: { used: number; cap: number; parts?: { label: string; v: number; color: string }[] }) {
  const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
  return (
    <div>
      <div className="relative h-2 overflow-hidden rounded-full bg-white/[0.07]">
        {parts ? (
          <div className="absolute inset-y-0 left-0 flex" style={{ width: `${pct}%` }}>
            {parts.map((p) => <div key={p.label} style={{ flex: Math.max(0.0001, p.v), background: p.color }} />)}
          </div>
        ) : <motion.div className="absolute inset-y-0 left-0 rounded-full bg-up" initial={{ width: 0 }} animate={{ width: `${pct}%` }} />}
      </div>
      {parts && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-white/50">
          {parts.map((p) => <span key={p.label} className="flex items-center gap-1"><i className="h-2 w-2 rounded-full" style={{ background: p.color }} />{p.label} <b className="num text-white/80">{nf(p.v)}</b></span>)}
        </div>
      )}
    </div>
  );
}

function Card({ id, title, on, configured, children, what }: { id: string; title: string; on: boolean; configured: boolean; children: React.ReactNode; what: string[] }) {
  const e = ENGINE[id];
  return (
    <section className="glass flex flex-col rounded-[28px] p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className={`flex h-8 w-8 items-center justify-center rounded-xl bg-white/[0.06] ${e.tone}`}><Icon name={e.icon} size={16} /></span>
        <span className="display text-[24px]">{title}</span>
        <span className={`ml-auto flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wider ${on ? 'bg-up/15 text-up' : configured ? 'bg-warn/15 text-warn' : 'bg-white/[0.06] text-white/45'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${on ? 'animate-pulse bg-up' : configured ? 'bg-warn' : 'bg-white/30'}`} />{on ? 'firing' : configured ? 'saved' : 'no key'}
        </span>
      </div>
      <div className="flex-1 space-y-3 text-[12.5px]">{children}</div>
      <ul className="mt-4 space-y-1 border-t border-white/[0.06] pt-3 text-[11.5px] text-white/50">
        {what.map((w) => <li key={w} className="flex gap-1.5"><span className={e.tone}>›</span>{w}</li>)}
      </ul>
      {!configured && <Link href="/connectors" className="mt-3 text-[12px] font-semibold text-white/70 underline decoration-white/30 underline-offset-4 hover:text-white">Add the key on Connectors →</Link>}
    </section>
  );
}

const Row = ({ k, v, tone = '' }: { k: string; v: React.ReactNode; tone?: string }) => (
  <div className="flex items-baseline justify-between gap-3"><span className="text-white/50">{k}</span><b className={`num text-right ${tone}`}>{v}</b></div>
);

export default function EnginesPage() {
  const [d, setD] = useState<any>(null);
  const [feed, setFeed] = useState<Ev[]>([]);
  const [buzz, setBuzz] = useState<any>(null);
  const now = useNow(5000);
  const load = useCallback(() => apiCached('/api/engines').then(setD).catch(() => {}), []);
  usePoll(load, 5000);
  usePoll(() => api('/api/youtube/buzz?limit=40').then(setBuzz).catch(() => {}), 60000);
  useEffect(() => { setD((x: any) => x ?? peek('/api/engines') ?? null); api<Ev[]>('/api/intel?limit=120').then(setFeed).catch(() => {}); }, []);
  useLive((m) => { if (m.ch === 'intel') setFeed((f) => [m.data as Ev, ...f].slice(0, 200)); });

  const h = d?.helius || {}, c = d?.claude || {}, y = d?.youtube || {}, du = d?.dune || {}, tg = d?.telegram || {}, sn = d?.snipe || {}, xs = d?.x || {};
  const firing = [xs.connected, h.connected, c.enabled, y.configured, du.configured, tg.configured].filter(Boolean).length;

  return (
    <div className="pt-4">
      <Reveal className="mb-8">
        <div className="eyebrow mb-3">Engines · everything your keys power</div>
        <h1 className="display text-[60px] md:text-[104px]">{firing}/6 <span className="text-up">firing.</span></h1>
        <p className="mt-4 max-w-3xl text-[16px] text-white/60">
          Helius checks a launch&apos;s early buyers on chain for <b className="text-white">insider clusters and fresh wallets</b>. YouTube finds which
          coins new videos are talking about. Claude reads every promising launch&apos;s meme in batches for fractions of a cent. Dune keeps
          your trader pool stocked, and Telegram puts all of it in your pocket. Each one runs inside a daily budget you control below.
        </p>
        <div className="num mt-5 flex flex-wrap gap-2 text-[12px]">
          <span className="rounded-full bg-white/[0.06] px-3 py-1">{nf(sn.tracking)} launches live</span>
          <span className="rounded-full bg-[#ff7a45]/15 px-3 py-1 text-[#ff7a45]">⛓ {nf(sn.with_intel)} scanned on chain</span>
          <span className="rounded-full bg-accent/15 px-3 py-1 text-accent">✦ {nf(sn.with_ai)} read by Claude</span>
          <span className="rounded-full bg-down/15 px-3 py-1 text-down">▶ {nf(sn.with_yt)} on YouTube</span>
          <span className="rounded-full bg-flash/15 px-3 py-1 text-flash">🐦 {nf(sn.with_x)} launched off tweets</span>
          <Link href="/snipe" className="rounded-full border border-white/15 px-3 py-1 text-white/70 hover:text-white">Open Snipe →</Link>
        </div>
      </Reveal>

      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        <Card id="x" title="X Radar" on={!!xs.connected} configured={!!xs.connected} what={[
          `${xs.accounts ?? '—'} accounts that move memecoins, polled by tier (S ~10s, A ~30s, B ~90s)`,
          'Every tweet scored for coinability; the promising ones read by Claude in batches',
          'Coin races: launches spawned off a tweet, boosted in Snipe, raced to your Telegram',
          'Callers graded from the market cap at their tweet; the roster promotes / demotes itself',
          'Name / bio / picture changes on S-tier accounts and Elon\u2019s newest follows',
        ]}>
          <Row k="Spent today" v={<>${(xs.spent_usd || 0).toFixed(3)} <span className="text-white/40">/ ${(xs.budget_usd ?? 5).toFixed(2)}</span></>} />
          <Meter used={xs.spent_usd || 0} cap={xs.budget_usd || 1} />
          <Row k="Tweets read" v={<>{nf(xs.posts)} <span className="text-white/40">· {nf(xs.empty)} empty checks (free)</span></>} />
          <Row k="Read by Claude" v={nf(xs.ai_read)} />
          <Row k="Coins spawned / races" v={<>{nf(xs.spawns)} / {nf(xs.races)}</>} tone="text-flash" />
          <Row k="Calls graded" v={nf(xs.calls)} />
          <Row k="Big-tweet alerts" v={nf(xs.alerts)} />
          <Link href="/x" className="text-[12px] font-semibold text-white/70 underline decoration-white/30 underline-offset-4 hover:text-white">Open X Radar →</Link>
        </Card>
        <Card id="helius" title="Helius" on={!!h.connected} configured={!!h.configured} what={[
          'Insider clusters: early buyers funded by the same wallet (or the dev’s funder)',
          'Fresh-wallet % and bot wallets among the first buyers',
          'Real on-chain top-10 holders (bonding curve removed)',
          'Live swaps of followed / top wallets on any DEX — 1-credit checks, not 100-credit calls',
        ]}>
          <Row k="Credits today" v={<>{nf(h.spent)} <span className="text-white/40">/ {nf(h.daily)}</span></>} />
          <Meter used={h.spent || 0} cap={h.daily || 1} parts={[
            { label: 'insider scans', v: h.by_job?.intel || 0, color: '#ff7a45' },
            { label: 'wallet swaps', v: h.by_job?.smart || 0, color: 'var(--color-accent)' },
            { label: '1y backfill', v: h.by_job?.backfill || 0, color: 'var(--color-warn)' },
          ]} />
          <Row k="Launches scanned" v={nf(h.intel?.scans)} />
          <Row k="Insider clusters found" v={nf(h.intel?.insider_coins)} tone="text-down" />
          <Row k="Wallets profiled (cached)" v={<>{nf(h.wallets_known)} <span className="text-white/40">· {nf(h.fresh_known)} fresh · {nf(h.bots_known)} bots</span></>} />
          <Row k="Cache hits" v={nf(h.intel?.cache_hits)} tone="text-up" />
          <Row k="≈ per month at this budget" v={compact(h.month_estimate)} />
        </Card>

        <Card id="claude" title="Claude" on={!!c.enabled} configured={!!c.configured} what={[
          `Economy mode: ${c.fast_model || 'Haiku'}, low effort, thinking off, ~25 coins per request`,
          'Narrative, meme score 0-10, copycat flag, red flags and a one-line take per coin',
          'Only launches already showing life are read, and never twice',
          'Also: playbook filter extraction, post classification, Ask Radar, briefs',
        ]}>
          <Row k="Spent today" v={<>${(c.spent_usd || 0).toFixed(4)} <span className="text-white/40">/ ${(c.budget_usd ?? 1).toFixed(2)}</span></>} />
          <Meter used={c.spent_usd || 0} cap={c.budget_usd || 1} />
          <Row k="Coins read" v={nf(c.labeled)} />
          <Row k="Requests today" v={<>{nf(c.calls)} <span className="text-white/40">· {compact(c.input_tokens)} in / {compact(c.output_tokens)} out</span></>} />
          <Row k="Avg cost per coin" v={c.labeled ? `$${((c.spent_usd || 0) / Math.max(1, c.labeled)).toFixed(5)}` : '—'} tone="text-up" />
          {c.narrator?.last_error && <p className="text-[11px] text-down">{c.narrator.last_error}</p>}
        </Card>

        <Card id="youtube" title="YouTube" on={!!y.configured} configured={!!y.configured} what={[
          'Hourly: newest memecoin videos → $tickers, contracts and names → buzz on live launches',
          `Playbook: ${y.playbook?.digested ?? 0} strategy videos digested (+ their top comments, where creators pin settings)`,
          `${y.playbook?.channels_followed ?? 0} proven creators followed through their uploads (1 unit, not 100)`,
          'Official Data API only — titles, descriptions, comments; no scraping',
        ]}>
          <Row k="Quota today" v={<>{nf(y.quota?.used)} <span className="text-white/40">/ {nf(y.quota?.cap)} units</span></>} />
          <Meter used={y.quota?.used || 0} cap={y.quota?.cap || 1} />
          <Row k="Videos indexed (48h)" v={nf(y.buzz?.videos_48h)} />
          <Row k="Tickers / contracts mentioned" v={<>{nf(y.buzz?.tickers)} / {nf(y.buzz?.contracts)}</>} />
          <Row k="Last buzz scan" v={y.buzz?.last_run ? `${ago(y.buzz.last_run, now)} ago` : 'pending'} />
          <Row k="Strategy sources with filters" v={nf(y.playbook?.with_filters)} />
        </Card>

        <Card id="dune" title="Dune" on={!!du.configured && (du.queries || []).length > 0} configured={!!du.configured} what={[
          'Saved queries re-pulled every 12h — reading results is cheap, nothing is re-run',
          'PnL / win-rate columns become wallet labels (e.g. “Dune · PnL $1.2M · WR 64%”)',
          'Imported wallets are pinned in the 5,000-wallet pool and followed live',
        ]}>
          <DuneQueries queries={du.queries || []} onChange={load} now={now} disabled={!du.configured} />
        </Card>

        <Card id="telegram" title="Telegram" on={!!tg.configured} configured={!!tg.configured} what={[
          '/top · /coin $TICKER · /calls · /wallets · /intel · /status',
          '/push degen|balanced|safe|off — auto-push coins that clear your appetite',
          '/mute 60 · /unmute (rug and flash warnings always come through)',
          'Every alert has tap-to-open pump.fun · DexScreener · Axiom buttons',
        ]}>
          <Row k="Push mode" v={<span className="uppercase">{tg.push_mode || '—'}</span>} tone="text-up" />
          <Row k="Pushed last hour" v={<>{nf(tg.pushed_last_hour)} <span className="text-white/40">/ {nf(tg.max_per_hour)}</span></>} />
          <Row k="Messages sent" v={nf(tg.messages_sent)} />
          <Row k="Muted" v={tg.muted_until && tg.muted_until > now ? `${Math.ceil((tg.muted_until - now) / 60)} min left` : 'no'} />
          <Row k="Last command" v={tg.last_command ? <>{tg.last_command.text} <span className="text-white/40">{ago(tg.last_command.ts, now)} ago</span></> : '—'} />
        </Card>

        <Budgets d={d} onSaved={setD} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_1fr]">
        <section className="glass overflow-hidden rounded-[28px]">
          <header className="flex items-center gap-2 border-b border-white/[0.06] px-6 py-4">
            <span className="h-2 w-2 animate-pulse rounded-full bg-up" /><span className="display text-[26px]">Live intel</span>
            <span className="ml-auto text-[11px] text-white/45">what every engine just found</span>
          </header>
          <ul className="max-h-[640px] overflow-y-auto">
            <AnimatePresence initial={false}>
              {feed.map((e) => {
                const en = ENGINE[e.engine] || { label: e.engine, tone: 'text-white/60', icon: 'bolt' };
                return (
                  <motion.li key={`${e.ts}${e.title}`} layout initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }}
                    className="flex gap-3 border-t border-white/[0.05] px-6 py-3 first:border-t-0">
                    <span className={`mt-0.5 ${en.tone}`}><Icon name={en.icon} size={14} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${en.tone}`}>{en.label}</span>
                        <span className="text-[10.5px] text-white/35">{ago(e.ts, now)} ago</span>
                      </div>
                      {e.mint ? <Link href={`/token?a=${e.mint}`} className="block truncate text-[13px] font-semibold hover:underline">{e.title}</Link>
                        : e.url ? <a href={e.url} target="_blank" rel="noreferrer" className="block truncate text-[13px] font-semibold hover:underline">{e.title}</a>
                          : <b className="block truncate text-[13px]">{e.title}</b>}
                      {e.body && <p className="line-clamp-2 text-[11.5px] text-white/50">{e.body}</p>}
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
            {!feed.length && <li className="px-6 py-10 text-center text-white/40">Nothing yet. Finds show up here the moment an engine makes one.</li>}
          </ul>
        </section>

        <section className="glass overflow-hidden rounded-[28px]">
          <header className="flex items-center gap-2 border-b border-white/[0.06] px-6 py-4">
            <span className="text-down">▶</span><span className="display text-[26px]">YouTube buzz</span>
            <span className="ml-auto text-[11px] text-white/45">memecoin videos, last 48h</span>
            {y.configured && <button onClick={() => api('/api/youtube/buzz/run', { method: 'POST' }).then(() => api('/api/youtube/buzz?limit=40').then(setBuzz)).catch(() => {})}
              className="rounded-full border border-white/15 px-2.5 py-0.5 text-[11px] text-white/70 hover:text-white">Scan now</button>}
          </header>
          <ul className="max-h-[640px] overflow-y-auto">
            {(buzz?.videos || []).map((v: any) => (
              <li key={v.id} className="border-t border-white/[0.05] px-6 py-3 first:border-t-0">
                <a href={v.url} target="_blank" rel="noreferrer" className="line-clamp-1 text-[13px] font-semibold hover:underline">{v.title}</a>
                <div className="num mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-white/50">
                  <span>{v.channel}</span><span>· {compact(v.views)} views</span><span>· {ago(v.published, now)} ago</span>
                  {v.tickers.map((t: string) => <span key={t} className="rounded-full bg-white/[0.06] px-1.5 font-bold text-white/75">${t}</span>)}
                  {v.contracts.map((c: string) => <span key={c} className="rounded-full bg-white/[0.06] px-1.5 font-mono text-white/60">{short(c)}</span>)}
                  {v.live.map((m: string) => <Link key={m} href={`/token?a=${m}`} className="rounded-full bg-up/15 px-1.5 font-bold text-up">● live coin</Link>)}
                </div>
              </li>
            ))}
            {!buzz?.videos?.length && <li className="px-6 py-10 text-center text-white/40">{y.configured ? 'The first hourly scan is on its way.' : 'Add a YouTube key on Connectors.'}</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}

function DuneQueries({ queries, onChange, now, disabled }: { queries: any[]; onChange: () => void; now: number; disabled: boolean }) {
  const [q, setQ] = useState('');
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = () => {
    setBusy(true);
    setMsg(null);
    api('/api/dune/queries', { method: 'POST', body: JSON.stringify({ query_id: q, label: label || undefined }) })
      .then((r: any) => { setMsg(`✓ ${r.imported} wallets imported`); setQ(''); setLabel(''); onChange(); })
      .catch((e) => setMsg(e.message)).finally(() => setBusy(false));
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} disabled={disabled} placeholder="dune.com/queries/1234567" className="min-w-0 flex-1 rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-[12px]" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={disabled} placeholder="label" className="w-24 rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-[12px]" />
        <button onClick={add} disabled={disabled || busy || !q} className="rounded-xl bg-white px-3 text-[12px] font-bold text-black disabled:opacity-30">{busy ? '…' : 'Add'}</button>
      </div>
      {msg && <p className={`text-[11px] ${msg.startsWith('✓') ? 'text-up' : 'text-down'}`}>{msg}</p>}
      <ul className="space-y-1.5">
        {queries.map((x) => (
          <li key={x.id} className="rounded-xl border border-white/[0.07] px-3 py-2">
            <div className="flex items-center gap-2">
              <a href={`https://dune.com/queries/${x.id}`} target="_blank" rel="noreferrer" className="font-semibold hover:underline">{x.label || `Query ${x.id}`}</a>
              <span className="num text-[11px] text-white/45">#{x.id}</span>
              <button onClick={() => api(`/api/dune/queries/${x.id}/refresh`, { method: 'POST' }).then(onChange).catch((e) => setMsg(e.message))} className="ml-auto text-[11px] text-white/55 hover:text-white">refresh</button>
              <button onClick={() => api(`/api/dune/queries/${x.id}`, { method: 'DELETE' }).then(onChange)} className="text-[11px] text-white/40 hover:text-down">remove</button>
            </div>
            <div className="num text-[11px] text-white/50">{x.error ? <span className="text-down">{x.error}</span> : <>{nf(x.wallets)} wallets of {nf(x.rows)} rows</>} · pulled {x.pulled ? `${ago(x.pulled, now)} ago` : '—'}</div>
          </li>
        ))}
      </ul>
      {!queries.length && <p className="text-[11.5px] text-white/45">Search dune.com for “top solana memecoin traders” or “pump.fun profitable wallets”, open a query, and paste its link here.</p>}
    </div>
  );
}

function Budgets({ d, onSaved }: { d: any; onSaved: (d: any) => void }) {
  const [hel, setHel] = useState<string>('');
  const [ai, setAi] = useState<string>('');
  const [yt, setYt] = useState<string>('');
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!d) return;
    setHel((v) => v || String(d.helius?.daily ?? ''));
    setAi((v) => v || String(d.claude?.budget_usd ?? ''));
    setYt((v) => v || String(d.youtube?.quota?.cap ?? ''));
  }, [d]);
  const save = () => api('/api/engines/budget', { method: 'POST', body: JSON.stringify({
    helius_daily_credits: hel ? Number(hel) : undefined, ai_daily_usd: ai ? Number(ai) : undefined, youtube_daily_units: yt ? Number(yt) : undefined,
  }) }).then((r) => { onSaved(r); setOk(true); setTimeout(() => setOk(false), 1500); });
  const plans: Record<string, number> = d?.helius?.plans || { free: 33000, developer: 330000, business: 3300000 };
  return (
    <section className="glass rounded-[28px] p-5">
      <div className="mb-3 flex items-center gap-2"><Icon name="settings" size={16} /><span className="display text-[24px]">Budgets</span></div>
      <p className="mb-4 text-[12px] text-white/50">Hard daily caps. Radar paces spending through the day, so an hour of madness can&apos;t burn tomorrow&apos;s credits.</p>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-white/50">Helius credits / day</label>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {Object.entries(plans).map(([k, v]) => (
          <button key={k} onClick={() => setHel(String(v))} className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${Number(hel) === v ? 'bg-white text-black' : 'border border-white/15 text-white/65'}`}>{k} plan · {compact(v)}</button>
        ))}
      </div>
      <input value={hel} onChange={(e) => setHel(e.target.value.replace(/\D/g, ''))} className="num mt-1.5 w-full rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-[13px]" />
      <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wider text-white/50">Claude $ / day</label>
      <input value={ai} onChange={(e) => setAi(e.target.value)} className="num mt-1 w-full rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-[13px]" />
      <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wider text-white/50">YouTube units / day (max 10,000)</label>
      <input value={yt} onChange={(e) => setYt(e.target.value.replace(/\D/g, ''))} className="num mt-1 w-full rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-[13px]" />
      <button onClick={save} className="btn-primary mt-4">{ok ? 'Saved ✓' : 'Save budgets'}</button>
    </section>
  );
}
