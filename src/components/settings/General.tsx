'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Reorder } from 'framer-motion';
import { useSettings } from '@/lib/settings';
import { useStore } from '@/lib/store';
import { api } from '@/lib/v2';
import { ACTIONS, bindings, conflicts, keyOf, prettyKey, type Action } from '@/lib/shortcuts';
import { Row, Section, Slider, Switch, btnCls, download, inputCls, primaryBtn } from './controls';
import { Segmented, Icon } from '../ui';

const TZS = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin', 'Europe/Zurich', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];

export function TickerSection() {
  const s = useSettings();
  const symbols = useStore((st) => st.symbols);
  const [q, setQ] = useState('');
  const t = s.ticker;
  const set = (p: Partial<typeof t>) => s.set({ ticker: { ...t, ...p } });
  const matches = useMemo(() => (q.length < 1 ? [] : Object.values(symbols).filter((m) => (m.symbol + m.name).toLowerCase().includes(q.toLowerCase()) && !t.symbols.includes(m.symbol)).slice(0, 8)), [q, symbols, t.symbols]);
  return (
    <Section title="Ticker strip" description="Compose exactly what scrolls across the top.">
      <Row label="Mode" hint="Auto shows movers per group; custom shows your exact list in your order">
        <Segmented label="Ticker mode" value={t.mode} onChange={(v) => set({ mode: v })} options={[{ value: 'auto', label: 'Auto (movers)' }, { value: 'custom', label: 'Custom list' }]} />
      </Row>
      {t.mode === 'auto' ? (
        <Row label="Groups">
          {(['EQ', 'FX', 'CRYPTO', 'MACRO'] as const).map((g) => (
            <button key={g} onClick={() => { const next = s.tickerGroups.includes(g) ? s.tickerGroups.filter((x) => x !== g) : [...s.tickerGroups, g]; if (next.length) s.set({ tickerGroups: next }); }} className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${s.tickerGroups.includes(g) ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-faint'}`}>{g}</button>
          ))}
        </Row>
      ) : (
        <div className="px-4 py-3">
          <div className="relative mb-2">
            <input className={`${inputCls} w-64`} placeholder="Add symbol…" value={q} onChange={(e) => setQ(e.target.value)} />
            {matches.length ? <div className="absolute z-10 mt-1 w-64 rounded-lg border border-line bg-panel-solid p-1 shadow-xl">{matches.map((m) => <button key={m.symbol} onClick={() => { set({ symbols: [...t.symbols, m.symbol] }); setQ(''); }} className="block w-full rounded px-2 py-1 text-left text-xs text-dim hover:bg-panel-hover">{m.symbol} <span className="text-faint">{m.name}</span></button>)}</div> : null}
          </div>
          <Reorder.Group axis="x" values={t.symbols} onReorder={(v) => set({ symbols: v })} className="flex flex-wrap gap-1.5">
            {t.symbols.map((sym) => (
              <Reorder.Item key={sym} value={sym} className="flex cursor-grab items-center gap-1 rounded-md border border-line bg-bg-2 px-2 py-0.5 text-xs text-text">
                {sym}<button onClick={() => set({ symbols: t.symbols.filter((x) => x !== sym) })} className="text-faint hover:text-down" aria-label={`Remove ${sym}`}>×</button>
              </Reorder.Item>
            ))}
          </Reorder.Group>
          {!t.symbols.length ? <p className="text-[11px] text-faint">Add symbols; drag to reorder.</p> : null}
        </div>
      )}
      <Row label="Speed"><Slider label="Ticker speed" value={s.tickerSpeed} min={10} max={120} step={5} onChange={(v) => s.set({ tickerSpeed: v })} format={(v) => `${v}px/s`} /></Row>
      <Row label="Density"><Segmented label="Ticker density" value={t.density} onChange={(v) => set({ density: v })} options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }]} /></Row>
      <Row label="Fields">
        {(['change', 'pct', 'delay'] as const).map((f) => <label key={f} className="flex items-center gap-1 text-[11px] text-dim"><input type="checkbox" checked={t.fields[f]} onChange={(e) => set({ fields: { ...t.fields, [f]: e.target.checked } })} />{f === 'pct' ? '% change' : f === 'delay' ? 'delay chip' : 'abs change'}</label>)}
      </Row>
    </Section>
  );
}

export function ShortcutsSection() {
  const s = useSettings();
  const map = bindings(s.shortcuts);
  const clash = conflicts(map);
  const [capturing, setCapturing] = useState<Action | null>(null);
  useEffect(() => {
    if (!capturing) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setCapturing(null);
      if (['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) return;
      s.set({ shortcuts: { ...s.shortcuts, [capturing]: keyOf(e) } });
      setCapturing(null);
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [capturing, s]);
  return (
    <Section title="Keyboard shortcuts" description="Click a binding, then press the new key. 1–9 switch workspaces and ⇧1–⇧6 switch feed filters (reserved)." right={<button className={btnCls} onClick={() => s.set({ shortcuts: {} })}>Reset all</button>}>
      {ACTIONS.map((a) => {
        const k = map[a.id];
        const bad = clash[k]?.includes(a.id);
        return (
          <Row key={a.id} label={a.label} warn={bad ? `Conflicts with ${clash[k].filter((x) => x !== a.id).map((x) => ACTIONS.find((y) => y.id === x)?.label ?? 'a reserved key').join(', ')}` : undefined}>
            <button disabled={a.fixed} onClick={() => setCapturing(a.id)} className={`num min-w-[5rem] rounded-md border px-2 py-0.5 text-xs ${capturing === a.id ? 'border-accent text-accent' : bad ? 'border-down/50 text-down' : 'border-line text-text'} disabled:opacity-60`}>{capturing === a.id ? 'Press a key…' : prettyKey(k)}</button>
          </Row>
        );
      })}
    </Section>
  );
}

export function TimeSection() {
  const s = useSettings();
  const [tz, setTz] = useState<string>('');
  useEffect(() => { void api<{ tz: string }>('/api/user').then((r) => setTz(r.tz)).catch(() => {}); }, []);
  const saveTz = async (v: string) => { setTz(v); await api('/api/user', { method: 'PUT', json: { tz: v } }); };
  const [sess, setSess] = useState({ label: '', tz: 'Asia/Singapore', openH: 9, closeH: 17 });
  return (
    <Section title="Time zones & hours" description="Your home time zone drives brief schedules and the calendar's 'today'.">
      <Row label="Home time zone"><select className={inputCls} value={tz} onChange={(e) => void saveTz(e.target.value)}>{[...new Set([tz, ...TZS])].filter(Boolean).map((t) => <option key={t}>{t}</option>)}</select></Row>
      <Row label="Extra clocks" hint="Shown in the header">
        <div className="flex flex-wrap gap-1.5">{s.clocks.map((c) => <span key={c} className="flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-text">{c.split('/').pop()?.replace('_', ' ')}<button onClick={() => s.set({ clocks: s.clocks.filter((x) => x !== c) })} className="text-faint hover:text-down">×</button></span>)}</div>
        <select className={inputCls} value="" onChange={(e) => e.target.value && s.set({ clocks: [...s.clocks, e.target.value].slice(0, 5) })}><option value="">+ clock</option>{TZS.filter((t) => !s.clocks.includes(t)).map((t) => <option key={t}>{t}</option>)}</select>
      </Row>
      <Row label="Working hours" hint="Low-priority alerts outside these hours go to the digest"><input className={`${inputCls} num w-16`} value={s.workingHours.start} onChange={(e) => s.set({ workingHours: { ...s.workingHours, start: e.target.value } })} />–<input className={`${inputCls} num w-16`} value={s.workingHours.end} onChange={(e) => s.set({ workingHours: { ...s.workingHours, end: e.target.value } })} /></Row>
      <Row label="Quiet hours" hint="No sounds, squawk or push; critical alerts still escalate">
        <input className={`${inputCls} num w-16`} value={s.quietHours.start} onChange={(e) => s.set({ quietHours: { ...s.quietHours, start: e.target.value } })} />–<input className={`${inputCls} num w-16`} value={s.quietHours.end} onChange={(e) => s.set({ quietHours: { ...s.quietHours, end: e.target.value } })} />
        <Switch label="Quiet hours" on={s.quietHours.enabled} onChange={(v) => { s.set({ quietHours: { ...s.quietHours, enabled: v } }); void api('/api/alert-settings', { method: 'PUT', json: { quietHours: { ...s.quietHours, enabled: v } } }).catch(() => {}); }} />
      </Row>
      <div className="px-4 py-3">
        <div className="mb-2 text-xs font-medium text-text">Custom sessions</div>
        {s.customSessions.map((c) => <div key={c.id} className="mb-1 flex items-center gap-2 text-xs text-dim">{c.label} · {c.tz} · {c.openH}:00–{c.closeH}:00 <button onClick={() => s.set({ customSessions: s.customSessions.filter((x) => x.id !== c.id) })} className="text-faint hover:text-down">remove</button></div>)}
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${inputCls} w-32`} placeholder="Name" value={sess.label} onChange={(e) => setSess({ ...sess, label: e.target.value })} />
          <select className={inputCls} value={sess.tz} onChange={(e) => setSess({ ...sess, tz: e.target.value })}>{TZS.map((t) => <option key={t}>{t}</option>)}</select>
          <input type="number" min={0} max={23} className={`${inputCls} w-14`} value={sess.openH} onChange={(e) => setSess({ ...sess, openH: Number(e.target.value) })} />
          <input type="number" min={1} max={24} className={`${inputCls} w-14`} value={sess.closeH} onChange={(e) => setSess({ ...sess, closeH: Number(e.target.value) })} />
          <button className={btnCls} disabled={!sess.label} onClick={() => { s.set({ customSessions: [...s.customSessions, { ...sess, id: crypto.randomUUID() }] }); setSess({ ...sess, label: '' }); }}>Add</button>
        </div>
      </div>
    </Section>
  );
}

export function DataSection() {
  const s = useSettings();
  const fileRef = useRef<HTMLInputElement>(null);
  const exportAll = async () => {
    const server = await api<Record<string, unknown>>('/api/export');
    const { hydrated: _h, hydrate: _hy, set: _s, reset: _r, pullRemote: _p, ...client } = useSettings.getState();
    download(`pulse-settings-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ pulseSettings: 2, client, server }, null, 2));
  };
  const importAll = async (f: File) => {
    try {
      const j = JSON.parse(await f.text()) as { pulseSettings?: number; client?: Record<string, unknown>; server?: unknown };
      if (j.pulseSettings !== 2) throw new Error('not a PULSE 2 settings file');
      if (j.server) await api('/api/import', { method: 'POST', json: j.server });
      if (j.client) useSettings.getState().set(j.client as never);
      useStore.getState().pushToast({ kind: 'info', title: 'Settings imported' });
    } catch (e) {
      useStore.getState().pushToast({ kind: 'error', title: 'Import failed', body: (e as Error).message });
    }
  };
  return (
    <Section title="Backup, restore & sync" description="One JSON file holds everything: theme, layout, workspaces, brief profiles, playbooks, smart feeds, positions, journal, levels, alert routes, sources and score weights. Integration secrets are never exported.">
      <Row label="Export all settings"><button className={primaryBtn} onClick={() => void exportAll()}><Icon name="external" size={12} /> Export JSON</button></Row>
      <Row label="Import settings" hint="Replaces matching collections"><button className={btnCls} onClick={() => fileRef.current?.click()}>Choose file…</button><input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void importAll(e.target.files[0])} /></Row>
      <Row label="Sync across devices" hint="Settings saved to this PULSE server; other browsers adopt the newest copy"><Switch label="Sync" on={s.syncEnabled} onChange={(v) => s.set({ syncEnabled: v })} /></Row>
      <Row label="Reset this browser's preferences"><button onClick={s.reset} className="rounded-md border border-down/40 px-2 py-1 text-[11px] text-down">Reset</button></Row>
    </Section>
  );
}

export function NotificationsSection() {
  const s = useSettings();
  const ask = async () => {
    if (typeof Notification === 'undefined') return;
    s.set({ notifications: (await Notification.requestPermission()) === 'granted' });
  };
  return (
    <Section title="Browser notifications">
      <Row label="Notifications while the tab is hidden">{s.notifications ? <Switch label="Notifications" on onChange={() => s.set({ notifications: false })} /> : <button onClick={() => void ask()} className={btnCls}>Ask permission</button>}</Row>
    </Section>
  );
}
