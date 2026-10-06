'use client';
import { useEffect, useRef, useState } from 'react';
import type { AlertRule, NewsCluster, Quote } from '@shared/types';
import { api } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { replayGate } from '@/lib/socket';
import { useCalm } from '@/lib/hooks';
import { Overlay } from '../Overlay';
import { Icon } from '../ui';

interface Chunk { from: number; to: number; ticks: [number, string, number][]; clusters: NewsCluster[]; alerts: { id: string; ruleId: string; message: string; ts: number }[]; refs: Record<string, number> }
const SPEEDS = [1, 5, 10, 30, 60];
const CHUNK = 2 * 3600_000;

/** Would this rule have fired between two prices? (client-side mirror of the server's price rules) */
function fired(r: AlertRule, prev: number | undefined, price: number, at: (ms: number) => number | undefined, t: number): string | null {
  if (!r.enabled || prev === undefined) return null;
  if (r.kind === 'price_cross' && r.level) {
    const up = prev < r.level && price >= r.level, down = prev > r.level && price <= r.level;
    if ((r.direction === 'above' && up) || (r.direction === 'below' && down) || (r.direction === 'cross' && (up || down))) return `${r.symbol} crossed ${r.level}`;
  }
  if (r.kind === 'pct_move' && r.pct && r.windowMin) {
    const then = at(t - r.windowMin * 60_000);
    if (then) {
      const pct = ((price - then) / then) * 100;
      if (Math.abs(pct) >= r.pct && (r.moveDir === 'up' ? pct > 0 : r.moveDir === 'down' ? pct < 0 : true)) return `${r.symbol} ${pct.toFixed(2)}% in ${r.windowMin}m`;
    }
  }
  return null;
}

export function Replay() {
  const [picker, setPicker] = useState(false);
  const [days, setDays] = useState<{ date: string; first: number; last: number; symbols: number }[] | null>(null);
  const [start, setStart] = useState<number | null>(null);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [vt, setVt] = useState(0);
  const [speed, setSpeed] = useState(10);
  const [playing, setPlaying] = useState(false);
  const calm = useCalm();
  const st = useRef<{ chunks: Map<number, Chunk>; idx: number; cIdx: number; aIdx: number; saved: { quotes: Record<string, Quote>; clusters: NewsCluster[] } | null; last: Record<string, number>; series: Record<string, [number, number][]>; firedKeys: Set<string>; vel: number }>({ chunks: new Map(), idx: 0, cIdx: 0, aIdx: 0, saved: null, last: {}, series: {}, firedKeys: new Set(), vel: 0 });

  useEffect(() => {
    const h = () => { setPicker(true); void api<{ days: typeof days }>('/api/replay/days').then((r) => setDays(r.days)); };
    window.addEventListener('pulse:replay', h);
    return () => window.removeEventListener('pulse:replay', h);
  }, []);

  const chunkFor = async (t: number) => {
    const key = Math.floor(t / CHUNK) * CHUNK;
    const s = st.current;
    if (!s.chunks.has(key)) s.chunks.set(key, await api<Chunk>(`/api/replay/data?from=${key}&to=${key + CHUNK}`));
    if (!s.chunks.has(key + CHUNK) && range && key + CHUNK < range.to) void api<Chunk>(`/api/replay/data?from=${key + CHUNK}&to=${key + 2 * CHUNK}`).then((c) => s.chunks.set(key + CHUNK, c)).catch(() => {});
    return s.chunks.get(key)!;
  };

  const begin = async (from: number, to: number) => {
    const s = st.current;
    const store = useStore.getState();
    s.saved = { quotes: store.quotes, clusters: store.clusters };
    s.chunks.clear(); s.last = {}; s.series = {}; s.firedKeys.clear();
    replayGate.active = true;
    const c = await chunkFor(from);
    store.set({ clusters: s.saved.clusters.filter((x) => x.receivedAt < from), quotes: Object.fromEntries(Object.entries(s.saved.quotes).map(([k, q]) => [k, { ...q, price: c.refs[k] ?? q.price, ref: c.refs[k] ?? q.ref, change: 0, changePct: 0 }])) });
    setRange({ from, to });
    setVt(from);
    setPicker(false);
    setPlaying(true);
    document.documentElement.classList.add('replaying');
  };

  const exit = () => {
    const s = st.current;
    replayGate.active = false;
    if (s.saved) useStore.getState().set({ quotes: s.saved.quotes, clusters: s.saved.clusters });
    s.saved = null;
    setRange(null);
    setPlaying(false);
    document.documentElement.classList.remove('replaying');
    useStore.getState().pushToast({ kind: 'info', title: 'Back to live' });
  };

  // engine: advance the virtual clock and apply everything up to it
  useEffect(() => {
    if (!range) return;
    let raf = 0, lastT = performance.now();
    const loop = async (now: number) => {
      const dt = Math.min(100, now - lastT);
      lastT = now;
      const s = st.current;
      setVt((prev) => {
        let next = prev;
        if (playing) next = prev + dt * speed;
        else if (Math.abs(s.vel) > 1) { next = prev + s.vel * dt; s.vel *= 0.92; } // scrubber momentum
        return Math.max(range.from, Math.min(range.to, next));
      });
      raf = requestAnimationFrame((t) => void loop(t));
    };
    raf = requestAnimationFrame((t) => void loop(t));
    return () => cancelAnimationFrame(raf);
  }, [range, playing, speed]);

  useEffect(() => {
    if (!range) return;
    let cancelled = false;
    void (async () => {
      const c = await chunkFor(vt);
      if (cancelled) return;
      const s = st.current;
      const store = useStore.getState();
      const quotes: Record<string, Quote> = { ...store.quotes };
      const rules = store.alerts;
      const at = (sym: string) => (ms: number) => { const arr = s.series[sym]; if (!arr) return undefined; for (let i = arr.length - 1; i >= 0; i--) if (arr[i][0] <= ms) return arr[i][1]; return undefined; };
      let changed = false;
      for (const [t, sym, price] of c.ticks) {
        if (t > vt || t <= (s.last[`t:${sym}`] ?? 0)) continue;
        const q = quotes[sym];
        const ref = c.refs[sym] ?? q?.ref ?? price;
        const prev = s.last[sym];
        quotes[sym] = { ...(q ?? { symbol: sym, source: 'Replay', receivedAt: t, delayedMin: 0 }), symbol: sym, price, ref, change: price - ref, changePct: ref ? ((price - ref) / ref) * 100 : 0, ts: t, receivedAt: t, source: `${q?.source ?? 'Archive'} · replay` } as Quote;
        s.last[sym] = price;
        s.last[`t:${sym}`] = t;
        (s.series[sym] ??= []).push([t, price]);
        changed = true;
        for (const r of rules.filter((x) => x.symbol === sym)) {
          const msg = fired(r, prev, price, at(sym), t);
          const key = `${r.id}:${Math.floor(t / 60_000)}`;
          if (msg && !s.firedKeys.has(key)) { s.firedKeys.add(key); store.pushToast({ kind: 'alert', title: 'REPLAY · alert would have fired', body: `${new Date(t).toLocaleTimeString([], { hour12: false })} — ${msg}` }); }
        }
      }
      if (changed) store.set({ quotes });
      const newC = c.clusters.filter((x) => x.receivedAt <= vt && !store.clusters.some((y) => y.id === x.id));
      for (const x of newC) {
        store.upsertCluster(x, x.breaking);
        for (const r of rules.filter((y) => y.kind === 'keyword' && y.keyword && y.enabled)) if (x.headline.toLowerCase().includes(r.keyword!.toLowerCase()) && !s.firedKeys.has(`${r.id}:${x.id}`)) { s.firedKeys.add(`${r.id}:${x.id}`); store.pushToast({ kind: 'alert', title: 'REPLAY · keyword alert', body: x.headline }); }
      }
      for (const a of c.alerts.filter((x) => x.ts <= vt && !s.firedKeys.has(`arch:${x.id}`))) { s.firedKeys.add(`arch:${a.id}`); store.pushToast({ kind: 'alert', title: 'REPLAY · alert (archived)', body: a.message }); }
      if (vt >= range.to) setPlaying(false);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [Math.floor(vt / 1000), range]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrub = (v: number) => {
    const s = st.current;
    if (v < vt) { // going back: reset state to the chunk start for correctness
      s.last = {}; s.series = {};
      if (s.saved) useStore.getState().set({ clusters: s.saved.clusters.filter((x) => x.receivedAt < v) });
    }
    s.vel = ((v - vt) / 16) * 0.5;
    setVt(v);
  };

  return (
    <>
      {picker ? (
        <Overlay open onClose={() => setPicker(false)} label="Market replay" width="max-w-lg">
          <div className="glass rounded-2xl bg-panel-solid/95 p-5">
            <h2 className="text-sm font-semibold text-text">Market replay</h2>
            <p className="mt-1 text-xs text-faint">Replay a stored day — ticker, feed, banners and alerts behave as if live. Test whether your alert rules would have fired.</p>
            {days === null ? <div className="skeleton mt-3 h-24" /> : !days.length ? <p className="mt-4 text-xs text-dim">No archived ticks yet. PULSE records ticks while it runs; come back after a session.</p> : (
              <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto">
                {days.map((d) => (
                  <li key={d.date} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-xs">
                    <span className="text-text">{d.date}<span className="ml-2 text-faint">{d.symbols} symbols · {new Date(d.first).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–{new Date(d.last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></span>
                    <span className="flex items-center gap-1">
                      <input type="time" className="rounded border border-line bg-bg-2 px-1 text-[11px] text-text" onChange={(e) => { const [h, m] = e.target.value.split(':').map(Number); const b = new Date(d.first); b.setHours(h, m, 0, 0); setStart(b.getTime()); }} aria-label="Start time" />
                      <button onClick={() => void begin(Math.max(d.first, start ?? d.first), d.last)} className="rounded-md border border-accent/50 bg-accent/15 px-2 py-0.5 text-text">Replay</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Overlay>
      ) : null}
      {range ? (
        <>
          {!calm ? <div className="film-grain pointer-events-none fixed inset-0 z-[55]" aria-hidden /> : null}
          <div className="fixed left-1/2 top-2 z-[64] flex -translate-x-1/2 items-center gap-3 rounded-full border-2 border-warn bg-panel-solid px-4 py-1.5 shadow-2xl" role="status" aria-live="polite">
            <span className="flex items-center gap-1.5 text-xs font-bold tracking-[0.2em] text-warn"><span className="h-2 w-2 animate-pulse rounded-full bg-warn" />REPLAY</span>
            <span className="num text-sm text-text">{new Date(vt).toLocaleTimeString([], { hour12: false })}</span>
            <span className="num text-xs text-warn">{speed}×</span>
            <span className="text-[10px] text-faint">{new Date(vt).toLocaleDateString()}</span>
            <button onClick={() => setPlaying(!playing)} className="text-text" aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
            {SPEEDS.map((s) => <button key={s} onClick={() => setSpeed(s)} className={`num text-[11px] ${s === speed ? 'text-warn' : 'text-faint hover:text-text'}`}>{s}×</button>)}
            <input type="range" min={range.from} max={range.to} step={1000} value={vt} onChange={(e) => scrub(Number(e.target.value))} className="w-56 accent-[var(--warn)]" aria-label="Replay timeline" />
            <button onClick={exit} className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-dim hover:text-text"><Icon name="x" size={11} />Exit to live</button>
          </div>
        </>
      ) : null}
    </>
  );
}
