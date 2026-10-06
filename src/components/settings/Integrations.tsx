'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { Row, Section, Slider, Switch, btnCls, inputCls, primaryBtn } from './controls';

interface Field { key: string; label: string; secret?: boolean; placeholder?: string; optional?: boolean }
interface DType { type: string; label: string; direction: string; powers: string; fields: Field[]; docs: string; disabled: boolean }
interface Integ { id: string; type: string; label: string; enabled: boolean; config: Record<string, string>; secretsSet: string[]; lastTest?: { ok: boolean; at: number; error?: string }; icsUrl?: string }

function Form({ t, existing, onDone }: { t: DType; existing?: Integ; onDone: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(existing?.config ?? {});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const config: Record<string, string> = {}, secrets: Record<string, string> = {};
      for (const f of t.fields) (f.secret ? secrets : config)[f.key] = vals[f.key] ?? '';
      await api(`/api/integrations/${existing?.id ?? `${t.type}-${Date.now().toString(36)}`}`, { method: 'PUT', json: { type: t.type, label: t.label, config, secrets, enabled: true } });
      onDone();
    } catch (e) { useStore.getState().pushToast({ kind: 'error', title: 'Could not save', body: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2 border-t border-line bg-bg-2/30 px-4 py-3">
      <p className="text-[11px] text-faint">{t.docs}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {t.fields.map((f) => (
          <label key={f.key} className="text-[11px] text-faint">{f.label}{f.optional ? ' (optional)' : ''}
            <input type={f.secret ? 'password' : 'text'} autoComplete="off" className={`${inputCls} mt-0.5 w-full`} placeholder={f.secret && existing?.secretsSet.includes(f.key) ? '•••••• saved (leave blank to keep)' : f.placeholder} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
          </label>
        ))}
      </div>
      <p className="text-[10px] text-faint">Secrets are encrypted at rest on your server (AES-256-GCM) and never sent back to the browser.</p>
      <button className={primaryBtn} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : existing ? 'Update' : 'Connect'}</button>
    </div>
  );
}

export function IntegrationsSection() {
  const [types, setTypes] = useState<DType[]>([]);
  const [list, setList] = useState<Integ[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [push, setPush] = useState<'unknown' | 'on' | 'off' | 'unsupported'>('unknown');
  const load = () => { void api<DType[]>('/api/integrations/types').then(setTypes); void api<Integ[]>('/api/integrations').then(setList); };
  useEffect(load, []);
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setPush('unsupported');
    void navigator.serviceWorker.getRegistration().then((r) => r?.pushManager.getSubscription()).then((s) => setPush(s ? 'on' : 'off'));
  }, []);
  const toast = useStore.getState().pushToast;
  const test = async (id: string) => {
    const r = await api<{ ok: boolean; error?: string; meetings?: number }>(`/api/integrations/${id}/test`, { method: 'POST' });
    toast({ kind: r.ok ? 'info' : 'error', title: r.ok ? 'Test sent ✓' : 'Test failed', body: r.ok ? (r.meetings !== undefined ? `${r.meetings} upcoming meetings read` : 'Check the destination.') : r.error });
    load();
  };
  const enablePush = async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('permission denied');
      const { publicKey } = await api<{ publicKey: string }>('/api/push/vapid');
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (publicKey.length % 4)) % 4)), (c) => c.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await api('/api/push/subscribe', { method: 'POST', json: sub.toJSON() });
      setPush('on');
      await api('/api/push/test', { method: 'POST' });
    } catch (e) { toast({ kind: 'error', title: 'Push not enabled', body: (e as Error).message }); }
  };
  return (
    <>
      <Section title="Web push (this device)" description="Alerts and the Morning Brief as notifications, even when PULSE is closed. Works on desktop browsers and installed iOS/Android PWAs.">
        <Row label="Push notifications" hint={push === 'unsupported' ? 'This browser does not support web push' : undefined}>{push === 'on' ? <span className="text-xs text-up">enabled ✓</span> : push === 'off' ? <button className={primaryBtn} onClick={() => void enablePush()}>Enable on this device</button> : null}</Row>
      </Section>
      <Section title="Connected" description="Every integration is optional. Missing or broken ones never affect the terminal.">
        {list.map((i) => {
          const t = types.find((x) => x.type === i.type);
          return (
            <div key={i.id}>
              <Row label={i.label} hint={<>{t?.powers}{i.lastTest ? <span className={i.lastTest.ok ? ' text-up' : ' text-down'}> · last test {i.lastTest.ok ? 'ok' : `failed: ${i.lastTest.error}`}</span> : null}{i.icsUrl ? <><br /><span className="select-all break-all text-dim">{location.origin}{i.icsUrl.replace(/^https?:\/\/[^/]+/, '')}</span></> : null}</>}>
                <Switch label={`Enable ${i.label}`} on={i.enabled} onChange={(v) => void api(`/api/integrations/${i.id}`, { method: 'PUT', json: { enabled: v } }).then(load)} />
                {i.type !== 'calendar-out' ? <button className={btnCls} onClick={() => void test(i.id)}>Send test</button> : null}
                {i.type === 'sheets' ? <button className={btnCls} onClick={() => void api<{ imported: number }>(`/api/integrations/${i.id}/import`, { method: 'POST' }).then((r) => toast({ kind: 'info', title: `Imported ${r.imported} positions` }))}>Import now</button> : null}
                <button className={btnCls} onClick={() => setOpen(open === i.id ? null : i.id)}>Edit</button>
                <button className="text-[11px] text-faint hover:text-down" onClick={() => void api(`/api/integrations/${i.id}`, { method: 'DELETE' }).then(load)}>Disconnect</button>
              </Row>
              {open === i.id && t ? <Form t={t} existing={i} onDone={() => { setOpen(null); load(); }} /> : null}
            </div>
          );
        })}
        {!list.length ? <p className="px-4 py-3 text-xs text-faint">Nothing connected yet.</p> : null}
      </Section>
      <Section title="Available">
        {types.map((t) => (
          <div key={t.type}>
            <Row label={t.label} hint={`${t.direction === 'in' ? 'In' : t.direction === 'both' ? 'In + out' : 'Out'} · ${t.powers}`}>{t.disabled ? <span className="text-[11px] text-faint">disabled by server flag</span> : <button className={btnCls} onClick={() => setOpen(open === t.type ? null : t.type)}>{open === t.type ? 'Cancel' : 'Connect'}</button>}</Row>
            {open === t.type ? <Form t={t} onDone={() => { setOpen(null); load(); }} /> : null}
          </div>
        ))}
        <Row label="Anthropic API" hint="Set ANTHROPIC_API_KEY on the server — powers TL;DRs, brief narrative, Ask Pulse, theme labels, filing one-liners and smart-alert parsing."><span className="text-[11px] text-faint">server env</span></Row>
        <Row label="FRED / Treasury / EDGAR / CFTC / Polymarket / Kalshi / DefiLlama" hint="Keyless or free-key public data, configured on the server (.env). See README."><span className="text-[11px] text-faint">server env</span></Row>
      </Section>
    </>
  );
}

export function AiSection() {
  const [u, setU] = useState<{ used: number; budget: number; costUsd: number; rows: { kind: string; calls: number; input_tokens: number; output_tokens: number; cost_usd: number }[] } | null>(null);
  const [status, setStatus] = useState<{ enabled: boolean; model: string } | null>(null);
  const [budget, setBudget] = useState(300000);
  useEffect(() => {
    void api<NonNullable<typeof u>>('/api/ai/usage').then((x) => { setU(x); setBudget(x.budget); });
    void api<NonNullable<typeof status>>('/api/copilot/status').then(setStatus);
  }, []);
  return (
    <Section title="AI & budget" description="Strict cost controls: a daily token budget across every AI feature, response caching, a small model for classification, and template fallbacks when the budget runs out.">
      <Row label="Status" hint={status?.enabled ? `Model ${status.model}` : 'Set ANTHROPIC_API_KEY on the server to enable AI features'}><span className={`text-xs ${status?.enabled ? 'text-up' : 'text-faint'}`}>{status?.enabled ? 'connected' : 'not connected'}</span></Row>
      <Row label="Daily token budget" hint={u ? `${u.used.toLocaleString()} used today · est. $${u.costUsd.toFixed(3)}` : undefined}>
        <Slider label="Daily budget" value={budget} min={0} max={3_000_000} step={50_000} onChange={setBudget} format={(v) => `${Math.round(v / 1000)}k`} />
        <button className={btnCls} onClick={() => void api('/api/admin/ai-budget', { method: 'PUT', json: { tokens: budget } }).then(() => useStore.getState().pushToast({ kind: 'info', title: 'Budget saved' }))}>Save</button>
      </Row>
      {u ? <div className="px-4 py-3"><div className="mb-1 h-2 overflow-hidden rounded-full bg-bg-2"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (u.used / Math.max(1, u.budget)) * 100)}%` }} /></div>
        <table className="w-full text-[11px]"><tbody>{u.rows.map((r) => <tr key={r.kind}><td className="text-dim">{r.kind}</td><td className="num text-right text-faint">{r.calls} calls</td><td className="num text-right text-faint">{(r.input_tokens + r.output_tokens).toLocaleString()} tok</td><td className="num text-right text-text">${r.cost_usd.toFixed(3)}</td></tr>)}</tbody></table></div> : null}
    </Section>
  );
}
