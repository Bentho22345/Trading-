'use client';
import { useEffect, useRef, useState } from 'react';
import type { KeywordEntry, ScoreWeights, SourceHealth } from '@shared/v2';
import { api } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { useNow } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import { Row, Section, Slider, Switch, btnCls, inputCls, primaryBtn } from './controls';

const WEIGHT_ROWS: { k: keyof ScoreWeights; label: string; hint: string; max: number; step?: number }[] = [
  { k: 'credibility', label: 'Source credibility', hint: 'Points for the most credible source in a cluster (× 0–1 credibility)', max: 50 },
  { k: 'severity', label: 'Keyword severity', hint: 'Multiplier on the strongest severity keyword (rate decision, hack, halt…)', max: 3, step: 0.1 },
  { k: 'perSource', label: 'Cluster size (per extra source)', hint: 'Points per corroborating source', max: 20 },
  { k: 'maxCorroboration', label: 'Cluster size cap', hint: 'Maximum points from corroboration', max: 40 },
  { k: 'watchlist', label: 'Watchlist match', hint: 'Boost when a story touches your watchlist', max: 40 },
  { k: 'exposure', label: 'Position exposure', hint: 'Boost when a story touches a position in your book', max: 40 },
  { k: 'centralBank', label: 'Central bank', hint: 'Central-bank stories move every asset class', max: 20 },
  { k: 'base', label: 'Base', hint: 'Starting score for every story', max: 30 },
];

type PreviewRow = { id: string; headline: string; source: string; before: number; after: number; rankBefore: number; rankAfter: number };

export function ScoringSection() {
  const [w, setW] = useState<ScoreWeights | null>(null);
  const [defaults, setDefaults] = useState<ScoreWeights | null>(null);
  const [saved, setSaved] = useState<ScoreWeights | null>(null);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    void api<{ weights: ScoreWeights; defaults: ScoreWeights }>('/api/tuning').then((r) => { setW(r.weights); setSaved(r.weights); setDefaults(r.defaults); });
  }, []);
  useEffect(() => {
    if (!w) return;
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => void api<PreviewRow[]>('/api/tuning/preview', { method: 'POST', json: w }).then(setPreview).catch(() => {}), 250);
  }, [w]);
  if (!w) return <div className="skeleton h-64" />;
  const dirty = JSON.stringify(w) !== JSON.stringify(saved);
  const save = async () => {
    const r = await api<ScoreWeights>('/api/tuning/weights', { method: 'PUT', json: w });
    setSaved(r);
    useStore.getState().pushToast({ kind: 'info', title: 'Score weights saved', body: 'The feed has been re-ranked.' });
  };
  return (
    <Section title="Impact score weights" description="Every story's 0–100 impact score is a weighted sum. Tune it and watch how the current feed would re-rank before you save." right={
      <span className="flex gap-1.5"><button className={btnCls} onClick={() => defaults && setW(defaults)}>Defaults</button><button className={primaryBtn} disabled={!dirty} onClick={save}>{dirty ? 'Save & re-rank' : 'Saved'}</button></span>
    }>
      <div className="grid gap-0 lg:grid-cols-[1fr_1fr]">
        <div className="divide-y divide-line">
          {WEIGHT_ROWS.map((r) => <Row key={r.k} label={r.label} hint={r.hint}><Slider label={r.label} value={w[r.k]} min={0} max={r.max} step={r.step ?? 1} onChange={(v) => setW({ ...w, [r.k]: v })} format={(v) => (r.step ? v.toFixed(1) : String(v))} /></Row>)}
        </div>
        <div className="border-l border-line p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Live re-rank preview</div>
          {preview.length ? (
            <ol className="space-y-1 text-[12px]">
              {preview.slice(0, 15).map((r) => {
                const d = r.rankBefore - r.rankAfter;
                return (
                  <li key={r.id} className="flex items-center gap-2">
                    <span className="num w-5 text-right text-faint">{r.rankAfter}</span>
                    <span className={`num w-8 text-[10px] ${d > 0 ? 'text-up' : d < 0 ? 'text-down' : 'text-faint'}`}>{d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : '·'}</span>
                    <span className="min-w-0 flex-1 truncate text-dim">{r.headline}</span>
                    <span className="num text-faint">{r.before}→<span className="text-text">{r.after}</span></span>
                  </li>
                );
              })}
            </ol>
          ) : <p className="text-xs text-faint">The preview fills once stories are in the feed.</p>}
        </div>
      </div>
    </Section>
  );
}

export function KeywordsSection() {
  const [builtin, setBuiltin] = useState<{ term: string; weight: number; pattern: string }[]>([]);
  const [entries, setEntries] = useState<KeywordEntry[]>([]);
  const [saved, setSaved] = useState('[]');
  const [draft, setDraft] = useState<KeywordEntry>({ term: '', weight: 15, tag: '' });
  useEffect(() => {
    void api<{ builtin: typeof builtin; keywords: KeywordEntry[] }>('/api/tuning').then((r) => { setBuiltin(r.builtin); setEntries(r.keywords); setSaved(JSON.stringify(r.keywords)); });
  }, []);
  const override = (term: string) => entries.find((e) => e.term.toLowerCase() === term.toLowerCase());
  const setOverride = (term: string, weight: number) => setEntries([...entries.filter((e) => e.term.toLowerCase() !== term.toLowerCase()), { term, weight }]);
  const custom = entries.filter((e) => !builtin.some((b) => b.term.toLowerCase() === e.term.toLowerCase()));
  const save = async () => {
    const r = await api<{ entries: KeywordEntry[] }>('/api/tuning/keywords', { method: 'PUT', json: { entries } });
    setEntries(r.entries);
    setSaved(JSON.stringify(r.entries));
    useStore.getState().pushToast({ kind: 'info', title: 'Keyword dictionary saved', body: 'Applies to new stories immediately.' });
  };
  return (
    <>
      <Section title="Your keywords & tags" description="Add terms that matter to you. Weight adds severity (0–40); a tag labels matching stories and can drive smart feeds (tag = …)." right={<button className={primaryBtn} disabled={JSON.stringify(entries) === saved} onClick={save}>Save dictionary</button>}>
        {custom.map((e) => (
          <Row key={e.term} label={e.term} hint={e.tag ? `tag: ${e.tag}` : 'no tag'}>
            <Slider label={`${e.term} weight`} value={e.weight} min={0} max={40} onChange={(v) => setEntries(entries.map((x) => (x === e ? { ...x, weight: v } : x)))} />
            <button className="text-[11px] text-faint hover:text-down" onClick={() => setEntries(entries.filter((x) => x !== e))}>Remove</button>
          </Row>
        ))}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <input className={`${inputCls} w-48`} placeholder="Term, e.g. yield curve control" value={draft.term} onChange={(e) => setDraft({ ...draft, term: e.target.value })} />
          <input className={`${inputCls} w-32`} placeholder="Tag (optional)" value={draft.tag ?? ''} onChange={(e) => setDraft({ ...draft, tag: e.target.value })} />
          <input type="number" min={0} max={40} className={`${inputCls} w-16`} value={draft.weight} onChange={(e) => setDraft({ ...draft, weight: Number(e.target.value) })} aria-label="Weight" />
          <button className={btnCls} disabled={!draft.term.trim()} onClick={() => { setEntries([...entries, { term: draft.term.trim(), weight: draft.weight, ...(draft.tag?.trim() ? { tag: draft.tag.trim() } : {}) }]); setDraft({ term: '', weight: 15, tag: '' }); }}>Add</button>
        </div>
      </Section>
      <Section title="Built-in severity keywords" description="Override any built-in weight; set it to 0 to switch a rule off.">
        {builtin.map((b) => {
          const o = override(b.term);
          return (
            <Row key={b.term} label={b.term} hint={<code className="text-[10px]">{b.pattern.slice(0, 80)}</code>}>
              <Slider label={`${b.term} weight`} value={o?.weight ?? b.weight} min={0} max={40} onChange={(v) => setOverride(b.term, v)} />
              {o ? <button className="text-[11px] text-faint hover:text-text" onClick={() => setEntries(entries.filter((e) => e !== o))}>↺</button> : null}
            </Row>
          );
        })}
      </Section>
    </>
  );
}

export function SourcesSection() {
  const [list, setList] = useState<SourceHealth[] | null>(null);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [check, setCheck] = useState<{ title: string; items: number; sample: string[] } | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow(5000);
  const load = () => void api<SourceHealth[]>('/api/sources').then(setList).catch(() => setList([]));
  useEffect(load, []);
  useEffect(() => {
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);
  const validate = async () => {
    setBusy(true);
    setCheck(null);
    try {
      const r = await api<{ title: string; items: number; sample: string[] }>('/api/sources/validate', { method: 'POST', json: { url } });
      setCheck(r);
      if (!name) setName(r.title);
    } catch (e) {
      useStore.getState().pushToast({ kind: 'error', title: 'Feed check failed', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    await api('/api/sources', { method: 'POST', json: { url, name } });
    setUrl(''); setName(''); setCheck(null); setAgree(false);
    load();
  };
  const patch = async (id: string, p: { credibility?: number; muted?: boolean }) => {
    await api(`/api/sources/${encodeURIComponent(id)}`, { method: 'PUT', json: p });
    load();
  };
  return (
    <>
      <Section title="Add an RSS / Atom feed" description="Feeds are fetched by the server (never by your browser), validated first, and polled politely. PULSE stores only headlines and short summaries and always links to the original.">
        <div className="space-y-2 px-4 py-3">
          <div className="flex flex-wrap gap-2">
            <input className={`${inputCls} min-w-[260px] flex-1`} placeholder="https://example.com/feed.xml" value={url} onChange={(e) => { setUrl(e.target.value); setCheck(null); }} />
            <button className={btnCls} disabled={!url || busy} onClick={validate}>{busy ? 'Checking…' : 'Validate'}</button>
          </div>
          {check ? (
            <div className="rounded-lg border border-up/30 bg-up/5 p-2 text-[12px]">
              <div className="text-text">✓ {check.title} · {check.items} items</div>
              <ul className="mt-1 list-disc pl-4 text-faint">{check.sample.map((x) => <li key={x}>{x}</li>)}</ul>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input className={`${inputCls} w-56`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" />
                <label className="flex items-center gap-1.5 text-[11px] text-dim"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />I&apos;m allowed to use this feed under its terms</label>
                <button className={primaryBtn} disabled={!agree} onClick={add}>Add source</button>
              </div>
            </div>
          ) : null}
        </div>
      </Section>
      <Section title="Sources" description="Credibility feeds the impact score. Muted sources are not polled and never reach the feed.">
        {list === null ? <div className="p-4"><div className="skeleton h-20" /></div> : list.map((s) => (
          <Row key={s.url ?? s.id} label={s.name} hint={<span className="flex flex-wrap gap-x-3"><span className={s.muted ? 'text-faint' : s.ok ? 'text-up' : s.lastError ? 'text-down' : 'text-faint'}>● {s.muted ? 'muted' : s.ok ? 'healthy' : s.lastError ? s.lastError : 'waiting'}</span>{s.latencyMs !== null ? <span className="num">{s.latencyMs}ms</span> : null}<span className="num">{s.itemsPerHour}/h</span>{s.lastOk ? <span className="num">ok {timeAgo(s.lastOk, now)} ago</span> : null}{s.custom ? <span>custom</span> : null}</span>}>
            <Slider label={`${s.name} credibility`} value={Math.round(s.credibility * 100)} min={0} max={100} step={5} onChange={(v) => void patch(s.id, { credibility: v / 100 })} format={(v) => `${v}%`} />
            <Switch label={`Mute ${s.name}`} on={!s.muted} onChange={(on) => void patch(s.id, { muted: !on })} />
            {s.custom ? <button className="text-[11px] text-faint hover:text-down" onClick={() => void api(`/api/sources/${encodeURIComponent(s.id)}`, { method: 'DELETE' }).then(load)}>Remove</button> : null}
          </Row>
        ))}
      </Section>
    </>
  );
}
