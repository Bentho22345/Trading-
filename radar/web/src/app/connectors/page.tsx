'use client';
import { useCallback, useEffect, useState } from 'react';
import { Dot, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useLive, useNow } from '@/lib/live';

type Field = { name: string; label: string; secret: boolean; optional: boolean; placeholder: string; value: string; from_env: boolean };
type Conn = {
  id: string; name: string; category: string; kind: 'keyless' | 'key' | 'info'; what: string; used_for: string; phase: number;
  signup_url?: string; how?: string; cost: string; state: string; last_test?: number; last_msg?: string; testable: boolean;
  health?: any; fields: Field[];
};

const STATE_LABEL: Record<string, string> = {
  ok: 'Running', pending: 'Starting', stale: 'Stale', degraded: 'Degraded', down: 'Unreachable',
  needs_key: 'Needs your key', saved: 'Saved', connected: 'Connected', error: 'Error', unavailable: 'Not available',
};

export default function ConnectorsPage() {
  const [data, setData] = useState<{ connectors: Conn[]; custom: any[] } | null>(null);
  const load = useCallback(() => api('/api/connectors').then(setData).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  if (!data) return <p className="p-6 text-mute">Loading connectors…</p>;

  const auto = data.connectors.filter((c) => c.kind === 'keyless');
  const need = data.connectors.filter((c) => c.kind === 'key');
  const info = data.connectors.filter((c) => c.kind === 'info');
  const connected = need.filter((c) => c.state === 'connected').length;

  return (
    <div className="mx-auto max-w-6xl space-y-4 pt-2">
      <div>
        <h1 className="text-lg font-bold">Connectors</h1>
        <p className="text-mute">Everything Radar can reach on its own is already running. Below that are the services that need something only you can get
          (an API key or account), and a box to plug in any other feed or API you find. Keys are encrypted on the server and never sent back to the browser.</p>
      </div>

      <AddYourOwn onAdded={load} custom={data.custom} />

      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-mute">Needs you · {connected}/{need.length} connected</h2>
        <div className="grid gap-2 md:grid-cols-2">
          {need.sort((a, b) => a.phase - b.phase).map((c) => <KeyCard key={c.id} c={c} onChange={load} />)}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-mute">Running automatically · no key needed · {auto.filter((c) => c.state === 'ok').length}/{auto.length} healthy</h2>
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
          {auto.map((c) => (
            <div key={c.id} className="rounded border border-line bg-panel p-2">
              <div className="flex items-center gap-2"><Dot status={c.state} /><b>{c.name}</b><span className="ml-auto text-[11px] text-mute">{STATE_LABEL[c.state] || c.state}</span></div>
              <p className="mt-1 text-mute">{c.what}</p>
              <p className="mt-1 text-[11px] text-mute">Feeds: {c.used_for}</p>
              {c.health?.last_error_msg && c.state !== 'ok' && <p className="mt-1 break-all text-[11px] text-down">{c.health.last_error_msg}</p>}
              {c.signup_url && <a href={c.signup_url} target="_blank" rel="noreferrer" className="text-[11px] text-accent">docs ↗</a>}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-mute">Not connectable (and why)</h2>
        <div className="grid gap-2 md:grid-cols-3">
          {info.map((c) => (
            <div key={c.id} className="rounded border border-line bg-panel p-2">
              <b>{c.name}</b>
              <p className="mt-1 text-mute">{c.what}</p>
              {c.how && <p className="mt-1 text-[11px]">{c.how}</p>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function KeyCard({ c, onChange }: { c: Conn; onChange: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<any>) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fn();
      if (r?.message) setMsg({ ok: r.status === 'ok', text: r.message });
      setVals({});
      onChange();
    } catch (e: any) { setMsg({ ok: false, text: String(e.message || e) }); }
    setBusy(false);
  };
  const stateCls = c.state === 'connected' ? 'text-up' : c.state === 'error' ? 'text-down' : c.state === 'needs_key' ? 'text-warn' : 'text-mute';
  return (
    <div className="rounded border border-line bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Dot status={c.state === 'needs_key' ? 'stale' : c.state} /><b>{c.name}</b>
        <span className="rounded bg-panel2 px-1 text-[10px] text-mute">{c.category}</span>
        <span className="rounded bg-panel2 px-1 text-[10px] text-mute">Phase {c.phase}</span>
        <span className="rounded bg-panel2 px-1 text-[10px] text-mute">{c.cost}</span>
        <span className={`ml-auto text-[11px] ${stateCls}`}>{STATE_LABEL[c.state] || c.state}</span>
      </div>
      <p className="mt-1">{c.what}</p>
      <p className="mt-1 text-[11px] text-mute">Powers: {c.used_for}</p>
      {c.how && <p className="mt-1 text-[11px] text-mute"><b className="text-fg">How to get it:</b> {c.how}</p>}
      {c.signup_url && <a href={c.signup_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-accent hover:underline">Get it here ↗</a>}
      <form className="mt-2 space-y-1" onSubmit={(e) => { e.preventDefault(); run(() => api(`/api/connectors/${c.id}`, { method: 'POST', body: JSON.stringify({ values: vals }) })); }}>
        {c.fields.map((f) => (
          <label key={f.name} className="flex items-center gap-2">
            <span className="w-40 shrink-0 text-[11px] text-mute">{f.label}{f.optional ? '' : ' *'}</span>
            <input type={f.secret ? 'password' : 'text'} autoComplete="off" value={vals[f.name] ?? ''}
              onChange={(e) => setVals((v) => ({ ...v, [f.name]: e.target.value }))}
              placeholder={f.value ? `${f.value}${f.from_env ? ' (from .env)' : ''}` : f.placeholder}
              className="min-w-0 flex-1 rounded border border-line bg-panel2 px-2 py-1 outline-none focus:border-accent" />
          </label>
        ))}
        <div className="flex items-center gap-2 pt-1">
          <button disabled={busy || !Object.values(vals).some(Boolean)} className="rounded bg-accent/20 px-3 py-1 text-accent disabled:opacity-40">Save & test</button>
          {c.testable && c.state !== 'needs_key' && <button type="button" disabled={busy} onClick={() => run(() => api(`/api/connectors/${c.id}/test`, { method: 'POST' }))} className="rounded border border-line px-3 py-1 hover:border-accent">Test</button>}
          {c.state !== 'needs_key' && <button type="button" disabled={busy} onClick={() => run(() => api(`/api/connectors/${c.id}`, { method: 'DELETE' }))} className="rounded border border-line px-3 py-1 text-mute hover:border-down hover:text-down">Remove</button>}
          {busy && <span className="text-mute">…</span>}
        </div>
      </form>
      {c.id === 'telegram_user' && c.state !== 'needs_key' && <TelegramLogin />}
      {(msg || c.last_msg) && <p className={`mt-1 break-words text-[11px] ${(msg ? msg.ok : c.state === 'connected') ? 'text-up' : 'text-down'}`}>
        {msg ? msg.text : `${c.last_msg} · ${ago(c.last_test)} ago`}</p>}
    </div>
  );
}

function AddYourOwn({ onAdded, custom }: { onAdded: () => void; custom: any[] }) {
  const now = useNow(5000);
  const [f, setF] = useState({ url: '', name: '', kind: 'auto', header_name: '', header_value: '', items_path: '', interval_s: '60', subscribe: '' });
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => { api('/api/sources/items?limit=40').then(setItems).catch(() => {}); }, [custom.length]);
  useLive(({ ch, data }) => { if (ch === 'custom') setItems((p) => [data, ...p].slice(0, 60)); });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api('/api/sources', { method: 'POST', body: JSON.stringify({
        url: f.url.trim(), name: f.name.trim() || null, kind: f.kind,
        headers: f.header_name ? { [f.header_name]: f.header_value } : null,
        items_path: f.items_path || null, interval_s: +f.interval_s || 60, subscribe: f.subscribe || null,
      }) });
      setF({ ...f, url: '', name: '', header_name: '', header_value: '', items_path: '', subscribe: '' });
      onAdded();
    } catch (e: any) { setErr(String(e.message || e)); }
    setBusy(false);
  };
  const inp = 'min-w-0 rounded border border-line bg-panel2 px-2 py-1 outline-none focus:border-accent';
  return (
    <Panel title="➕ Add your own source — paste any link you find">
      <div className="p-3">
        <p className="mb-2 text-mute">Paste an <b className="text-fg">RSS/Atom feed</b>, a <b className="text-fg">JSON API</b> URL, a <b className="text-fg">WebSocket</b> (wss://), or a website’s homepage (Radar finds its RSS feed automatically).
          New items stream into Radar live and are scanned for contract addresses and $cashtags. Radar won’t scrape plain HTML pages.</p>
        <form onSubmit={submit} className="flex flex-wrap gap-2">
          <input required value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://… or wss://…" className={`${inp} flex-[3_1_280px]`} />
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Name (optional)" className={`${inp} flex-[1_1_140px]`} />
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className={inp}>
            <option value="auto">Auto-detect</option><option value="rss">RSS/Atom</option><option value="json">JSON API</option><option value="websocket">WebSocket</option>
          </select>
          <button disabled={busy} className="rounded bg-accent/20 px-4 py-1 text-accent disabled:opacity-40">{busy ? 'Checking…' : 'Connect'}</button>
          <button type="button" onClick={() => setAdv(!adv)} className="text-[11px] text-mute hover:text-fg">{adv ? 'less' : 'advanced (API key header, path, interval)'}</button>
          {adv && (
            <div className="flex w-full flex-wrap gap-2">
              <input value={f.header_name} onChange={(e) => setF({ ...f, header_name: e.target.value })} placeholder="Header name, e.g. x-api-key" className={`${inp} flex-1`} />
              <input type="password" value={f.header_value} onChange={(e) => setF({ ...f, header_value: e.target.value })} placeholder="Header value (encrypted)" className={`${inp} flex-1`} />
              <input value={f.items_path} onChange={(e) => setF({ ...f, items_path: e.target.value })} placeholder="JSON items path, e.g. data.items" className={`${inp} flex-1`} />
              <input value={f.interval_s} onChange={(e) => setF({ ...f, interval_s: e.target.value })} placeholder="Poll every (s, min 15)" className={`${inp} w-36`} />
              <input value={f.subscribe} onChange={(e) => setF({ ...f, subscribe: e.target.value })} placeholder='WebSocket subscribe message, e.g. {"method":"subscribe"}' className={`${inp} w-full`} />
            </div>
          )}
        </form>
        {err && <p className="mt-2 text-down">{err}</p>}
        {!!custom.length && (
          <table className="mt-3 w-full">
            <thead className="text-[11px] text-mute"><tr><th className="text-left font-normal">Source</th><th className="text-left font-normal">Type</th><th className="text-left font-normal">Status</th><th className="text-right font-normal">Items</th><th /></tr></thead>
            <tbody>
              {custom.map((s) => (
                <tr key={s.id} className="border-t border-line/60">
                  <td className="py-1"><b>{s.name}</b><div className="max-w-[420px] truncate text-[11px] text-mute">{s.url}</div></td>
                  <td>{s.kind}</td>
                  <td className="text-[11px]"><span className="flex items-center gap-1"><Dot status={s.status || 'pending'} />{s.status || 'starting'} {s.last_ok ? `· ${ago(s.last_ok, now)} ago` : ''}</span>
                    {s.status === 'error' && <div className="max-w-[300px] truncate text-down" title={s.last_msg}>{s.last_msg}</div>}</td>
                  <td className="text-right num">{s.items}</td>
                  <td className="text-right"><button onClick={() => api(`/api/sources/${s.id}`, { method: 'DELETE' }).then(onAdded)} className="text-mute hover:text-down">remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!!items.length && (
          <div className="mt-3">
            <h3 className="mb-1 text-[11px] uppercase text-mute">Latest from your sources</h3>
            <ul className="max-h-64 overflow-auto">
              {items.map((i) => (
                <li key={i.id} className="border-t border-line/50 py-1"><span className="text-[11px] text-mute">{i.source} · {ago(i.ts, now)} </span>
                  {i.link ? <a href={i.link} target="_blank" rel="noreferrer" className="hover:text-accent">{i.title}</a> : i.title}
                  {i.detected?.solana?.length ? <span className="ml-1 text-flash">CA!</span> : null}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}

function TelegramLogin() {
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState('');
  const call = (path: string, body?: any) => api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }).then((r) => setMsg(r.message)).catch((e) => setMsg(String(e.message)));
  return (
    <div className="mt-2 rounded border border-line p-2 text-[11px]">
      <b>Sign in once</b> (Telegram sends a login code to your app):
      <div className="mt-1 flex flex-wrap gap-1">
        <button onClick={() => call('/api/telegram/send-code')} className="rounded border border-line px-2">1. Send code</button>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="code" className="w-20 rounded border border-line bg-panel2 px-1" />
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="2FA password (if set)" className="w-36 rounded border border-line bg-panel2 px-1" />
        <button onClick={() => call('/api/telegram/sign-in', { code, password: pw || null })} className="rounded border border-line px-2">2. Sign in</button>
      </div>
      {msg && <p className="mt-1">{msg}</p>}
    </div>
  );
}
