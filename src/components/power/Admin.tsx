'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/v2';
import { timeAgo } from '@/lib/format';
import { ThemeSync } from '../layout/ThemeSync';
import { useSettings } from '@/lib/settings';

type A = {
  streams: { id: string; label: string; provider: string; mock: boolean; state: string; lastUpdate: number | null; latencyMs: number | null; p50: number | null; p95: number | null; message?: string; override: string | null; delayedMin: number }[];
  adapters: { id: string; stream: string; provider: string; mock: boolean; running: boolean }[];
  quotas: { host: string; label: string; lastMin: number; lastHour: number; limitPerMin: number | null; errorsHour: number }[];
  intel: { key: string; label: string; mode: string; lastOk: number | null; lastError: string | null; runs: number; errors: number; p50: number | null; p95: number | null }[];
  jobs: { id: string; label: string; runs: number; lastRun: number | null; lastMs: number | null; lastError: string | null; nextHint: string }[];
  pipeline: { totals: { ingested: number; deduped: number; clustered: number; muted: number }; hourly: { hour: number; ingested: number; deduped: number; clustered: number }[] };
  ai: { used: number; budget: number; costUsd: number; rows: { kind: string; calls: number; cost_usd: number }[] };
  outbox: { pending: number; dead: { id: string; dest: string; attempts: number; last_error: string; created_at: number }[] };
  db: { ticks: number; articles: number; briefs: number };
  uptime: number; memoryMb: number;
};

const card = 'rounded-xl border border-line bg-panel p-4';
const th = 'pb-1 text-left text-[10px] font-semibold uppercase tracking-wider text-faint';
const dot = (s: string) => (s === 'live' ? 'bg-up' : s === 'stale' || s === 'connecting' ? 'bg-warn' : 'bg-down');

/** /admin — per-adapter status, latency percentiles, error rates, quotas, runtime switching, pipeline & AI stats, dead letters. */
export function AdminConsole() {
  const hydrate = useSettings((s) => s.hydrate);
  const [a, setA] = useState<A | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = Date.now();
  const load = () => void api<A>('/api/admin').then((x) => { setA(x); setErr(null); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { hydrate(); load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [hydrate]);
  const post = async (path: string, json?: unknown) => { await api(path, { method: path.includes('/mode') ? 'PUT' : 'POST', json: json ?? {} }); load(); };
  return (
    <>
      <ThemeSync />
      <div className="h-dvh overflow-y-auto bg-bg px-6 py-6 text-text">
        <div className="mx-auto max-w-7xl space-y-5">
          <header className="flex items-center justify-between"><h1 className="text-lg font-semibold">PULSE · data source health &amp; admin</h1><span className="text-xs text-faint">{a ? `up ${(a.uptime / 3600).toFixed(1)}h · ${a.memoryMb} MB RSS · ${a.db.articles} articles · ${a.db.ticks} tick blocks · ${a.db.briefs} briefs` : err ?? 'loading…'} · <a href="/" className="underline">terminal</a></span></header>
          {a ? (
            <>
              <section className={card}>
                <h2 className="mb-2 text-sm font-semibold">Streams</h2>
                <table className="w-full text-xs"><thead><tr><th className={th}>Stream</th><th className={th}>Provider</th><th className={th}>Last update</th><th className={th}>Latency p50 / p95</th><th className={th}>Message</th><th className={th}>Switch</th></tr></thead>
                  <tbody className="divide-y divide-line">{a.streams.map((s) => (
                    <tr key={s.id}><td className="py-1.5"><span className={`mr-2 inline-block h-2 w-2 rounded-full ${dot(s.state)}`} />{s.label}</td><td className="text-dim">{s.provider}{s.mock ? ' · mock' : ''}{s.delayedMin ? ` · ${s.delayedMin}m delayed` : ''}</td><td className="num text-dim">{s.lastUpdate ? `${timeAgo(s.lastUpdate, now)} ago` : '—'}</td><td className="num text-dim">{s.p50 ?? '—'} / {s.p95 ?? '—'} ms</td><td className="max-w-xs truncate text-faint">{s.message ?? ''}</td>
                      <td className="space-x-1"><button onClick={() => void post(`/api/admin/streams/${s.id}/provider`, { provider: 'live' })} className={`rounded border px-1.5 ${!s.mock ? 'border-up/50 text-up' : 'border-line text-faint'}`}>live</button><button onClick={() => void post(`/api/admin/streams/${s.id}/provider`, { provider: 'mock' })} className={`rounded border px-1.5 ${s.mock ? 'border-accent/50 text-accent' : 'border-line text-faint'}`}>mock</button></td></tr>
                  ))}</tbody></table>
              </section>
              <div className="grid gap-5 lg:grid-cols-2">
                <section className={card}>
                  <h2 className="mb-2 text-sm font-semibold">Adapters</h2>
                  <ul className="space-y-1 text-xs">{a.adapters.map((x) => <li key={x.id} className="flex justify-between"><span><span className={`mr-2 inline-block h-2 w-2 rounded-full ${x.running ? 'bg-up' : 'bg-down'}`} />{x.id} <span className="text-faint">· {x.stream} · {x.provider}</span></span><button onClick={() => void post(`/api/admin/adapters/${x.id}/toggle`)} className="rounded border border-line px-1.5 text-dim hover:text-text">{x.running ? 'stop' : 'start'}</button></li>)}</ul>
                </section>
                <section className={card}>
                  <h2 className="mb-2 text-sm font-semibold">Rate limits & quotas</h2>
                  <table className="w-full text-xs"><tbody className="divide-y divide-line">{a.quotas.slice(0, 14).map((q) => (
                    <tr key={q.host}><td className="py-1 text-dim">{q.label}</td><td className="num text-right">{q.lastMin}{q.limitPerMin ? `/${q.limitPerMin}` : ''} req/min</td><td className="w-24 pl-2">{q.limitPerMin ? <div className="h-1.5 rounded-full bg-bg-2"><div className={`h-1.5 rounded-full ${q.lastMin / q.limitPerMin > 0.8 ? 'bg-down' : 'bg-accent'}`} style={{ width: `${Math.min(100, (q.lastMin / q.limitPerMin) * 100)}%` }} /></div> : null}</td><td className={`num text-right ${q.errorsHour ? 'text-down' : 'text-faint'}`}>{q.errorsHour} err/h</td></tr>
                  ))}</tbody></table>
                </section>
              </div>
              <section className={card}>
                <h2 className="mb-2 text-sm font-semibold">Intelligence jobs</h2>
                <table className="w-full text-xs"><thead><tr><th className={th}>Job</th><th className={th}>Mode</th><th className={th}>Last success</th><th className={th}>Runs / errors</th><th className={th}>p50 / p95</th><th className={th}>Last error</th></tr></thead>
                  <tbody className="divide-y divide-line">{a.intel.map((j) => (
                    <tr key={j.key}><td className="py-1">{j.label}</td><td>{(['auto', 'live', 'mock', 'off'] as const).map((m) => <button key={m} onClick={() => void post(`/api/intel/${j.key}/mode`, { mode: m })} className={`mr-1 rounded border px-1 ${j.mode === m ? 'border-accent/50 text-accent' : 'border-line text-faint'}`}>{m}</button>)}</td><td className="num text-dim">{j.lastOk ? `${timeAgo(j.lastOk, now)} ago` : '—'}</td><td className="num text-dim">{j.runs} / <span className={j.errors ? 'text-down' : ''}>{j.errors}</span></td><td className="num text-dim">{j.p50 ?? '—'} / {j.p95 ?? '—'} ms</td><td className="max-w-xs truncate text-faint">{j.lastError ?? ''}</td></tr>
                  ))}</tbody></table>
              </section>
              <div className="grid gap-5 lg:grid-cols-3">
                <section className={card}>
                  <h2 className="mb-2 text-sm font-semibold">News pipeline</h2>
                  <div className="text-xs text-dim">Since start: {a.pipeline.totals.ingested} ingested · {a.pipeline.totals.deduped} deduped · {a.pipeline.totals.clustered} clustered · {a.pipeline.totals.muted} muted</div>
                  <table className="mt-2 w-full text-[11px]"><tbody>{a.pipeline.hourly.slice(0, 8).map((h) => <tr key={h.hour}><td className="num text-faint">{new Date(h.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td><td className="num text-right">{h.ingested} in</td><td className="num text-right text-faint">{h.deduped} dup</td><td className="num text-right text-faint">{h.clustered} clu</td></tr>)}</tbody></table>
                </section>
                <section className={card}>
                  <h2 className="mb-2 text-sm font-semibold">AI today</h2>
                  <div className="text-xs text-dim">{a.ai.used.toLocaleString()} / {a.ai.budget.toLocaleString()} tokens · est. ${a.ai.costUsd.toFixed(3)}</div>
                  <ul className="mt-2 space-y-0.5 text-[11px]">{a.ai.rows.map((r) => <li key={r.kind} className="flex justify-between"><span className="text-dim">{r.kind}</span><span className="num">{r.calls} calls · ${r.cost_usd.toFixed(3)}</span></li>)}</ul>
                </section>
                <section className={card}>
                  <h2 className="mb-2 text-sm font-semibold">Outbound queue</h2>
                  <div className="text-xs text-dim">{a.outbox.pending} pending · {a.outbox.dead.length} dead letters</div>
                  <ul className="mt-2 space-y-1 text-[11px]">{a.outbox.dead.map((d) => <li key={d.id}><span className="text-down">{d.dest}</span> · {d.attempts} tries · <span className="text-faint">{d.last_error}</span> <button onClick={() => void post(`/api/outbox/${d.id}/retry`)} className="underline">retry</button></li>)}</ul>
                </section>
              </div>
              <section className={card}>
                <h2 className="mb-2 text-sm font-semibold">Scheduled jobs</h2>
                <table className="w-full text-xs"><tbody className="divide-y divide-line">{a.jobs.map((j) => <tr key={j.id}><td className="py-1">{j.label}</td><td className="text-faint">{j.nextHint}</td><td className="num text-dim">{j.runs} runs</td><td className="num text-dim">{j.lastRun ? `${timeAgo(j.lastRun, now)} ago` : '—'}</td><td className="num text-dim">{j.lastMs ?? '—'} ms</td><td className="max-w-xs truncate text-down">{j.lastError ?? ''}</td><td><button onClick={() => void api(`/api/scheduler/${j.id}/run`, { method: 'POST' }).then(load)} className="rounded border border-line px-1.5 text-dim hover:text-text">run</button></td></tr>)}</tbody></table>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
