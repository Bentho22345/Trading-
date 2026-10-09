'use client';
import { useEffect, useState } from 'react';
import { useAction } from '@/components/radar';
import { Panel } from '@/components/ui';
import { api } from '@/lib/api';

function NumField({ label, value, onChange, step = 1 }: { label: string; value: any; onChange: (v: number) => void; step?: number }) {
  return (
    <label className="flex items-center gap-2"><span className="w-48 text-[11px] text-mute">{label}</span>
      <input type="number" step={step} value={value ?? ''} onChange={(e) => onChange(+e.target.value)} className="w-24 rounded border border-line bg-panel2 px-2 py-0.5 num" /></label>
  );
}

export default function SettingsPage() {
  const [cfg, setCfg] = useState<any>(null);
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [spend, setSpend] = useState<any>(null);
  const { run, Msg } = useAction();
  const load = () => api('/api/settings').then((c) => { setCfg(c); setRaw({ scoring: JSON.stringify(c.scoring, null, 2), watch: JSON.stringify(c.watch, null, 2) }); });
  useEffect(() => { load(); api('/api/spend').then(setSpend); }, []);
  if (!cfg) return <p className="p-6 text-mute">Loading…</p>;
  const sc = cfg.scoring;
  const setSc = (path: string[], v: any) => setCfg((c: any) => {
    const n = structuredClone(c); let o = n.scoring; for (const k of path.slice(0, -1)) o = o[k]; o[path[path.length - 1]] = v; return n;
  });
  const save = (name: string, body: any) => run(() => api(`/api/settings/${name}`, { method: 'POST', body: JSON.stringify(body) }), 'Saved — live immediately').then(load);
  const vips = (cfg.watch.x_vips || []).map((v: any) => `${v.handle}${v.tier && v.tier !== 'vip' ? `:${v.tier}` : ''}`).join('\n');
  return (
    <div className="mx-auto max-w-6xl space-y-2 pt-2">
      <div className="flex items-center gap-2"><h1 className="text-lg font-bold">Settings</h1><Msg />
        <button onClick={() => run(() => api('/api/alerts/test', { method: 'POST' }), 'Test alert sent to every connected channel')} className="ml-auto rounded border border-line px-2 py-1">Send test alert</button></div>
      {spend && (
        <Panel title="API spend today (cost meter)">
          <div className="flex flex-wrap gap-4 p-2 num text-[12px]">
            {spend.today.map((r: any) => <span key={r.adapter}>{r.adapter}: {r.calls} calls{r.usd ? ` · $${r.usd.toFixed(4)}` : ''}</span>)}
            <span className="text-mute">AI cap ${spend.ai_budget_usd}/day (AI_DAILY_BUDGET_USD) · X cap ${spend.x_budget_usd}/day (Connectors → X)</span>
          </div>
        </Panel>
      )}
      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title="Radar Score — weights & verdict">
          <div className="space-y-1 p-2">
            {Object.keys(sc.weights).map((k) => <NumField key={k} label={`weight: ${k}`} value={sc.weights[k]} step={0.05} onChange={(v) => setSc(['weights', k], v)} />)}
            <NumField label="BUY ≥ score" value={sc.verdict.buy_min_score} onChange={(v) => setSc(['verdict', 'buy_min_score'], v)} />
            <NumField label="WATCH ≥ score" value={sc.verdict.watch_min_score} onChange={(v) => setSc(['verdict', 'watch_min_score'], v)} />
            <NumField label="veto: max top-10 %" value={sc.vetoes.max_top10_pct} onChange={(v) => setSc(['vetoes', 'max_top10_pct'], v)} />
            <NumField label="veto: min liquidity $" value={sc.vetoes.min_liquidity_usd} onChange={(v) => setSc(['vetoes', 'min_liquidity_usd'], v)} />
            <NumField label="plan: stop %" value={sc.plan.stop_pct} onChange={(v) => setSc(['plan', 'stop_pct'], v)} />
            <NumField label="plan: time stop h" value={sc.plan.time_stop_hours} onChange={(v) => setSc(['plan', 'time_stop_hours'], v)} />
            <NumField label="FLASH velocity σ" value={sc.narrative.breakout_sigma} step={0.5} onChange={(v) => setSc(['narrative', 'breakout_sigma'], v)} />
            <p className="text-[11px] text-mute">Active mint/freeze authority is always a hard AVOID.</p>
            <div className="flex gap-2 pt-1">
              <button onClick={() => save('scoring', { weights: sc.weights, verdict: sc.verdict, vetoes: sc.vetoes, plan: sc.plan, narrative: sc.narrative })} className="rounded bg-accent/20 px-3 py-1 text-accent">Save</button>
              <button onClick={() => run(() => api('/api/settings/scoring', { method: 'DELETE' }), 'Reset to config/scoring.yaml').then(load)} className="rounded border border-line px-3 py-1">Reset to file</button>
            </div>
          </div>
        </Panel>
        <Panel title="Watchlists — X VIPs, search terms, Telegram channels">
          <div className="space-y-2 p-2">
            <WatchEditor label="X VIP handles (one per line; append :news or :kol to change tier)" initial={vips}
              onSave={(t) => save('watch', { x_vips: t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [h, tier] = l.replace('@', '').split(':'); return { handle: h, tier: tier || 'vip' }; }) })} />
            <WatchEditor label="X search queries (one per line; each poll costs reads)" initial={(cfg.watch.x_search_terms || []).join('\n')}
              onSave={(t) => save('watch', { x_search_terms: t.split('\n').map((l) => l.trim()).filter(Boolean) })} />
            <WatchEditor label="Telegram public channels (one per line)" initial={(cfg.watch.telegram_channels || []).join('\n')}
              onSave={(t) => save('watch', { telegram_channels: t.split('\n').map((l) => l.trim().replace('@', '')).filter(Boolean) })} />
            <NumField label="X cost per post read ($)" value={cfg.watch.x_cost_per_post_read_usd} step={0.001} onChange={(v) => setCfg({ ...cfg, watch: { ...cfg.watch, x_cost_per_post_read_usd: v } })} />
            <button onClick={() => save('watch', { x_cost_per_post_read_usd: cfg.watch.x_cost_per_post_read_usd })} className="rounded border border-line px-2 py-0.5 text-[11px]">save price</button>
          </div>
        </Panel>
      </div>
      {(['scoring', 'watch'] as const).map((name) => (
        <Panel key={name} title={`Advanced: full ${name} config (JSON)`}>
          <div className="space-y-1 p-2">
            <textarea value={raw[name] || ''} onChange={(e) => setRaw({ ...raw, [name]: e.target.value })} rows={14} className="w-full rounded border border-line bg-panel2 p-2 font-mono text-[11px]" />
            <button onClick={() => { try { save(name, JSON.parse(raw[name])); } catch (e: any) { alert(`Invalid JSON: ${e.message}`); } }} className="rounded bg-accent/20 px-3 py-1 text-accent">Save {name}</button>
          </div>
        </Panel>
      ))}
    </div>
  );
}

function WatchEditor({ label, initial, onSave }: { label: string; initial: string; onSave: (t: string) => void }) {
  const [t, setT] = useState(initial);
  useEffect(() => setT(initial), [initial]);
  return (
    <div>
      <div className="text-[11px] text-mute">{label}</div>
      <textarea value={t} onChange={(e) => setT(e.target.value)} rows={5} className="w-full rounded border border-line bg-panel2 p-1 font-mono text-[11px]" />
      <button onClick={() => onSave(t)} className="rounded border border-line px-2 py-0.5 text-[11px]">save</button>
    </div>
  );
}
