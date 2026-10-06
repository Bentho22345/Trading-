'use client';
import { useRef, useState } from 'react';
import type { Level, Position } from '@shared/v2';
import { useDocs, useV2, api } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { Row, Section, Switch, btnCls, download, inputCls, primaryBtn } from './controls';

export function PortfolioSection() {
  const positions = useDocs<Position>('positions');
  const symbols = useStore((s) => s.symbols);
  const fileRef = useRef<HTMLInputElement>(null);
  const [p, setP] = useState({ symbol: '', qty: '', avgPrice: '' });
  const toast = useStore.getState().pushToast;
  const upload = async (f: File, replace: boolean) => {
    try {
      const r = await fetch(`/api/positions/import${replace ? '?replace=1' : ''}`, { method: 'POST', body: await f.text() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      toast({ kind: 'info', title: `Imported ${j.imported} positions`, body: j.unpriced.length ? `No live price for: ${j.unpriced.join(', ')}` : undefined });
    } catch (e) { toast({ kind: 'error', title: 'CSV import failed', body: (e as Error).message }); }
  };
  return (
    <>
      <Section title="Import positions" description="Positions stay on your PULSE server. Brokers are connected read-only — PULSE never places orders.">
        <Row label="CSV upload" hint="Columns: symbol, qty, avg_price (optional: sector). Negative qty = short.">
          <button className={btnCls} onClick={() => download('positions-template.csv', 'symbol,qty,avg_price,sector\nNVDA,50,120.5,Semiconductors\nEURUSD,100000,1.152,\nBTC,0.5,98000,\n', 'text/csv')}>Template</button>
          <button className={primaryBtn} onClick={() => fileRef.current?.click()}>Upload CSV</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0], confirm('Replace existing positions? (Cancel = add to them)'))} />
        </Row>
        <Row label="Alpaca (read-only)" hint="Uses ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY from the server (.env). Paper by default; ALPACA_LIVE=1 for live.">
          <button className={btnCls} onClick={() => void api<{ imported: number; account: string }>('/api/positions/broker/alpaca', { method: 'POST' }).then((r) => toast({ kind: 'info', title: `Imported ${r.imported} positions from Alpaca (${r.account})` })).catch((e) => toast({ kind: 'error', title: 'Alpaca', body: (e as Error).message }))}>Sync positions</button>
        </Row>
        <Row label="Google Sheets" hint="Connect a published CSV in Integrations → Google Sheets, then import from there."><button className={btnCls} onClick={() => useV2.getState().set({ settingsCenter: 'integrations' })}>Open integrations</button></Row>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <input className={`${inputCls} w-28`} placeholder="Symbol" value={p.symbol} onChange={(e) => setP({ ...p, symbol: e.target.value.toUpperCase() })} list="pos-syms" />
          <datalist id="pos-syms">{Object.keys(symbols).map((s) => <option key={s} value={s} />)}</datalist>
          <input className={`${inputCls} w-24`} placeholder="Qty" value={p.qty} onChange={(e) => setP({ ...p, qty: e.target.value })} />
          <input className={`${inputCls} w-28`} placeholder="Avg price" value={p.avgPrice} onChange={(e) => setP({ ...p, avgPrice: e.target.value })} />
          <button className={btnCls} disabled={!p.symbol || !Number(p.qty)} onClick={() => { void useV2.getState().putDoc('positions', { symbol: p.symbol, qty: Number(p.qty), avgPrice: Number(p.avgPrice) || 0, source: 'manual' }); setP({ symbol: '', qty: '', avgPrice: '' }); }}>Add manually</button>
        </div>
      </Section>
      <Section title={`Positions (${positions.length})`}>
        {positions.map((x) => (
          <Row key={x.id} label={`${x.symbol} · ${x.qty}`} hint={`avg ${x.avgPrice || '—'} · ${x.source}${symbols[x.symbol] ? '' : ' · no live price'}`}>
            <button className="text-[11px] text-faint hover:text-down" onClick={() => void useV2.getState().delDoc('positions', x.id)}>Remove</button>
          </Row>
        ))}
        {!positions.length ? <p className="px-4 py-3 text-xs text-faint">No positions yet.</p> : null}
      </Section>
    </>
  );
}

export function LevelsSection() {
  const levels = useDocs<Level>('levels');
  const [l, setL] = useState({ symbol: 'EURUSD', price: '', label: '' });
  return (
    <Section title="Levels" description="Your levels appear on charts, in the Morning Brief's key-levels section, and (with alert on) fire a price-cross alert.">
      {levels.map((x) => (
        <Row key={x.id} label={`${x.symbol} ${x.price}`} hint={x.label}>
          <span className="text-[11px] text-faint">alert</span><Switch label="Alert" on={x.alert} onChange={(v) => void useV2.getState().putDoc('levels', { ...x, alert: v })} />
          <button className="text-[11px] text-faint hover:text-down" onClick={() => void useV2.getState().delDoc('levels', x.id)}>Remove</button>
        </Row>
      ))}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <input className={`${inputCls} w-24`} value={l.symbol} onChange={(e) => setL({ ...l, symbol: e.target.value.toUpperCase() })} />
        <input className={`${inputCls} w-28`} placeholder="Price" value={l.price} onChange={(e) => setL({ ...l, price: e.target.value })} />
        <input className={`${inputCls} w-40`} placeholder="Label" value={l.label} onChange={(e) => setL({ ...l, label: e.target.value })} />
        <button className={btnCls} disabled={!Number(l.price)} onClick={() => { void useV2.getState().putDoc('levels', { symbol: l.symbol, price: Number(l.price), label: l.label || 'Level', alert: true, createdAt: Date.now() }); setL({ ...l, price: '', label: '' }); }}>Add level</button>
      </div>
    </Section>
  );
}
