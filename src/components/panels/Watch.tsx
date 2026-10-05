'use client';
import { memo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { AlertRule, WatchKind } from '@shared/types';
import { useStore } from '@/lib/store';
import { useFlash, useQuote, useNow } from '@/lib/hooks';
import { fmtPct, fmtPrice, pairLabel, timeAgo } from '@/lib/format';
import { useSettings } from '@/lib/settings';
import { Panel, Icon, Chip, EmptyState } from '../ui';
import { MagneticButton } from '../Magnetic';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json' } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

const WatchPrice = memo(function WatchPrice({ symbol }: { symbol: string }) {
  const q = useQuote(symbol);
  const meta = useStore((s) => s.symbols[symbol]);
  const ref = useFlash<HTMLSpanElement>(q?.price);
  if (!q || !meta) return null;
  return (
    <span ref={ref} className="num ml-auto flex items-center gap-2 rounded px-1 text-[11px]">
      <span className="text-text">{fmtPrice(q.price, meta.decimals)}</span>
      <span className={q.changePct >= 0 ? 'text-up' : 'text-down'}>{fmtPct(q.changePct)}</span>
    </span>
  );
});

function guessKind(v: string, symbols: Record<string, { assetClass: string }>): WatchKind {
  const u = v.toUpperCase().replace(/[^A-Z]/g, '');
  const m = symbols[u];
  if (m) return m.assetClass === 'fx' ? 'pair' : m.assetClass === 'crypto' ? 'coin' : 'ticker';
  return 'keyword';
}

export function WatchlistPanel() {
  const list = useStore((s) => s.watchlist);
  const symbols = useStore((s) => s.symbols);
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    const v = value.trim();
    if (!v) return;
    setErr(null);
    try {
      const kind = guessKind(v, symbols);
      const w = await api<typeof list>('/api/watchlist', { method: 'POST', body: JSON.stringify({ kind, value: v }) });
      useStore.getState().set({ watchlist: w });
      setValue('');
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async (id: string) => {
    const w = await api<typeof list>(`/api/watchlist/${id}`, { method: 'DELETE' }).catch(() => null);
    if (w) useStore.getState().set({ watchlist: w });
  };

  return (
    <Panel title="Watchlist" accent="var(--warn)" right={<span className="text-[10px] text-faint">boosts impact · highlights feed</span>}>
      <form onSubmit={(e) => { e.preventDefault(); void add(); }} className="mb-2 flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="AAPL, EURUSD, BTC or a keyword…"
          list="pulse-symbols"
          className="min-w-0 flex-1 rounded-lg border border-line bg-bg-2/60 px-2 py-1 text-xs text-text placeholder:text-faint focus:border-accent/50 focus:outline-none"
          aria-label="Add to watchlist"
        />
        <datalist id="pulse-symbols">{Object.keys(symbols).map((s) => <option key={s} value={s} />)}</datalist>
        <MagneticButton type="submit" aria-label="Add"><Icon name="plus" size={12} />Add</MagneticButton>
      </form>
      {err ? <div className="mb-1 text-[11px] text-down">{err}</div> : null}
      {!list.length ? (
        <EmptyState title="Watchlist is empty" body="Add tickers, FX pairs, coins or keywords." />
      ) : (
        <ul className="space-y-0.5">
          <AnimatePresence initial={false}>
            {list.map((w) => (
              <motion.li key={w.id} layout initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 6 }} className="group flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-panel-hover">
                <Chip>{w.kind}</Chip>
                {w.kind === 'keyword' ? (
                  <button onClick={() => useStore.getState().set({ search: w.value, filter: 'all' })} className="text-xs text-text hover:underline">“{w.value}”</button>
                ) : (
                  <button onClick={() => useStore.getState().set({ drawerSymbol: w.value })} className="text-xs font-semibold text-text hover:underline">{pairLabel(w.value, symbols[w.value]?.assetClass)}</button>
                )}
                {w.kind !== 'keyword' ? <WatchPrice symbol={w.value} /> : <span className="ml-auto" />}
                <button onClick={() => remove(w.id)} className="text-faint opacity-0 hover:text-down group-hover:opacity-100 focus:opacity-100" aria-label={`Remove ${w.value}`}><Icon name="trash" size={12} /></button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Panel>
  );
}

function describe(r: AlertRule) {
  if (r.kind === 'price_cross') return `${r.symbol} ${r.direction === 'cross' ? 'crosses' : `crosses ${r.direction}`} ${r.level}`;
  if (r.kind === 'pct_move') return `${r.symbol} moves ${r.pct}% in ${r.windowMin! >= 60 ? `${r.windowMin! / 60}h` : `${r.windowMin}m`}`;
  return `Headline contains “${r.keyword}”`;
}

export function AlertsPanel() {
  const rules = useStore((s) => s.alerts);
  const events = useStore((s) => s.alertEvents);
  const notifications = useSettings((s) => s.notifications);
  const now = useNow(5000);
  const [kind, setKind] = useState<AlertRule['kind']>('price_cross');
  const [symbol, setSymbol] = useState('EURUSD');
  const [level, setLevel] = useState('');
  const [direction, setDirection] = useState<'above' | 'below' | 'cross'>('cross');
  const [pct, setPct] = useState('3');
  const [windowMin, setWindowMin] = useState('60');
  const [keyword, setKeyword] = useState('');
  const [once, setOnce] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    setErr(null);
    try {
      const body = kind === 'keyword' ? { kind, keyword, once } : kind === 'pct_move' ? { kind, symbol, pct: +pct, windowMin: +windowMin, once } : { kind, symbol, level: +level, direction, once };
      await api('/api/alerts', { method: 'POST', body: JSON.stringify(body) });
      setLevel('');
      setKeyword('');
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const toggle = (r: AlertRule) => api('/api/alerts', { method: 'POST', body: JSON.stringify({ ...r, enabled: !r.enabled }) }).catch(() => {});
  const remove = (id: string) => api(`/api/alerts/${id}`, { method: 'DELETE' }).catch(() => {});

  const enableNotifications = async () => {
    if (typeof Notification === 'undefined') return useStore.getState().pushToast({ kind: 'error', title: 'Browser notifications are not supported here' });
    const p = await Notification.requestPermission();
    useSettings.getState().set({ notifications: p === 'granted' });
    useStore.getState().pushToast({ kind: 'info', title: p === 'granted' ? 'Browser notifications enabled' : 'Notifications permission was not granted' });
  };

  const input = 'rounded-md border border-line bg-bg-2/60 px-2 py-1 text-xs text-text placeholder:text-faint focus:border-accent/50 focus:outline-none';
  const q = useStore((s) => s.quotes[symbol]);

  return (
    <Panel title="Alerts" accent="var(--down)" right={
      notifications ? <Chip className="border-up/40 text-up">notifications on</Chip> : <button onClick={enableNotifications} className="flex items-center gap-1 text-[10px] text-dim hover:text-text"><Icon name="bell" size={11} />Enable notifications</button>
    }>
      <form onSubmit={(e) => { e.preventDefault(); void create(); }} className="space-y-1.5">
        <select value={kind} onChange={(e) => setKind(e.target.value as AlertRule['kind'])} className={`${input} w-full`} aria-label="Alert type">
          <option value="price_cross">Price crosses level</option>
          <option value="pct_move">% move within window</option>
          <option value="keyword">Headline contains keyword</option>
        </select>
        {kind === 'keyword' ? (
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="e.g. SNB, halt, ETF" className={`${input} w-full`} aria-label="Keyword" />
        ) : (
          <div className="flex gap-1.5">
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} list="pulse-symbols" className={`${input} w-24`} aria-label="Symbol" />
            {kind === 'price_cross' ? (
              <>
                <select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)} className={input} aria-label="Direction">
                  <option value="cross">crosses</option>
                  <option value="above">above</option>
                  <option value="below">below</option>
                </select>
                <input value={level} onChange={(e) => setLevel(e.target.value)} placeholder={q ? String(q.price) : 'level'} inputMode="decimal" className={`${input} min-w-0 flex-1`} aria-label="Level" />
              </>
            ) : (
              <>
                <input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal" className={`${input} w-14`} aria-label="Percent" />
                <span className="self-center text-[11px] text-faint">% in</span>
                <select value={windowMin} onChange={(e) => setWindowMin(e.target.value)} className={`${input} min-w-0 flex-1`} aria-label="Window">
                  <option value="5">5m</option><option value="15">15m</option><option value="60">1h</option><option value="240">4h</option><option value="1440">24h</option>
                </select>
              </>
            )}
          </div>
        )}
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-[11px] text-dim"><input type="checkbox" checked={once} onChange={(e) => setOnce(e.target.checked)} className="accent-[var(--accent)]" />Fire once</label>
          <MagneticButton type="submit"><Icon name="bell" size={12} />Create alert</MagneticButton>
        </div>
        {err ? <div className="text-[11px] text-down">{err}</div> : null}
      </form>

      <ul className="mt-2 space-y-0.5 border-t border-line pt-2">
        {rules.length ? rules.map((r) => (
          <li key={r.id} className="group flex items-center gap-2 text-[11px]">
            <button onClick={() => toggle(r)} role="switch" aria-checked={r.enabled} className={`relative h-3 w-5 shrink-0 rounded-full ${r.enabled ? 'bg-up/70' : 'bg-line-strong'}`} aria-label={r.enabled ? 'Disable alert' : 'Enable alert'}>
              <span className={`absolute top-0.5 h-2 w-2 rounded-full bg-white transition-transform ${r.enabled ? 'translate-x-2.5' : 'translate-x-0.5'}`} />
            </button>
            <span className={`flex-1 truncate ${r.enabled ? 'text-text' : 'text-faint line-through'}`}>{describe(r)}</span>
            {r.lastFiredAt ? <span className="num text-[10px] text-faint">fired {timeAgo(r.lastFiredAt, now)}</span> : null}
            <button onClick={() => remove(r.id)} className="text-faint opacity-0 hover:text-down group-hover:opacity-100 focus:opacity-100" aria-label="Delete alert"><Icon name="trash" size={12} /></button>
          </li>
        )) : <li className="text-[11px] text-faint">No alerts yet.</li>}
      </ul>
      {events.length ? (
        <div className="mt-2 border-t border-line pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-faint">Recently fired</div>
          <ul className="max-h-28 space-y-0.5 overflow-y-auto">
            {events.slice(0, 8).map((e) => (
              <li key={e.id} className="flex gap-2 text-[11px]"><span className="num w-7 shrink-0 text-faint">{timeAgo(e.ts, now)}</span><span className="truncate text-dim">{e.message}</span></li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}
