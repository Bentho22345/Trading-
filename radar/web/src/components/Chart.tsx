'use client';
import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, HistogramSeries, type IChartApi, type ISeriesMarkersPluginApi, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';

const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];

export type ChartMarker = { ts: number; label: string; kind: 'vip' | 'post' | 'signal' | 'smart' };

export function Chart({ address, poll = 30000, markers = [] }: { address: string; poll?: number; markers?: ChartMarker[] }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<any>(null);
  const vol = useRef<any>(null);
  const mk = useRef<ISeriesMarkersPluginApi<any> | null>(null);
  const times = useRef<number[]>([]);
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const [tf, setTf] = useState('5m');
  const [meta, setMeta] = useState<{ as_of?: number; err?: string; n?: number; stale?: boolean }>({});

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      layout: { background: { type: ColorType.Solid, color: '#0d1117' }, textColor: '#6b7787', fontSize: 11 },
      grid: { vertLines: { color: '#151b24' }, horzLines: { color: '#151b24' } },
      rightPriceScale: { borderColor: '#1d2531' },
      timeScale: { borderColor: '#1d2531', timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    series.current = c.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#f43f5e', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#f43f5e',
      priceFormat: { type: 'price', precision: 10, minMove: 1e-10 },
    });
    vol.current = c.addSeries(HistogramSeries, { priceScaleId: '', priceFormat: { type: 'volume' }, color: '#38bdf833' });
    vol.current.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    mk.current = createSeriesMarkers(series.current, []);
    chart.current = c;
    return () => { c.remove(); chart.current = null; };
  }, []);

  const paintMarkers = () => {
    const t = times.current;
    if (!mk.current || !t.length) return;
    const COLORS = { vip: '#e879f9', post: '#38bdf8', signal: '#f59e0b', smart: '#22c55e' };
    const snap = (ts: number) => { let best = null as number | null; for (const x of t) if (x <= ts) best = x; return best; };
    const out = markersRef.current.map((m) => ({ m, time: snap(m.ts) })).filter((x) => x.time != null)
      .map(({ m, time }) => ({ time: time as UTCTimestamp, position: m.kind === 'signal' ? 'belowBar' as const : 'aboveBar' as const,
        shape: m.kind === 'signal' ? 'arrowUp' as const : 'circle' as const, color: COLORS[m.kind], text: m.label.slice(0, 18) }))
      .sort((a, b) => a.time - b.time);
    mk.current.setMarkers(out);
  };

  useEffect(() => { paintMarkers(); }, [markers]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    const load = () => api(`/api/token/${address}/ohlcv?tf=${tf}`).then((d) => {
      if (!alive || !series.current) return;
      series.current.setData(d.candles.map((k: any) => ({ time: k.time as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
      vol.current.setData(d.candles.map((k: any) => ({ time: k.time as UTCTimestamp, value: k.volume, color: k.close >= k.open ? '#22c55e40' : '#f43f5e40' })));
      times.current = d.candles.map((k: any) => k.time);
      paintMarkers();
      setMeta({ as_of: d.as_of, n: d.candles.length, stale: d.stale });
    }).catch((e) => alive && setMeta((m) => ({ ...m, err: String(e.message || e) })));
    load();
    const t = setInterval(load, poll);
    return () => { alive = false; clearInterval(t); };
  }, [address, tf, poll]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1 text-[11px]">
        {TFS.map((t) => (
          <button key={t} onClick={() => setTf(t)} className={`rounded px-1.5 ${tf === t ? 'bg-panel2 text-accent' : 'text-mute hover:text-fg'}`}>{t}</button>
        ))}
        <span className={`ml-auto ${meta.err || meta.stale ? 'text-down' : 'text-mute'}`}>
          {meta.err ? `chart: ${meta.err}` : meta.as_of ? `GeckoTerminal OHLCV · ${meta.n} candles · ${ago(meta.as_of)} ago${meta.stale ? ' · STALE' : ''}` : 'loading…'}
        </span>
      </div>
      <div ref={el} className="min-h-[320px] flex-1" />
    </div>
  );
}
