'use client';
import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, HistogramSeries,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type MouseEventParams, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { ago, price, usd } from '@/lib/format';
import { useLive } from '@/lib/live';
import { cssVar, useTheme } from '@/lib/theme';

const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
type TF = (typeof TFS)[number];
const TF_S: Record<TF, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

export type ChartMarker = { ts: number; label: string; kind: 'vip' | 'post' | 'signal' | 'smart' | 'top'; side?: 'buy' | 'sell' };
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Resp = { candles: Candle[]; as_of?: number; source?: string; stale?: boolean; supply?: number | null; tf_s?: number };

// Per-tab memory cache: switching timeframe or re-opening a coin paints instantly, then refreshes.
const CACHE = new Map<string, { at: number; d: Resp }>();
const INFLIGHT = new Map<string, Promise<Resp>>();
function fetchCandles(address: string, tf: TF): Promise<Resp> {
  const key = `${address}:${tf}`;
  let p = INFLIGHT.get(key);
  if (!p) {
    p = api<Resp>(`/api/token/${address}/ohlcv?tf=${tf}`).then((d) => { CACHE.set(key, { at: Date.now(), d }); return d; })
      .finally(() => INFLIGHT.delete(key));
    INFLIGHT.set(key, p);
  }
  return p;
}

/** lightweight-charts only parses hex/rgb(a): turn a theme hex into rgba with alpha. */
function rgba(hex: string, a: number) {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(f, 16);
  return Number.isNaN(n) ? `rgba(128,128,128,${a})` : `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const two = (n: number) => String(n).padStart(2, '0');
function localTick(t: number, tf: TF) {
  const d = new Date(t * 1000);
  if (tf === '1d') return `${d.getMonth() + 1}/${d.getDate()}`;
  if (d.getHours() === 0 && d.getMinutes() === 0) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

function Inner({ address, poll = 15000, markers = [] }: { address: string; poll?: number; markers?: ChartMarker[] }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const vol = useRef<ISeriesApi<'Histogram'> | null>(null);
  const mk = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const bars = useRef<Candle[]>([]);
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const [tf, setTf] = useState<TF>(() => { try { return (localStorage.getItem('radar:tf') as TF) || '5m'; } catch { return '5m'; } });
  const [mode, setMode] = useState<'price' | 'mcap'>(() => { try { return (localStorage.getItem('radar:chartmode') as 'price' | 'mcap') || 'price'; } catch { return 'price'; } });
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const supply = useRef<number | null>(null);
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const [meta, setMeta] = useState<{ as_of?: number; err?: string; n?: number; stale?: boolean; source?: string }>({});
  const [loading, setLoading] = useState(true);
  const [legend, setLegend] = useState<Candle | null>(null);
  const [theme] = useTheme();
  const fitted = useRef('');

  const k = useCallback((v: number) => (modeRef.current === 'mcap' && supply.current ? v * supply.current : v), []);
  const fmt = useCallback((v: number) => (modeRef.current === 'mcap' && supply.current ? usd(v, 2) : price(v)), []);

  const colors = useCallback(() => ({
    bg: cssVar('--color-panel', '#0c0c0d'), text: cssVar('--color-mute', '#8d8d95'), line: cssVar('--color-line', '#232326'),
    up: cssVar('--color-up', '#22e57a'), down: cssVar('--color-down', '#ff2d55'), accent: cssVar('--color-accent2', '#00d1ff'),
  }), []);

  // create once
  useEffect(() => {
    if (!el.current) return;
    const c0 = colors();
    const c = createChart(el.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: c0.text, fontSize: 11, fontFamily: 'var(--font-mono), ui-monospace, monospace', attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: rgba(c0.line, 0.6) } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.22 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 8,
        tickMarkFormatter: (t: Time) => localTick(t as number, tfRef.current) },
      localization: {
        timeFormatter: (t: Time) => new Date((t as number) * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
        priceFormatter: (v: number) => fmt(v),
      },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    });
    series.current = c.addSeries(CandlestickSeries, {
      upColor: c0.up, downColor: c0.down, borderVisible: false, wickUpColor: c0.up, wickDownColor: c0.down,
      priceFormat: { type: 'custom', formatter: (v: number) => fmt(v), minMove: 1e-12 },
      priceLineStyle: 2,
    });
    vol.current = c.addSeries(HistogramSeries, { priceScaleId: '', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    vol.current.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    mk.current = createSeriesMarkers(series.current, []);
    const onMove = (p: MouseEventParams) => {
      const d = p.time != null ? (p.seriesData.get(series.current!) as any) : null;
      if (!d) { setLegend(null); return; }
      const raw = bars.current.find((b) => b.time === p.time);
      setLegend(raw ? { ...raw } : null);
    };
    c.subscribeCrosshairMove(onMove);
    chart.current = c;
    return () => { c.unsubscribeCrosshairMove(onMove); c.remove(); chart.current = null; series.current = null; vol.current = null; };
  }, [colors, fmt]);

  // re-skin on theme switch (no re-create, keeps zoom)
  useEffect(() => {
    const c = chart.current;
    if (!c || !series.current) return;
    const c0 = colors();
    c.applyOptions({ layout: { textColor: c0.text }, grid: { horzLines: { color: rgba(c0.line, 0.6) } } });
    series.current.applyOptions({ upColor: c0.up, downColor: c0.down, wickUpColor: c0.up, wickDownColor: c0.down });
    paint(false);
  }, [theme]); // eslint-disable-line react-hooks/exhaustive-deps

  const paintMarkers = useCallback(() => {
    const t = bars.current.map((b) => b.time);
    if (!mk.current || !t.length) return;
    const COLORS = { vip: cssVar('--color-flash'), post: cssVar('--color-accent2'), signal: cssVar('--color-warn'), smart: cssVar('--color-up'), top: '#facc15' };
    const snap = (ts: number) => {   // binary search: last bar at or before ts
      let lo = 0, hi = t.length - 1, best = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= ts) { best = m; lo = m + 1; } else hi = m - 1; }
      return best >= 0 ? t[best] : null;
    };
    const out = markersRef.current.map((m) => ({ m, time: snap(m.ts) })).filter((x) => x.time != null)
      .map(({ m, time }) => {
        const up = m.kind === 'signal' || (m.kind === 'top' && m.side === 'buy');
        const shape = m.kind === 'top' ? (up ? 'arrowUp' as const : 'arrowDown' as const) : m.kind === 'signal' ? 'arrowUp' as const : 'circle' as const;
        const color = m.kind === 'top' && m.side === 'sell' ? cssVar('--color-down') : COLORS[m.kind];
        return { time: time as UTCTimestamp, position: up ? 'belowBar' as const : 'aboveBar' as const, shape, color, text: m.label.slice(0, 18) };
      })
      .sort((a, b) => a.time - b.time);
    mk.current.setMarkers(out);
  }, []);

  const paint = useCallback((fit: boolean) => {
    if (!series.current || !vol.current) return;
    const c0 = colors();
    const b = bars.current;
    series.current.setData(b.map((x) => ({ time: x.time as UTCTimestamp, open: k(x.open), high: k(x.high), low: k(x.low), close: k(x.close) })));
    vol.current.setData(b.map((x) => ({ time: x.time as UTCTimestamp, value: x.volume, color: rgba(x.close >= x.open ? c0.up : c0.down, 0.35) })));
    paintMarkers();
    if (fit && chart.current && b.length) {
      const n = b.length;
      chart.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 4 });
    }
  }, [colors, k, paintMarkers]);

  useEffect(() => { paintMarkers(); }, [markers, paintMarkers]);
  useEffect(() => { try { localStorage.setItem('radar:chartmode', mode); } catch { /* */ } paint(false); }, [mode, paint]);

  // load: cached paint first, then network; poll while visible
  useEffect(() => {
    let alive = true;
    try { localStorage.setItem('radar:tf', tf); } catch { /* */ }
    const apply = (d: Resp, fit: boolean) => {
      if (!alive) return;
      bars.current = d.candles || [];
      supply.current = d.supply ?? null;
      paint(fit);
      setMeta({ as_of: d.as_of, n: d.candles.length, stale: d.stale, source: d.source });
      setLoading(false);
    };
    const key = `${address}:${tf}`;
    const hit = CACHE.get(key);
    const fitKey = key;
    if (hit) apply(hit.d, fitted.current !== fitKey);
    else { setLoading(true); bars.current = []; paint(false); }
    fitted.current = fitKey;
    const load = () => fetchCandles(address, tf).then((d) => apply(d, !hit && bars.current.length === 0))
      .catch((e) => alive && (setMeta((m) => ({ ...m, err: String(e.message || e) })), setLoading(false)));
    if (!hit || Date.now() - hit.at > 5000) load();
    let t: ReturnType<typeof setInterval> | undefined;
    const start = () => { stop(); t = setInterval(load, poll); };
    const stop = () => { if (t) clearInterval(t); t = undefined; };
    const vis = () => (document.hidden ? stop() : (load(), start()));
    start();
    document.addEventListener('visibilitychange', vis);
    return () => { alive = false; stop(); document.removeEventListener('visibilitychange', vis); };
  }, [address, tf, poll, paint]);

  // live: every trade on this coin moves the last candle immediately (pump.fun supply is fixed, price = mcap / 1B)
  useLive(({ ch, data }) => {
    if (ch !== 'trade' || data.mint !== address || !data.price_usd || !series.current || !vol.current) return;
    const s = TF_S[tfRef.current];
    const ts = Math.floor(data.ts / s) * s;
    const b = bars.current;
    const last = b[b.length - 1];
    const p = data.price_usd as number;
    const v = (data.usd as number) || 0;
    if (last && ts < last.time) return;
    // guard against a pool/price-basis mismatch (e.g. a non-pump DEX pool): ignore trades >5× away from the last close
    if (last && (p > last.close * 5 || p < last.close / 5)) return;
    let bar: Candle;
    if (last && last.time === ts) {
      bar = { ...last, high: Math.max(last.high, p), low: Math.min(last.low, p), close: p, volume: last.volume + v };
      b[b.length - 1] = bar;
    } else {
      const open = last ? last.close : p;
      bar = { time: ts, open, high: Math.max(open, p), low: Math.min(open, p), close: p, volume: v };
      b.push(bar);
    }
    if (!supply.current) supply.current = 1e9;
    const c0 = colors();
    series.current.update({ time: ts as UTCTimestamp, open: k(bar.open), high: k(bar.high), low: k(bar.low), close: k(bar.close) });
    vol.current.update({ time: ts as UTCTimestamp, value: bar.volume, color: rgba(bar.close >= bar.open ? c0.up : c0.down, 0.35) });
    setMeta((m) => ({ ...m, as_of: data.ts, n: b.length }));
  });

  const prefetch = (t: TF) => { if (!CACHE.has(`${address}:${t}`)) fetchCandles(address, t).catch(() => {}); };
  const L = legend || bars.current[bars.current.length - 1];
  const chg = L ? (L.close / L.open - 1) * 100 : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11px]">
        <div className="flex rounded-full border border-white/10 p-0.5">
          {TFS.map((t) => (
            <button key={t} onMouseEnter={() => prefetch(t)} onClick={() => setTf(t)}
              className={`num rounded-full px-2.5 py-0.5 font-semibold transition ${tf === t ? 'bg-white text-black' : 'text-white/55 hover:text-white'}`}>{t}</button>
          ))}
        </div>
        <div className="flex rounded-full border border-white/10 p-0.5">
          {(['price', 'mcap'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`rounded-full px-2.5 py-0.5 font-semibold uppercase tracking-wider transition ${mode === m ? 'bg-white text-black' : 'text-white/55 hover:text-white'}`}>{m === 'price' ? 'Price' : 'MCap'}</button>
          ))}
        </div>
        {L && (
          <span className="num hidden gap-2 text-white/60 md:flex">
            <span>O <b className="text-white">{fmt(k(L.open))}</b></span><span>H <b className="text-white">{fmt(k(L.high))}</b></span>
            <span>L <b className="text-white">{fmt(k(L.low))}</b></span><span>C <b className="text-white">{fmt(k(L.close))}</b></span>
            <span className={chg != null && chg >= 0 ? 'text-up' : 'text-down'}>{chg != null ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : ''}</span>
            <span>Vol <b className="text-white">{usd(L.volume)}</b></span>
          </span>
        )}
        <span className={`ml-auto flex items-center gap-1.5 ${meta.err || meta.stale ? 'text-down' : 'text-white/45'}`}>
          {!meta.err && meta.as_of && <span className="live-dot h-1.5 w-1.5 rounded-full bg-up" />}
          {meta.err ? `chart: ${meta.err}` : meta.as_of ? `${(meta.source || '').replace('geckoterminal', 'GeckoTerminal').replace('pumpportal', 'live trades').replace('+', ' + ')} · ${ago(meta.as_of)} ago${meta.stale ? ' · STALE' : ''}` : loading ? 'loading…' : 'no trades yet'}
        </span>
      </div>
      <div className="relative min-h-[320px] flex-1">
        <div ref={el} className="absolute inset-0" />
        {loading && <div className="skeleton absolute inset-3 opacity-60" />}
        {!loading && !meta.n && !meta.err && <div className="absolute inset-0 flex items-center justify-center text-[12px] text-white/40">No candles yet — the chart fills in from the first trade.</div>}
      </div>
    </div>
  );
}

/** Candles from GeckoTerminal + Radar's live trade stream; the last candle moves on every trade. */
export const Chart = memo(Inner, (a, b) => a.address === b.address && a.poll === b.poll && a.markers === b.markers);

export function useChartMarkers<T>(d: T, fn: (d: T) => ChartMarker[]) {
  return useMemo(() => fn(d), [d]); // eslint-disable-line react-hooks/exhaustive-deps
}
