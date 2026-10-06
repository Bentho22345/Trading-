'use client';
import { useEffect, useState } from 'react';
import type { AlertRule } from '@shared/types';
import type { AlertRoute, DestinationType, Severity, SmartFeed } from '@shared/v2';
import { useDocs, useV2, api } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { useSettings } from '@/lib/settings';
import { Row, Section, Slider, Switch, btnCls, inputCls, primaryBtn } from './controls';

const DESTS: DestinationType[] = ['toast', 'push', 'email', 'slack', 'telegram', 'discord', 'sms', 'webhook'];
const SEVS: Severity[] = ['low', 'normal', 'high', 'critical'];

function RouteEditor({ id, label }: { id: string; label: string }) {
  const routes = useDocs<AlertRoute>('alert_routes');
  const r: AlertRoute = routes.find((x) => x.id === id) ?? { id, severity: 'normal', destinations: ['toast', 'push'], digestMin: 0 };
  const save = (p: Partial<AlertRoute>) => void useV2.getState().putDoc('alert_routes', { ...r, ...p });
  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium text-text">{label}</span>
        <select className={inputCls} value={r.severity} onChange={(e) => save({ severity: e.target.value as Severity })}>{SEVS.map((s) => <option key={s}>{s}</option>)}</select></div>
      <div className="flex flex-wrap gap-1">{DESTS.map((d) => <button key={d} onClick={() => save({ destinations: r.destinations.includes(d) ? r.destinations.filter((x) => x !== d) : [...r.destinations, d] })} className={`rounded-md border px-1.5 py-0.5 text-[10px] ${r.destinations.includes(d) ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-faint'}`}>{d}</button>)}</div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-dim">
        <label className="flex items-center gap-1">Digest every <input type="number" min={0} max={240} className={`${inputCls} w-14`} value={r.digestMin} onChange={(e) => save({ digestMin: Number(e.target.value) })} /> min <span className="text-faint">(low severity only; 0 = instant)</span></label>
        <label className="flex items-center gap-1">Escalate after <input type="number" min={0} className={`${inputCls} w-16`} value={r.escalate?.afterSec ?? 0} onChange={(e) => save({ escalate: Number(e.target.value) ? { afterSec: Number(e.target.value), to: r.escalate?.to ?? 'sms' } : undefined })} />s to
          <select className={inputCls} value={r.escalate?.to ?? 'sms'} onChange={(e) => r.escalate && save({ escalate: { ...r.escalate, to: e.target.value as DestinationType } })}>{DESTS.filter((d) => d !== 'toast').map((d) => <option key={d}>{d}</option>)}</select></label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={!!r.squawk} onChange={(e) => save({ squawk: e.target.checked })} />squawk</label>
        <button className="underline hover:text-text" onClick={() => void api('/api/alerts/test-route', { method: 'POST', json: { ruleId: id } })}>send test</button>
      </div>
    </div>
  );
}

export function AlertsSection() {
  const rules = useStore((s) => s.alerts);
  const feeds = useDocs<SmartFeed>('smart_feeds');
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<{ rule: Partial<AlertRule>; description: string; via: string } | null>(null);
  const [stats, setStats] = useState<{ ruleId: string; hits: number; last: number }[]>([]);
  const [server, setServer] = useState<{ themeAlerts: boolean } | null>(null);
  useEffect(() => { void api<typeof stats>('/api/alert-stats').then(setStats).catch(() => {}); void api<{ themeAlerts: boolean }>('/api/alert-settings').then(setServer).catch(() => {}); }, []);
  const parse = async () => {
    try { setParsed(await api('/api/alerts/parse', { method: 'POST', json: { text } })); } catch (e) { useStore.getState().pushToast({ kind: 'error', title: 'Could not parse', body: (e as Error).message }); }
  };
  const confirm = async () => {
    if (!parsed) return;
    await api('/api/alerts', { method: 'POST', json: { ...parsed.rule, enabled: true } });
    useStore.getState().pushToast({ kind: 'info', title: 'Alert created', body: parsed.description });
    setParsed(null); setText('');
  };
  const hit = (id: string) => stats.find((s) => s.ruleId === id);
  return (
    <>
      <Section title="Smart alert builder" description="Describe it in plain English. PULSE turns it into a rule and shows it back before saving.">
        <div className="space-y-2 px-4 py-3">
          <div className="flex gap-2"><input className={`${inputCls} flex-1`} placeholder="Tell me if BTC drops 5% in 1h while funding is positive" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void parse()} /><button className={btnCls} onClick={() => void parse()} disabled={!text.trim()}>Parse</button></div>
          {parsed ? <div className="rounded-lg border border-accent/40 bg-accent/5 p-2 text-xs"><div className="text-text">{parsed.description}</div><code className="mt-1 block text-[10px] text-faint">{JSON.stringify(parsed.rule)}</code><div className="mt-2 flex gap-2"><button className={primaryBtn} onClick={() => void confirm()}>Looks right — create</button><button className={btnCls} onClick={() => setParsed(null)}>Cancel</button></div></div> : null}
          <p className="text-[10px] text-faint">Templates: “EURUSD above 1.18” · “gold falls 2% in 4h” · “headlines mentioning intervention” · “NVDA rises 3% while VIX below 18”.</p>
        </div>
      </Section>
      <Section title="Routing" description="Where each alert goes, how loud, and what happens if you don't acknowledge it.">
        <RouteEditor id="default" label="Default (all price & keyword alerts)" />
        {rules.map((r) => <div key={r.id} className="border-t border-line"><div className="px-4 pt-2 text-[10px] text-faint">{hit(r.id) ? `${hit(r.id)!.hits} hits · last ${new Date(hit(r.id)!.last).toLocaleString()}` : 'never fired'}</div><RouteEditor id={r.id} label={r.label ?? (r.kind === 'keyword' ? `Keyword “${r.keyword}”` : `${r.symbol} ${r.kind === 'price_cross' ? `${r.direction} ${r.level}` : `${r.pct}% / ${r.windowMin}m`}`)} /></div>)}
        <div className="border-t border-line"><RouteEditor id="playbook" label="Playbook fires" /></div>
        <div className="border-t border-line"><RouteEditor id="feeds" label="Smart-feed alerts (all feeds)" /></div>
        {feeds.filter((f) => f.alert).map((f) => <div key={f.id} className="border-t border-line"><RouteEditor id={`feed:${f.id}`} label={`Feed: ${f.name}`} /></div>)}
        <div className="border-t border-line"><RouteEditor id="theme" label="New top-5 themes" /></div>
      </Section>
      <Section title="Other alerts">
        <Row label="Notify when a new theme enters the top 5">{server ? <Switch label="Theme alerts" on={server.themeAlerts} onChange={(v) => { setServer({ themeAlerts: v }); void api('/api/alert-settings', { method: 'PUT', json: { themeAlerts: v } }); }} /> : null}</Row>
        <Row label="Quiet hours" hint="Set in Time zones & hours"><button className={btnCls} onClick={() => useV2.getState().set({ settingsCenter: 'time' })}>Open</button></Row>
      </Section>
    </>
  );
}

export function AudioSection() {
  const s = useSettings();
  const q = s.squawk;
  const set = (p: Partial<typeof q>) => s.set({ squawk: { ...q, ...p } });
  const voices = typeof window !== 'undefined' && 'speechSynthesis' in window ? speechSynthesis.getVoices() : [];
  return (
    <>
      <Section title="Audio squawk" description="Reads breaking headlines and alerts aloud. Off by default. Push-to-mute: ⇧M. Quiet while Listen mode is playing.">
        <Row label="Squawk"><Switch label="Squawk" on={q.enabled} onChange={(v) => set({ enabled: v })} /></Row>
        <Row label="Voice"><select className={inputCls} value={q.voice} onChange={(e) => set({ voice: e.target.value })}><option value="">System default</option>{voices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}</select></Row>
        <Row label="Rate"><Slider label="Rate" value={q.rate} min={0.7} max={1.6} step={0.05} onChange={(v) => set({ rate: v })} format={(v) => `${v.toFixed(2)}×`} /></Row>
        <Row label="Minimum impact"><Slider label="Minimum impact" value={q.minImpact} min={40} max={100} onChange={(v) => set({ minImpact: v })} /></Row>
        <Row label="Domains">{['centralbanks', 'fx', 'crypto', 'equities', 'macro', 'rates', 'commodities'].map((d) => <button key={d} onClick={() => set({ domains: q.domains.includes(d) ? q.domains.filter((x) => x !== d) : [...q.domains, d] })} className={`rounded-md border px-1.5 py-0.5 text-[10px] ${q.domains.includes(d) ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-faint'}`}>{d}</button>)}</Row>
        <Row label="Earcons" hint="Soft distinct tones per domain and alert severity"><Switch label="Earcons" on={q.earcons} onChange={(v) => set({ earcons: v })} /></Row>
        <Row label="Test"><button className={btnCls} onClick={() => window.dispatchEvent(new CustomEvent('pulse:squawk-test'))}>Play sample</button></Row>
      </Section>
      <Section title="Listen mode (briefs)">
        <Row label="Speech rate"><Slider label="Listen rate" value={s.ttsRate} min={0.7} max={1.6} step={0.05} onChange={(v) => s.set({ ttsRate: v })} format={(v) => `${v.toFixed(2)}×`} /></Row>
        <Row label="Server voice" hint="Uses ELEVENLABS_API_KEY on the server when set; falls back to the browser voice"><Switch label="Server voice" on={s.ttsServer} onChange={(v) => s.set({ ttsServer: v })} /></Row>
      </Section>
    </>
  );
}
