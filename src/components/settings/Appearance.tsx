'use client';
import { useEffect, useRef, useState } from 'react';
import { useSettings } from '@/lib/settings';
import { useDocs, useV2 } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { contrast, PRESETS, resolveColor, type ThemeConfig, type TokenKey } from '@/lib/theme';
import { playChime } from '@/lib/sound';
import { Row, Section, Slider, Switch, btnCls, download, inputCls, primaryBtn } from './controls';
import { Segmented } from '../ui';

const DOMAIN_TOKENS: [TokenKey, string][] = [['accent', 'Accent'], ['fx', 'FX'], ['crypto', 'Crypto'], ['eq', 'Equities'], ['macro', 'Macro'], ['rates', 'Rates'], ['cmdty', 'Commodities'], ['social', 'Social / prediction'], ['reg', 'Regulation']];

function ColorInput({ token, label, tc, update }: { token: TokenKey; label: string; tc: ThemeConfig; update: (p: Partial<ThemeConfig>) => void }) {
  const [current, setCurrent] = useState('#888888');
  useEffect(() => setCurrent(tc.tokens[token] ?? resolveColor(token)), [tc, token]);
  return (
    <label className="flex items-center gap-2 text-[11px] text-dim">
      <input type="color" value={current} onChange={(e) => update({ preset: 'custom', tokens: { ...tc.tokens, [token]: e.target.value } })} className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent" aria-label={`${label} colour`} />
      {label}
      {tc.tokens[token] ? <button onClick={() => { const t = { ...tc.tokens }; delete t[token]; update({ tokens: t }); }} className="text-faint hover:text-text" aria-label={`Reset ${label}`}>↺</button> : null}
    </label>
  );
}

function ContrastBadge({ fg, bg, label }: { fg: string; bg: string; label: string }) {
  const r = contrast(fg, bg);
  if (r === null) return null;
  const pass = r >= 4.5, ui = r >= 3;
  return (
    <span className={`rounded-md border px-1.5 py-0.5 text-[10px] ${pass ? 'border-up/40 text-up' : ui ? 'border-warn/40 text-warn' : 'border-down/50 text-down'}`} title={pass ? 'Passes WCAG AA for text' : ui ? 'Passes for large text / UI only' : 'Fails WCAG contrast'}>
      {label} {r.toFixed(1)}:1 {pass ? 'AA' : ui ? 'AA large' : 'fail'}
    </span>
  );
}

export function AppearanceSection() {
  const s = useSettings();
  const tc = s.themeConfig;
  const themes = useDocs<{ id: string; name: string; config: ThemeConfig }>('themes');
  const [tick, setTick] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const update = (p: Partial<ThemeConfig>) => {
    s.set({ themeConfig: { ...tc, ...p }, ...(p.base ? { theme: p.base } : {}) });
    setTimeout(() => setTick((x) => x + 1), 30);
  };
  // re-read resolved colours after the theme applies (for contrast checks)
  const [colors, setColors] = useState({ up: '#22c983', down: '#f2555a', panel: '#11111d', bg: '#07070d' });
  useEffect(() => {
    setColors({ up: resolveColor('up'), down: resolveColor('down'), panel: resolveColor('panel-solid'), bg: resolveColor('bg') });
  }, [tick, s.colorblind, s.theme]);
  const failing = [contrast(colors.up, colors.panel), contrast(colors.down, colors.panel)].some((r) => r !== null && r < 3);
  const similar = (() => {
    const r = contrast(colors.up, colors.down);
    return r !== null && r < 1.15;
  })();

  const saveTheme = async () => {
    const name = prompt('Name this theme', tc.preset === 'custom' ? 'My theme' : `${PRESETS.find((p) => p.id === tc.preset)?.name} (custom)`);
    if (!name) return;
    await useV2.getState().putDoc('themes', { name, config: { ...tc, base: s.theme } });
    useStore.getState().pushToast({ kind: 'info', title: `Theme “${name}” saved` });
  };
  const importTheme = async (f: File) => {
    try {
      const j = JSON.parse(await f.text()) as { pulseTheme?: number; name?: string; config?: ThemeConfig };
      if (!j.config) throw new Error('not a PULSE theme');
      update({ ...j.config });
      await useV2.getState().putDoc('themes', { name: j.name ?? 'Imported theme', config: j.config });
    } catch (e) {
      useStore.getState().pushToast({ kind: 'error', title: 'Import failed', body: (e as Error).message });
    }
  };

  return (
    <>
      <Section title="Theme" description="Presets, colours and density. Changes preview live across the whole terminal." right={
        <span className="flex gap-1.5">
          <button className={btnCls} onClick={saveTheme}>Save as…</button>
          <button className={btnCls} onClick={() => download('pulse-theme.json', JSON.stringify({ pulseTheme: 1, name: 'Shared theme', config: { ...tc, base: s.theme } }, null, 2))}>Share (export)</button>
          <button className={btnCls} onClick={() => fileRef.current?.click()}>Import</button>
          <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void importTheme(e.target.files[0])} />
        </span>
      }>
        <div className="grid grid-cols-2 gap-2 p-4 md:grid-cols-4">
          {PRESETS.map((p) => (
            <button key={p.id} onClick={() => update({ ...p.config })} className={`overflow-hidden rounded-xl border text-left ${tc.preset === p.id ? 'border-accent ring-1 ring-accent/40' : 'border-line hover:border-line-strong'}`}>
              <div className="flex h-14 items-end gap-1 p-2" style={{ background: p.config.tokens.bg ?? (p.config.base === 'light' ? '#f4f4f8' : '#07070d') }}>
                {(['accent', 'up', 'down', 'fx', 'crypto'] as TokenKey[]).map((k) => <span key={k} className="h-4 w-4 rounded-full" style={{ background: p.config.tokens[k] ?? ({ accent: p.config.base === 'light' ? '#5b5bf0' : '#8b8bff', up: '#22c983', down: '#f2555a', fx: '#22d3ee', crypto: '#f5a524' } as Record<string, string>)[k] }} />)}
              </div>
              <div className="px-2 py-1.5 text-[11px] font-medium text-text">{p.name}</div>
            </button>
          ))}
          {themes.map((t) => (
            <div key={t.id} className="relative">
              <button onClick={() => update({ ...t.config })} className="w-full rounded-xl border border-line px-2 py-1.5 text-left text-[11px] text-dim hover:border-line-strong">{t.name}</button>
              <button onClick={() => void useV2.getState().delDoc('themes', t.id)} className="absolute right-1.5 top-1.5 text-[10px] text-faint hover:text-down" aria-label={`Delete ${t.name}`}>✕</button>
            </div>
          ))}
        </div>
        <Row label="Base"><Segmented label="Base theme" value={s.theme} onChange={(v) => update({ base: v })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} /></Row>
        <Row label="Up / down colours" hint="Checked against the panel background for WCAG contrast" warn={failing ? 'One of these fails WCAG contrast on the panel background.' : similar ? 'Up and down are too similar in brightness — hard to tell apart for many readers.' : undefined}>
          <ColorInput token="up" label="Up" tc={tc} update={update} />
          <ColorInput token="down" label="Down" tc={tc} update={update} />
          <ContrastBadge fg={colors.up} bg={colors.panel} label="up" />
          <ContrastBadge fg={colors.down} bg={colors.panel} label="down" />
        </Row>
        <Row label="Colour-blind safe palette" hint="Blue / orange for up / down; overrides custom up/down colours"><Switch label="Colour-blind palette" on={s.colorblind} onChange={(v) => s.set({ colorblind: v })} /></Row>
        <div className="px-4 py-3">
          <div className="mb-2 text-xs font-medium text-text">Domain accents</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{DOMAIN_TOKENS.map(([k, l]) => <ColorInput key={k} token={k} label={l} tc={tc} update={update} />)}</div>
        </div>
        <Row label="Background intensity" hint="Ambient gradient behind the panels"><Slider label="Background intensity" value={tc.bgIntensity} min={0} max={1} step={0.05} onChange={(v) => update({ bgIntensity: v })} format={(v) => `${Math.round(v * 100)}%`} /></Row>
        <Row label="Glass blur"><Slider label="Glass blur" value={tc.blur} min={0} max={24} onChange={(v) => update({ blur: v })} format={(v) => `${v}px`} /></Row>
        <Row label="Corner radius"><Slider label="Corner radius" value={tc.radius} min={0} max={1.6} step={0.1} onChange={(v) => update({ radius: v })} format={(v) => `${v.toFixed(1)}×`} /></Row>
        <Row label="Density"><Segmented label="Density" value={tc.density} onChange={(v) => update({ density: v })} options={[{ value: 'compact', label: 'Compact' }, { value: 'cozy', label: 'Cozy' }, { value: 'spacious', label: 'Spacious' }]} /></Row>
        <Row label="Fonts" hint="Numbers always use the monospace face">
          <select className={inputCls} value={tc.fontSans} onChange={(e) => update({ fontSans: e.target.value as ThemeConfig['fontSans'] })} aria-label="Interface font"><option value="geist">Geist</option><option value="system">System UI</option><option value="serif">Newsreader (serif)</option></select>
          <select className={inputCls} value={tc.fontMono} onChange={(e) => update({ fontMono: e.target.value as ThemeConfig['fontMono'] })} aria-label="Number font"><option value="geist">Geist Mono</option><option value="system">System mono</option></select>
        </Row>
        <div className="px-4 py-3">
          <div className="mb-2 text-xs font-medium text-text">Live preview</div>
          <div className="glass flex flex-wrap items-center gap-4 rounded-xl p-3">
            <span className="text-sm font-semibold text-text">EURUSD</span><span className="num text-sm text-text">1.16812</span>
            <span className="num text-sm text-up">+0.24%</span><span className="num text-sm text-down">−0.31%</span>
            {(['fx', 'crypto', 'eq', 'rates', 'cmdty', 'social'] as const).map((d) => <span key={d} className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase" style={{ color: `var(--${d})`, background: `color-mix(in oklab, var(--${d}) 14%, transparent)` }}>{d}</span>)}
            <button className={primaryBtn}>Primary</button>
          </div>
        </div>
        <div className="flex justify-end px-4 py-3"><button className={btnCls} onClick={() => update({ ...PRESETS[0].config })}>Reset theme</button></div>
      </Section>
      <Section title="Motion & sound">
        <Row label="Calm mode" hint="Tones down every animation; slower ticker"><Switch label="Calm mode" on={s.calm} onChange={(v) => s.set({ calm: v })} /></Row>
        <Row label="Sound" hint="Soft chime on breaking news and alerts"><button onClick={() => playChime('breaking')} className="text-[11px] text-dim hover:text-text">Preview</button><Switch label="Sound" on={s.sound} onChange={(v) => s.set({ sound: v })} /></Row>
        <Row label="Focus mode" hint="Only the ticker, the feed and the next release"><Switch label="Focus mode" on={s.focus} onChange={(v) => s.set({ focus: v })} /></Row>
      </Section>
    </>
  );
}
