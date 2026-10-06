'use client';
import { useEffect, useMemo, useState } from 'react';
import type { SmartFeed } from '@shared/v2';
import { FIELDS, parseRule, serialize, evaluate, RuleError, type Node, type Field, type Op } from '@shared/rules';
import { useDocs, useV2 } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { Overlay } from '../Overlay';
import { Icon } from '../ui';

type Row = { not: boolean; field: Field; op: Op | 'in'; value: string };
type Group = { join: 'AND' | 'OR'; rows: Row[] };

/** Visual model: OR of groups, each group an AND of rows (each row optionally negated). */
function toGroups(n: Node): Group[] | null {
  const rowOf = (x: Node, not = false): Row | null => {
    if (x.type === 'not') return rowOf(x.item, !not);
    if (x.type === 'cmp') return { not, field: x.field, op: x.op, value: String(x.value) };
    if (x.type === 'in') return { not, field: x.field, op: 'in', value: x.values.join(', ') };
    return null;
  };
  const groupOf = (x: Node): Group | null => {
    const items = x.type === 'and' ? x.items : [x];
    const rows = items.map((i) => rowOf(i));
    return rows.every(Boolean) ? { join: 'AND', rows: rows as Row[] } : null;
  };
  const gs = (n.type === 'or' ? n.items : [n]).map(groupOf);
  return gs.every(Boolean) ? (gs as Group[]) : null;
}

function toNode(groups: Group[]): Node {
  const row = (r: Row): Node => {
    const kind = FIELDS.find((f) => f.id === r.field)?.kind;
    const val = kind === 'number' ? Number(r.value) : kind === 'bool' ? r.value === 'true' : r.value;
    const base: Node = r.op === 'in' ? { type: 'in', field: r.field, values: r.value.split(',').map((v) => v.trim()).filter(Boolean) } : { type: 'cmp', field: r.field, op: r.op, value: val };
    return r.not ? { type: 'not', item: base } : base;
  };
  const gnodes = groups.filter((g) => g.rows.length).map((g) => (g.rows.length === 1 ? row(g.rows[0]) : { type: 'and', items: g.rows.map(row) } as Node));
  return gnodes.length === 1 ? gnodes[0] : { type: 'or', items: gnodes };
}

const sel = 'rounded-md border border-line bg-bg-2 px-1.5 py-0.5 text-[11px] text-text';
const ICONS = ['', '⚡', '🏦', '🪙', '💱', '📈', '🛢️', '🇯🇵', '🇪🇺', '🔥'];

export function FeedBuilder() {
  const id = useV2((s) => s.feedBuilder);
  const feeds = useDocs<SmartFeed>('smart_feeds');
  const clusters = useStore((s) => s.clusters);
  const existing = feeds.find((f) => f.id === id);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#8b8bff');
  const [icon, setIcon] = useState('');
  const [alert, setAlert] = useState(false);
  const [text, setText] = useState('');
  const [groups, setGroups] = useState<Group[]>([{ join: 'AND', rows: [{ not: false, field: 'asset_class', op: '=', value: 'FX' }] }]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    const q = existing?.query ?? 'asset_class = FX AND impact > 50';
    setName(existing?.name ?? 'My feed'); setColor(existing?.color ?? '#8b8bff'); setIcon(existing?.icon ?? ''); setAlert(!!existing?.alert); setText(q);
    try { const g = toGroups(parseRule(q)); if (g) setGroups(g); } catch { /* text mode */ }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const syncFromGroups = (g: Group[]) => { setGroups(g); try { setText(serialize(toNode(g))); setErr(null); } catch { /* incomplete */ } };
  const syncFromText = (t: string) => {
    setText(t);
    try { const n = parseRule(t); setErr(null); const g = toGroups(n); if (g) setGroups(g); } catch (e) { setErr(e instanceof RuleError ? `${e.message} (at ${e.pos})` : 'invalid'); }
  };
  const matchCount = useMemo(() => { try { const n = parseRule(text); return clusters.filter((c) => evaluate(n, c, { watch: !!c.watchHit })).length; } catch { return null; } }, [text, clusters]);
  if (!id) return null;
  const close = () => useV2.getState().set({ feedBuilder: null });
  const save = async () => {
    try { parseRule(text); } catch { return; }
    await useV2.getState().putDoc('smart_feeds', { ...(existing ?? { order: feeds.length, createdAt: Date.now() }), id: existing?.id, name: name || 'Feed', color, icon, query: text, alert });
    close();
  };
  return (
    <Overlay open onClose={close} label="Smart feed builder" width="max-w-2xl">
      <div className="glass max-h-[85vh] overflow-y-auto rounded-2xl bg-panel-solid/95 p-5">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-text">{existing ? 'Edit smart feed' : 'New smart feed'}</h2><button onClick={close} aria-label="Close"><Icon name="x" /></button></div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input className={`${sel} w-48 text-xs`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-6 w-8 rounded border border-line bg-transparent" aria-label="Colour" />
          <select className={sel} value={icon} onChange={(e) => setIcon(e.target.value)} aria-label="Icon">{ICONS.map((i) => <option key={i} value={i}>{i || 'no icon'}</option>)}</select>
          <label className="flex items-center gap-1 text-[11px] text-dim"><input type="checkbox" checked={alert} onChange={(e) => setAlert(e.target.checked)} />alert on new matches</label>
        </div>
        <div className="space-y-2">
          {groups.map((g, gi) => (
            <div key={gi}>
              {gi > 0 ? <div className="my-1 text-center text-[10px] font-semibold text-accent">OR</div> : null}
              <div className="space-y-1 rounded-xl border border-line p-2">
                {g.rows.map((r, ri) => {
                  const f = FIELDS.find((x) => x.id === r.field)!;
                  const upd = (p: Partial<Row>) => syncFromGroups(groups.map((gg, i) => (i !== gi ? gg : { ...gg, rows: gg.rows.map((rr, j) => (j === ri ? { ...rr, ...p } : rr)) })));
                  return (
                    <div key={ri} className="flex flex-wrap items-center gap-1.5">
                      <span className="w-8 text-[10px] text-faint">{ri ? 'AND' : 'WHERE'}</span>
                      <button onClick={() => upd({ not: !r.not })} className={`rounded px-1 text-[10px] ${r.not ? 'bg-down/20 text-down' : 'text-faint'}`}>NOT</button>
                      <select className={sel} value={r.field} onChange={(e) => upd({ field: e.target.value as Field, value: '' })}>{FIELDS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
                      <select className={sel} value={r.op} onChange={(e) => upd({ op: e.target.value as Op | 'in' })}>{(f.kind === 'number' ? ['>', '>=', '<', '<=', '='] : f.kind === 'bool' ? ['='] : f.kind === 'text' ? ['=', '~', '!=', 'in'] : ['=', '!=', 'in']).map((o) => <option key={o} value={o}>{o === '~' ? 'contains' : o}</option>)}</select>
                      {f.kind === 'bool' ? <select className={sel} value={r.value || 'true'} onChange={(e) => upd({ value: e.target.value })}><option value="true">yes</option><option value="false">no</option></select>
                        : f.options && r.op !== 'in' ? <select className={sel} value={r.value} onChange={(e) => upd({ value: e.target.value })}><option value="">…</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                          : <input className={`${sel} w-40`} value={r.value} placeholder={r.op === 'in' ? 'JPY, CHF' : ''} onChange={(e) => upd({ value: e.target.value })} />}
                      <button onClick={() => syncFromGroups(groups.map((gg, i) => (i !== gi ? gg : { ...gg, rows: gg.rows.filter((_, j) => j !== ri) })).filter((gg) => gg.rows.length))} className="text-faint hover:text-down">×</button>
                    </div>
                  );
                })}
                <button onClick={() => syncFromGroups(groups.map((gg, i) => (i !== gi ? gg : { ...gg, rows: [...gg.rows, { not: false, field: 'impact', op: '>', value: '60' }] })))} className="text-[11px] text-faint hover:text-text">+ condition</button>
              </div>
            </div>
          ))}
          <button onClick={() => syncFromGroups([...groups, { join: 'AND', rows: [{ not: false, field: 'tag', op: '=', value: '' }] }])} className="text-[11px] text-accent">+ OR group</button>
        </div>
        <div className="mt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Query (editable)</div>
          <textarea value={text} onChange={(e) => syncFromText(e.target.value)} rows={2} className={`w-full rounded-lg border bg-bg-2 p-2 font-mono text-xs text-text ${err ? 'border-down/60' : 'border-line'}`} />
          <div className="mt-1 flex justify-between text-[11px]"><span className={err ? 'text-down' : 'text-faint'}>{err ?? 'e.g. (asset_class = FX AND currency IN [JPY, CHF]) OR (tag = "Central Banks" AND impact > 60) NOT source = X'}</span>{matchCount !== null ? <span className="text-dim">{matchCount} matches in the current feed</span> : null}</div>
        </div>
        <div className="mt-4 flex justify-between">
          {existing ? <button onClick={() => { void useV2.getState().delDoc('smart_feeds', existing.id); close(); }} className="text-xs text-down">Delete feed</button> : <span />}
          <span className="flex gap-2"><button onClick={close} className="rounded-lg border border-line px-3 py-1 text-xs text-dim">Cancel</button><button disabled={!!err} onClick={() => void save()} className="rounded-lg border border-accent/50 bg-accent/15 px-3 py-1 text-xs text-text disabled:opacity-40">Save feed</button></span>
        </div>
      </div>
    </Overlay>
  );
}
